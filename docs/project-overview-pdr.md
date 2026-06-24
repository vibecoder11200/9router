# 9Router — Project Overview & PDR

> Source of truth for what 9Router is and what it must do. Grounded in the actual
> code in this repository (`9router-mod`). Where older prose docs (README,
> CHANGELOG, gitbook) disagree with the code, the code wins.

## 1. What 9Router is

9Router (`package.json` name: `9router-app`, version `0.5.8`) is a **self-hosted
LLM API gateway / router** with a Next.js dashboard. It exposes an OpenAI-compatible
HTTP API and routes each request to one of many configured upstream providers —
translating between client formats (OpenAI, Claude, Gemini, OpenAI Responses API)
and provider formats on the fly, with streaming (SSE).

It is a **local-first** application: all state lives in a SQLite database on the
host, there is no mandatory cloud dependency, and it ships both a web dashboard
and an npm CLI (`9router`) for headless use.

### Core capabilities (verified in code)

- **OpenAI-compatible API** under `/api/v1/...`: chat completions, messages
  (Claude), embeddings, images, audio speech/transcriptions, models listing,
  search, web fetch. Rewrites in `next.config.mjs` also map `/v1/:path*`,
  `/v1/v1/:path*`, and `/codex/:path*` → `/api/v1/...`.
- **Multi-format translation**: the `open-sse` engine converts between client
  and provider request/response formats, pivoting through OpenAI when no direct
  translator exists.
- **Many upstream providers** via specialized executors (OpenAI-compatible,
  Anthropic/Azure/Vertex, plus "web/IDE" providers: Gemini Web, Cursor, Kiro,
  GitHub Copilot, Codex, Antigravity, Qoder, Grok-web, Perplexity-web,
  CodeBuddy-cn, Mimo-free, Cloudflare AI, etc.).
- **Credentials & failover**: per-connection credentials (API key or OAuth),
  account fallback with exponential backoff, and multi-model "combos"
  (failover or fusion).
- **MITM mode**: an HTTPS interception proxy (`src/mitm/`) reroutes traffic from
  AI IDEs (Antigravity, Cursor, Kiro, Copilot) through the gateway by installing
  a local root CA and DNS-redirecting tool domains to 127.0.0.1.
- **Tunnels**: optional Cloudflare and Tailscale integration to expose the local
  dashboard (`src/lib/tunnel/`).
- **Dashboard**: Next.js App Router UI for providers, combos, API keys, usage
  analytics, MITM config, proxy pools, CLI tools, media providers, and settings.
- **CLI**: the `9router` npm package launches/manages the server and offers a
  terminal UI + system-tray mode.
- **SSRF guard**: `ssrfGuard.js` validates outbound fetch targets, blocking
  requests to private/internal/metadata IP ranges to prevent SSRF attacks.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Web framework | Next.js 16 (App Router), React 19, standalone output |
| Language | JavaScript (ESM), with `jsconfig.json` path aliases (`@/...`) |
| Styling | Tailwind CSS v4, Material Symbols |
| State (client) | Zustand (`src/store/`), TTL-cached stores |
| Editor / charts / flow | Monaco, Recharts, @xyflow/react, @dnd-kit |
| Auth | bcrypt + JWT dashboard sessions (`src/lib/auth/`), optional OIDC PKCE |
| HTTP | undici, http-proxy-middleware, express (custom server), socks-proxy-agent |
| Database | SQLite via multi-driver adapter (`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js` WASM fallback) |
| Crypto/certs | node-forge, selfsigned, jose (JWT), bcryptjs |

`better-sqlite3` is an `optionalDependency` so install does not fail on hosts
without build toolchains; `sql.js` (WASM) is the runtime fallback (per the
comment in `package.json`).

## 3. Product Development Requirements (PDR)

### 3.1 Goals

1. **One endpoint, any provider.** A client using the OpenAI (or Claude/Gemini)
   API shape must work against 9Router with zero code changes beyond base URL
   and an API key.
2. **Streaming by default.** Chat responses stream as SSE; non-streaming is
   supported but streaming is the primary path.
3. **Local & private.** No data leaves the host except outbound to the chosen
   provider. All config/usage/credentials stored locally in SQLite.
