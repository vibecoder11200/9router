# System Architecture

> How 9Router fits together and how a request flows end-to-end. All statements
> are traceable to source. Note: there is also a legacy `docs/ARCHITECTURE.md`
> (fork-inherited prose); this file supersedes it where they differ.

## 1. High-level topology

```
                ┌──────────────────────────────────────────────────────────┐
   LLM clients  │  OpenAI / Claude / Gemini SDKs, AI IDEs, the 9router CLI  │
   (any shape)  └─────────────────────────┬────────────────────────────────┘
                                           │  HTTPS (/v1, /v1/messages, /codex, …)
                                           ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ Next.js custom server  (custom-server.js)                     │
        │  • strips spoofable x-forwarded-for / x-real-ip              │
        │  • injects x-9r-real-ip (socket IP) for rate-limiting        │
        │  • rewrites: /v1/* /v1/v1/* /codex/* → /api/v1/*              │
        └────────────────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴─────────────────────────────┐
        │ src/app/api/v1/*  (thin route handlers)                       │
        └────────────────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴─────────────────────────────┐
        │ src/sse/handlers/*  (gateway: auth, model resolution, combo)  │
        └────────────────────────────────┬─────────────────────────────┘
                                         │  handleChatCore / handleComboChat / handleFusionChat
        ┌────────────────────────────────┴─────────────────────────────┐
        │ open-sse engine                                                │
        │  translate → RTK compress → select executor → call provider   │
        │  → stream-transform response back to client format            │
        └────────────────────────────────┬─────────────────────────────┘
                                         │  outbound HTTPS (optional HTTP_PROXY/HTTPS_PROXY)
                                         ▼
                              Upstream LLM providers
```

Separate inbound path for AI IDEs that can't be re-pointed at `/v1`:

```
   Cursor / Kiro / Copilot / Antigravity
        │ (DNS hijacked to 127.0.0.1 via /etc/hosts; root CA installed)
        ▼
   src/mitm/server.js  (HTTPS + SNI + HTTP/2 interception)
        │  maps intercepted model → user provider via `mitmAlias`
        └──► reuses the same open-sse pipeline above
```

## 2. End-to-end request lifecycle (chat completion)

Traceable from `src/app/api/v1/chat/completions/route.js`:

1. **Ingress & rewrite.** `next.config.mjs` rewrites `/v1/chat/completions`
   (and `/v1/v1/...`, `/codex/...`) to `/api/v1/chat/completions`. The custom
   server injects the real client IP before Next handles it.
2. **Route handler.** `route.js` parses the body and calls
   `handleChat(request)` in `src/sse/handlers/chat.js`.
3. **Auth gate.** `handleChat` reads `settings.requireApiKey`; if set, it
   validates the bearer key via `isValidApiKey()` (`src/sse/services/auth.js`)
   and returns `401` on failure.
4. **Format detection.** `detectFormatByEndpoint()` (`open-sse/translator/
   formats.js`) identifies the client format (OpenAI / Claude / Gemini /
   Responses).
5. **Model resolution.** `src/sse/services/model.js` resolves the `model`
   string: alias → combo → single provider model (`getModelInfo` /
   `getComboModels`). Model strings use `provider/model` or an alias.
6. **Credential selection.** `getProviderCredentials()` selects an active
   connection for the resolved provider (mutex-protected), refreshing OAuth
   tokens via `checkAndRefreshToken()` when needed.
7. **Combo vs single.**
   - Single model → `handleChatCore()` (`open-sse/handlers/chatCore.js`).
   - Combo → `handleComboChat()` (failover) or `handleFusionChat()` (fusion)
     from `open-sse/services/combo.js`.
8. **Inside `open-sse` `handleChatCore`:**
   1. `handleBypassRequest()` short-circuits warmup/skip patterns.
   2. **Capability concerns** strip unsupported modalities (vision/audio/pdf)
      per model (`translator/concerns/`).
   3. **Translate request** to the provider's format (`translator/index.js`;
      pivots through OpenAI if no direct route).
   4. **RTK compress** verbose `tool_result` content (`rtk/index.js`).
   5. **Select executor** (`executors/index.js`) — `DefaultExecutor` or a
      provider-specific one (cursor, kiro, gemini-web, vertex, …).
   6. **Execute** (`executors/base.js`) — build URL/headers, call provider
      with retry, fallback URLs, and credential refresh; honor outbound proxy
      env vars via `utils/proxyFetch.js`.
