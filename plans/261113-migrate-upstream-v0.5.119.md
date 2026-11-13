# Migrate upstream decolua/9router v0.5.116 → v0.5.119 into fork

**STATUS: DONE — see Verification log below.**

## Verification log (2026-11-13)
- 3-way apply: 110 files clean + 6 conflicts, all resolved by hand
  (errorConfig fork `providers:[]` schema + nvidia rule, registry renumber
  p154/p155→p153/p154, opencodeTlsClient fork-LRU-keeps-all + x-9r-proxy-via
  port, proxyFetch imports + claude-cli block + proxyCapable-block REMOVED
  (fork bridge mechanism instead), opencode overload-loop layered over fork
  freeLaneFetch, proxy-pools imports + body auto-merged).
- Fork-only additions during merge: bridge path accepts BOTH flag shapes
  (options.directFetchProxyBridge OR directFetch.proxyBridge — direct
  proxyAwareFetch callers work without base.js); strictProxy threaded into
  fetchWithTlsFallback (5th param) for the bridge fail-close; wreq client
  sets credential-free x-9r-proxy-via; PROXY ROUTING VERIFIED dbg line.
- npm install repaired a stale node_modules (uuid 13.0.2 was declared since
  the initial commit but never installed — new usage tests import it via
  cursorChecksum). undici stays 8.12.4; engines.node >=22.15.0 declared.
- Test adaptations: opencode-wreq-proxy-routing (sessionPool/sessionKey,
  proxyBridge flag, {proxyUrl} ctx assertion), opencode-executor-proxy-
  forwarding (localDb legacy-engine + alerts + bunLane mocks), nvidia-params
  converted node:test→vitest (assertions unchanged), usage-route-lease mocks
  isStrictProxyFailure. opencode-overload-retry runs VERBATIM. known-fails
  +1: second gotScraping case (fork disabled got-scraping; under-documented).
- Full suite (from tests/, 5921 tests): 5745 passed / 55 failed / 14
  expected-fail. Failing-set reconciliation (programmatic vs known-fails):
  every entry matches known-fails or a documented flaky class EXCEPT 8 —
  3 were golden-url-header cline/clinepass/kimi pinned to version string
  0.6.77 (stale since v0.6.78; regenerated with -u → 178/178 green), 4 were
  load-flakes that pass in isolation (codex-image-usage-persistence,
  key-access-handlers, runtime-install-scope ×2), and request-details-tab
  is the documented EPERM temp-dir-cleanup Windows class (22/22 tests run
  green; only the tempdir unlink fails). **0 failures in migrated or new
  upstream suites.**
- providers-baseline regenerated (108 tracked providers incl. synthetic +
  sensenova-intl; verify-providers byte-for-byte equal). alias-baseline
  3-way (+sensenova-intl, +synthetic; fork aliases intact). golden-url-
  header snapshot: claude-cli 2.1.280→2.1.322 + synthetic entries via
  3-way.
- NOTE (process): a mid-session parallel commit c1f8f132 (user's children
  N/M fix, CHANGELOG + xray/FreeLaneCard only) landed before the apply —
  no overlap, apply stacked correctly on top.

## Post-release review round (v0.6.89, 2026-11-13 evening)
Three parallel code-reviewer passes over 50d46f47:
- **Completeness audit**: 39/39 upstream commits verified landed (byte-
  equality for 91 non-diverged files + re-apply proof for diverged set);
  0 P0/P1. P2s: vitest unpinned (version roulette), user's untracked
  zz-tmp-failfast matching the suite glob (left for user decision).
- **Providers/registry/UI review**: clean; P3s only — modelScoped doc
  comment (fixed), nvidia degraded account-wide testStatus stamp (upstream
  parity, product-decision follow-up), bulkDelete count cosmetic (upstream-
  identical, left).
- **Transport review** — 3 P1s, all runtime-reproduced, all FIXED:
  1. fork 429 hooks evicted on overload-429s too (healthy-session churn)
     → hooks removed; retry loop's session branch is the single eviction
     point.
  2. hook's cooldown timestamp blocked the retry loop's drop →
     forgetOpencodeSession unreachable on real 429 paths (hinted/translated
     sessions stuck until TTL) → same fix; new real-path suite
     opencode-session-rotation-real-path.test.js pins both behaviors
     through real base + real proxyAwareFetch (mocked-base upstream suite
     cannot see this).
  3. strictProxy catches REPLACED adapter errors → noRetry/statusCode/code
     lost → base re-retired lane fail-fasts 3× + double-wrapped message →
     all 3 catch sites annotate (message + proxyInfra) instead.
