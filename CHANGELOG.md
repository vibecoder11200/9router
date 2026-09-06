# v0.6.47 (2026-09-06)

Every dashboard page now speaks the same visual language: shared page
headers, real design tokens, and centered layouts.

## Features
- **Shared page headers for V2Ray Proxy (/dashboard/xray), Alerts
  (/dashboard/alerts), and PXPIPE (/dashboard/pxpipe)**: the three pages
  render the standard icon + title + description header bar (same as
  Proxy Pools) instead of hand-rolled headings or an empty top bar.

## Fixes
- **PricingModal no longer renders with a transparent panel**: the modal
  panel and its number inputs used `bg-bg-base`, a token that never
  existed in the design system, so they drew with no background at all.
  Now painted with `bg-surface`.
- **Dead design tokens purged dashboard-wide**: `bg-bg-subtle`,
  `bg-bg-hover`, `bg-bg-base`, `text-muted-foreground`, and bare
  `text-text` never resolved to any CSS, silently degrading segmented
  controls, table headers, sort hovers, and toggle states in Usage
  (table / chart / topology), PricingModal, RequestLogger, UsageStats,
  and the CLI-tools guide card. All replaced with real tokens
  (`bg-surface-2`, `text-text-main`, `text-text-muted`); active segment
  buttons now use `text-primary-foreground` on the brand orange.
- **Dead Card padding overrides**: `Card className="p-4/p-6"` could never
  beat the built-in default `p-6` because the `cn()` helper concatenates
  classes instead of merging them — the override was a silent no-op.
  settings/pricing now uses the `padding` prop.
- **Layout alignment**: xray / alerts / pxpipe / token-saver use the
  standard centered `max-w-*` container without double page padding; the
  xray status badge moved into the Proxy Status card; alerts' inline
  success/error text is replaced by toast notifications.

# v0.6.46 (2026-09-06)

Backups can now be encrypted end-to-end with a passphrase.

## Features
- **Encrypted backups (opt-in)**: exporting can seal the ENTIRE backup —
  provider tokens, settings, API-key hashes, install secrets — everything
  except session login tokens, which are redacted in all exports by
  design — into one scrypt (N=2^16) + AES-256-GCM archive
  (`9router-encrypted-archive`). Two passphrase modes: your own (min 10
  chars) or a generated 100-bit Crockford-Base32 passphrase shown ONCE
  (copy/download + mandatory retype). I and L are treated as 1, O as 0;
  spaces and hyphens are ignored. If the passphrase is lost the backup
  cannot be recovered and nothing is stored server-side. Intended for
  archives up to ~100MB (one-shot encryption; no chunking).
- **Cross-install key-CRC adoption**: password exports now also embed the
  key-CRC secret (wrapped, alongside the v0.6.45 key-hash secret) and
  imports adopt both — pasted keys from the exporting install pass
  key-format CRC validation again. When the API_KEY_SECRET env override
  is active the file secret is neither exported nor adopted (env wins; a
  warning says so).
- **commandcode payment-required rotation**: provider-scoped error rules;
  commandcode billing-402 errors rotate to the next account while
  GitHub's bare "Payment required" 402 still fails fast (C4 preserved).
- CLI: encrypted export/import with masked passphrase prompts and
  show-once generated passphrase; dashboard: encrypt step in the export
  flow and passphrase prompt on import.

# v0.6.45 (2026-09-06)

API keys become portable in backups. Exporting with the dashboard
password embeds the key-hashing secret inside the backup, encrypted with
that password (scrypt N=2^16 + AES-256-GCM); importing with the same
password adopts the secret so every restored key validates immediately.

## Features
- **Backups can now carry working API keys across installs**: exporting
  with the dashboard password embeds the key-hashing secret inside the
  backup, encrypted with that password (scrypt N=2^16 + AES-256-GCM).
  Importing with the same password adopts the secret, so every restored
  key validates immediately. Sealing only happens when the password
  matches a stored dashboard password — exports made before one is set,
  or via CLI token without one, omit the secret. The rest of the backup
  file — including provider access tokens — remains unencrypted
  (full-archive encryption is planned for v0.6.46).
- **Re-key fallback**: importing with a wrong/missing password still
  imports everything; affected keys are flagged "needs re-key" and can
  be fixed by pasting their raw key once (Endpoint page or CLI). The
  re-key action is offered only for flagged keys and rate-limits wrong
  pastes (5 fails per key → 15-minute lockout).
- **Stronger key IDs**: new keys use a 12-char crypto-random id
  (~62 bits, was 6 chars via a non-crypto PRNG); existing keys
  unaffected.
- **CLI: Backup & Restore menu** — export to a JSON file in the current
  directory, import from a path, both password-gated with masked
  password prompts; the re-key action in the API Keys menu also masks
  the pasted key.

## Fixes
- **Importing an empty/foreign JSON no longer wipes the database**: a
  wrong file pick (an empty object, an unrelated JSON) used to delete
  every table and silently reset auth to the fallback password; the
  import now rejects payloads that don't look like a 9Router backup
  before touching anything.
- **The backup routes are now rate-limited** like the login route
  (a successful password guess used to return the whole database in
  one unthrottled request), and overlapping imports are serialized.


Regression-sweep release: a full audit of every change since v0.6.35
(v0.6.36 hardening A → v0.6.41) traced each behavior change back through
its consumers and fixed the 20+ regressions found — including several
latent breaks the test suite could not see. Verified by a full-suite
failing-set diff against a clean v0.6.43 checkout (zero new failures;
three usage-dashboard tests broken since v0.6.36 pass again).

## Fixes
- **Database export was completely broken (since v0.6.36)**:
  `exportDb` threw `ReferenceError` on any database holding at least one
  API key — the S7 hash helpers were re-exported but never imported into
  module scope. The round-trip test never created a key, so CI stayed
  green. Exports also now carry per-key budget config and an install id.
- **Importing a backup on another machine warns instead of silently
  killing every API key**: `keyHash` is HMAC'd with the exporting
  install's secret, so restored keys can never validate elsewhere; the
  import result now explains that loudly (and `[REDACTED]` session-token
  markers are never persisted as fake credentials).
- **Usage dashboard "API Key Name" column (since v0.6.36)**: attribution
  joined raw keys against the masked display column — a match that can
  never succeed. Now hash-joins; works for every migration state.
- **Masked display keys no longer fed into credentials anywhere**: MITM
  start (auto + manual), all 14 CLI-tool dashboard cards, ApiKeySelect,
  and the CLI quick-setups refused or wrote dead tokens; all now ask for
  the RAW key (shown once at creation) or run keyless in local mode.
- **Account failover restored for provider auth/billing errors**: the C4
  NO_FALLBACK list had silently ended account rotation for
  expired-cookie / out-of-credit errors (gemini-web, grok, genspark,
  perplexity, qoder, commandcode, grok-cli, openrouter, anthropic) —
  text evidence now rotates accounts again; bare deterministic 4xx
  still fails fast.
- **Proxy-pool outages no longer lock accounts or trip circuit
  breakers**: proxy-infra failures skip the account without a model-lock
  or breaker record; noauth pool exhaustion no longer fires a false
  "all accounts locked" alert; alert dedup lets higher severities
  through.
- **Per-key budget hard-block now covers all spending endpoints**
  (embeddings, fetch, stt, tts, images, search, video) — previously only
  chat enforced it.
- **Self-hosted provider nodes validate again**: the v0.6.36 SSRF
  hardening blocked localhost/LAN base URLs even for local callers;
  provably-local requests may now reach them (credential headers are
  stripped on cross-origin redirects instead of being replayed).
- **Upgrades no longer lock tunnel users out of their dashboard**: a
  one-time migration preserves pre-v0.6.36 implicit access for installs
  that predate the fail-closed default flip.
- **Windows xray/DS2API no longer orphaned by a failed PID check**: a
  slow/blocked PowerShell-CIM probe used to delete the PID file of a
  live process and brick restarts; unprovable PIDs are now treated
  conservatively.
- **Streams**: no more duplicate `[DONE]` frames for `data:[DONE]`
  (no-space) upstreams; client-cancel-early no longer loses lock-heal /
  breaker success; remote-image prefetch is cached so fallback attempts
  stop re-downloading images.
- **Proxy-pool delete UI** shows the real 409 reason (bound strategies)
  and offers unbind-and-delete.
- Plus: stale MITM sudo blobs self-clear with a warning instead of
  silently disabling auto-start, hex-form IPv4-mapped IPv6 loopback is
  recognized, and the CommandCode peek escape hatches are documented in
  `.env.example`.

# v0.6.43 (2026-09-06)

Hotfix on v0.6.42: with **Require API Key enabled** (the fresh-install
default), the dashboard model test returned "HTTP 401: Missing API key" on
every model — v0.6.42 correctly stopped sending the masked API key but left
internal callers with no way to authenticate (raw keys exist only as hashes).

## Fixes
- **Internal loopback auth for `requireApiKey` gates**: all LLM endpoint
  gates (chat, embeddings, images, stt, tts, video, search, fetch) now accept
  a server-internal caller that proves (a) the request originates from the
  host itself — `x-9r-real-ip` is stamped by the custom server from the TCP
  socket after stripping client-supplied values — and (b) it holds the
  per-install machine token (`x-9r-cli-token`, the same constant-time-checked
  credential the dashboard guard already trusts). The dashboard model test
  ping authenticates this way, so model tests work again with Require API
  Key on. Off-host callers are unaffected and still need a valid API key;
  keyless external requests remain 401 (verified end-to-end on a production
  build).

# v0.6.42 (2026-09-06)

Fix release: repairs the model-test crash on the providers page, un-breaks
managed-pool (v2go) rotation for models the Model Filter never ran with, and
ships the public docs site.

## Fixes
- **Model test crashed with "Cannot convert argument to a ByteString…"**:
  the `/api/models/test` ping put `apiKeys.key` into `Authorization: Bearer …`,
  but since v0.6.36 (S7, keys hashed at rest) that column stores the MASKED
  display string (`sk-{keyId}-••••{last4}`). The `•` (U+2022) is not a valid
  HTTP header character, so `fetch()` threw before any request left and EVERY
  model test failed with a red banner whenever an API key row existed.
  The header is now dropped entirely: with Require API Key off no auth is
  needed (local mode); with it on the endpoint's honest 401 is surfaced
  instead. Model tests now report real provider health (green check / the
  actual 429/5xx reason) again.
- **Managed-pool (v2go) rotation was a no-op for unfiltered models**: the
  rotation candidate lookup only read Model Filter cache rows for the exact
  request model — e.g. traffic for `oc/mimo-v2.5-free` while the filter cache
  only held the (discontinued) default filter model — so every 429 aborted
  with "no-healthy-candidate" and the pool stayed pinned on the rate-limited
  IP. Rotation now falls back to any recently-validated node across models;
  switchConfig still live-verifies SOCKS + a distinct exit IP, and the
  request loop re-rotates if the new node also fails for that model.
- **Xray Model Proxy Filter no longer pre-fills a discontinued model**: the
  hardcoded default `oc/deepseek-v4-flash-free` (dead upstream) is removed
  from the dashboard input and DEFAULT_SETTINGS; the field starts empty with
  a placeholder only. Existing saved values are preserved.

## Docs
- The docs site is live at https://vibecoder11200.github.io/9router/ —
  fixed the hydration crash + root redirect, rewrote `.md` links into real
  routes, and added three new feature pages (Alerts, API Keys & Budgets,
  Circuit Breaker) in all 5 languages. Header logo no longer reads
  "9 9Router Docs"; "Go to App" points at the docs home.

## Features
- Donate modal: per-channel QR fallback chain (primary QR → fallback
  provider → altText) with Ko-fi and PayPal channels.


# v0.6.41 (2026-09-05)

Hotfix: makes the v0.6.40 one-time setup code **actually retrievable** when
the server has no visible console.

## Fixes
- **CLI background/tray mode discarded the setup code**: the daemonized
  server was spawned with `stdio: "ignore"`, so the console banner printed on
  a remote first-run login (and every other server diagnostic) went nowhere —
  and `docker logs` / `journalctl` don't apply to this install mode. The CLI
  now tees the daemon's stdout/stderr to `<data-dir>/server.log` (simple 5 MB
  rotate) and prints the log location when it starts the background process.
- **The setup-code form now names the file**: `cat ~/.9router/setup-code`
  (Windows: `%APPDATA%\9router\setup-code`; Docker:
  `docker exec <container> cat /app/data/setup-code`) instead of the vague
  "check the server console".

# v0.6.40 (2026-09-05)

Security/UX release: fixes the **fresh-install remote login dead-end** and
hardens the new self-service flow against brute-force and stale-secret
takeover.

