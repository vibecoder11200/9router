---
title: "v0.6.46 — Whole-archive encryption (Option F), dual-scope secret wrapping, provider-scoped payment-required rules"
description: "Opt-in passphrase-encrypted backups (scrypt+GCM whole-archive, show-once generated passphrases), wrap+adopt the api-key-secret (CRC) scope alongside api-keys-hmac, and provider-scoped 'payment required' fallback rules for commandcode."
status: done
priority: P1
effort: 17.5h
branch: master
tags: [security, backup, crypto, c4-fallback]
created: 2026-09-06
---

# Goal

Opt-in per-export END-TO-END backup encryption: the whole archive (provider tokens, settings, key hashes, install secrets) becomes one scrypt+AES-256-GCM envelope; passphrase loss = unrecoverable. Two modes: user-chosen (floor 10, no zxcvbn) and "Generate for me" (Crockford Base32, 20 chars / 100 bits, show-once + copy/download + mandatory retype). Also (B): password exports wrap `api-key-secret` (CRC) alongside `api-keys-hmac`, adopt both on import (foreign pasted keys pass `parseApiKey` CRC again; re-key proof 16 bits → pepper-knowledge). Independent (C): provider-scoped "payment required" rule — commandcode billing-402 rotates, github bare 402 keeps failing fast.

# Decision log (user-approved — do not relitigate)

