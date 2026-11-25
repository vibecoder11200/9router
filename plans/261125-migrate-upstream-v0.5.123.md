# Migrate upstream decolua/9router v0.5.119 → v0.5.123 into fork

**STATUS: DONE — see Verification log below.**

## Verification log (2026-11-25)
- 3-way apply: 147 files clean + 5 conflicts, all resolved by hand
  (chatCore fork `onStreamError` param + upstream `reaAllowEnabled` threaded
  together; registry renumber p156/157/158 → p155/156/157 with fork comment
  block; validate route keeps fork `/usage` probe + adds upstream's
  `x-opencode-session` header derived from key hash; verify-alias + nous
  line the fork had been missing since v0.5.104 + 3 new provider rows;
  golden-request i18n comment).
- Fork-mod preservation proof: for all 39 fork-diverged files touched by
  upstream, diff(forkHEAD, upstream@1855aa44) == diff(working, upstream@5ae63d22)
  for 28/39 files; the 11 exceptions are exactly the 5 hand-merged conflict
  files + 6 policy files (manifests/baselines/CHANGELOG handled separately).
  Zero fork mods lost.
- Manifests: v0.6.92 root+cli (lockstep); next 16.3.4-pin dropped → ^16.4.6
  (win32 SWC binary verified present on npm before deciding; user chose full
  adoption), @next/third-parties ^16.4.6, eslint-config-next 16.4.6,
  node-forge ^1.4.3 (installs 1.4.4), overrides +minimatch ^11.0.1
  (11.0.9) +brace-expansion ^5.0.13 (5.1.0). tests vitest stays ^5.1.0
  (upstream's 4.1.12 hunk skipped — fork line).
- Registry: 153 providers import cleanly; renumbered p155 opendesign-go,
  p156 deeprelay, p157 qwencloud (fork offset −2 maintained).
- Baselines: providers-baseline regenerated (111 providers, verify
  byte-for-byte equal); alias-baseline snapshotted (142 tokens — fork was
  missing the nous row since v0.5.104, now complete); oauth-urls equal;
  golden-url-header regenerated with -u (184/184; the 3 stale-version
  cline/clinepass/kimi entries pinned to 0.6.88 since v0.6.89 now current).
- Full suite (tests/, vitest 5.1.0): pre-migration baseline 5963 tests /
  5791 passed / 51 failed / 14 expected-fail; post-migration 6237 tests
  (+274) / 6082 passed / 48 failed. Failing-file set: IDENTICAL to baseline
  minus golden-url-header (regenerated). verify-no-regression gate flags 3
  entries — mimo-free.live bootstrap + xai-oauth ×2 — all three also failed
  in the PRE-migration baseline run (live-service: xAI returns invalid_grant
  for test codes; mimo bootstrap is a live gate), i.e. environmental, not
  migration regressions; left out of known-fails.txt per fork convention.
- 36/36 new + upstream-touched test suites green with ZERO adaptation
  (both vi.mock uses in the new suites are module-top-level — vitest 5.1.0
  collects fine; the v0.6.89 in-it() hoist lesson did not recur).
- npm run build (webpack, next 16.4.6): PASS — all routes compiled, standalone
  assets + opencodeBunSidecar.mjs copied by postbuild.

**Upstream range:** `1855aa44..5ae63d22` — but the effective range per user
instruction starts at **db83e88b** (first new feature commit; d1970ac9 between
them is a version-bump-only commit, skipped). 34 commits, 152 files,
+7396/−478, 38 new files, no merges (linear). Final target = **5ae63d22**
(tagged v0.5.123, 2026-11-22). Fork baseline: v0.6.91 (a22b9dab).
Fork release target: **v0.6.92**.

**Strategy:** surgical 3-way apply (`git diff --binary 1855aa44 5ae63d22
| git apply --3way`), NOT `git merge` — same as all previous migrations.

## Exclusions at apply time
- package.json / cli/package.json / tests/package.json — hand-merged
  (version bump to 0.6.92, deps per DECISION 1; tests vitest stays ^5.1.0).
- CHANGELOG.md — fork writes own entry.
- tests/__baseline__/providers-baseline.json — regenerate via
  scripts/snapshot-providers.mjs (fork baseline carries fork providers).
- tests/__baseline__/alias-baseline.json — 3-way by hand.
- README.md / cli/README.md — not touched by upstream in this range anyway.

## DECISION 1 — toolchain bump (e180e752) — ANSWERED: ADOPT FULLY (user choice)
Upstream bumps: next ^16.4.2→^16.4.6, @next/third-parties ^16.2.9→^16.4.6,
eslint-config-next 16.4.2→16.4.6, node-forge ^1.3.3→^1.4.3 (root+cli), NEW
root overrides {minimatch ^11.0.1, brace-expansion ^5.0.13}, tests vitest
^4.0.0→^4.1.12. Fork had pinned next 16.3.4 because 16.3.5 shipped without
@next/swc-win32-x64-msvc (e95c3d61) — binary EXISTS for 16.4.6 (npm-verified).
**User chose: bump next to ^16.4.6 and adopt the whole manifest set.**
vitest stays on fork's ^5.1.0 line (upstream's 4.1.12 is their line, fork
re-based its suites on 5.1.0 in the v0.6.89 hardening; skip their hunk).
Apply: npm install + full webpack build verification required.