9. **Response streaming.** `handlers/chatCore/streamingHandler.js` (or
   `nonStreamingHandler.js`) builds an SSE transform pipeline
   (`utils/stream.js`): converts provider SSE → client format, maps tool
   names, tracks usage, and watches for disconnect/stall (`streamHandler.js`).
10. **Usage logging.** Tokens/cost/status are written to `usageHistory` (and
    daily rollups to `usageDaily`); full payloads to `requestDetails` when
    request-detail capture is on.
11. **Failure & fallback.** On 429/401/5xx, `handleChat` calls
    `markAccountUnavailable(model)` and `open-sse/services/accountFallback.js`
    applies backoff; the next active account is tried until success or all are
    exhausted (`unavailableResponse`).

## 3. The `open-sse` engine (internal architecture)

`open-sse` is a self-contained ESM package consumed by the app via
`open-sse/index.js` (also imported for side effects — it wires HTTP proxy env
vars).

- **Handlers** = modality orchestrators (`chatCore`, `responsesHandler`,
  `embeddingsCore`, `imageGenerationCore`, `ttsCore`, `sttCore`, `search`).
- **Translators** = bidirectional format conversion (`formats/{openai,claude,
  gemini,responsesApi}`, `request/`, `response/`, `schema/`, `concerns/`).
- **Executors** = provider HTTP clients; `base.js` provides URL/header build,
  retry, fallback-URL, credential-refresh; specialized executors add
  provider protocols (protobuf for Cursor, EventStream for Kiro, RPC for
  Gemini-Web, etc.).
- **Services** = cross-cutting: model/provider resolution, account fallback,
  combos, OAuth credential management + token refresh, per-provider usage
  parsers (`services/usage/`), and the Gemini-Web session/cookie/RPC/keepalive
  cluster.
- **RTK** = token-reduction layer that compresses tool output (git diff/status,
  logs, grep/find/ls) before sending upstream.
- **Config** = single source for timeouts, retry/backoff, error mapping, and
  the provider/model registries (built from `providers/registry/`).

## 4. MITM mode (`src/mitm/`)

For IDEs that hardcode their backend domains, 9Router can intercept them
locally instead of being re-pointed at `/v1`:

1. `cert/generate.js` creates a local root CA; `cert/install.js` adds it to
   the OS trust store (Windows/macOS/Linux).
2. `dns/dnsConfig.js` maps target tool domains to `127.0.0.1` via `/etc/hosts`
   (or platform equivalent).
3. `server.js` runs an HTTPS server (SNI + HTTP/2, HTTP/1.1 fallback) that
   terminates TLS with per-domain certs signed by the local CA.
4. Per-IDE handlers (`handlers/{kiro,copilot,antigravity,cursor}.js`) decode
   the intercepted request, map the requested model to a user-configured
   provider model via the `mitmAlias` KV, and forward through the same
   `open-sse` pipeline.
5. `manager.js` owns the child-process lifecycle, health checks, and DNS
   teardown.

Intercepted domains (from `src/mitm/config.js`): e.g. Antigravity
(`*.googleapis.com` cloudcode), Cursor (`api2.cursor.sh`), Kiro
(`runtime.*.kiro.dev`), Copilot (`api.individual.githubcopilot.com`).

## 5. Data & persistence

- **Engine:** SQLite via a runtime-selected driver
  (`src/lib/db/driver.js`): `bun:sqlite` → `better-sqlite3` → `node:sqlite`
  → `sql.js` (WASM). PRAGMAs: WAL, `synchronous=NORMAL`, `mmap_size=30MB`,
  `busy_timeout=5000`, `foreign_keys=ON`.
- **Location:** `<DATA_DIR>/db/data.sqlite`. Default `DATA_DIR`:
  `~/.9router/` (Linux/macOS) or `%APPDATA%/9router/` (Windows).