- P3s fixed in passing: bitwise-or → two statements; stale-socket recursion
  comment; errorConfig modelScoped doc.
- Environment hardening: vitest ^5.1.0 pinned (root devDependencies +
  tests/package.json); reviewer-era tests/node_modules (vitest 4.1.10)
  removed — full-suite run #3 had silently used it; run #4 (final) under
  pinned 5.1.0. npx cache entries for vitest cleared.
- Verification: 12 affected suites 75/75; full suite final run under pinned
  vitest: failing set == v0.6.88 baseline minus the 3 regenerated golden
  cases, modulo the rotating flaky family (siblings swap between runs);
  0 regressions. Reviewer temp repro (econreset-repro.test.js) confirmed
  deleted, not a repo file.
- Final reconciliation catch: opencode-executor-proxy-forwarding failed
  FILE-LEVEL under 5.1.0 — the one NEW-vs-baseline entry that was NOT a
  flake. Root cause: upstream's vi.hoisted/vi.mock calls lived inside it();
  vitest ≥4 rejects them at collection (only 3.x tolerated). Mocks hoisted
  to module top level (same shape as the real-path suite); the two other
  NEW entries (cli-launcher-process, runtime-install-scope global=true)
  re-verified green in isolation — load flakes. detect_changes on the
  staged fix set: medium risk, 6 symbols, all expected (ERROR_RULES + 5
  proxyFetch fns; 4 processes via proxyAwareFetch).

**Upstream range:** `1339107e..1855aa44` (39 commits, 116 files, +3802/−266).
`1339107e` = v0.5.116 — already migrated (fork commit b496b331, released as
fork v0.6.77). First new commit is cdcd09cc (parent = 1339107e, verified).
Upstream tagged v0.5.119 twice (54a88d04 then 1855aa44 after more fixes);
final target = **1855aa44**. Fork baseline: v0.6.87 (99bb0818).
Fork release target: **v0.6.88**.

**Strategy:** surgical 3-way apply (`git diff --binary 1339107e v0.5.119
| git apply --3way`), NOT `git merge` — same as all previous migrations.

## Exclusions at apply time
- README.md / cli/README.md — user policy (upstream touches them for the
  undici/engines note; skip).
- CHANGELOG.md — fork writes own entry.
- package.json / cli/package.json — version bump manually to 0.6.88;
  undici + engines handled per DECISION below.
- tests/__baseline__/providers-baseline.json — regenerate via
  scripts/snapshot-providers.mjs (fork baseline carries fork providers).

## DECISION 1 — undici 7.x vs 8.x (94f141dd) — ANSWERED: B (stay 8.12.4)
Upstream reverted undici ^8.12.3 → ^7.30.2 (undici 8 imports fail on Node
< 22.15: zlib.createZstdDecompress bind at import; stale-socket fix + CVEs
are in 7.30.2 too; eyeballs/ecdhCurve verified on 7.30.2). The code diff of
the revert is COMMENTS ONLY in proxyFetch.js.
**User chose: keep undici ^8.12.3 (installed 8.12.4).**
Apply: skip the dependency downgrade hunks; add honest engines floors
instead — root package.json `"node": ">=22.15.0"` (fork comment: undici 8
requires it), cli/package.json engines → `>=22.15.0` (upstream's >=20.18.1
assumes their 7.x). ProxyFetch comment hunks: adopt the neutral wording
(connect-level options belong in `connect`) minus the "undici 8 rejects"
specifics — actually keep fork's undici-8-accurate comments as-is; only take
upstream hunks where they add new code.

## Upstream inventory (39 commits → thematic groups)

### Transport / compat
1. 94f141dd undici 7.x + engines >=20.18.1 (root + cli manifests, comments).
2. 97b2c545 zstd: NEW utils/zstdCompat.js ACCEPT_ENCODING (Node >= 22.15
   gate); validate route + deepseek-web + grok-web advertise via it.
3. ec165e1c stt: undici FormData in sttCore.js (Next polyfill breaks
   multipart serialization; top-level await import with global fallback).
4. 9ae6e147 stream.js: single [DONE] sentinel — passthrough tail "data:
   [DONE]" is not forwarded raw (glues onto framed one, #5592); buffered
   SSE path sets streamDoneSent when upstream already sent it.