## Registry renumber (fork owns offset −2 since v0.5.109 migration)
Upstream adds p156 opendesign-go, p157 deeprelay, p158 qwencloud →
**fork p155 / p156 / p157** with fork-style comment block. Upstream p151
uc-web / p152 runcrate / p153 nace / p154 sensenova-intl / p155 synthetic
already map to fork p149/p151/p152/p153/p154.

## Upstream inventory (34 commits → thematic groups)

### New providers + gateway-quota usage tracking (HEAVIEST new code)
1. db83e88b OpenDesign Go + DeepRelay: NEW registry/{opendesign-go,deeprelay}.js,
   NEW usage/{opendesign,deeprelay}.js (323L/175L), synthetic.js gateway-quota
   rework (+123L shared tracking), usage.js +6, ProviderLimits/utils +21,
   providerConnectionResponse +9, 3 icons, 3 test suites.
2. dbe446d0 Alibaba Token Plan dual-endpoint + qwencloud: NEW
   registry/qwencloud.js (75L), alitp-intl.js +30, capabilities +22,
   usageTracking.js +15, chatCore/requestDetail.js +4, icon.

### Token-saver / system prompt
3. fdd942de REA allow-prompt toggle: NEW translator/concerns/systemPrompt.js
   (180L), chatCore.js +8, settingsRepo +2, sse/handlers/chat.js +1,
   TokenSaverClient.js +31, system-prompt-strip.test.js 225L.

### i18n cleanup
4. c0feb3a0 leftover VI strings/comments → EN (appConstants, opencode.js
   2 lines, qoder, injectDisplayToRegistry, GenericCliToolCard,
   constants/providers, verify-no-regression, golden tests ×4,
   opencode-free-tool-choice, opendesign-usage tests).

### Model catalogs / capabilities
5. 374e17b8 codex GPT 6.2 Sol + Astra; 7d32657c kimi K3.1 Code ctx;
   ba3bba47 nvidia Nemotron 3 Ultra tools+1M window.
6. a851a89c nvidia live embedding models + input_type: NEW
   config/embeddingParams.js, embeddingsCore, models/providers schema,
   EmbeddingExampleCard, tests.
7. 213558f1 mistral string text_delta for array chunks + Large 4 limits.
8. 4e548583 combo seat context limits + opencode free-model windows
   (capabilities +10, v1/models route +38).
9. 6e3c16a1 usage charts billion/trillion formatting (NEW tokenDisplay.js
   extracted; 3 chart components; request-detail test).

### Cloudflare / SystemOne
10. 46f488b1 clef/clef-omni/clairic + custom upstreamModelId (systemoneCore
    +55, aliasRepo, models/custom + ping routes, GenericExampleCard, test).
11. 35b920c6 unwrap Cloudflare result envelope (systemoneCore +9).
12. ecb4d49e prune deprecated CF models (registry/cloudflare-ai, test).

### Kiro
13. 0957919c CreateResponse (/v1/responses) fallback on 429
    USER_REQUEST_RATE_EXCEEDED: NEW utils/kiroCreateResponse.js (381L),
    executors/kiro.js +115, kiroConstants, test 367L.
14. ada236da Kiro IDE 1.4.154 identity + Hydrogen tiers: NEW
    shared/kiroIdentity.js + config/kiroClient.js.
15. 1da78e2b kiro identity on token refresh (executors/default,
    tokenRefresh/providers, testUtils).

