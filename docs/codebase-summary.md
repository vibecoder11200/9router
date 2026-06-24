# Codebase Summary

> A code-grounded map of the repository. LOC figures are approximate counts of
> source files (`.js/.jsx/.ts/.tsx/.py/.sh/.css` etc.), excluding
> `node_modules`, `.git`, `.next`, `dist`.

## Top-level layout

```
9router/
├── src/              # Next.js application (UI + API routes + local backend)
├── open-sse/         # Provider-agnostic request engine (translation, execution, streaming)
├── cli/              # `9router` npm CLI (launch, terminal UI, tray)
├── tests/            # Vitest suite (translator snapshots, unit, fixtures)
├── scripts/          # Build/migration helper scripts
├── public/           # Static assets
├── gitbook/          # Separate Next.js docs-site subapp (excluded from main build)
├── docs/             # This documentation (source of truth)
├── *.py / *.sh / *.js (root)  # Maintenance & ops helper scripts
├── custom-server.js  # Next.js custom HTTP server (real-IP injection, header stripping)
├── https-server.js   # Local HTTPS front (self-signed certs) → internal Next server
├── Dockerfile, DOCKER.md, start.sh, captain-definition
├── next.config.mjs   # Standalone build, /v1 rewrites, body-size & tracing config
└── package.json      # 9router-app (private)
```

## Approximate LOC by area

| Area | Files | LOC (approx) | Role |
|---|---|---|---|
| `src/app` | ~230 | ~39,400 | Next.js App Router: pages + API routes |
| `src/lib` | ~84 | ~11,500 | Local backend: DB, auth, tunnel, network, MITM certs |
| `src/shared` | ~78 | ~9,700 | Reusable UI components, hooks, constants, bootstrap |
| `src/mitm` | ~17 | ~3,200 | HTTPS interception proxy for AI IDEs |
| `src/sse` | ~11 | ~2,000 | SSE request handlers bridging API routes → `open-sse` |
| `src/store` | 7 | ~250 | Zustand client stores |
| `src/i18n` | 3 | ~335 | Runtime DOM i18n (31 locales) |
| `open-sse` | ~327 | ~39,700 | Engine: executors, translators, handlers, services |
| `cli` | ~23 | ~6,000 | `9router` CLI |
| `tests` | ~115 | ~15,500 | Vitest tests + fixtures + baseline |

## `src/` — the application

### `src/app/` (Next.js App Router)

- **`(dashboard)/dashboard/*`** — authenticated UI pages: `providers`, `combos`,
  `endpoint`, `usage`, `cli-tools`, `proxy-pools`, `mitm`, `translator`,
  `media-providers`, `quota`, `profile`, `console-log`, `basic-chat`, `skills`.
- **`api/`** — route handlers. Key groups: `api/v1/` (OpenAI-compatible:
  `chat/completions`, `messages`, `responses`, `embeddings`, `images`,
  `audio/{speech,transcriptions}`, `models`, `search`, `web`), `api/auth/`
  (login, logout, status, OIDC, reset-password), `api/providers/`,
  `api/combos/`, `api/keys/`, `api/usage/`, `api/settings/`, `api/oauth/`,
  `api/mcp/`, `api/proxy-pools/`, `api/translator/`, `api/tunnel/`.
- **`layout.js` / `page.js`** — root layout (ThemeProvider, i18n, GA, console
  capture) and root redirect to `/dashboard`.
- **`globals.css`** — Tailwind v4 theme, brand palette, dark mode.

### `src/lib/` — local backend

- **`db/`** — multi-driver SQLite: `driver.js` (bun → better-sqlite3 →
  node:sqlite → sql.js), `schema.js` (declarative tables + WAL PRAGMAs),
  `migrate.js`, `paths.js`, `repos/` (repository per entity).
- **`auth/`** — `dashboardSession.js` (JWT + bcrypt), `oidc.js` (PKCE),
  `loginLimiter.js` (rate limiting).
- **`ds2api/`** — `process.js` (DS2API sidecar lifecycle management), `detect.js`.
- **`headroom/`** — `process.js` (Headroom proxy lifecycle management), `detect.js`.
- **`tunnel/`** — `cloudflare/manager.js`, `tailscale/manager.js`.
- **`network/`** — `connectionProxy.js`, `proxyTest.js`, `providers.js`.
- **`oauth/providers.js`** — centralized OAuth handlers.
- **`mitm/cert/`** — root-CA generation + system trust-store install.
- Notable: `dataDir.js`, `appUpdater.js`, `consoleLogBuffer.js`,
  `providerNormalization.js`, `mitmAliasCache.js`.

### `src/shared/` — UI + shared logic

- **`components/`** — `Header`, `Sidebar`, `OAuthModal`, `ModelSelectModal`,
  `EditConnectionModal`, `UsageStats`, `PricingModal`, and ~40 more.