### OpenCode free lane (HEAVIEST merge — fork has bun lane + rotation)
5. 989b1eec overload retry + session drop: OPENCODE_OVERLOAD_* consts (8
   attempts, 800ms base/4s cap backoff), classifyRejection (429 "overloaded"
   → retry; other 429/403 → session), forgetOpencodeSession (value-match
   drop across both session stores), execute() retry loop + aborted handling.
   FORK ALREADY HAS: cooldown-limited session rotation on any 429
   (shouldRotateStableSession/evictStableSessionForRotation, 10-min cooldown,
   exit-keyed sessions) — same #5559 problem, different shape.
   **Merge plan:** keep fork freeLaneFetch (bun lane + legacy + rotation) as
   directFetch; layer upstream retry loop around super.execute; on
   "session"-class rejection call fork's cooldown-gated evict (avoids
   mint-storm when whole exit IP is capped) + keep upstream's
   forgetOpencodeSession exported (value-match drop) wired for
   upstream-test compatibility.
6. a76c2afc wreq proxy carry: upstream adds directFetch.proxyCapable opt-in
   + proxyAwareFetch adapter branch (before MITM DNS) + safeProxyHost/
   safeTargetHost dbg log + strictProxy wrap; opencodeTlsClient keys wreq
   sessions by (profile, proxy).
   FORK ALREADY SOLVED THIS (v0.6.79 lane work): freeLaneFetch.proxyBridge
   flag → base.js sets options.directFetchProxyBridge → fetchWithTlsFallback
   calls directFetch(url, options, { proxyUrl }); opencodeTlsFetch already
   takes proxyUrl and sessionKey(profile, proxyUrl) LRU already exists.
   **Merge plan:** do NOT add upstream's parallel proxyCapable branch (dead
   code on fork); DO port upstream's 3 new test files adapted to the fork
   mechanism; DO adopt the dbg "PROXY ROUTING VERIFIED | transport=adapter"
   line + strictProxy error wrap into the fork's bridge path.

### Claude
7. 43bc940e live CLI version + live models: NEW utils/claudeCliVersion.js
   (npm resolve, 6h cache, CLAUDE_CLI_VERSION pin, floor 2.1.322);
   shared.js CLAUDE_CLI_VERSION → floor + setClaudeCliFallback; claudeCloaking
   billing header uses getClaudeCliVersion(); proxyAwareFetch rewrites
   claude-cli/x.y.z headers (ensureClaudeCliVersion background refresh);
   models route claude config → OAuth bearer + oauth-2025-04-20 beta,
   ?limit=1000, display_name mapping; providers/[id]/page.js adds claude +
   commandcode to LIVE_MODEL_CATALOG_PROVIDERS.
8. 10b0afa4 Claude Code 2.1.290 advertise (superseded by 43bc940e's live
   resolver; net effect arrives via 7).
9. f4f5f183 claudeCloaking: rename tool_reference blocks inside tool_result
   content when cloaking (CLAUDE_BLOCK consts); +fe0d1a29 usage request
   details show output_tokens (tokenDisplay).
10. 12e7930e retire Fable 5.1 from catalogs (claude.js, github.js,
    opencode-zen.js); 8aef7480 add Fable 5.2 + Haiku 5.5 + Gemini 4 Carbon
    (claude.js registry, capabilities fable-5-2/haiku-5-5 rows, pricing? no —
    4c7804ef pricing gemini-4 real rate).
11. 29f3db11 src/sse/services/model.js fallbackToClaudeOAuth: bare claude-*
    with no anthropic connection but active claude OAuth → provider claude.
12. ce1e0c3c quotaAutoPing: catch Claude resets missed between ticks
    (cached-deadline catch-up ping + failure-cooldown retention).

### Providers / registry (renumber required — fork owns p131-135)
13. 14b27dc7 sensenova-intl NEW provider (token.sensenova.ai; own catalog,
    caps 262144 ctx; validate via /v1/models; image adapter; icon png).
    Upstream p154 → **fork p153**.
14. ebe398a9 + 402230ed synthetic.new NEW provider (api.synthetic.new,
    aliases syn/synthetic-new, validate+usage via /v2/quotas, usage/
    synthetic.js NEW, fal-style key test). Upstream p155 → **fork p154**.
15. fa73c938 CommandCode live catalog: NEW services/commandcodeModels.js
    (public catalog), models route customResolver + v1/models LIVE resolver
    + page.js live-catalog set + registry models trimmed (60a1b365 adds
    gemini-4-carbon + claude-fable-5-2 there).