## Fixes
- **Remote first-run login is no longer a dead-end**: since the CVE-2026-56679
  hardening, logging in remotely with the default password `123456` returned
  403 "must be changed before remote access" — and the promised "set a new
  password" form never appeared (the login page only read `mustChangePassword`
  from 2xx responses, and the settings PATCH it called requires the
  deliberately-withheld JWT). Docker/VPS users could not complete first-run
  setup at all. The login page now honors the 403 body and shows the setup
  flow. **Upgrade recommended for anyone blocked at the first remote login of
  a fresh install.**

## Features
- **One-time setup code (remote self-service)**: on a fresh install, a remote
  default-password login prints a single-use setup code to the server console
  (`docker logs`, `journalctl -u 9router`, or the terminal running 9Router).
  Enter it on the login page together with the default password and your new
  password. The code lives only on the host (`DATA_DIR/setup-code`, mode
  0600, timing-safe compare, consumed on use), so host ownership is still
  required — the no-credential-before-rotation invariant from the CVE fix is
  preserved (no session/JWT is issued until the default password is rotated).
  Local logins from the host itself and `INITIAL_PASSWORD` installs behave
  exactly as before.
- **`POST /api/auth/setup-password`**: fresh-install-only (404 otherwise,
  never leaks install state), rate-limited via the shared login limiter,
  requires the default password + setup code, rejects an empty or default
  new password without consuming the code, and never starts a session (the
  client logs in with the new password afterwards).

## Security hardening (all found in code review, all fixed)
- A blocked default-password login no longer resets the login-lockout bucket —
  previously an attacker could alternate setup-code guesses with default
  password logins and never trigger lockout.
- The setup-code console banner prints at most once per minute, so internet
  scanners hammering an exposed fresh install cannot flood `docker logs` /
  journald (and the secret is not re-echoed per request).
- Pending setup codes are invalidated whenever the password is set through
  another path (dashboard settings, CLI reset-to-default), so a code leaked
  into pasted logs or issue comments cannot complete a takeover after a
  later reset to the default.

## Docs
- FAQ (EN/VI): new "Why can't I log in remotely with the default password?"
  entry describing the setup-code flow and where to find the code.

# v0.6.39 (2026-09-05)

Patch release fixing a **runtime bug shipped in v0.6.38** + CI hardening.

## Fixes
- **Chat auth crash when Require API Key is on (v0.6.38 only)**: `getApiKeyRow` was exported from the DB layer but never re-exported by the `localDb` facade that `auth.js` imports from. The webpack production build downgraded the missing named export to a warning and shipped `undefined` — any request with `requireApiKey` enabled failed with `getApiKeyRow is not a function`. Installs with Require API Key **off** were unaffected. **Upgrade strongly recommended for v0.6.38 Docker/CLI users with API-key enforcement enabled.**

## CI
- Strict Turbopack export check added to the build job — missing named exports now fail CI loudly instead of shipping as webpack warnings (this is what caught the bug).
- Windows process-lifecycle job now actually works end-to-end (npm arborist crash fixed via tracked tests lockfile + `npm ci`; boots the real `custom-server.js` entry after a production build instead of a nonexistent `server.js`).
- GitBook docs deploy is self-contained: publishes to this repo's `gh-pages` branch with the built-in token (the upstream docs repo was READ-only for this fork) — fixed a missing `useEffect` import that had broken every docs build since v0.6.35-era v0.4.77.
- CLI release workflow passes `--latest` explicitly, so parallel tag pushes can no longer mis-assign the GitHub "Latest" badge.

# v0.6.38 (2026-09-05)

Hardening release C: the **v2go health scheduler**, **per-API-key budgets**,
and **cache analytics** from `plans/260904-0344-hardening-alerts-breaker-budgets/`
(phases 07–09). Completes the 3-release hardening program (A: v0.6.36, B: v0.6.37).

## Features
- **v2go/xray health scheduler (phase 07)**: the `xrayHealthCheckIntervalMin` setting (default 10) now actually does something — a boot-armed scheduler probes the active node each interval and auto-rotates when it's down (0 = manual-only; clamped to ≥5 min). Rotation failures raise the `xray-rotation-failed` alert; probe failures keep the phase-05 `xray-node-down` alert. Scheduler state is introspectable; non-v2go installs skip for ~free.
- **Per-API-key budgets (phase 08)**: each key can set a USD or token budget over a daily or monthly (server-local) window. Soft threshold (default 80%) fires an edge-triggered `budget-threshold` alert once per window; optional hard block returns 429 with `Retry-After` (window end) and `X-9Router-Budget: limit-exceeded`. Spend is read fresh from usageHistory at enforcement (indexed; unbudgeted keys add zero queries). Editor lives on the Endpoint & Key page. **Notes:** budgets apply only when "Require API key" is enabled; USD budgets count only models with pricing configured (token budgets are exact); windows are server-local time.
- **Cache analytics (phase 09)**: the Usage page gains a Cache panel — cached tokens, estimated hit-rate, and "estimated saved vs uncached prompt cost" per provider/model, riding the existing stats payload (no new API). Unpriced models show n/a (never a misleading $0); rows without token data are excluded from ratios.

# v0.6.37 (2026-09-05)

Hardening release B: the **alert system** and the **per-account circuit
breaker** from `plans/260904-0344-hardening-alerts-breaker-budgets/`
(phases 05–06).

## Features
- **Alert system (phase 05)**: Telegram / Discord / generic-webhook alerting with per-channel send queues (pacing + 3-try backoff + 429 retry-after), a 10-minute dedup window, and per-event-type enable map. New dashboard page (Dashboard → Alerts) with credential masking (blank = keep stored) and a per-channel test button. Six wired events: all-accounts-locked, proxy-pool-exhausted, strictproxy-violation, xray-node-down, totu-fetch-failed, quota-near-limit. Alert sends are fire-and-forget and never block or break request paths; inert under test.
- **Per-account circuit breaker (phase 06)**: a connectionId-keyed breaker wraps account selection in the chat fallback loop — 5 account-level failures within 60s open the breaker for 60s (re-opens back off 60s×2, cap 10 min), after cooldown exactly one real request is admitted as a passive probe; success closes it, failure re-opens with a longer cooldown. Users are never sacrificed: a denied or failed probe simply falls through to the next account. Antigravity quota-429s already handled by the upstream strike-block are not double-counted. `breaker-open` / `breaker-recovered` alerts feed the phase-05 channels. Kill switch: `breakerEnabled=false` restores byte-identical behavior; thresholds tunable via `breakerFailureThreshold` / `breakerWindowSec` / `breakerBaseCooldownSec` settings.
- **Breaker dashboard panel**: the Quota Tracker page shows open/half-open breakers, recent failure counts, cooldown countdowns, antigravity strike-blocks, and a manual reset button (states piggyback on `GET /api/providers`; reset via `POST /api/providers/{id}/breaker`).

# v0.6.36 (2026-09-05)

Hardening release A of the 57-finding audit program: all **45 bug/hygiene
findings** (proxy pools, managed subsystems, core request path, security) plus
CI/fuzz quality infrastructure. Releases B (alerts + circuit breaker) and C
(v2go scheduler, per-key budgets, cache analytics) follow under
`plans/260904-0344-hardening-alerts-breaker-budgets/`.

## Security
- **DB export/import auth closed (S1/N12)**: `/api/settings/database` now validates the REAL per-install CLI token (constant-time) instead of trusting header presence; imports can no longer overwrite the dashboard password hash or sudo ciphertext (current values survive); exports are served `Cache-Control: no-store`.
- **Default password refused remotely (N11)**: the printed `123456` fallback only works from the host itself — stolen-session + crafted-import re-auth chains are dead.
- **API keys hashed at rest (S7)**: keys are stored as HMAC-SHA256 under a per-install secret (0600 file), never plaintext. Legacy keys keep working and migrate lazily on first use; listings/UI show only `sk-{keyId}-••••{last4}`; backups export hashes, never raw keys. **Migration note:** take a DB backup before upgrading; rollback = revert + restore snapshot.
- **Per-install secrets everywhere (S5/N10/S9)**: the MITM sudo-password AES key and the API-key CRC secret derive from random per-install secret files — the public `machineId + committed salt` derivation (and its universal fallback key) is gone. Old sudo ciphertext is intentionally undecryptable — re-enter the password once. `mitmSudoEncrypted` no longer appears in settings API responses.
- **Tunnel dashboard access is opt-in (S6)**: `tunnelDashboardAccess` defaults to **false** for installs that never saved the setting explicitly (saved values are preserved; the endpoint page offers the toggle and warns on cleartext `http://` external tunnels).
- **SSRF: last two call sites wired (S2)**: provider-node validation and the `/v1/fetch` direct-URL path now use `fetchPublic` (manual redirects, per-hop DNS revalidation) on top of the v0.5.65 guard.
- **Request-log masking restored (S3)**: authorization / x-api-key / cookie values are masked in every log sink, even with `ENABLE_REQUEST_LOGS=true`.
- **MITM dir 0700 + root CA key 0600 (S4)**, including a post-hoc chmod for existing installs (POSIX; Windows is ACL-based).
- **No hostnames pre-auth (S8)**: `/api/settings/require-login` returns booleans only.
- **cloudflared token off argv (S10)**: passed via `TUNNEL_TOKEN` env — no longer visible in `ps` on multi-user hosts.

## Fixes
- **Strict proxy pools fail closed (P1/P9/N3, N1)**: exhausted or errored strict pools return 503 with retry-after instead of silently direct-fetching; every caller shares one `isStrictProxyFailure` guard; the dead `_excludedProxyEntryIds` path is removed.
- **No more lost pool updates (P2/N2)**: proxy-pool entry writes (cooldowns, rotation cursors, usage stamps) are transactional read-modify-write deltas instead of stale whole-snapshot overwrites.
- **Pool ordering and entry hygiene (P4/P5/P6)**: stable createdAt ordering; entries without a usable URL are skipped; group cursors reset deterministically.
- **failStreak deactivation (P7/P8)**: three consecutive test failures deactivate an entry; group cooldowns applied per entry; deleting a bound pool now 409s with the bound providers listed (and `?force` unbinds).
- **Managed xray/v2go safety (X1-X7, N4)**: PID-reuse kill safety via cmdline verification, single-flight config switching, staged binary install with sha256 verification, empty-parse fail-closed subscription sync, port-ownership checks, bounded rotate attempts, reaper patterns that no longer match unrelated processes.
- **Graceful shutdown (X8/X9)**: 5s bounded shutdown with double-signal protection; TOTU auto-fetch interval validation (X10-X12, N5/N6).
- **CommandCode peek rewritten (C1/N8/N9/C8)**: post-sentinel lines in the same TCP read are replayed in order instead of dropped (silent prefix truncation on every provider that flushes sentinel + deltas together); pre-sentinel buffering capped at 1 MiB with passthrough degrade; wrapped SSE responses whitelist headers (no stale content-length/content-encoding); mid-body errors replay buffered bytes. Escape hatch: `9R_CC_PEEK_LEGACY=1`.
- **Per-attempt body isolation (C2)**: modality stripping works on a deep copy — combo-fusion members and fallback attempts always see the client's original blocks.
- **Deterministic client errors stop locking accounts (C4)**: bare 400/401/402/404/405/413/422 no longer lock every account for 30s (text evidence like "quota exceeded" still falls back — that one account really is out of credits).
- **Search unlocks on success (C5)**: a successful `/v1/search` clears the scoped `modelLock_websearch:*` immediately, and search-only failures no longer stamp account-wide `unavailable`.
- **Combo cycle protection (C6)**: combo create/update reject alias cycles (400); the chat path has a visited-set backstop for legacy rows.
- **PXPIPE respects the saver kill-switch (C3)**: `X-9Router-Token-Saver: off` now disables PXPIPE like every other saver.
- **Passthrough stream honesty (C7/C9)**: `[DONE]` finalizes usage the moment it is forwarded (a client closing right after it no longer loses usage logging) and never emits a duplicate frame.
- **Search body-read timeout (C10)**: stalled search upstreams abort at 15s during body read instead of hanging the request forever.
- **First-byte success signal (N7)**: account locks only heal when a byte actually reaches the client — an upstream that dies right after accept no longer marks the account healthy.

## CI
- **Windows process-lifecycle job**: boots the server, verifies clean shutdown leaves no orphaned `xray.exe` (soft-fail rollout — `continue-on-error` for the first two weeks).
- **Stream fuzz harness**: seeded 1000-iteration random chunk-split properties over the CommandCode peek and passthrough stream rewriters.

## Notes
- Test count **+113** this release (phases 01-04); failing-set diff vs the pre-release baseline is clean (0 pass→fail). Local environment caveat unchanged: the dev install lives under `tests/node_modules` only.
- **Rollback for S7** (keys hashed at rest): revert its commit and restore the DB snapshot taken before upgrade — plaintext is only cleared after the hash was verified working.