- **`services/`** — `bootstrap.js`, `initializeApp.js` (post-auth setup).
- **`hooks/`** — `useTheme.js`, etc.
- **`constants/`** — `providers.js`, `models.js`, `config.js`.
- **`utils/`** — `api.js` (typed API client functions), `ssrfGuard.js` (SSRF protection).

### `src/mitm/` — interception proxy

- `server.js` (HTTPS + SNI + HTTP/2), `manager.js` (process lifecycle, DNS),
  `config.js` (target domains, model patterns).
- `handlers/` — `base.js`, `kiro.js` (AWS EventStream), `copilot.js`,
  `antigravity.js`, `cursor.js` (binary protocol).
- `cert/` — generate + install; `dns/dnsConfig.js` — `/etc/hosts` manipulation.

### `src/sse/` — SSE gateway layer

Thin layer that turns HTTP requests into streamed responses by delegating to
`open-sse`:

- `handlers/` — `chat.js` (→ `handleChatCore`), `embeddings.js`,
  `imageGeneration.js`, `search.js`, `stt.js`, `tts.js`, `fetch.js`.
- `services/` — `auth.js` (credential selection + fallback), `model.js`
  (alias/combo/single resolution), `tokenRefresh.js` (OAuth refresh).

### `src/store/` — Zustand stores

`providerStore`, `settingsStore`, `themeStore`, `notificationStore`,
`headerSearchStore`, `userStore` (client-side, TTL-cached where relevant).

### `src/i18n/`

Runtime DOM translation: `config.js` (31 locales), `runtime.js`
(MutationObserver-driven), `RuntimeI18nProvider.js`.

## `open-sse/` — the engine

Provider-agnostic core that turns one OpenAI-style request into a call to any
provider and streams the response back in the client's format.

| Subdir | Role |
|---|---|
| `config/` | Constants, providers registry, model registry, runtime timeouts/retry, error/backoff config |
| `executors/` | Per-provider HTTP clients (`base.js`, `default.js`, + specialized: azure, vertex, codex, cursor, kiro, gemini-web, gemini-cli, github, antigravity, qoder, qwen, grok-web, perplexity-web, codebuddy-cn, mimo-free, cloudflare-ai, commandcode, …) |
| `handlers/` | Modality orchestrators: `chatCore.js` (+ `chatCore/` streaming/non-streaming/SSE→JSON), `responsesHandler.js`, `embeddingsCore.js`, `imageGenerationCore.js`, `ttsCore.js`, `sttCore.js`, `search/` |
| `translator/` | Format conversion: `formats/` (openai, claude, gemini, responsesApi), `request/`, `response/`, `schema/`, `concerns/` (modality stripping, finish-reason) |
| `services/` | `model.js`, `provider.js`, `accountFallback.js`, `combo.js`, `oauthCredentialManager.js`, `tokenRefresh.js`, `usage/` (per-provider usage parsers), Gemini-Web session/cookie/RPC/keepalive/fingerprint cluster (8 files), `projectId.js` (Vertex) |
| `rtk/` | "Response Token Kernel" — compresses verbose tool_result content (git diff/status, logs, grep, find, ls) to cut token usage; `filters/` (11 files), `autodetect.js`, `headroom.js` (external proxy), `caveman.js` (−65% output tokens), `ponytail.js` (lazy senior dev, Lite/Full/Ultra) |
| `transformer/` | `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js` |
| `utils/` | `stream.js`, `streamHandler.js`, `sse.js`, `proxyFetch.js`, `bypassHandler.js`, `clientDetector.js`, `claudeCloaking.js`, `claudeHeaderCache.js`, `cursorChecksum.js`/`cursorProtobuf.js`, `usageTracking.js`, `error.js`, `requestLogger.js` |
| `providers/`, `shared/` | Provider registry builder (`registry/` — 96 files, `models/`, `pricing.js`, `capabilities.js`, `schema.js`) |

Entry: `open-sse/index.js` (re-exports config, translators, services, handlers,
stream utils). Imported for side effects (HTTP proxy env wiring) at the top of
`src/sse/handlers/chat.js`.

### Gemini-Web cluster

A dedicated subsystem for session/cookie-based access to Gemini via the web interface (not API):

- `open-sse/executors/gemini-web.js` — executor using Gemini Web RPC protocol
- `open-sse/services/geminiWebSession.js` — session management (login, token refresh)
- `open-sse/services/geminiWebCookiePool.js` — multi-account cookie rotation pool
- `open-sse/services/geminiWebCookie.js` — individual cookie lifecycle
- `open-sse/services/geminiWebKeepAlive.js` — keepalive to prevent session expiry
- `open-sse/services/geminiWebFingerprint.js` — browser fingerprint simulation
- `open-sse/services/geminiWebRpc.js` — RPC protocol (batchexecute, streamgenerate)
- `open-sse/services/geminiWebModels.js` — model listing from web session
- `open-sse/services/geminiWebUsage.js` — usage tracking for web sessions
- `tests/fixtures/gemini-web/` — 15 fixture files for Gemini-Web testing
- `add-gemini-web.sh`, `update-gemini-cookies.sh`, `gemini-health-check-runner.js` — ops scripts