16. 5e54377b xiaomi-tokenplan model list refresh; 2275bc0d nvidia NIM
    hardening (registry catalog + paramSupport + capabilities tools flags +
    errorConfig "degraded" modelScoped rule + accountFallback modelScoped
    passthrough).
17. 5f925cf9 clinepass quota tracker: NEW usage/clinepass.js (OAuth WorkOS
    JWT or API key), usage.js handler + authType plumbed, ProviderLimits
    utils rows, registry authModes.
18. 201e81fb MiniMax desktop lease usage: usage route isLeaseConnection
    bypass + usage.js lease handler (minimaxCodeLease exists in fork).
19. 597ee684 qoder catalog display names: applyQoderModelNames in
    selectableModels/ModelSelectModal/page.js + qoderModels normalize;
    850eb573 dashboard custom model type explicit (AddCustomModelModal
    passes type through, providerCustomModels kindForCustomModel,
    ModelsCard); 3a936d13 SearXNG in Web Search picker
    (NO_AUTH_PROVIDER_IDS now from AI_PROVIDERS, moved to
    selectableModels.js export).
20. aaf9b65f Codex CLI 0.167.1; cdcd09cc antigravity ~optional strip
    (registry + gemini translator tolerance); 4c7804ef gemini-4 pricing.

### UI / misc
21. 12256f72 proxy-pools: status filter + visible-range selection with
    shift-click (NEW shared/utils/proxyPoolSelection.js; page.js rework).
    Fork's page has ~500 lines of fork mods (xray integration) — HAND MERGE.
22. 0760c302 muse-web exported JSON cookie normalize
    (webCookieAuth.normalizeCookieHeaderInput + webIdentity probe + muse-web
    executor); f8fd61aa explicit input IDs (Input.js htmlFor + labels).
23. 85c91c4e + 5bb041ed codex-image: native images/edits endpoint + terra
    fallback when account rejects gpt-6-sol; 0cf07ccf fal key validation
    via model catalog (validate route fal-ai case).

## Fork-conflict map (21 fork-diverged files touched upstream)
- **open-sse/executors/opencode.js** — HEAVIEST: fork bun lane + rotation vs
  upstream retry loop (group 5 plan above). Hand-merge.
- **open-sse/utils/proxyFetch.js** — add claude-cli header rewrite (group 7)
  + comment updates (group 1); upstream proxyCapable branch NOT added (group
  6); adopt dbg log + strictProxy wrap on fork bridge path. Hand-merge.
- **open-sse/services/opencodeTlsClient.js** — fork already has proxy-keyed
  sessions; verify upstream's sessionKey shape == fork's, adopt any missing
  bits (e.g. strictProxy handling, dbg).
- **open-sse/providers/registry/index.js** — renumber p154/p155 → p153/p154
  with fork-style comment block.
- **src/app/(dashboard)/dashboard/proxy-pools/page.js** — fork ~500-line
  xray mods; hand-merge filter + selection semantics; proxyPoolSelection.js
  applies clean.
- **src/app/(dashboard)/dashboard/providers/[id]/page.js** — fork mods
  around AddCustomModelModal/qoder; 3-way + verify.
- **capabilities.js / usage.js / quotaAutoPing.js / errorConfig.js /
  accountFallback.js / webIdentity.js / model.js (src/sse) / v1/models route
  / models route / validate route / testUtils.js / usage route /
  ModelSelectModal.js / stream.js / imageProviders/index.js** — fork mods
  elsewhere in file; 3-way + verify each.
- **tests**: ~28 new/changed suites. opencode-wreq-proxy-* (3 files) adapted
  to fork proxyBridge mechanism; opencode-overload-retry adapted to
  cooldown-gated evict; golden-url-header snapshot regenerated (version
  strings 0.6.87→0.6.88 + claude-cli floor 2.1.322); providers-baseline
  regenerated (fork providers + new upstream entries); alias-baseline 3-way.

## Verification plan
- npx vitest run full suite from tests/; compare vs known-fails.txt (same
  set + all new upstream suites green).
- Regen providers baseline: scripts/snapshot-providers.mjs.
- npm run build (webpack) — spot-check zstd/undici/claudeCliVersion chunks.
- detect_changes() before commit; CI master + tag v0.6.88; cli-release
  tarball; edit release body; push.