# v0.6.35 (2026-09-04)

Upstream-sync + self-hosting release: merges upstream **v0.5.65** into the
fork (v0.5.59 → v0.5.65, 97 commits) and self-hosts the donate modal's data.
Every fork subsystem is preserved — v2go/Xray managed pool + rotation, proxy
pools/groups, DS2API, web-cookie providers, TOTU auto-fetch, MITM, tunnel
access — and the opencode anti-fingerprint (official UA + `x-opencode-client:
cli`) now coexists with upstream's muse-spark Responses routing.

## Upstream highlights now in the fork
- **Security**: SSRF guard hardening (#3714) — alternate IPv6 encodings,
  trailing-dot hostnames, DNS resolution checks, safe redirect handling via
  the new `fetchPublic` wrapper (manual redirects, per-hop revalidation).
- **Antigravity**: strike-break optimistic quota readings — 3 strike-429s in
  60s blocks the connection+model pair for 15 minutes with live quota refresh.
- **Chat**: all-credentials-rate-limited now returns a real **503** instead of
  passing the last upstream status through.
- **Model markers**: the `[1m]` context marker Claude Code appends to model
  names (`claude-opus-5[1m]`) is stripped before model resolution.
- **Fetch**: new Ollama Cloud web fetch provider (`/v1/fetch`).
- **Models**: Gemini 3.8 Flash, Claude Fable 5.1 (adaptive thinking), Groq
  usage + rate-limit tracking, Codebuddy-CN catalog refresh, tokenrouter
  catalog streamlining, capability toggles (vision/reasoning) for custom
  models, single-model lookup route `/v1/models/<provider>/<model>`.
- **OpenCode**: muse-spark models route to `/zen/v1/responses` with vision
  declared (upstream's fix composes with the fork's registry-driven
  `isResponsesModel`, which remains authoritative).
- **Usage**: Responses-shape `cached_tokens` read for non-streaming traffic
  (cache hits no longer billed at full input rate on those paths).
- **CLI tools**: save and manage custom API-key presets per tool card.
- **i18n**: complete Indonesian translation (1391 keys; the fork's 69
  TOTU/MITM-specific keys re-merged on top).

## Features (fork)
- **Donate info is self-hosted**: the donate modal reads `public/donate.json`
  served from GitHub raw (CDN-friendly, no app-server dependency) with a
  bundled local fallback — no more third-party endpoint.

## Merge notes
- Tests: **2554 total, 0 pass→fail** vs the pre-merge baseline (103 new
  upstream tests; 105 pre-existing local failures byte-identical pre/post).
  Upstream shipped with 2 broken Kiro test files (28 tests fail on vanilla
  v0.5.65 — `systemPrompt` moved to the session-start content prefix without
  the tests following); both adapted on the fork side with no assertions
  weakened.
- Known behavior change (upstream, kept deliberately): the rate-limited
  response no longer passes `lastStatus`/`lastErrorCode` through — always 503.
- The v0.6.36+ hardening program (57-finding audit fix plan, alerts, circuit
  breaker, budgets) is committed under `plans/260904-0344-hardening-alerts-breaker-budgets/`.

# v0.6.34 (2026-09-04)

OpenCode Free reliability release: muse-spark-1.3 no longer 500s (the
executor now routes from the same registry the translator reads), and
zen model routing auto-syncs from opencode's api.json — the identical
per-model metadata the official CLI uses — so newly released
responses-only models route correctly with zero code changes, and dead
models are visible in the dashboard before they burn a request.

## Fixes
- **muse-spark-1.3-contributor-free failed with 500 on 9router while
  working in opencode CLI**: zen serves the muse-spark free models only
  from /zen/v1/responses, but the executor kept its own hardcoded
  RESPONSES_MODELS set (1.2 only) to pick the endpoint — it had drifted
  from the registry targetFormat, so 1.3 was POSTed to
  /chat/completions (verified live: muse → 500 there / 200 on
  /responses; mimo-v2.5-free is the exact inverse). isResponsesModel()
  now derives from the registry — the same source the translator uses —
  so body format and URL can never disagree again, and
  muse-spark-1.3-contributor-free is declared in the registry with its
  capabilities (1M ctx / 131k out / reasoning effort minimal..xhigh,
  per models.opencode.ai api.json).
- **thinking-suffixed ids ("model(level)") missed their registry
  targetFormat** on opencode: the lookup is exact-match, so
  `oc/muse-spark…(xhigh)` silently fell back to chat/completions and
  failed; the opencode path now retries with the suffix stripped.

## Features
- **zen model routing auto-syncs from models.opencode.ai/api.json**
  (new `providers/opencodeCatalog.js`): background fetch (first
  opencode request after boot + every 6h) of the same metadata the
  official CLI reads — per-model `provider.npm == "@ai-sdk/openai"` →
  /zen/v1/responses, `status:deprecated` flags. Registry declarations
  stay authoritative; undeclared models fall back to the catalog;
  fail-open: until the first sync completes (or if it errors), routing
  behaves exactly as before. Verified against the live catalog:
  gpt-5.4 / grok-4.5 / muse-spark-1.2 route to /responses with no
  registry entry; mimo stays on /chat/completions.
- **Deprecated models are visible instead of surprising**: requesting
  one logs `[OPENCODE] <model> is deprecated upstream (400/401
  expected) — remove it from combos`; the provider dashboard
  (/dashboard/providers/opencode) marks them with an amber DEPRECATED
  badge, warning icon, dimmed row and an explanatory tooltip (new
  `/api/models/opencode-status` endpoint); "Suggested free models" no
  longer offers deprecated ids (deepseek-v4-flash-free and friends —
  most of the free catalog is retired upstream; only 8 of 31 -free
  models still respond).

## Docs
- Reconciled fork docs with the v0.6.33 release + upstream v0.5.59
  merge.

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label
# v0.6.33 (2026-09-01)

Upstream-sync release: merges upstream v0.5.59 into the fork (72 commits,
v0.5.50 → v0.5.59; the v0.5.51–v0.5.55 cycle was already content-cherry-
picked, v0.5.56–v0.5.59 is net-new). Every fork subsystem is preserved —
v2go/Xray managed pool + rotation + Model Proxy Filter, proxy pools/groups,
DS2API, web-cookie providers, TOTU auto-fetch, MITM, tunnel access — and the
v0.6.32 opencode anti-fingerprint (full official UA + `x-opencode-client:
cli`) is kept on top of upstream's new Responses routing.

## Upstream highlights now in the fork
- **Search**: new `POST /v1/search` providers — Antigravity (Google Search
  grounding on the existing OAuth account pool), Xquik (X search with
  cursor pagination), plus ollama-search / zai-search which borrow a chat
  provider's API key via the new `credentialFallback` registry field.
- **Usage**: Zed plan quota on the dashboard; GLM `CREDIT_LIMIT` +
  multi-interval quota parsing; nested `cached_tokens` preserved in
  canonicalizeUsage; Claude quota calls deduped + cached (120s TTL).
- **Models**: `glm-5.3-flash` (GLM / GLM-CN / opencode-go), DeepSeek V4
  Flash Vision (Exp); model catalog auto-syncs from models.dev in the
  background with snake_case token limits on `/v1/models`.
- **opencode**: muse-spark routed through the Responses API (it 500s on
  chat/completions) with reasoning-effort normalization and xhigh clamping.
- **Antigravity**: quota-aware routing with reset-aware fallback — 409/429
  refreshes live quota for the exact resetAt before locking; generalized
  system-prompt branding rewrites (`ANTIGRAVITY_PROMPT_REWRITES`); Gemini
  3.7 Flash tiers in MITM defaultModels; image size → aspect-ratio model
  suffix.
- **CLI tools**: endpoint presets shared across every tool card; Codex
  config writes the API key where Codex actually reads it (http_headers,
  not auth.json).
- **CLI install**: better-sqlite3 installs without build tools on Node 22+
  (per-platform prebuilds + `--ignore-scripts`).
- **Fixes**: Claude Code session id read from its request header; Cline
  token refresh uses the extension JSON contract; usage recorded when a
  client disconnects on the terminal event + no disconnect log for
  completed Responses calls; Ollama trailing NDJSON line parsed; Kiro
  intercepts `x-amz-target` + mandatory initial-response frame; API-key
  mask clamp for short keys; Material Symbols font reveal wait; connection
  tests time out and guard undefined provider names; search failure locks
  scoped so search cannot take chat offline.

## Merge notes
- Registry renumber: fork providers moved p122–p126 → p124–p128 around
  upstream's new xquik (p122) + ollama-search (p123) slots — 124
  definitions total, 0 duplicate ids.
- `chatCore` `targetFormat` now prefers a source-format-matched transport
  over model-level targetFormat (upstream fix; prevents MiniMax image loss
  through mismatched transports).
- Kept the fork's 30s bounded non-mutating connection-test probes over
  upstream's 15s mutating variant, and the fork's Grok-CLI bulk import
  coexists with TOTU "Lấy acc" on the provider detail page.
- Verification: full-suite pre/post comparison 2442 tests with **0
  pass→fail regressions** (3 golden header tests fixed); providers/alias/
  oauth-urls baselines byte-for-byte equal; `npm run build` clean
  including all fork routes.

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.6.32 (2026-08-25)

Anti-fingerprint release for the opencode (zen) provider: outbound requests
now carry the exact official opencode CLI request fingerprint, so upstream
can no longer distinguish 9router traffic from the real client.

## Fixes
- **opencode (zen) 503 "Endpoint is unavailable" for some users**: the
  executor sent a bare `opencode` User-Agent and defaulted
  `x-opencode-client` to `desktop`, while the real opencode CLI (1.18.22)
  sends the full ai-sdk/runtime UA string and `cli`. Requests that didn't
  look like the official client were intermittently rejected with
  `503 {"error":{"type":"server_error","message":"Error from provider
  (Console): Upstream request failed: Endpoint is unavailable."}}` — hit
  some users/IPs and not others, which made it look like a proxy problem
  (the v2go managed pool kept rotating exit IPs in response without ever
  fixing it). The executor now sends the captured official fingerprint
  (`opencode/1.18.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`)
  and defaults `x-opencode-client` to `cli`. Downstream client headers
  (`User-Agent`, `x-opencode-*`) still pass through unchanged when the
  request itself carries them.

# v0.6.31 (2026-08-21)

Model-compatibility release for the Model Proxy Filter and provider
validation: every probe payload is now model-agnostic (no more hardcoded
max_tokens: 1) and every probe is time-bounded, so a model that enforces
its own token minimum — or one that generates slowly — can no longer fail
every Xray config or hang a worker/UI request.

## Fixes
- **Model Proxy Filter failed every config for models with upstream
  token minimums**: the filter probe hardcoded `max_tokens: 1`, and
  upstreams enforce different floors (opencode's
  muse-spark-1.2-contributor-free rejects anything under 16 with HTTP
  400 — verified live: 2/4/8 → 400, 16/32/omitted → 200). Every config
  then "failed" identically regardless of proxy quality, and with
  "Delete failures" enabled the prune step permanently deleted healthy
  configs. The probe body now lives in one shared builder
  (src/lib/xray/modelProbe.js) with max_tokens omitted: each upstream
  applies its own default, and target-format translators inject one
  where the format requires it (openai→claude/commandcode:
  DEFAULT_MAX_TOKENS; openai→gemini: optional field omitted). Bonus:
  OpenAI reasoning models (o-series) that reject `max_tokens` outright
  now probe correctly too.
- **Provider/node validation had the same latent bug** (23 sites across
  providers/validate, provider-nodes/validate, and the per-connection
  test utils): openai-format probes omit max_tokens; claude-format
  probes (/v1/messages, where the field is required) use 64 to clear
  gateway minimums. The provider-nodes chat fallback was the real
  user-facing case — it judges validity via `chatRes.ok`, so a min-cap
  400 meant a working node tested as INVALID.
- **Model filter probes could hang a worker indefinitely**: the filter's
  timeoutMs was never applied to the actual chat request, so a
  slow-generating model held the worker until the upstream gave up.
  Both probe paths (spawn mode and api mode) are now wrapped in
  withProbeTimeout(): on timeout the config is marked failed with
  "Probe timed out after Xms" (visible in the results table) and the
  worker moves on; spawn mode kills its temp xray, tearing down the
  abandoned fetch.
- **Validation probes are now time-bounded (30s)**: dropping the token
  cap means probes wait for a full completion, so the edited validation
  fetches carry AbortSignal.timeout(30000) (default added to the
  connection-proxy fetch helper), preventing a slow model from hanging
  the interactive "test connection" request for minutes.

## Chores
- Regression tests for the probe payload (asserts no token caps are
  reintroduced) and the timeout helper (resolve, hang, late-rejection
  safety, early-failure propagation, pass-through mode).
- GitNexus impact/detect-changes run before each edit batch; code
  review verified no verdict-logic changes in any validation site.

# v0.6.30 (2026-08-19)

i18n compliance release for the v0.6.29 provider pack: the TOTU
auto-fetch UI now follows the translation pipeline (English source
keys + 34 locale dictionaries), a modal settings bug is fixed, and the
provider detail page is lint-clean.

## Fixes
- **TOTU auto-fetch UI broke the i18n convention**: three Vietnamese
  source strings ("Lấy acc" buttons, modal title, "Lấy acc ngay") were
  hardcoded, so English and the other locales saw Vietnamese forever,
  and the modal wrapped none of its strings in translate(). All strings
  are now English keys passed through translate(); Vietnamese keeps the
  "Lấy acc" branding via dictionary translations ("Get accounts" →
  "Lấy acc"), every other locale falls back to English.
- **New keys translated across all 34 locales**: the 20 auto-fetch
  keys are present in every locale file (vi, zh-CN and the remaining 32
  added in this release; verified 100% key coverage).
- **Modal never loaded saved settings**: handleOpen was dead code
  (never invoked), so the auto-fetch toggle always showed OFF even when
  the scheduler was enabled. Settings now load each time the modal
  opens (useEffect on isOpen with a cancellation guard).
- **Server-side usage messages embedded Vietnamese**: the NewAPI
  balance messages mixed "Lấy acc" into English text shown to all
  locales; now pure English ("use the account auto-fetch…").
- **Translatable quota notices**: quota.message (usage dashboard) and
  provider notice.text / "Get API Key" / "Sign up / Learn more"
  (provider detail page) now pass through translate() at render time.

## Chores
- Resolved the three remaining react-hooks/set-state-in-effect lint
  errors in the provider detail page: the mount-fetch effect gets a
  scoped disable with rationale (false positive — the fetchers only
  setState after await, same convention as the media-providers pages);
  the cursor live-models reset became a render-time derivation; the
  selection prune now uses the React-docs render-phase adjustment
  pattern.

# v0.6.29 (2026-08-19)

Provider pack: two new API-key providers (OrcaRouter, TOTU AI), a TOTU
account auto-fetch ("Lấy acc"), per-account $ balance for the NewAPI
gateways, and tokenrouter free-model suggestions that actually work.

## Features
- **OrcaRouter provider (orcarouter.ai)**: new API-key provider with a
  thin executor that parses `Retry-After` / `x-ratelimit-reset-after`
  on 429 into a precise `resetsAtMs` cooldown instead of the default
  guess; generic-OpenAI suggested-models filter; connection test; the
  per-workspace rate-limit caveat surfaced in the provider notice.
- **TOTU AI provider**: OpenAI-compatible NewAPI gateway (category
  `apikey`), 3-model seed, embedding + image config, model listing via
  the public pricing endpoint, connection test. No `thinkingConfig`
  (TOTU reasoning conventions unverified).
- **TOTU auto-fetch ("Lấy acc")**: one button creates fresh TOTU
  accounts end-to-end — disposable mail.tm mailbox, email-OTP capture,
  register, login, mint an `sk-` key — and saves each as a connection
  with `testStatus: active`. Per-account error isolation, email dedup,
  and an optional scheduler (default off; manual / 15 / 30 / 60 min).
  The dashboard login token is stored server-side only, outside
  `SAFE_PSD_FIELDS`, so it never reaches the browser.
- **Per-account $ balance for NewAPI gateways**: tokenrouter and totu-ai
  query `GET /api/user/self` with the stored dashboard login token
  (never the sk- inference key) and convert NewAPI quota units to USD
  (tokenrouter price 7, totu 0.5, quota_per_unit 500000). 401/403 maps
  to a clear "re-add the account" message; orcarouter has no balance
  API and says so instead of fabricating numbers.

## Fixes
- **tokenrouter "Suggested free models" was empty**: the modelsFetcher
  pointed at `/v1/models`, which 401s unauthenticated; it now reads the
  public pricing endpoint and keeps only `model_ratio === 0` models.
  Seed trimmed from 120 to 6 — the 3 verified-real free ids plus 3
  paid — and the stale fake-free `moonshotai/kimi-k3-free` removed.
  Other ids still route fine via `passthroughModels`.
- **`undici` was an undeclared dependency** (imported at module scope by
  `open-sse/translator/concerns/image.js` since the upstream v0.5.2
  migration): test suites reaching the claude-to-openai translator chain
  failed to load with `Cannot find package 'undici'` wherever no
  ambient copy existed, and the SSRF-pinned image-fetch path silently
  degraded. Now declared (`^7.29.0`) and copied into the Docker runner
  image alongside the node-forge / sql.js precedent.

## Chores
- Provider/alias regression baselines regenerated for totu-ai
  (post-merge of PRs #7–#10).

# v0.6.28 (2026-08-18)

Dashboard hotfix: the "Usage by API Key" table on /dashboard/usage was
wrong in every period, each period in its own way.

## Fixes
- **All keys collapsed into one row in Today/24h**: API keys are
  `sk-{machineId}-{keyId}-{crc}`, so every key on one machine shares the
  same first 8 characters — and the Today/24h aggregation used exactly
  those 8 masked chars as the row key. Every request from every key
  merged into a single row attributed to whichever key happened to be
  seen first; the other keys simply vanished from the table. Rows are
  now keyed by the full raw key internally and by a per-key SHA-256
  fingerprint in the response, so each key keeps its own numbers.
- **Deleted keys merged into one anonymous row in 7d/30d/60d**: once a
  key was removed from the key manager, its display name fell back to
  the first 8 chars + "..." — identical for every deleted key — and the
  UI groups rows by name, so all deleted keys' usage piled into a
  single row. The fallback name now includes the key tail (e.g.
  `sk-machi…beef01`), unique per key.
- **Local (no-key) usage showed the wrong model in Today/24h**: all
  no-key requests were forced into one row that inherited the model of
  the first request seen; each model now gets its own row, matching the
  daily-summary path.
- **Raw API keys leaked in the /api/usage/stats response**: the
  daily-summary path used `rawKey|model|provider` as JSON property
  names, shipping full plaintext keys to the browser. Property names
  are now fingerprint-based.
- **lastUsed never sharpened for no-key rows**: the timestamp overlay
  looked up `"local-no-key"` while daily rows are keyed
  `local-no-key|model|provider`; the overlay now builds the same key.

No data migration needed: stored daily aggregates were already keyed by
the full raw key, so historical per-key numbers render correctly as
soon as the dashboard reloads. Regression tests in
`tests/unit/usage-by-api-key.test.js`.

# v0.6.27 (2026-08-15)

Hotfix for the flaky-node rotation introduced in v0.6.26: it never fired
for its primary target.

## Fixes
- **Mid-stream aborts never reached the flaky-node counter**: `TypeError:
  terminated` errors carry NO http status — the response already started
  (200) when the stream died — so they never satisfied the `rotatable`
  gate the rolling counter was nested under. Live logs confirmed it:
  three `terminated` errors within 30 seconds across two nodes, zero
  rotations, users stuck until the flaky node recovered on its own (or
  didn't). The counter now lives in its own status-agnostic block that
  runs for every managed-pool connection-level failure; the old
  classification branch keeps only the two signals that belong there
  (retries exhausted with the SOCKS port open, and the port down with no
  rotation in flight). The rotation module's adaptive cooldown bypass
  covers the case where the flaky node was itself just rotated to.

# v0.6.26 (2026-08-15)

v2go rotation intelligence: flaky nodes, edge-banned exit IPs, and
public/no-auth traffic all rotate away automatically now, with a
full error taxonomy deciding when switching IP helps and when it
just wastes a node.

## Fixes
- **Flaky nodes no longer pin the pool**: a node that INTERMITTENTLY
  drops streams (xray `websocket: failed to dial ... EOF`, mid-body
  `TypeError: terminated`) never looked dead — requests between the
  drops succeed — so the pool stayed pinned to it indefinitely.
  Connection-level failures on the managed pool are now tracked in a
  rolling 5-minute window (interleaved successes do not reset it) and
  the 3rd failure triggers a managed rotation to a healthy node. This
  joins the two existing escape hatches: retries exhausted with the
  SOCKS port open (dead outbound) and the port down with no rotation
  in flight (instance gone).

## Added
- **Edge-banned exit IPs rotate + quarantine**: a 403 Cloudflare block
  page (Error 1034 "Edge IP Restricted", 1006/1007/1008 "Your IP
  address has been banned", 1020 firewall rules) means the exit IP is
  banned at the edge — every request through it fails identically
  regardless of account. These are now classified proxy-rotatable
  (previously a plain 403 was treated as an account problem: the
  account got marked unavailable while the banned IP stayed active).
  Hard bans rotate immediately, cool group entries for 1h, and mark
  the config's model-filter row `ok=0` so future rotations skip the
  node until the next filter run re-validates it — a quarantine, not
  removal, since edge bans are usually temporary. Cloudflare 1015
  ("You are being rate limited") is a short per-IP edge window and
  rotates with the normal 60s rate-limit cooldown, no quarantine.
  Classification is signature-driven (block-page text), and the
  taxonomy was verified with a 14-case unit check: auth 403/401, S3
  AccessDenied, and CF 1010 (browser-signature) correctly stay
  non-rotatable for authenticated accounts.
- **Aggressive rotation for public/no-auth connections**: a no-auth
  connection (opencode free, mimo-free — the truly credential-free
  providers) has no account to protect, and edge/bot blocks can
  masquerade as 401/402/403. When such a connection rides a proxy
  pool, ANY http error except the request-shape-deterministic ones
  (400/404/405/413/422) now triggers rotation. Authenticated
  connections keep the conservative taxonomy — their 401/402 are
  genuinely credential/billing problems.

# v0.6.25 (2026-08-15)

v2go resilience: a dead xray outbound can no longer wedge the managed pool
— real traffic, the pool Test button, and manual health checks all
trigger auto-rotation now, and probes run on the shared SOCKS dispatcher.

## Fixes
- **Dead v2go node wedged the managed pool forever**: a node that died
  outside a rotation (xray process up, SOCKS port accepting, outbound
  unable to reach anything) produced connection-level "fetch failed"
  errors, which the chat loop deliberately classified as rotation-
  teardown noise — two bounded retries through the same dead node, then
  nothing. Health checks only run manually, so nothing ever rotated
  (observed as 45+ minutes of 502s after a boot-time node death). The
  chat loop now distinguishes teardown noise from a genuinely dead
  outbound: when the managed-connection retries are exhausted while the
  SOCKS port stayed open — or the port never came back with no rotation
  in flight to blame — it fires a managed rotation to a healthy node
  (`triggerManagedRotationOnProxyError`; its in-flight + cooldown guards
  keep this safe to call per request).
- **Testing the managed pool was passive and harmful**: POST
  `/api/proxy-pools/v2go-xray-managed/test` only probed and recorded the
  result — and a failure deactivated the pool, silently cutting bound
  connections over to DIRECT (an IP leak under strictProxy intent). The
  managed pool's lifecycle now belongs solely to the xray manager: a
  failed test keeps the pool active, appends an actionable hint to the
  recorded error ("auto-rotation triggered; re-test in a few seconds"),
  and kicks a debounced background `runHealthCheck` which blue-green
  switches to a healthy node when Auto-rotate is enabled. Non-managed
  pools keep the previous active/inactive-on-test behaviour.
- **xray probes used undici's experimental SOCKS5 support**: the latency
  / exit-IP probes in `tester.js` still went through `ProxyAgent` with a
  `socks5://` URI — experimental, unreliable for https targets, and the
  source of the boot-time `ExperimentalWarning: SOCKS5 proxy support is
  experimental`. Probes now use the shared SOCKS dispatcher
  (`socksDispatcher.js`), matching the pool-test and runtime fetch
  paths.

## Chores
- Removed one-off Gemini Web integration scripts, an obsolete ds2api
  plan, and a stale `.bak` file from the repo.

# v0.6.24 (2026-08-14)

Proxy-pool editing overhaul: proxyxoay.org pool edits now actually save,
a free-form rotation interval, and SOCKS proxies finally work in pool
tests and proxied fetches.

## Fixes
- **proxyxoay pool edits were silently ignored**: proxyxoay pools are
  stored as groups (`isGroup:true`), but the dashboard's save handler
  checked the generic group branch first, so every edit sent
  group-shaped fields and dropped `liveMinutes`, `keys`, `protocol`,
  `autoRotate` and `forwardEnabled` entirely — changing the rotation
  interval (or any provider field) did nothing. The branches are
  reordered so the proxyxoay branch wins, surviving keys are re-sent
  with their ids, and the PUT handler now detects proxyxoay by the
  post-update type so manager-owned entries pass through verbatim and
  keep their live `_px` state instead of being wiped and re-fetched
  against the provider rate-limit. Converting a pool away from
  proxyxoay now stops its rotation timers and forwarding servers, and
  the pool-type selector no longer highlights both "group" and
  "proxyxoay" when editing.
- **SOCKS proxies failed pool tests and proxied fetches** (e.g. the v2go
  xray pool `socks://127.0.0.1:10808`): undici's `ProxyAgent` speaks HTTP
  CONNECT only, so it sent an HTTP CONNECT line to the SOCKS server,
  which dropped the connection mid-TLS-handshake ("Client network socket
  disconnected before secure TLS connection was established",
  `ECONNRESET`). A shared SOCKS-capable dispatcher
  (`src/lib/network/socksDispatcher.js`, socks4/4a/5/5h with optional
  user/pass) tunnels each origin connection through the proxy and
  performs the TLS upgrade itself for https targets; both `testProxyUrl`
  and `proxyFetch`'s dispatcher cache now route socks:// URLs through it
  (http(s) proxies keep using `ProxyAgent`). Verified end-to-end against
  a local SOCKS5 server (https + http + pooled connections + dead-proxy
  error path).

## Added
- **Custom proxyxoay rotation interval (1–60 min)**: the rotation
  interval is now a free-form input instead of a fixed 1–5 dropdown,
  snapped to 1–60 on blur, with the clamp widened consistently across
  the UI, POST/PUT routes and the provider client. The provider doesn't
  document a hard `live` maximum; rotation scheduling already follows
  the `time_die` it returns, so a provider-side cap degrades gracefully.
- `socks@^2.8.9` as an explicit dependency (was already in the tree
  transitively via `socks-proxy-agent`).

# v0.6.23 (2026-08-14)

XRAY managed-pool rotation overhaul: zero-downtime blue-green outbound
switching, exit-IP-aware candidate selection, and collision-free model-filter
port allocation.

## Fixes
- **Zero-downtime managed-pool rotation (blue-green)**: `switchConfig` no
  longer kills the active xray before respawning it on the same port — that
  tore down the shared SOCKS port for 8-15s on every 429-triggered rotation
  and destroyed every in-flight stream with `TypeError: terminated` (request
  durations of 19-23s were dying mid-response). The switch now spawns the
  NEXT instance on a fresh ephemeral port pair (53108+, disjoint from the
  model-test range), races port-readiness against early exit (the fixed 8s
  startup gate is gone), health-probes the candidate through its own port,
  and only then atomically repoints the managed pool (`proxyUrl` → new SOCKS
  port, PID file, DB selection). A failed candidate is killed while the OLD
  instance keeps serving — the pool is never pointed at an unverified
  outbound. The retired instance drains in-flight requests for 90s
  (`NINEROUTER_XRAY_DRAIN_MS`, capped at 3 concurrent retirees) before being
  terminated.
- **Rotation amplification loop**: connection-level failures (SOCKS port
  down, `terminated` streams) were classified as rotatable 502s, so each
  rotation's teardown spawned new 502s that triggered yet another rotation.
  The chat loop now skips managed-pool rotation for connection failures
  (they are handled by the bounded same-account retry), and
  `CONNECTION_FAILURE_RE` additionally recognizes undici's `terminated`
  mid-body abort.
- **Rotation no longer swaps to the same exit IP**: a per-IP rate limit
  can't be dodged by switching to a node that egresses from the same IP.
  Rotation now collects the active config's exit IPs (generic probe result +
  model-specific filter row), skips candidates with a matching cached exit
  IP, and live-verifies the winner's exit IP after the swap
  (`switchConfig({ avoidExitIps })`, rejecting with `SAME_EXIT_IP`). When
  every candidate shares the active IP, rotation aborts with
  `no-distinct-exit-ip-candidate` instead of thrashing through the pool.
- **Model-filter "bind: address already in use" false negatives**: temp
  probes released their port reservation while the async kill was still in
  flight, so the next probe could re-pick a port whose socket was still
  open; xray failed to start, and after a 4.5s wait the config was recorded
  FAILED in the filter cache even though the proxy was fine. Ports are now
  pre-flight bind-checked before spawn, stay reserved until the listener is
  confirmed gone, and a "port did not open" failure retries once on a fresh
  port before failing. The per-row Test button uses the same allocator
  instead of an uncoordinated random pick.
- **Active SOCKS port resolution**: after a blue-green switch the live
  instance no longer sits on the configured port (10808 is now only the
  cold-start port). `startXrayService` (idempotent start),
  `runHealthCheck`, and the chat-loop connection retry all resolve the real
  port from in-memory state → the managed pool's `proxyUrl` (survives HMR /
  module-state resets) → settings, so an idempotent start can no longer
  overwrite the pool URL with a stale port.
- **Hygiene for retired instances**: `stopXrayService` now terminates
  blue-green retirees immediately, and the boot reaper kills orphaned
  draining instances listed in `xray.pid.draining` (guarded against PID
  reuse via a `/proc/<pid>/cmdline` xray check on POSIX).

## Added
- `NINEROUTER_XRAY_DRAIN_MS` env knob (default 90000) for the blue-green
  drain window.
- `switchConfig(configId, { avoidExitIps })` option plus `HEALTH_FAILED` /
  `SAME_EXIT_IP` error codes, so rotation candidates are verified reachable
  AND IP-distinct before traffic moves.
- Draining-instance registry (`xray.pid.draining`) with boot-time cleanup.
- Unit tests for exit-IP candidate ordering, same-IP abort, and
  connection-failure (`terminated`) classification
  (`tests/unit/xray-managed-rotation-exitip.test.js`).

# v0.6.22 (2026-08-14)

Upstream `decolua/9router` v0.5.55 migration (26 upstream commits; upstream
README changes intentionally not taken).

## Added
- **SAML 2.0 SSO (native)**: dashboard login now supports SAML alongside OIDC
  and password — AuthnRequest generation, ACS assertion handling, SP metadata
  export, admin config test, replay-protected via a `saml_state` cookie matched
  against `InResponseTo`.
- **Alibaba Token Plan provider** (`alitp-intl`, `token-plan.ap-southeast-1`):
  the fourth Alibaba key type — Singapore region, OpenAI-compatible transport.
- **Fish Audio TTS provider**: model id travels in an HTTP `model` header,
  voice is a `reference_id` (preset or cloned voice model).
- **Kimchi dual auth**: Kimchi now accepts API keys as well as OAuth
  (`authModes: ["oauth", "apikey"]`), with a working Test Connection for both
  modes.
- **Gemini 3.7 Flash on Antigravity**: high/medium/low tiered variants, also
  registered in the Gemini registry, with pricing and quota tracking.
- **`glm-5.3`** added to GLM Coding and GLM (China) registries.
- **Claude usage quota**: dedup + cache Claude quota calls (120s TTL keyed by
  access token, in-flight promise dedup, last-good read on soft failure) so
  multiple open tabs stop tripping 429; the manual refresh button sends
  `force=1` to bypass the cache.

## Fixes
- **Claude passthrough cache anchoring** (upstream): the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Cache breakpoints are now re-anchored on the final
  body — last system block and last tool pinned at 1h TTL, last assistant turn
  at 5m — and mid-conversation system messages are folded into the neighbouring
  user turn instead of hoisted into `body.system` (hoisting invalidated the
  prefix cache every request).
- **opencode (zen) official client fingerprint** — replaced our v0.6.20
  workaround with the upstream implementation: session id now resolves
  conversation-stable via `resolveSessionId` (client session → assistant-text
  hash → connection) normalized into opencode `ses_` format to preserve prompt
  caching, and a downstream opencode client's headers are forwarded as-is
  instead of being regenerated per request.
- **Kiro**: intercept chat via `x-amz-target` (Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM); emit the
  now-mandatory initial-response frame; map the `auto` model slot; report real
  output tokens and stop discarding usable turns.
- **Antigravity**: read Gemini `usageMetadata` out of the antigravity
  `{ response }` envelope — every non-streaming request previously logged
  `IN 0 | OUT 0`. Also strip competitive system prompts (Zed IDE's
  Claude-agent prompt) that Antigravity flags with 429 Quota Exhausted.
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat.
- **OpenAI Responses**: don't close the message on an empty `tool_calls`
  array; preserve `prompt_cache_key` when converting chat to responses.
- **Vision Adapter**: detect images from Hermes and attachment payloads
  (`images[]`, `experimental_attachments`, message-level
  `image_url`/`audio_url`, inline `data:` URIs) so the auto-switch fires for
  Hermes/Ollama/Vercel AI SDK shapes.
- **Fusion combos**: strip `stream_options` from the panel fan-out (avoids a
  DeepSeek 400); model-test probe budget raised to 1024 with a soft-pass for
  reasoning-only responses (llm7 added to provider test support).
- **`/v1/models`**: expose snake_case token limits.
- **Hermes**: add the `api_key` parameter to the model block in YAML config.
- **Docker**: ship `sql.js`'s `dist/sql-wasm.wasm` in the image so the pure-JS
  DB fallback can start when no native driver is available.

## Security
- **Trusted-peer proof for `x-9r-real-ip`** (upstream GHSA-pjm4-8fpg-f9p6):
  the real-IP header and the Host fallback were trusted from client-controlled
  input whenever `custom-server.js` was not in the request path, letting a
  remote caller pose as local to skip API-key auth and reach local-only routes
  (`/api/mcp/*`, `/api/tunnel/enable`, `/api/auth/reset-password`). The server
  now stamps a per-process `x-9r-peer-token` on every request it sanitizes and
  only trusts `x-9r-real-ip` behind that proof — falling back to Host in
  development and failing closed in production. `npm start` / `start:bun` now
  route through `custom-server.js`. Fork tunnel/LAN-dashboard access paths are
  preserved on top of the hardened loopback check.
- **Search SSRF guard**: `resolveBaseUrl()` rejects client-supplied
  non-public baseUrls on `/v1/search`.
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT.
- **Usage**: `/api/usage/request-details` redacts request/response payloads.

## Tests
- Golden URL/header snapshot regenerated: upstream v0.5.55 entries (incl.
  Kimchi dual-auth) plus fork providers (tokenrouter, ds2api, gemini-web,
  genspark-web, kimi-coding) — fixes 3 pre-existing golden failures.
- `translator-helpers-edge` updated to the new system-message folding
  behavior.

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.6.21 (2026-08-14)

## Added
- **opencode-go — usage metering on the dashboard**: OpenCode Go meters three
  plan windows (rolling / weekly / monthly) at `GET /zen/go/v1/usage`, taking
  the same `sk-...` key chat uses. The new usage handler renders all three on
  the `/usage` page. `percent` is percent **used** (a depleted window reads
  100, not 0); a window counts as blocked on **either** signal
  (`status: "rate-limited"` or percent at 100), so an upstream that renames the
  status string still reports the window as blocked; and a reset time is only
  surfaced for a window that is blocked or partly used — an untouched window's
  `resetsAt` is a moving projection, not a deadline. `monthly` is a rolling
  ~30 day window, not a calendar month.
- **opencode-go — endpoint routing by client request format**: the provider now
  declares multi-endpoint `transports` (openai / claude / openai-responses) so
  the endpoint is picked by the **client's request format** — Claude Code hits
  `/messages` (native, thinking block preserved), Codex hits `/responses`,
  OpenAI clients hit `/chat/completions` — instead of force-translating every
  request through the Claude pivot (two hops, with thinking/tool_id loss). A
  per-model `supportedFormats` guard keeps models on the endpoints they
  actually support: kimi/glm/mimo only do `/chat/completions`, MiniMax/Qwen
  add `/messages`, DeepSeek adds `/responses`. The bespoke `OpenCodeGoExecutor`
  is gone — routing now flows through `DefaultExecutor` + the registry, like
  every other multi-endpoint provider.

## Fixes
- **opencode-go — spent plan reported as "Invalid API key"**: the key test
  probed a chat completion and treated 401/403 as a bad key, but a key whose
  plan window is spent answers 401 on chat while `/usage` answers 200 — so the
  dashboard called a working, self-recovering key invalid. Both test paths now
  probe `/usage` (accurate, costs no tokens, no `getDefaultModel` dependency).
  As a fallback, `401 {"error":{"type":"CreditsError"}}` is still treated as a
  valid-but-spent key, while `AuthError` remains invalid — the two share a
  status code and only `error.type` separates them.

# v0.6.20 (2026-08-14)

## Fixes
- **opencode (zen) free models — 429 `FreeUsageLimitError`**: opencode.ai now
  classifies requests as anonymous unless they carry the same client-fingerprint
  headers the official opencode CLI sends. 9router only sent
  `x-opencode-client: desktop` (no session/request id, no project, no
  `User-Agent`), so free-tier requests (`oc/...` models) were throttled with
  `429 FreeUsageLimitError` after a few calls per day even when quota was
  available — even though direct opencode CLI usage on the same IP worked fine.
  `OpenCodeExecutor.buildHeaders()` now also sends:
  - `x-opencode-session` / `x-opencode-request` — freshly generated `ses_` /
    `req_` ids per request (24 random alphanumerics)
  - `x-opencode-project: /opencode`
  - `User-Agent: opencode/latest/1.18.18/cli` (required — without it `429`
    still occurs; `desktop` remains a valid `x-opencode-client` value)

# v0.6.19 (2026-08-13)

## Added
- **proxyxoay.org rotating-proxy provider**: a new pool type `proxyxoay` on the
  Proxy Pools page. Paste one or more API keys (bulk-add, one per line); each
  key becomes a rotating residential/4G proxy and the pool rotates across all
  keys using the existing rotation modes (on-error / round-robin / random). The
  manager polls `api.proxyxoay.org/api/key_xoay.php` shortly before each key's
  `time_die` to keep its IP fresh, displays carrier (`nha_mang`), location
  (`vi_tri`), exit IP and live countdowns, and honors the provider rate-limit
  (`next_allowed_in_seconds`) on manual rotation. Provider calls go through the
  global outbound proxy so the dashboard can reach proxyxoay even when itself
  proxied. Per-key "Rotate now" + pool-level "Rotate all" controls are exposed,
  and a dedicated status card polls every 5s. API: `POST /api/proxy-pools`
  (`type:"proxyxoay"`), `POST /api/proxy-pools/:id/rotate`, `GET|POST
  /api/proxy-pools/:id/forward`, `GET /api/proxy-pools/:id/status`.
- **Local forwarding ports (proxyxoay)**: optionally expose a `127.0.0.1:<port>`
  forwarding server (proxy-chain) per key so external tools can ride the current
  rotating IP — mirroring the proxy.exe.exe reference tool. Ports bind localhost
  only; never exposed externally.
- **Multi-format proxy URL parser**: a single shared parser
  (`src/lib/proxy/parseProxy.js`) now accepts the full spread of proxy formats
  across the dashboard, API routes, and the request-time network layer. Newly
  supported: **reversed order** `scheme://host:port@user:pass` (previously
  mis-parsed by `new URL`), `user:pass:host:port`, `scheme://user:pass@host`
  (default port), bare `host:port`, and IPv6 (`[::1]:8080:user:pass`). All forms
  canonicalise to a standard URL undici's `ProxyAgent` accepts. Full unit-test
  coverage in `tests/unit/proxy-parser.test.js` (28 cases).

## Changed
- proxy-pool create/update now canonicalise every proxy URL through the shared
  parser, so pasting any supported format into the single-proxy field, the group
  batch import, or a group entry all just works. Relay pools (vercel/cloudflare/
  deno) keep their base URL untouched.
- `proxyFetch.normalizeProxyUrl` routes through the shared parser, so legacy
  connection-proxy URLs (which bypass creation-time normalisation) also accept
  every format at request time.

## Fixes
- **proxyxoay forwarding server import**: `proxy-chain` is a transpiled CJS
  module with no `.default`, so a default import resolved to `undefined` under
  webpack and crashed pool registration. Switched to a namespace import.
- **Deleting a proxyxoay pool no longer hangs**: the forwarding-server teardown
  (`proxy-chain` `close`) is now fire-and-forget on delete with a 3s hard cap,
  so removing a pool with active local ports can't stall the response.

## Notes
- proxyxoay filtering by carrier/location is display-only: the verified
  `key_xoay.php` endpoint accepts only `key` + `live`, so `nha_mang`/`vi_tri`
  are shown but not used as request filters.
- proxyxoay success-schema (`proxyhttp`/`proxysocks5`/`nha_mang`/`vi_tri`/
  `time_die`/`next_allowed_*`) follows the provider spec; the error path
  (`{"error":"invalid_key","message":"Key không tồn tại"}`) was verified live,
  and the success path + end-to-end forwarding were verified with a real key
  (external request through `127.0.0.1:<forwardPort>` exited via the proxyxoay IP).

# v0.6.18 (2026-08-12)

## Changed
- **Managed-pool rotation — adaptive cooldown**: reduced the rotation cooldown
  from 30s to 8s so a 429'd egress IP is swapped out much sooner. On top of
  the flat window, an **adaptive bypass** now fires when errors keep coming
  from the config we *just* rotated to (i.e. the new IP is also bad): the
  cooldown is bypassed and another rotation runs immediately, so a burst of
  429s no longer pins you on a known-bad freshly-rotated IP for the whole
  window. `recentlyTried` (5-min skip, cap 8) still prevents re-picking the
  same IP, and when the usable candidate pool is exhausted the rotation enters
  cooldown to avoid hot-spinning an empty filter cache. Selection itself is
  unchanged — it still picks Model-Filter-verified `ok=1` IPs ordered by
  latency, excluding the active + recently-tried.

## Fixes
- **Managed-pool 502 during rotation (victim requests)**: concurrent requests
  that hit the ~1-10s SOCKS-port-down window of a `switchConfig` kill+respawn
  previously failed with `502 fetch failed` and — worse — were treated as
  account errors (marking the account unavailable / triggering fallback). These
  are now recognised as transient connection failures: the chat loop waits for
  any in-flight rotation to settle, polls the SOCKS port back up (≤6s), then
  retries the SAME account up to 2 times **without** marking it unavailable.
  Classification is by low-level socket signature in the error text
  (`fetch failed` / `ECONNREFUSED` / `UND_ERR_SOCKET` / `socket hang up` /
  `cause: ECONN…`), so genuine upstream 502s are unaffected. Mid-stream aborts
  keep their existing graceful-terminal path.

## Added
- `getInflightRotation()`, `getRotationState()`, `waitForManagedRotationSettle()`
  exports in managedRotation.js (observability + the retry path).
- `waitForSocksPortOpen(port, maxWaitMs)` in tester.js (port readiness poll).
- `isConnectionFailure(errorText)` in proxyRotation.js (connection vs upstream
  error classifier).

# v0.6.17 (2026-08-12)

## Added
- **Model Proxy Filter — Stop button**: the dashboard now shows a red "Stop
  Filter" button while a filter run is in progress. It requests a cooperative
  stop: the worker loop checks a cancel flag between configs, so in-flight
  probes finish naturally and the job winds down within a few seconds (the
  traffic-quiet wait is also broken early so a cancelled job doesn't idle for
  up to 10 min). New endpoint `POST /api/xray/configs/model-filter/stop`.
  Results already probed are persisted incrementally (one DB upsert per
  config), so they survive the stop — re-running "Run Filter Now" resumes from
  where it stopped because the cache splitter skips configs with fresh success
  rows. This is why no separate "Resume" button is needed: **Start after Stop
  IS the resume.** Status badge and banner reflect a "Stopped · X/Y usable"
  / "Stopping…" state.

## Fixes
- **Windows desktop cmd-window flood (critical UX)**: running the Model Proxy
  Filter on Windows spammed hundreds of `cmd.exe` console windows, freezing
  the desktop. Root cause was NOT the xray spawn (it already passed
  `windowsHide: true`) — it was the per-test process teardown. Every temp xray
  was killed via `child_process.exec('powershell.exe …Stop-Process…')`, which
  routes through cmd.exe and opens a visible console per call; with one kill
  per config, a run over hundreds of configs produced hundreds of windows.
  The same defect also affected `stopXray()` and `restartXray()`. Fixed by
  spawning `powershell.exe` directly (no shell) with `windowsHide: true` and
  `stdio: "ignore"` in a new `killPidWindows()` helper, which creates the
  process with `CREATE_NO_WINDOW` so nothing is ever visible. The unused
  `exec`/`execFile` imports were removed from `process.js`.
- **Cross-platform hardening (Windows console flashes)**: audited every
  `child_process` call in the repo for missing `windowsHide`. Two additional
  latent console-window leaks fixed (same class of bug, off the filter path):
  the MCP stdio-plugin spawner (`src/lib/mcp/stdioSseBridge.js`) and the
  updater's browser-open relaunch (`src/lib/updater/updater.js`, `shell: true`
  spawn) now pass `windowsHide: true`, so neither pops a `cmd.exe` window.

# v0.6.16 (2026-08-12)

## Fixes
- **V2Ray Proxy (critical)**: streaming requests through the managed SOCKS5
  proxy intermittently aborted mid-response with an undici
  `TypeError: terminated` after 3-13s. Root cause: xray-core's default level-0
  `downlinkOnly` policy is 5 seconds — once the request body finishes uploading,
  xray starts a 5s countdown and closes the connection if the server pauses
  longer than that between SSE chunks (typical during model thinking/TTFT).
  Fixed by emitting a `policy.levels.0` block in every config built by
  `buildClientConfig` (managed active proxy, temp probes, api-mode filter
  instance): `handshake: 30, connIdle: 300, uplinkOnly: 60, downlinkOnly: 300`.
  Verified: 5 large streaming requests (23-66s, 250-534KB each) completed with
  zero terminates, vs intermittent failure before. The bundled undici 7.29.0
  SOCKS5 stack itself was exonerated — the terminate was undici correctly
  propagating the TCP close that xray initiated.

# v0.6.15 (2026-08-12)

## Added
- **V2Ray Proxy**: optional `api` execution mode for the Model Proxy Filter
  (`xrayFilterMode` setting, default `spawn` for backward compatibility). In
  `api` mode a single long-lived xray instance is started per filter job and
  each config-under-test is probed by swapping its outbound via the xray gRPC
  API (`ado`/`rmo` + per-worker SOCKS5 username routing) instead of spawning a
  fresh `xray run` process per config. Eliminates thousands of process forks
  per filter pass (~6000+/day on busy installs), drops per-probe RAM from
  ~29MB transient to one ~30MB steady instance, and removes the readiness
  port-poll wait. Verified end-to-end: 10 probes at concurrency 4 via one
  instance, zero forks, exit IPs per outbound correct, production proxy
  unaffected, filter instance cleaned up at job end. Auto-falls-back to
  `spawn` mode if the api instance can't start (old binary, port conflict).
  New settings: `xrayFilterMode`, `xrayFilterApiSocksPort` (53080),
  `xrayFilterApiPort` (15491), `xrayFilterApiAccounts` (16).

## Changed
- **V2Ray Proxy**: `tester.js` exposes `testProxyExitIpWithUri(socksUri)` for
  exit-IP probes through a full SOCKS URI (with auth) — used by api-mode where
  each worker connects as `probe-<i>:x@...`.

# v0.6.14 (2026-08-12)

## Fixes
- **V2Ray Proxy**: reap orphaned temp-probe xray processes and config files at
  app boot. Previously, if the app crashed or was restarted while a Model Proxy
  Filter job was running, the spawned `xray run -c config.json.model-test-*`
  processes and their temp config files were never cleaned up (the `finally`
  cleanup only runs when the Node process is alive). Each restart mid-job
  leaked processes + RAM + ports permanently. Added a dependency-free reaper
  module (`src/lib/xray/reaper.js`) statically imported at boot; it kills any
  xray whose cmdline references `config.json.model-test-*` and unlinks the
  matching files. Never touches the main `config.json` or the managed PID.
- **V2Ray Proxy**: Model Proxy Filter cache now has a freshness TTL. Cached
  SUCCESS results older than `xrayModelFilterCacheTtlH` (default 24h, 0 =
  forever) are treated as misses and re-probed, so a server that was reachable
  yesterday but broken today is re-verified instead of trusted forever.
- **V2Ray Proxy**: cached FAIL results are no longer permanent. A failed probe
  is retried once it ages past `xrayModelFilterRetryFailAfterH` (default 1h,
  0 = never retry), so a server that was temporarily down isn't blacklisted
  forever — the filter rediscovers it when it recovers.

## Changed
- **V2Ray Proxy**: `getModelFilterResultsByConfigIds` accepts a `maxAgeMs`
  option to exclude rows older than a cutoff (used by the new TTL gate).

# v0.6.13 (2026-08-11)

## Fixes
- **V2Ray Proxy (critical)**: Model Proxy Filter, health checks, and the per-row
  Server "Test" button were silently bypassing the SOCKS5 proxy and connecting
  direct. The probes passed `SocksProxyAgent` as the legacy `agent` option,
  which undici-backed `fetch` ignores — so `testProxyLatency` / `testProxyExitIp`
  / `testProxy` always measured the host's own IP, never the proxy egress. This
  made the filter's reported exit IP always equal the server IP, and worse, it
  disabled `xrayAutoRotate`: the latency probe reported healthy even when the
  real proxy was dead. Switched to undici `ProxyAgent` passed as `dispatcher`
  (matching `proxyAwareFetch`), with an LRU dispatcher cache. Exit IPs now
  reflect the real proxy.
- **V2Ray Proxy (critical)**: the `v2go-xray-managed` proxy pool never rotated
  on 429 / rate-limit errors. The pool is single-URL (one running xray
  outbound), and the existing proxy-group rotation in the chat loop requires a
  per-entry id that single-URL pools never set — so a rate-limited egress IP
  caused infinite 429 loops until the account burned out. Added a managed-pool
  rotation path that, on a rotatable error, fire-and-forget switches the active
  xray outbound to the next config known-healthy for that model via
  `switchConfig`, guarded by single-flight + a 30s cooldown + a recently-tried
  history. Also fixes a model-key mismatch (chat passed `opencode/...` while
  the filter cache keys on the `oc/...` alias) via prefix normalization. Rotation
  events are persisted to `~/.9router/logs/managed-rotation.log`.

# v0.6.12 (2026-08-11)

## Fixes
- **V2Ray Proxy**: make the Model Proxy Filter pause toggle take effect while
  a filter job is already running. The dashboard setting now updates the live
  runtime state as well as persisted settings, and workers waiting for live
  traffic can resume immediately when pause is turned off.
- **V2Ray Proxy**: expose live-traffic wait state in the model filter status
  and show a clear dashboard message when workers are waiting for model
  traffic to go quiet.

## Changed
- **V2Ray Proxy**: add pagination controls to the Servers table while keeping
  the existing 200-server page size. Users can move with Previous/Next or jump
  directly to any page number from the top or bottom pager.
- **Release**: keep the root app and CLI package versions in lockstep so the
  GitHub Release tarball reports `v0.6.12` after install/update.

# v0.6.11 (2026-08-11)

## Features
- **V2Ray Proxy**: persist Model Proxy Filter probe results so re-runs skip
  already-tested servers. Each (config, model) result is cached in the DB and
  reused until the config changes (the config id is a sha1 of the canonical
  share link, so it doubles as a fingerprint — a config whose server or
  credentials change is naturally a new id and a fresh cache entry). This
  means restarting the server no longer forces a full re-probe: a filter run
  after a restart completes in milliseconds when nothing has synced in between,
  and the next subscription sync only re-probes configs that are actually new
  or changed.
- **V2Ray Proxy**: add a **Force Re-test All** button to the Model Proxy Filter
  card. It clears the cache for the current model and re-probes every selected
  server from scratch — for when you suspect a cached result has gone stale and
  want a fresh pass. Prune mode always bypasses the cache so the destructive
  pass sees every config's current state.
- **V2Ray Proxy**: add a **Clear Cache** button (with confirmation) and a
  matching `POST /api/xray/configs/model-filter/clear-cache` endpoint that
  wipes cached results — either for a single model (`{ model }`) or for all
  models. The endpoint refuses to run while a filter job is in progress
  (`409`) to avoid racing with in-progress writes.
- **V2Ray Proxy**: surface per-server model-filter status in the server list.
  Each row now shows a `✓ <time>` / `✗ <time>` / `untested` badge indicating
  the most recent probe outcome for the currently-configured filter model, and
  the Model Proxy Filter card shows an aggregate cache summary
  (`Cache: N results · M for current model`).

# v0.6.10 (2026-08-11)

## Features
- **V2Ray Proxy**: make the subscription auto-sync interval user-configurable
  on `/dashboard/xray` instead of a hardcoded hourly schedule. The Sync card
  now exposes a dropdown with presets (10 min / 15 min / 30 min / hourly /
  every 3/6/12 hours / daily / every 3 days / weekly), a "Never (manual only)"
  option that fully stops the scheduler, and a "Custom…" mode that accepts any
  value in minutes, hours, or days. Values are clamped to a 5-minute minimum
  (no upper bound, so external subscriptions can use longer intervals), and
  changing the interval live-restarts the scheduler via the settings API with
  no server restart required. The header badge and the quick-start guide now
  reflect the active interval dynamically.

# v0.6.9 (2026-08-11)

## Fixes
- **V2Ray Proxy**: make `/dashboard/xray` show active synced servers by
  default instead of mixing inactive stale rows into the main server count.
  The page now includes Active / Inactive / All views plus catalog totals.
- **V2Ray Proxy**: add configurable cleanup for inactive servers after sync.
  Missing subscription entries are still marked inactive first to preserve
  history, then deleted according to the selected retention window.

# v0.6.8 (2026-08-11)

## Fixes
- **V2Ray Proxy**: make Model Proxy Filter safer while live model requests are
  running. The filter now supports an opt-in pause mode that waits for live
  traffic to go quiet before starting more probes, while still allowing users
  to disable that behavior and run continuous parallel checks.
- **V2Ray Proxy**: reduce model filter probe output to `max_tokens: 1`, change
  the recommended/default thread count to 2, and avoid pruning the currently
  running Xray config.

# v0.6.7 (2026-08-11)

## Fixes
- **V2Ray Proxy**: silence internal Model Proxy Filter probe logs. Expected
  failed proxy probes still mark configs as failed/prunable, but no longer
  spam the main request log with `POST`, `DONE`, `[PROXY]`, or scary `ERROR
  502` lines.

# v0.6.6 (2026-08-11)

## Features
- **V2Ray Proxy**: extend Model Proxy Filter with an opt-in auto-filter toggle
  after subscription sync, an option to check all active configs, and bounded
  parallel checking with a recommended default of 4 threads.

# v0.6.5 (2026-08-11)

## Features
- **V2Ray Proxy**: add a model-aware proxy filter on `/dashboard/xray`. The new
  **Model Proxy Filter** card tests synced v2go/Xray configs against a real
  routed chat request such as `oc/deepseek-v4-flash-free`, reports usable vs
  failed IPs, and can permanently delete failing configs when requested.
- **V2Ray Proxy**: test model reachability through isolated temporary Xray
  processes with strict SOCKS routing, so the probe uses the same provider,
  model, executor, and translator path as normal `/v1/chat/completions` traffic.

## Fixes
- **V2Ray Proxy**: make the auto-managed `V2Ray Proxy (v2go)` pool strict by
  default. If the local SOCKS proxy fails, provider requests now fail through
  the normal fallback/rotation path instead of silently bypassing the proxy and
  falling back to direct outbound traffic.

# v0.6.4 (2026-08-11)

## Fixes
- **V2Ray Proxy**: fix first-start after subscription sync on large v2go
  catalogs. The sync stale-marker now computes the actual missing config IDs
  before chunking SQL updates, instead of applying `NOT IN (...)` per chunk.
  This prevents subscriptions with more than 500 configs from accidentally
  marking the entire catalog inactive and causing start to fail with
  `No V2Ray configs available. Run a subscription sync first.`
- **Dashboard Guard**: allow authenticated same-origin dashboard requests from
  private LAN hosts such as `http://192.168.x.x:20128` to call non-strict
  local-only Xray process routes (`install`, `start`, `stop`, `restart`,
  `switch`, `health-check`, and per-config tests). This fixes `Local only: CLI
  token required` when managing the host's Xray proxy from another machine on
  the same LAN.
- **Dashboard Guard**: keep strict local-only routes blocked from LAN/tunnel
  dashboard access. Routes that can reset auth or expose the CLI token, such as
  `/api/auth/reset-password` and `/api/cli-tools/cowork-settings`, still require
  true local access or the CLI token.
- **Endpoint**: replace the external tunnel placeholder/example domain with the
  generic `https://ai.domain.com`.

# v0.6.3 (2026-08-11)

## Fixes
- **V2Ray Proxy**: persist dashboard proxy settings correctly. The `/dashboard/xray`
  page now loads saved Xray settings from `/api/settings`, so Auto Start,
  Auto Rotate, sync interval, SOCKS/HTTP ports, and subscription URL reflect the
  stored values after a refresh instead of falling back to in-memory defaults.
- **V2Ray Proxy**: make setting saves optimistic but verified — failed saves now
  show the API error and revert the toggle locally, while successful saves re-read
  settings from the server to confirm persistence.
- **Dashboard**: use `next/link` for the V2Ray quick-start links to Providers and
  Proxy Pools.

# v0.6.2 (2026-08-10)

## Features
- **V2Ray Proxy UI**: add a quick-start guide card on the `/dashboard/xray` page
  that walks new users through the 4-step flow (install → sync → start → assign
  pool to a provider). Shows only until the proxy is running.

## Fixes
- **V2Ray Proxy**: protect the auto-managed `v2go-xray-managed` proxy pool from
  accidental deletion — the DELETE endpoint now returns 403 for managed pools
  with a message directing users to stop the proxy from the V2Ray Proxy page
  instead (the manager recreates the pool on every start, so deleting it just
  caused confusion)

# v0.6.1 (2026-08-10)

## Fixes
- **V2Ray Proxy**: fix invalid SQLite `ORDER BY` expression in
  `getSelectedXrayConfig` fallback — `(lastLatencyMs > 0 DESC)` is not valid SQL
  (DESC cannot modify a boolean expression). Some SQLite adapters tolerated it
  (sql.js on Windows) but `node:sqlite`/`better-sqlite3` on Linux rejected it
  with `near "DESC": syntax error`, breaking proxy start. Rewritten as a
  standard `CASE WHEN ... THEN 0 ELSE 1 END` expression. Verified end-to-end on
  both Windows and Ubuntu 24.04 Linux.

# v0.6.0 (2026-08-10)

## Features
- **V2Ray Proxy (v2go integration)**: managed local Xray-core proxy client that
  turns V2Ray share links from [v2go](https://github.com/Danialsamadi/v2go) into a
  SOCKS5/HTTP proxy 9Router can route through — giving every provider access to
  premium-grade proxies that auto-update hourly.
  - Auto-syncs ~1,000+ working V2Ray configs (VLESS/VMess/Trojan/SS) from v2go's
    GitHub Actions pipeline every 60 minutes via `raw.githubusercontent.com`
  - Bundles the official Xray-core binary (v26.3.27, MPL-2.0) — auto-downloaded
    per OS/arch on first use, no manual install required
  - Full web dashboard at `/dashboard/xray`: start/stop, server selection with
    country/protocol filters, per-server latency testing, auto-rotation when the
    active server dies, live log viewer, sync status, and settings
  - Creates a managed Proxy Pool ("V2Ray Proxy (v2go)") automatically — assign it
    to any provider connection via the existing Proxy Pools UI and requests route
    through the active SOCKS proxy
  - Faithful JS port of v2go's share-link parser (`converter.go`): handles VLESS,
    VMess, Trojan, Shadowsocks, Hysteria2 with REALITY/TLS/WebSocket/gRPC/XHTTP
    transports, including the XHTTP host-safety guard that prevents Xray crashes
  - Settings: `xrayEnabled`, `xrayAutoStart` (boot), `xrayAutoRotate`,
    configurable SOCKS/HTTP ports, subscription URL, sync/health-check intervals
  - DB schema v2: `xrayConfigs` (catalog) + `xraySyncState` (singleton)

## Fixes
- (testing) fix Windows zip extraction: use PowerShell `Expand-Archive` instead
  of `tar -xf` (GNU tar in Git Bash cannot extract zips)
- (testing) fix Windows process kill: use PowerShell `Stop-Process` instead of
  `taskkill` for reliable detached-process termination
- (testing) fix single-config test isolation: spawn temp xray on ephemeral port
  without touching the shared PID file, so the active proxy is never disturbed
- (testing) fix HMR state reconciliation: `getStatus()`/`runHealthCheck()` infer
  "running" from PID file + settings when in-memory state resets on dev reload
- (testing) fix Next.js 16 dynamic route params: `await params` (params is a
  Promise in Next 16, not a plain object)
- (testing) fix vmess TCP/http-header parsing: coalesce null host → "" to match
  Go's `url.Values.Get` + `strings.Split` semantics on missing keys

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

## Fork
- **Migrate upstream v0.5.50** — merges decolua/9router upstream v0.5.45 → v0.5.50 (42 commits) into the fork while preserving all custom features: ds2api (DeepSeek Web), gemini-web, genspark-web, proxy rotation, GitHub Releases update mechanism. Fork custom providers renumbered p116-118 → p120-122 to avoid clashing with upstream's new tokenrouter (p116) and selfhosted-stt/tts/embedding (p117-119) registry slots. Conflicts resolved in `open-sse/providers/registry/index.js` (provider renumber), `AddApiKeyModal.js` (union of fork `isCookie` + upstream `qoder` PAT bulk branches), and `i18n/README.{vi,zh-CN}.md` (kept fork banner + section, took upstream tier-diagram translations). Baselines regenerated: 83 providers, 117 alias tokens. Both `package.json` and `cli/package.json` confirmed at `0.5.50` in lockstep per the release SOP.

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets

## Fork
- **Migrate upstream v0.5.40** — merges decolua/9router upstream v0.5.35 → v0.5.40 (16 commits) into the fork while preserving all custom features: ds2api (DeepSeek Web), gemini-web, genspark-web, proxy-group rotation, GitHub Releases update mechanism, DS2API autostart. Upstream merged `kimi-coding` into `kimi` (dual OAuth + API key auth) and added a new `alims-intl` (Model Studio) provider alongside the reverted `alicode-intl` (Coding Plan). Both `package.json` and `cli/package.json` bumped to `0.5.40` in lockstep per the release SOP.

# v0.5.37 (2026-07-18)

## Fixes (test-only — no runtime change)
- **Tests**: `force-stream-config.test.js` mock of `open-sse/rtk/headroom.js` was missing the `formatHeadroomSizeLog` and `isHeadroomPhantomSavings` exports that `chatCore.js` imports (added in upstream v0.5.35's RTK token-saver commit). The mock now exposes the full export surface, so the 2 previously-skipped force-stream tests pass instead of failing with "No 'formatHeadroomSizeLog' export is defined". This was a pre-existing bug in upstream v0.5.35 itself (verified by running on a clean upstream checkout).
- **Tests**: `golden-request.test.js`'s `clean()` helper (which strips dynamic fields before snapshot comparison) now also masks `agentContinuationId` — a per-session `crypto.randomUUID()` added to the OpenAI→Kiro translator by upstream's "Kiro direct session cache reuse" commit. Without this mask the snapshot comparison was flaky (failed on every run with a different UUID). Now deterministic.

# v0.5.36 (2026-07-17)

## Features (inherited from upstream v0.5.33–v0.5.35)
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI (`9router xai video …`)
- **CLI tools**: Grok Build setup — writes `[model.9router]` to `~/.grok/config.toml`
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes (inherited from upstream)
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements (inherited)
- **Perf**: skip inactive background services on startup

## Fork
- **Migrate upstream v0.5.35** — merges decolua/9router upstream v0.5.32→v0.5.35 (27 commits) into the fork while preserving all custom features (DeepSeek Web/ds2api, gemini-web, genspark-web, proxy-group rotation, GitHub Releases update mechanism, DS2API autostart). Upstream's `runHeavyStartup()` perf refactor (gated cloudflared/mitm/quota-auto-ping) is adopted; the fork's `autoStartDs2api()` is preserved as an unconditional step. Both `package.json` and `cli/package.json` bumped to `0.5.36` in lockstep per the release SOP.

# v0.5.32 (2026-07-13)

## Fixes
- **CLI version sync**: the v0.5.32 release bumped `package.json` but left `cli/package.json` at `0.5.31`. Because the CLI launcher reads its own version from `cli/package.json`, it reported `v0.5.31` in the menu and permanently showed "★ Update to v0.5.32" (a false update loop — reinstalling pulled the same mismatched tarball). Both `package.json` files now ship at `0.5.32`, and the release SOP in `CLAUDE.md` documents that the two must move in lockstep.
- **Proxy-Pools**: rotating proxy groups (e.g. "Webshare") were silently ignored at runtime. `resolveConnectionProxyConfig` required a non-empty `proxyUrl`, but group pools intentionally leave `proxyUrl` empty (entries hold the proxies). The validity check now accepts groups with at least one entry.
- **Proxy-Pools (test)**: the `/proxy-pools/:id/test` endpoint always tested `pool.proxyUrl` and failed with "proxyUrl is required" for groups. Group pools now test each entry in parallel, report a per-entry breakdown (`passed/failed/total`), and auto-cool down failed entries.
- **Proxy-Pools (no-auth)**: the auto-rotate pool picker for no-auth free providers filtered pools by `proxyUrl`, excluding groups. Groups are now eligible candidates.
- **Proxy-Pools (strictProxy)**: `strictProxy` was dropped between `resolveConnectionProxyConfig`, `auth.js`, and `chatCore.js`, so a failing proxy silently fell back to direct instead of failing hard. It now propagates end-to-end.
- **Providers UI**: a bound rotating group now shows `Group: name · N entries` instead of an empty proxy URL.

# v0.5.31 (2026-07-12)

## Features
- **Migrate upstream v0.5.30** — merges decolua/9router upstream v0.5.20→v0.5.30 (32 commits) into the fork while preserving all custom features (DeepSeek Web/ds2api, gemini-web, genspark-web, proxy-group rotation, GitHub Releases update mechanism, external tunnel URL). New upstream providers (Grok CLI, Perplexity Agent API, Featherless) and features (PXPipe token saver, Headroom extras, proxy-pool auto-rotate for no-auth providers, deferred startup, version-endpoint caching, Cloudflare-AI accountId bulk import) are now available alongside the fork's custom providers.

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.26 (2026-07-10)

## Features
- **DeepSeek Web: update engine button** — the ds2api provider page now shows an **Update** button when a newer engine version is available (previously the "update available" text appeared with no action to take). Clicking it stops a running engine, waits for the process to release the binary lock (important on Windows), force-re-downloads the latest release, and restarts the engine if it was running. A new `POST /api/ds2api/update` route orchestrates the safe stop → reinstall → restart cycle; the legacy `POST /api/ds2api/install` route is unchanged.

# v0.5.25 (2026-07-10)

## Features
- **Genspark Web provider** — integrates the Genspark Copilot MOA backend as a web-cookie provider, including image generation via the COPILOT_MOA_IMAGE flow. Adds unit-test coverage for chat, image, search, and reasoning paths.

# v0.5.24 (2026-07-09)

## Features
- **Proxy Pools: group entries now support all proxy protocols + batch import** — rotating proxy group entries accept http, https, socks5, socks5h, socks4, and socks4a (matching the full network-layer support), not just http. The entry protocol is auto-detected from the URL. The group form gains a **Batch import** button: paste a proxy list (`protocol://user:pass@host:port` or `host:port:user:pass`) and all valid lines are appended to the group's entries in one go.

# v0.5.23 (2026-07-09)

## Features
- **Proxy Pools: rotating proxy groups** — a proxy pool can now be a "group" holding multiple proxy entries (plus an optional "direct" entry that uses the server's own IP). On each request the resolver picks one entry by rotation mode: **rotate on error** (least-recently-used, the default — spreads load and skips the entry that just failed), **round-robin** (cycle every request), or **random**. When a request fails with a rotatable error (429 / rate-limit / quota / capacity / overloaded / 5xx / 408), the current entry is cooled down (60s for rate-limits, 30s for 5xx) and the next available entry is tried on the SAME account — only falling back to the next account once the group is exhausted. This is especially useful for free providers (opencode, mimo-free, etc.) that rate-limit by IP: put several proxies + the server IP in a group and bind it to the connection / provider strategy. The Proxy Pools page gains a "Rotating proxy group" toggle in the create/edit form with an entries editor (+proxy / +direct buttons) and a rotation-mode selector; the list shows a group badge with mode, entry count, and cooldown summary. Backward compatible — legacy single-proxy pools are unchanged. Also fixes a bug where editing a Deno relay pool downgraded its type to http.

## Features
- **External tunnel URL** — register a tunnel the app does not manage itself (e.g. a `cloudflared` systemd service, or any reverse proxy) under **Endpoint → External tunnel URL**. Combined with *Allow dashboard access via tunnel*, this lets local-only actions — installing/starting/stopping the DeepSeek Web engine, Tailscale & tunnel controls, Headroom, MITM tooling — run over that tunnel after login. See `gitbook/content/en/deployment/cloud.md` → *Cloudflare Tunnel (external / systemd)*.

## Fixes
- **"Local only: CLI token required" over a tunnel** — local-only routes (DeepSeek Web install/start/stop, etc.) were blocked when the dashboard was reached through a tunnel, because `isLocalRequest()` deliberately returns `false` for proxied requests and the browser cannot present a CLI token. The guard now admits these routes over a recognized tunnel when the user has opted into *Allow dashboard access via tunnel* **and** is authenticated. Strict secret-handling routes (`reset-password`, `cowork-settings`) stay loopback-only even with tunnel access enabled, since they expose host secrets / the internal CLI token. Shared tunnel-host detection (`isKnownTunnelHost`) now also recognizes `externalTunnelUrl` in both the guard and the login route.

# v0.5.22 (2026-07-08)

## Features
- **DeepSeek Web (ds2api): proxy groups with rotation strategies** — an account can now reference a proxy group (a named list of proxies) instead of a single fixed proxy, and each request picks a proxy by the group's strategy: **round-robin** (advance every N requests via "sticky"), **random** (uniform per request), or **failover** (retry on the next proxy on transport error or 5xx/408/429, replaying the request body). The DeepSeek Web provider page gains a "Proxy groups (rotating)" section with create/edit/delete (choose name, strategy, sticky count, and pick multiple proxies), and each account row now has a proxy-mode selector (`direct` / `fixed` / `group`) plus a target dropdown. Accounts with a legacy fixed proxy keep working unchanged. The engine is pulled from `vibecoder11200/ds2api` release `v4.6.2-rotation` (6 platform binaries).

# v0.5.21 (2026-07-08)

## Features
- **DeepSeek Web (ds2api): HTTP/HTTPS proxy support + proxy management** — the ds2api engine previously only supported `socks5`/`socks5h` proxies. It now supports `http` and `https` proxies (HTTP CONNECT tunneling, with TLS to the proxy for `https` and HTTP Basic auth). The DeepSeek Web provider page gains: a per-proxy **Test** button (inline ✓/✗ + response time), a **Batch import** modal (paste a proxy list — `protocol://user:pass@host:port`, `host:port:user:pass`, or `host:port` — with a default-type selector, dedupe, and created/skipped/failed counts), and a per-account proxy dropdown to assign or change the outbound proxy on existing accounts (not only at creation). The engine is now pulled from the `vibecoder11200/ds2api` fork (release `v4.6.1-httpproxy`, 6 platform binaries) that ships the proxy patch, so installs/updates no longer override it with the upstream socks5-only build.

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL

# v0.4.44 (2026-05-15)

## Features
- Add Blackbox provider with `bb` alias (#1143)
- Add Xiaomi token plan provider
- Enhance model select modal UX + modal traffic lights (#1111)
- Default Usage dashboard period to Today (#1141)

## Fixes
- Fix Cowork model selection and Windows CLI packaging (#1129)
- Update provider name retrieval for compatibility provider (#1135)
- Update JWT_SECRET handling

# v0.4.41 (2026-05-14)

## Features
- Add jcode CLI tool integration with auto-configuration (#1047)
- Redesign CLI Tools dashboard: grid layout (1/2/3 cols) + dedicated detail page per tool
- Add drag-and-drop reordering for combo models (#1108)
- Add Today period option to Usage & Analytics (#1063)
- Add DeepSeek V4 Pro effort aliases (#950)

## Fixes
- fix(autostart): work on nvm + npm 9/10, actually register with launchctl (#1104, fixes #1082)
- Fix Ollama usage not tracked/shown in UI (#1102)
- fix(opencode): preserve DeepSeek reasoning content (#1099, fixes #1093)
- Fix TUI input lag (replace enquirer with native readline, persistent raw mode)
- fix(ui): show API key row actions on mobile (#1112)

## Improvements
- Sync DeepSeek TUI card style with other CLI tools (badges, layout, manual config modal)
- Add official logos for Amp CLI, jcode, Qwen Code (replace generic icons)
- Resize deepseek-tui icon 1024→128 with padding for visual consistency

# v0.4.39 (2026-05-14)

## Fixes
- fix(docker): restore `/app/server.js` (v0.4.38 regression)

# v0.4.38 (2026-05-13)

## Features
- Add DeepSeek TUI as CLI tool in dashboard (#1088)

## Fixes
- Fix broken Docker image in v0.4.36/v0.4.37 (#1096, #1097)

## Improvements
- Clean Docker tags + clearer pulls badge

# v0.4.37 (2026-05-13)

## Improvements
- Security hardening — upgrade recommended

# v0.4.36 (2026-05-13)

## Features
- Add MiniMax TTS provider support (#1043)
- Docker images now published on both Docker Hub (`decolua/9router`) and GHCR — pull from your preferred registry

## Improvements
- Replace browser confirm dialogs with custom ConfirmModal (#1060)

## Fixes
- Fix Docker `Cannot find module 'next'` error in standalone build
- Restore /app/server.js in Docker standalone build (#1064, #1067)
- Fix CLI TUI menu arrow-key escape sequences leaking (^[[A^[[B)
- Switch macOS/Linux tray to systray2 fork (fixes Kaspersky AV false-positive) (#1080)
- Fix zoom controls contrast in topology view (#1066)// retry build