- **Schema (`SCHEMA_VERSION = 1`), 11 tables:**
  - `_meta` — schema version/migration state.
  - `settings` — single-row JSON (authMode, password hash, OIDC config, flags).
  - `providerConnections` — provider credentials (API key or OAuth),
    `authType`, priority, isActive; multi-account per provider.
  - `providerNodes` — optional node/region config per connection.
  - `proxyPools` — rotating outbound proxy definitions + test status.
  - `apiKeys` — dashboard-issued endpoint API keys (with `machineId`).
  - `combos` — multi-model groups (`kind`, `models`).
  - `kv` — scoped key-value (`modelAliases`, `customModels`, `mitmAlias`,
    `pricing`, …).
  - `usageHistory` — per-request tokens/cost/status (indexed by time/provider/
    model/connection).
  - `usageDaily` — daily aggregates keyed by date.
  - `requestDetails` — full request/response dumps for debugging.
- **Migrations:** versioned files in `src/lib/db/migrations/`;
  `migrate.js` also auto-imports legacy JSON (`db.json`, `usage.json`) on first
  run; declarative `TABLES` sync adds non-destructive columns/indexes.

## 6. Auth & security model

- **Dashboard access:** single admin. Password (bcrypt) or OIDC (PKCE,
  `src/lib/auth/oidc.js`). Sessions are JWT cookies set by
  `dashboardSession.js`. Login is rate-limited per real IP
  (`loginLimiter.js`).
- **Endpoint access:** optional. When `settings.requireApiKey` is true,
  `/api/v1/*` requires a valid bearer key from the `apiKeys` table.
- **IP integrity:** `custom-server.js` derives the client IP from the socket
  and strips client-supplied forwarding headers so rate limiting and audit
  can't be spoofed. Requests seen through a reverse proxy are flagged
  (`x-9r-via-proxy`).
- **Secrets:** env-driven (`.env.example`); `JWT_SECRET`, `INITIAL_PASSWORD`,
  `API_KEY_SECRET`, `MACHINE_ID_SALT` are the security-critical ones.

## 7. Frontend architecture

- Next.js 16 App Router. Server components fetch data and render shell;
  interactive surfaces are `*Client.js` client components.
- Client state via Zustand (`src/store/`); server data via TTL-cached stores
  and direct `fetch('/api/...')`.
- Real-time: SSE streams for live usage (`/api/usage/stream`) and the MCP
  plugin bridge (`/api/mcp/[plugin]/sse`).
- Runtime i18n (`src/i18n/`) translates the DOM via MutationObserver across
  31 locales; theme via `useTheme`.

## 8. Deployment & runtime topology

- **Dev:** `npm run dev` → Next on port **20127**.
- **Docker / production:** `node:22-alpine`, CMD `node custom-server.js`,
  exposed port **20128**, volumes `/app/data` and `/app/data-home`
  (→ `/root/.9router`). Multi-arch images (amd64/arm64) published on tag `v*`
  via `.github/workflows/docker-publish.yml` to GHCR + Docker Hub.
- **CLI:** `9router` launches the standalone server (default port **20128**),
  optionally in system-tray mode, and can drive the server over HTTP via
  `cli/src/cli/api/client.js`.
- **Local HTTPS:** `https-server.js` fronts an internal Next server (port
  19997) with self-signed certs on port 9997 for local dev.
- **Tunnels:** Cloudflare (`src/lib/tunnel/cloudflare/manager.js`) and
  Tailscale (`src/lib/tunnel/tailscale/manager.js`) expose the dashboard
  beyond localhost.
- **CI (`.github/workflows/`):** `ci.yml` (lint/type/build/audit),
  `docker-publish.yml` (build+push on tag), `deploy.yml` (SSH deploy),
  `gitbook-pages.yml` (publish the separate `gitbook/` docs site).

## 9. Key extension points (quick reference)

| Want to… | Touch |
|---|---|
| Add an OpenAI-compatible endpoint | `src/app/api/v1/<name>/route.js` + a handler in `src/sse/handlers/` |
| Add an upstream provider | `open-sse/executors/<name>.js`, register in `executors/index.js`, add to `providers/registry/` + `config/{providers,providerModels}.js` |
| Add a client format | `open-sse/translator/formats/<name>.js` + `request/`/`response/` |
| Change timeouts/retry/backoff | `open-sse/config/runtimeConfig.js`, `config/errorConfig.js` |
| Add a DB table/column | `src/lib/db/schema.js` (+ migration if destructive) |
| Add an MITM-intercepted IDE | `src/mitm/handlers/<ide>.js` + target domain in `src/mitm/config.js` |
| Add dashboard UI | `src/app/(dashboard)/dashboard/<feature>/` + components in `src/shared/components/` |