### Web-based executors

Three executors that use session cookies (not API keys) to access web versions:
- **`grok-web`** (`open-sse/executors/grok-web.js`) — xAI Grok via web interface
- **`perplexity-web`** (`open-sse/executors/perplexity-web.js`) — Perplexity via web interface
- **`gemini-web`** (`open-sse/executors/gemini-web.js`) — Google Gemini via RPC protocol

### Provider registry

The provider registry in `open-sse/providers/registry/` contains **97 individual provider definition files**, each exporting metadata, model lists, and capabilities. The `registry/index.js` auto-generates the import list. Combined with `config/providers.js` and `config/providerModels.js`, this powers model resolution, pricing calculation, and capability detection.

### RTK (Response Token Kernel)

Token-reduction layer that compresses verbose `tool_result` content before it reaches the LLM — 16 files total:

- `open-sse/rtk/index.js` — entry point, orchestrates compression pipeline
- `open-sse/rtk/autodetect.js` — auto-detects tool output type from first 1KB
- `open-sse/rtk/filters/` — **11 filter files**: `gitDiff.js`, `gitStatus.js`, `grep.js`, `find.js`, `ls.js`, `tree.js`, `dedupLog.js`, `smartTruncate.js`, `readNumbered.js`, `searchList.js`, `buildOutput.js`
- `open-sse/rtk/headroom.js` — external Headroom proxy compressor integration
- `open-sse/rtk/caveman.js` + `cavemanPrompts.js` — "caveman speak" system-prompt injector (3 levels, −65% output tokens)
- `open-sse/rtk/ponytail.js` + `ponytailPrompt.js` + `systemInject.js` — "lazy senior dev" system-prompt injector (Lite/Full/Ultra)

## `cli/` — the `9router` CLI

- `cli/cli.js` — entry: flags `-p/--port` (default 20128), `-H/--host`,
  `-n/--no-browser`, `-l/--log`, `-t/--tray`, `--skip-update`.
- `src/cli/terminalUI.js` + `menus/` (providers, apiKeys, combos, settings,
  cliTools) and `api/client.js` (HTTP to the running server).
- `src/cli/tray/` — system tray (systray2 on mac/linux, PowerShell NotifyIcon
  on Windows).
- `hooks/` — `postinstall.js` (runtime warm-up), `sqliteRuntime.js`,
  `trayRuntime.js`.
- `scripts/build-cli.js` — packs the CLI (`npm run cli:pack`).

The CLI includes quick-setup wizards for Claude Code, Codex CLI, Factory Droid, Open Claw, OpenCode, Hermes Agent, and other AI coding tools (`cli/src/cli/menus/cliTools.js`).

## `tests/`

Vitest. Layout:

- `tests/translator/` — **15 golden + regression test files** for translation (incl. `real/` and `__snapshots__/`)
- `tests/unit/` — **89 unit test files** covering executors, capabilities, DB, routing, gemini-web, image, embeddings, mitm/antigravity, combo, fusion, translator concerns
- `tests/__baseline__/` — **11 baseline verification scripts** (verify-providers, verify-alias, verify-no-regression, snapshot-providers, verify-oauth-urls) and 6 JSON baseline files (providers, aliases, OAuth URLs)
- `tests/fixtures/` — mock provider payloads (15 Gemini-Web fixtures, provider response dumps)

A data-driven translator coverage matrix maps which format pairs are tested and which remain implicit (via OpenAI bridge). Run from the `tests/` directory; the root `package.json` has no `test` script.

## Root helper scripts

Maintenance/ops tooling (not runtime):

- `custom-server.js`, `https-server.js`, `start.sh` — server launch / Docker.
- `fix_provider_models.py`, `uncomment.py`, `fix-theme.py` — one-off code fixes.
- `add-gemini-web.sh`, `update-gemini-cookies.sh`,
  `gemini-health-check-runner.js` — Gemini-Web account ops.
- `check-db.js`, `test-db.js` — SQLite inspection.
- `scripts/` — `gemini-web-health-check.js`, `injectDisplayToRegistry.mjs`,
  `migrate-registry.mjs`, `test-combo-autoswitch.mjs`, `translate-readme.js`.

## `gitbook/`

A **separate** Next.js docs-site subapp, excluded from the main build via
`outputFileTracingExcludes` and the webpack watcher (`next.config.mjs`). Built
and deployed by `.github/workflows/gitbook-pages.yml`. Not part of the runtime
application.