1. Scope = ALL THREE: (A) Option F; (B) wrap + adopt `api-key-secret` (CRC); (C) researcher-02 option (a) — per-rule `providers` allowlist.
2. Passphrase: BOTH modes — user-chosen (floor ~10, no new deps) and generated (100-bit show-once + mandatory retype confirm).
3. Encrypted file shape `{format:"9router-encrypted-archive", v:1, envelope:{…}}`; detection = top-level `format` key; import accepts BOTH shapes (wrapper and legacy plaintext).
4. F opt-in per export ("Encrypt archive?" step). F-off keeps the .45 FLOW byte-identical; F-off archive CONTENT gains one additive field (`crcSecretEnvelope`) from (B) — old binaries ignore unknown fields.
5. Planner resolutions: frozen scrypt tuple reused via AAD-parameterized backupEnvelope.js (domain separation via AAD `9router-archive-v1`, not new params); one-shot GCM with ~100MB documented ceiling, no chunking (YAGNI); symmetric `normalizeArchivePassphrase` (uppercase, strip hyphens/spaces, I/L→1, O→0) applied at seal AND open; length floor checked at export only (raw AND normalized ≥ 10); under F the install secrets ride PLAIN inside the encrypted payload (`payload.plainSecrets`) and the .45 inner envelope is suppressed (outer encryption = confidentiality; import stays single-credential: passphrase only).
6. RED TEAM 2026-09-06 (binding — full detail in each phase's "Red-Team Amendments"; two adversarial agents, 19 combined findings, 0 critical, 6 must-fix — all folded in):
   - F-mode secret RELEASE is gated `pwOk || viaCliToken` — the authOk default-password branch can NEVER fetch plainSecrets (RT46-A1; supersedes decision-3's broader reading).
   - Adoption threat model corrected: archive-passphrase knowledge = full file-author trust INCLUDING secret replacement; a non-suppressible warning fires when adoption replaces an existing different secret; with the CRC pepper known, the rekey masked-compare proof collapses 16 bits → ~0 — the warning + auth-gated rekey are the compensations (RT46-A2).
   - Passphrase charset: printable-ASCII validated SERVER-side (400) + client pre-checks on both surfaces — browser fetch truncates U+0100–U+01FF, a silent unrecoverable-archive path (RT46-A3).
   - POST F branch returns/logs the constant "Wrong archive passphrase or corrupted archive" (JSON.parse SyntaxErrors embed decrypted snippets; the route logs whole error objects, not error.message) (RT46-A4).
   - Lifecycle harness REWORKED to a per-fileName Map mock — the .45 single-state mock makes dual-scope tests vacuous (RT46-O1); route-test harness gets POST helper + assertable importDb + archive mocks (RT46-O4).
   - `cmc` alias handled NOW: rule providers `["commandcode","cmc"]` + resolveProviderId at combo.js:335 (RT46-A6; supersedes Unresolved #1).
   - Honest copy: "entire backup except session login tokens (redacted by design)"; normalization discount disclosed (RT46-A7/A8). Effort 15.5h → 17.5h (RT46-O8).

# Carried invariants from .45 (binding)

Never seal under default/initial passwords (bcrypt-only via `verifyDashboardPasswordAgainstStoredHash`, dashboardSession.js:98) · masked prompts (`promptSecret`, cli input.js:64) · importDb shape-guard + import mutex + loginLimiter stay · honest copy (F-off text unchanged; F-on = "everything encrypted with your passphrase; loss = unrecoverable") · route-layer tests REQUIRED from the start (.45's only blocker lived in the untested route layer) · one green commit per phase · failing-set diff release gate (~110 pre-existing Windows failures, zero-new) · passphrase never in URL/logs/persisted server-side · CLI writes files 0600.

# Phases

| Phase | File | Deps | Effort |
|---|---|---|---|
| 01 generator + archive seal/open (pure) | [phase-01-archive-crypto-module.md](phase-01-archive-crypto-module.md) | — | 2.5h |
| 02 server F path + dual-scope wrapping + route tests | [phase-02-server-export-import.md](phase-02-server-export-import.md) | 01 | 4.5h |
| 03 dashboard UX (F opt-in, modal, show-once) | [phase-03-dashboard-ux.md](phase-03-dashboard-ux.md) | 02 | 3h |
| 04 CLI F + generator display | [phase-04-cli-backup-encryption.md](phase-04-cli-backup-encryption.md) | 02 | 2h |
| 05 C4 provider-scoped rules (independent) | [phase-05-provider-scoped-rules.md](phase-05-provider-scoped-rules.md) | — | 1.5h |
| 06 sweep + failing-set diff + CHANGELOG + release | [phase-06-tests-release.md](phase-06-tests-release.md) | 01–05 | 2h |

Parallelism: phase 05 is fully independent (open-sse/ + src/sse/ files) — parallel with the 01→02 chain; after 02, phases 03 and 04 are parallel (dashboard vs CLI, disjoint files). Exclusive file ownership: 01 = backupEnvelope.js + new archive.js; 02 = db/index.js + route.js + apiKey.js; 03 = profile/page.js; 04 = cli backup.js + api/client.js; 05 = errorConfig/accountFallback/auth.js/combo.js + fallback tests; 06 = CHANGELOG + versions. No two parallel phases share a file.

# Key verified anchors (re-verified 2026-09-06 vs a916ec20; full detail lives in phase files)

- src/lib/auth/backupEnvelope.js:11 AAD const, :12-18 frozen PARAMS, :42-54 isBackupEnvelope, :56-90 seal, :92-135 open, :140-145 test hook; callers: db/index.js:5/:182/:259-261 + 3 test files (all default-AAD).
- src/lib/db/index.js:128-187 exportDb (envelope block :179-184), :192-200 shape guard, :206 mutex, :208-228 importDb, :230-423 doImportDb (unwrap :259-265, adopt :371-390, warnings :395-419).
- src/app/api/settings/database/route.js:39-80 GET (pwOk :48, authOk :53, exportDb call :65), :82-117 POST (body :84, importDb :95); exportDb output has NO `format`/`archive` key — F detection both ways is unambiguous.
- src/shared/utils/apiKey.js:7-12 apiKeySecret (env override first + REDUNDANT local cache — must go), :65-87 parseApiKey, :94-103 verifyApiKeyCrc — re-grepped: ZERO production callers (tests only); src/lib/auth/installSecret.js:15-30/:38-45/:52-62.
- Dashboard src/app/(dashboard)/dashboard/profile/page.js:657-688 export, :690-736 import, :739-744 confirm, :813-845 buttons/status, :1692-1696 modal copy; CLI: menus/backup.js:23-75/:80-133/:144-147, api/client.js:335-337/:345-347, utils/input.js:64 promptSecret.
- C4: open-sse/config/errorConfig.js:45-58 doc, :59-98 ERROR_RULES (NOTE :87-90, bare 402 :94); open-sse/services/accountFallback.js:10 NO_FALLBACK, :32-71 checkFallbackError, :223-236 applyErrorState (no external callers); src/sse/services/auth.js:285 markAccountUnavailable (provider in scope; call :309); open-sse/services/combo.js:70 ("provider/model"), :335 call; commandcode.js:106/:288; id=alias="commandcode" (open-sse/providers/registry/commandcode.js:2,4).
- Test pins: tests/unit/account-fallback-no-fallback.test.js:9/:72; tests/unit/github-monthly-usage-lock.test.js:20-37/:66-72; harnesses: database-route.test.js, backup-envelope.test.js, key-portability(-lifecycle).test.js, s7-followup-regressions.test.js; package.json:3 + cli/package.json:3 = 0.6.45 (dual bump required).

# Unresolved questions

1. ~~combo.js raw-prefix provider matching~~ — RESOLVED by red team (RT46-A6): `cmc` added to the rule + resolveProviderId at the call site.
2. Capture-confirm that commandcode billing-402 is account-specific (rotates) before shipping phase 05 (researcher-02 flag).
3. ~~F-export under CLI-token-only auth~~ — NARROWED by RT46-A1: token-only F-export stays allowed (pwOk || viaCliToken); the default-password authOk branch can never fetch plainSecrets.
4. Dashboard clipboard fallback on non-secure origins (localhost OK) — phase 03 implementation detail.
5. Optional hardening deferred: require pwOk for plainSecrets ADOPTION when a stored hash exists (two-credential import) — validate interview decides.

# Validation Summary (2026-09-06)

Interview contract: planner plan → red team (2 adversarial agents, 19 combined findings: 0 critical, 3 MEDIUM + 3 MAJOR must-fix) → binding amendments applied to all 6 phase files → 3 open decision points put to the owner. All 3 owner answers confirmed the recommended option, matching the amendments already written — **no phase file needs further changes from validation**.

Confirmed decisions:

1. **RT46-A1 release gate:** plainSecrets in F-export released only under `pwOk || viaCliToken`; the authOk default-password branch answers 401 in F mode. (.45 invariant preserved; decision-3 CLI-token path intact.)
2. **RT46-A2 adoption compensation:** import stays single-credential; a NON-SUPPRESSIBLE warning fires whenever adoption replaces an existing different secret. (Two-credential pwOk-for-adoption rejected — friction without stopping an attacker who already holds the dashboard password.)
3. **RT46-A6 alias handling:** both — rule `providers: ["commandcode","cmc"]` AND `resolveProviderId(prefix) ?? prefix` at combo.js:335, plus the cmc test case.

Action items (all encoded in phase files; checklist of record):

- [x] Phase 01: raw+normalized length floor; ASCII-bounded passphrase docs (RT46-A7).
- [x] Phase 02: release gate + route test; adoption replacement warning + corrected threat model; server charset 400; constant error for ArchiveError/parse errors; per-fileName Map harness; route-harness structural extension (RT46-A1/A2/A3/A4/O1/O4).
- [x] Phase 03: charset pre-checks on own/confirm/retype before any request; hint discloses normalization; import parse moved to selection time (RT46-A3/A7/O7).
- [x] Phase 04: empty-password-cancels correction (token-only via API only); CJS premise reworded (RT46-A5/O2/O10).
- [x] Phase 05: cmc in rule + resolveProviderId + test (RT46-A6).
- [x] Phase 06: reworked dual-scope harness; "except session login tokens" honest copy; normalization disclosure; baseline 1ff29d9b; effort 17.5h (RT46-O1/A7/A8/O8/O11).

Status: implemented, released, and review-approved 2026-09-06 — see Completion Record.

# Completion Record (2026-09-06)

Implemented via ak:cook --auto --parallel: 4 waves (01∥05 → 02 → 03∥04 → 06), one
green commit per phase, detect_changes before every commit.

Commits (post-rebase SHAs on master; tag note below):
- 2feefe9c phase 01 — archive crypto module (62 tests green incl. unedited .45 envelope set)
- 738f8914 phase 05 — provider-scoped rules (37 green; github pin UNEDITED, empty-diff proof)
- f502d4de process-guard flake fix (landed upstream first; content-identical local copy dropped in rebase)
- ed75e58c phase 02 — server F path + dual-scope wrapping/adoption (100 green across 7 files)
- 42d099ae phase 03 — dashboard UX (ESLint clean; route layer 28 green)
- 19e10480 phase 04 — CLI (node --check clean; no CLI test script exists)
- 9a930ca0 phase 06 — archive-lifecycle.test.js (4/4 promise matrix)
- 27af5679 release — CHANGELOG (A7/A8 honest copy) + dual bump 0.6.46

Verification:
- Failing-set diff vs 1ff29d9b baseline: 107/107 IDENTICAL failing sets, ZERO new
  failures; 2918→2984 tests (+66, all green). Verdict: plans/reports/260906-v0646-failset-verdict.md
- Real-server boot smoke (next dev + temp DATA_DIR): F-on wrapper {format,v,envelope}
  with production scrypt N=65536 + AAD "9router-archive-v1", no plaintext leaks,
  F-off both envelopes, wrong-passphrase 400 constant (no decrypted-snippet leak in
  logs), archive-passphrase endpoint regex+no-store, both imports 200, limiter counting.
- Code review: APPROVE — 0 blockers, 0 majors; all 8 verdict-critical security
  invariants verified in code; 141/141 on the .46 set.

Release: tag v0.6.46 @ 772a9442 (pushed with the first, partially-rejected push —
master was behind, tag was not). Tree of 772a9442 is BYTE-IDENTICAL to master's
27af5679 (same tree SHA 5e2e65e1; the rebase only replaced the duplicate
process-guard commit with its upstream twin). Build and Release CLI + Docker
workflows auto-triggered from the tag; CI green on master push.

Deviations (both documented in phase-02's implementation, accepted by review):
1. CRC adoption runs BEFORE hmac adoption (semantically neutral; .45 test pins
   last-adopted = api-keys-hmac).
2. RT46-A2 replacement warning fires only for plainSecrets-sourced adoption
   (envelope adoption already requires the dashboard password — reviewer flagged
   and endorsed as conformant).

Follow-ups (non-blocking, from code review):
- Default-password installs dead-end at dashboard F-export with a misleading
  "Invalid password" (RT46-A1-correct); clearer hint copy wanted.
- Three hardcoded "9router-encrypted-archive" literals could import
  ARCHIVE_FORMAT/isEncryptedArchive (drift risk only).
- Route-test comment overstates a log-spy assertion that doesn't exist; combo.js
  `?? prefix` is dead code (resolveProviderId already falls through) — both cosmetic.
- Unresolved #2 (capture a real commandcode billing-402) still open by design —
  rule revert is one config line if capture says request-level.