4. **Operationally resilient.** Rate limits, auth failures, and transient errors
   trigger automatic account fallback and retry without manual intervention.
5. **Manageable without a browser.** The CLI can launch the server, manage
   providers/keys/combos, and run headless (system tray).

### 3.2 Non-goals

- 9Router is **not** an LLM itself and does not train or host models.
- It is **not** a multi-tenant SaaS; the dashboard has a single administrative
  user (password / OIDC). API keys gate endpoint access, not user identity.

### 3.3 Functional requirements

| ID | Requirement | Implementation reference |
|---|---|---|
| FR-1 | Expose OpenAI-compatible `/v1/chat/completions` with SSE | `src/app/api/v1/chat/completions/route.js` → `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` |
| FR-2 | Support Claude `/v1/messages`, Gemini, and Responses API formats | `src/app/api/v1/{messages,responses}/`, `open-sse/translator/` |
| FR-3 | Provider connections (API key or OAuth), multi-account per provider | `src/lib/db/repos/`, `src/lib/oauth/`, `providerConnections` table |
| FR-4 | Account fallback on 429/401/5xx with backoff | `open-sse/services/accountFallback.js`, `src/sse/services/auth.js` |
| FR-5 | Combos (failover + fusion) across models | `open-sse/services/combo.js`, `combos` table |
| FR-6 | Usage logging + analytics | `usageHistory`, `usageDaily`, `requestDetails` tables; `/api/usage/` |
| FR-7 | MITM rerouting for AI IDEs | `src/mitm/` |
| FR-8 | Tunnel exposure (Cloudflare/Tailscale) | `src/lib/tunnel/` |
| FR-9 | Dashboard auth (password / OIDC) with rate-limited login | `src/lib/auth/`, `/api/auth/` |
| FR-10 | CLI launch + terminal UI + tray | `cli/` |
| FR-11 | Web-based/session-based providers (cookie auth, not API key) | `open-sse/executors/gemini-web.js`, `grok-web.js`, `perplexity-web.js`; Gemini-Web cluster (`open-sse/services/geminiWeb*.js`) |
| | FR-12 | SSRF guard for outbound requests | `src/shared/utils/ssrfGuard.js` — blocks requests to private/internal/metadata IP ranges |
| FR-13 | DS2API sidecar management (start/stop/status of local DeepSeek-to-API proxy) | `src/lib/ds2api/{detect,process}.js`, `/api/ds2api/*`, `ds2apiEnabled`/`ds2apiUrl` settings |

### 3.4 Non-functional requirements

- **Portability:** runs on Node 22 (Docker `node:22-alpine`) and Bun; Windows,
  macOS, Linux. DB driver is selected at runtime to avoid native-build failures.
- **Security:** login rate-limiting (`loginLimiter.js`), bcrypt password hashing,
  JWT sessions, real-IP injection + spoofable-header stripping in
  `custom-server.js`, optional API-key requirement on the endpoint, SSRF guard
  for outbound fetches (`ssrfGuard.js`).
- **Observability:** in-memory console log buffer (`consoleLogBuffer.js`),
  optional request logging (`ENABLE_REQUEST_LOGS`), request-detail capture.
- **Configurability:** behavior tunable via env vars (`.env.example`) and the
  single-row `settings` table.

### 3.5 Acceptance criteria (initial docs baseline)

- The four `docs/*.md` files accurately describe the code as it exists today.
- Every architectural claim is traceable to a file path in the repo.
- No claim is copied verbatim from fork-inherited prose without code verification.

## 4. Repository identity

- **Repo/checkout:** `9router-mod` (a modified fork; treat inherited prose as
  unverified).
- **Entrypoints:**
  - Web: `next dev` (port 20127) / `next start`; Docker `node custom-server.js`
    (port 20128).
  - CLI: `cli/cli.js` (published as `9router`).
- **Data dir:** `~/.9router/` (Linux/macOS) or `%APPDATA%/9router/` (Windows),
  overridable via `DATA_DIR`. SQLite at `<DATA_DIR>/db/data.sqlite`.

See `docs/system-architecture.md` for how a request flows end-to-end,
`docs/codebase-summary.md` for the directory map, and `docs/code-standards.md`
for conventions.
