# Code Standards & Conventions

> Conventions as they actually exist in this codebase (observed in source), not
> aspirational rules. Follow the surrounding code when editing.

## Language & module system

- **JavaScript (ESM)** throughout. `"type"` is ESM; files use `import`/`export`.
- No TypeScript in the app or `open-sse`; types are expressed via JSDoc where
  helpful. `cli/` is also plain JS.
- Path alias `@/...` → repo root (`jsconfig.json`), e.g.
  `import { getSettings } from "@/lib/localDb"`. The `open-sse` package is
  imported by bare specifier (`open-sse/...`) resolved via the workspace.
- Next.js 16 App Router: route files export named HTTP methods
  (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`) and set `export const dynamic =
  "force-dynamic"` where they must not be statically rendered.

## File & directory conventions

- `kebab-case` for files is common but not universal; match the nearest
  neighbors. New self-contained modules use `kebab-case` or `camelCase.js`.
- API routes live under `src/app/api/<group>/[...]/route.js`.
- Server/client boundary: pages are server components by default; interactive
  pages are split into a `*Client.js` client component (e.g.
  `EndpointPageClient.js`) with the `"use client"` directive.
- Reusable UI goes in `src/shared/components/`; feature-local components sit in
  that feature's `components/` folder.

## Next.js API route patterns

- **CORS-first**: most routes define an explicit `OPTIONS` handler returning
  `Access-Control-Allow-Origin: *` (the endpoint is meant to be called by
  arbitrary LLM clients).
- **Delegation, not logic**: heavy work is delegated out of the route. Chat
  routes call `src/sse/handlers/*`; those in turn call `open-sse`. Routes stay
  thin (parse → authorize → delegate → return `Response`).
- **Error shape**: routes return `errorResponse(status, message)` /
  `unavailableResponse(...)` from `open-sse/utils/error.js` for the
  `/api/v1/*` family, and plain `NextResponse.json(..., { status })` elsewhere.
- **Auth**: dashboard routes trust the JWT session cookie; `/api/v1/*` honors
  `settings.requireApiKey` and validates the bearer key via
  `isValidApiKey()`.

## State management

- **Zustand** for client state (`src/store/`). Stores that mirror server data
  use a TTL cache (e.g. `providerStore`, `CLIENT_STORE_TTL_MS`) to avoid
  refetch storms.
- No SWR/React Query. Components call `fetch('/api/...')` directly or via
  `src/shared/utils/api.js`.

## Database access

- All persistence goes through `src/lib/db/` (the `@/lib/localDb` barrel).
  Never talk to SQLite drivers directly from feature code.
- **Repository pattern**: one repo per entity in `src/lib/db/repos/`.
- **Schema is declarative** in `src/lib/db/schema.js` (`TABLES` object). Add
  columns by editing `TABLES` (the sync step adds them); for destructive
  changes (drop/rename/type-change) write a versioned migration under
  `src/lib/db/migrations/` and bump `SCHEMA_VERSION`.
- Connection PRAGMAs are fixed in `PRAGMA_SQL` (WAL, `synchronous=NORMAL`,
  `mmap_size`, `busy_timeout=5000`, `foreign_keys=ON`).

## The `open-sse` engine — extension points

- **Add a provider**: drop an executor in `open-sse/executors/`, register it in
  `executors/index.js`, and ensure the provider + its models are in the
  registry (`providers/registry/`, `config/providers.js`,
  `config/providerModels.js`).
- **Add a format translator**: implement under `open-sse/translator/formats/`
  (and `request/`/`response/`); direct routes are preferred, otherwise the
  system pivots through the OpenAI format.
- **Configuration is data-driven**: timeouts, retry/backoff, and error mapping
  live in `config/runtimeConfig.js` and `config/errorConfig.js` — do not
  hardcode these values in handlers/executors.
- **Streaming utilities** (`utils/stream.js`, `streamHandler.js`) are the
  canonical way to build SSE transform pipelines (tool-name mapping, usage
  tracking, disconnect/stall detection).
- **Pre-translate hooks** (`rtk/`) run in order before format translation: RTK
  compression (tool_result), Headroom proxy compress, Caveman inject, Ponytail
  inject. All are fail-open — errors return null, body untouched.
- **Web-based/session-based executors** (`grok-web`, `perplexity-web`,
  `gemini-web`) use cookies not API keys. Each implements its own session
  management; there is no shared base class for cookie-based auth.
- **Responses API transformer** (`transformer/responsesTransformer.js`,
  `streamToJsonConverter.js`) converts Chat Completions SSE to Responses API
  format for clients that expect the Responses API shape.

## Security conventions

- Real client IP comes from the TCP socket, injected in `custom-server.js`
  (`x-9r-real-ip`); `x-forwarded-for`/`x-real-ip` are stripped to prevent
  spoofing. Rate limiting must use the socket IP.
- Passwords hashed with bcrypt; never return password/OIDC-secret fields from
  `/api/settings` (filtered server-side).
- Secrets are read from env (`.env.example` is the canonical list) or stored
  encrypted-at-rest only insofar as SQLite file permissions allow — never
  commit `.env`, tokens, or the `~/.9router` data dir.
- **SSRF guard** (`src/shared/utils/ssrfGuard.js`) validates outbound fetch
  targets and blocks requests to private/internal/metadata IP ranges. All
  provider executor calls pass through this guard.

## Testing conventions

- **Vitest**, run from `tests/`. No root `npm test`.
- Translation changes should add or update golden snapshots in
  `tests/translator/` (incl. `__snapshots__/`).
- Provider/alias/OAuth regressions are guarded by `tests/__baseline__/`
  verification scripts.
- Run focused tests first; broaden only when shared behavior (translators,
  executors, DB) changes.

## Build, lint, commit

- **Lint**: `eslint` flat config (`eslint.config.mjs`) extending
  `eslint-config-next`. CI (`.github/workflows/ci.yml`) runs lint, type-check
  (where applicable), build, and `npm audit`.
- **Build**: `next build --webpack` → standalone output (`output: "standalone"`).
  The `gitbook/` subapp and `logs`/`.next`/`cli` dirs are excluded from the
  watcher and trace.
- **Commits**: conventional-commit format (`feat:`, `fix:`, `docs:`, …) with
  no AI references, scoped where helpful (e.g. `fix(providers): ...`).
- Keep changes small and scoped; prefer extending existing patterns over new
  abstractions.
