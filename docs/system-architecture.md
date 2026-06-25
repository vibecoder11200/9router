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
   2. **Pre-translate hooks** (fail-open, run in order before translation):
      - **RTK compress** verbose `tool_result` content (`rtk/index.js`).
      - **Headroom proxy** (`rtk/headroom.js`) — optional external `/v1/compress` proxy.
      - **Caveman mode** (`rtk/caveman.js`) — injects caveman-speak system prompt (−65% output tokens).
      - **Ponytail** (`rtk/ponytail.js`) — injects "lazy senior dev" system prompt (Lite/Full/Ultra).
   3. **Capability concerns** strip unsupported modalities (vision/audio/pdf)
      per model (`translator/concerns/`).
   4. **Translate request** to the provider's format (`translator/index.js`;
      pivots through OpenAI if no direct route).
   5. **Select executor** (`executors/index.js`) — `DefaultExecutor` or a
      provider-specific one (cursor, kiro, gemini-web, vertex, …).
   6. **Execute** (`executors/base.js`) — build URL/headers, call provider
      with retry, fallback URLs, and credential refresh; honor outbound proxy
      env vars via `utils/proxyFetch.js`; validates target via `ssrfGuard.js`.
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

### Responses API path

`/v1/responses` is handled by a dedicated route handler
(`src/app/api/v1/responses/route.js`) that delegates to the same `handleChat`
pipeline. The `responsesHandler.js` in `open-sse/handlers/` converts Responses
API format to Chat Completions format via `convertResponsesApiFormat()`
(`open-sse/translator/formats/responsesApi.js`), then calls `handleChatCore`.
On the response side, `responsesTransformer.js` converts Chat Completions SSE
chunks into Responses API SSE format, and `streamToJsonConverter.js` handles
non-streaming Responses.

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
  Gemini-Web, etc.). **24 executors total**, including `codebuddy-cn`
  (Tencent CodeBuddy), `mimo-free` (Xiaomi Mimo free), `commandcode`,
  web-based executors (`grok-web`, `perplexity-web`, `gemini-web`).
- **Services** = cross-cutting: model/provider resolution, account fallback,
  combos, OAuth credential management + token refresh, per-provider usage
  parsers (`services/usage/`), and the Gemini-Web session/cookie/RPC/keepalive
  cluster (8 files).
- **RTK** = token-reduction layer that compresses tool output (git diff/status,
  logs, grep/find/ls) before sending upstream. Includes `filters/` (11 files),
  `headroom.js` (external compress proxy), `caveman.js` (caveman-speak injector,
  −65% output tokens), `ponytail.js` ("lazy senior dev" injector, Lite/Full/Ultra).
- **Transformer** = `responsesTransformer.js` (Chat Completions SSE → Codex
  Responses API SSE), `streamToJsonConverter.js` (Responses non-streaming).
- **Config** = single source for timeouts, retry/backoff, error mapping, and
  the provider/model registries (built from `providers/registry/` — 97 files).

### The pre-translate hook pipeline (chat)

Before translation, `chatCore.js` runs a series of **fail-open** hooks that
mutate the request body in-place. Each hook returns null on error, leaving
the body untouched:

```
Body → RTK compress (tool_result) → Headroom (/v1/compress proxy)
     → Caveman (system inject, −65% output) → Ponytail (system inject,
       Lite/Full/Ultra) → Translate → Execute
```

- **RTK** (`rtk/index.js` + `rtk/filters/`) compresses `tool_result` blocks
  by auto-detecting their type (git diff, grep, ls, etc.) and applying
  format-preserving compression. Safe by design — if a filter fails, the
  original text is kept.
- **Headroom** (`rtk/headroom.js`) forwards the request body to an optional
  external Headroom proxy (`/v1/compress`). If the proxy is down or returns an
  error, 9Router fails open and sends the original request. The Headroom
  subprocess lifecycle is managed by `src/lib/headroom/process.js` with a
  dashboard UI for start/stop/status (`/api/headroom/*`).
- **Caveman** (`rtk/caveman.js`) injects a caveman-speak system prompt
  ("why use many token when few token do trick") in 3 levels — −65% output tokens.
- **Ponytail** (`rtk/ponytail.js`) injects a "lazy senior dev" system prompt
  (Lite/Full/Ultra) that biases the LLM toward minimal, YAGNI-first code.


### DS2API sidecar provider

**DS2API** (`open-sse/providers/registry/ds2api.js`) is a registered provider that
exposes DeepSeek web chat as an OpenAI-compatible API via a managed local sidecar
process (the `ds2api` Go binary, which pools DeepSeek accounts and solves PoW).

Integration is "Tier B" — 9router owns the full lifecycle and configuration:

- **Binary install** (`src/lib/ds2api/install.js`): auto-downloads the matching
  GitHub release artifact per OS/arch, sha256-verifies it, and extracts it into
  `DATA_DIR/ds2api` (`DS2API_VERSION`, overridable via env). No Go toolchain needed.
- **Lifecycle** (`src/lib/ds2api/process.js`, `detect.js`): spawn/stop/health-probe
  the sidecar. On first start 9router generates strong `adminKey` + caller `apiKey`
  secrets (`credentials.json`, mode 0600); the admin key is passed via
  `DS2API_ADMIN_KEY`, config persisted via `DS2API_CONFIG_PATH`.
- **Config bridge** (`src/lib/ds2api/adminClient.js`): 9router drives ds2api's JWT
  admin REST API (`/admin/*`) to manage DeepSeek-web accounts, keys, queue, and
  settings from the 9router dashboard, so the user never touches ds2api's own UI.
- **Auto-injection**: after start, 9router ensures the managed caller key is in
  ds2api's `keys` and registers a `ds2api` provider connection carrying it, so the
  existing executor routes with `Authorization: Bearer <key>` (the registry uses
  `authType: "apikey"` + `transport.auth`, `passthroughModels: true`).
- **Routing sync** (`src/lib/ds2api/resolve.js`): `PROVIDERS.ds2api.baseUrl` is
  patched at runtime from the `ds2apiUrl` setting (loopback default
  `http://localhost:5001`).
- **Reverse proxy** (`/api/ds2api/proxy/[...path]`): auth-gated streaming passthrough
  to the internal sidecar for advanced/raw access.

Dashboard UI lives in
`src/app/(dashboard)/dashboard/providers/[id]/Ds2apiManager.js`, rendered on the
DeepSeek Web provider detail page (`/dashboard/providers/ds2api`), where users
install/start the engine, manage the DeepSeek-account pool, and see available
models. API routes under `/api/ds2api/*` are deny-by-default auth-gated
(`src/dashboardGuard.js`), and the process-spawning routes
(`install`/`start`/`stop`) are further restricted to localhost via
`LOCAL_ONLY_PATHS`.

**Security note:** ds2api binds `0.0.0.0:<port>` (hardcoded upstream), so on
shared/LAN hosts the internal port is technically reachable; 9router reverse-proxies
browser access, auto-generates strong admin/api keys, and does not advertise the
port, but a host firewall is recommended on multi-user machines. (A loopback-only
bind would require forking ds2api.)

### Web-based/session-based executors

Three executors use session cookies instead of API keys:

- **`grok-web`** (`open-sse/executors/grok-web.js`) — accesses xAI Grok via cookies
- **`perplexity-web`** (`open-sse/executors/perplexity-web.js`) — accesses Perplexity via cookies
- **`gemini-web`** (`open-sse/executors/gemini-web.js`) — accesses Google Gemini via RPC protocol

These share no common base; each implements its own session management within
its executor.

### Gemini-Web cluster

A dedicated subsystem for session/cookie-based access to Gemini via the web
interface (not API), comprising 9 service files + 1 executor:

- `open-sse/executors/gemini-web.js` — executor using the Gemini-Web RPC protocol
- `open-sse/services/geminiWebSession.js` — session management (login, token refresh)
- `open-sse/services/geminiWebCookiePool.js` — multi-account cookie rotation pool
- `open-sse/services/geminiWebCookie.js` — individual cookie lifecycle
- `open-sse/services/geminiWebKeepAlive.js` — keepalive to prevent session expiry
- `open-sse/services/geminiWebFingerprint.js` — browser fingerprint simulation (headers, TLS)
- `open-sse/services/geminiWebRpc.js` — RPC protocol (batchexecute for status, streamgenerate for chat)
- `open-sse/services/geminiWebModels.js` — model listing from web session
- `open-sse/services/geminiWebUsage.js` — usage tracking for web sessions

The executor calls through `geminiWebRpc.js` which uses `batchexecute` (JSON-RPC-style)
for user status checks and `streamgenerate` (binary-framed SSE) for chat completion.
Cookie rotation, keepalive pings, and fingerprint emulation run as background tasks.

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

Intercepted domains (from `src/mitm/config.js`): Antigravity (cloudcode
`*.googleapis.com`), Cursor (`api2.cursor.sh`), Kiro (`runtime.*.kiro.dev`),
Copilot (`api.individual.githubcopilot.com`).

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
- **SSRF guard:** `src/shared/utils/ssrfGuard.js` validates all outbound
  fetch targets, blocking requests to private/internal/metadata IP ranges
  (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, and cloud metadata
  IPs like 169.254.169.254).
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