### Antigravity (8 commits)
16. c779db2b OpenClaw prompt header + live model catalog; bb399170 Hermes
    prompt strip fake-429; 05fa58b8 fingerprint Hub 2.33.0; e37cb78e lead-gen
    identity prompt; 109e4816 Gemini 4 Hydrogen + long decode (NEW
    utils/geminiLongDecode.js 231L) + prompt-rejection recovery; 767d7aeb
    model ids + thinking tiers; bc3a88b9 test alignment; 6b8b7ceb client
    identity + UA shape (antigravityIdeVersion +37).
    Touches: appConstants (heavy), executors/antigravity.js (+130 net),
    executors/default.js, providerModels, capabilities, pricing, registry
    {antigravity,gemini}, thinkingLevels/ thinkingUnified, mitm/config,
    mitm/antigravityIdeVersion, cliTools constants, antigravityQuota,
    usage/google, shared.js, cli/src/cli/menus/providers.js, providers/[id]
    page.js, models route, testUtils.

### Misc providers
17. ef55a10c qoder multipart sign (qoder/attachments + cosy, test).
18. 72ad720c elevenlabs TTS refresh + live model list + OpenAI voice field:
    NEW media-providers/tts/elevenlabs/models route, ttsProviders/elevenlabs
    +73, ttsModels/ttsCore/index, registry/elevenlabs, TtsExampleCard,
    tts.js handler, test 161L.
19. 971ae638 client billing header kept out of cached Claude system prompt
    (concerns/message, claude-to-openai, openai-to-claude, test).
20. bf5c4192 x-opencode-session for opencode-go validate (validate route +3).

### Cli-tools
21. 1ca07616 Pi model input/reasoning/thinking levels: NEW
    shared/utils/piModels.js (226L), GenericCliToolCard 194L rework,
    pi-settings route, models route, test 303L.
22. 9fb84c94 commandcode + claude live catalogs in pickers (models route,
    ModelSelectModal, selectableModels, 2 tests).

### Proxy-pools
23. f5f3d396 CF worker upload as hand-built multipart (NEW
    src/lib/cloudflare-worker-upload.js, cloudflare-deploy route,
    proxy-pools/page.js +1 line over fork's ~500-line xray mods).

### Release
24. 5ae63d22 version + CHANGELOG (skipped; fork writes own).

## Fork-conflict map (39 fork-diverged files touched upstream)
- **open-sse/providers/registry/index.js** — renumber p156/157/158 →
  p155/156/157, hand-merge.
- **src/app/(dashboard)/dashboard/proxy-pools/page.js** — fork ~500-line
  xray mods; upstream adds 1 line (CF upload) — hand-merge.
- **open-sse/executors/opencode.js** — fork bun lane + rotation; upstream
  only 2-line i18n comment — verify hunk placement, hand-merge.
- **open-sse/handlers/chatCore.js / src/sse/handlers/chat.js /
  src/lib/db/repos/settingsRepo.js** — REA toggle hunks (small).
- **src/app/api/v1/models/route.js** — combo-seats +38 over fork
  free-model-window mods — hand-merge.
- **src/shared/components/ModelSelectModal.js** — live-catalog 31L over fork
  qoder-name mods — hand-merge.
- **open-sse/providers/capabilities.js** — 7 commits' hunks; fork mods
  elsewhere — 3-way + verify each.
- **open-sse/config/appConstants.js** — antigravity consts + i18n; fork
  diverged — 3-way + verify.
- **src/app/(dashboard)/dashboard/providers/[id]/page.js** — antigravity live
  catalog flag; fork mods around — 3-way + verify.
- **validate route / models/test/ping / testUtils.js** — small hunks.
- **media-providers cards (Embedding/Generic/Tts ExampleCard)** — fork
  diverged — 3-way + verify.
- **usage chart components ×3 / TokenSaverClient / constants/providers /
  antigravityQuota / systemone.js / tts.js** — 3-way + verify.
- **tests**: ~24 new suites (verify vitest-5.1.0 compatibility — check for
  vi.mock inside it() blocks, hoist if needed); fork-adapted suites upstream
  now touches (golden-request, golden-url-header, nvidia-params,
  opencode-free-tool-choice) — 3-way + adapt; golden-url-header snapshot
  regen (version strings 0.6.91→0.6.92); providers-baseline regen; alias
  baseline 3-way.

## Verification plan
- Pre-migration baseline full suite (running, /tmp/baseline-run.txt).
- 3-way apply + conflict resolution; registry renumber.
- npm install (next 16.4.6, node-forge 1.4.3, overrides) + npm run build
  (webpack) — Windows SWC binary check.
- Regen providers baseline: scripts/snapshot-providers.mjs; alias 3-way;
  golden-url-header regen with -u.
- Full suite post-migration; reconcile vs baseline + known-fails.txt.
- detect_changes() before commit; CI master + tag v0.6.92; push; gh release
  with fork CHANGELOG body.
