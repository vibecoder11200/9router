# Phase 06 — Test Sweep, Failing-Set Diff, CHANGELOG, Version Bump, Release

## Context links

- Depends on: phases 01–05 all complete
- Parent: [plan.md](plan.md)
- Precedent: .45 phase-06 (FixLog failing-set-diff method; ~110 pre-existing Windows failures; zero-new is the bar) — mirror its mechanics exactly

## Overview

- Date: 2026-09-06
- Description: One integration test covering the full F lifecycle across
  module boundaries, full-suite failing-set diff vs clean HEAD, honest
  CHANGELOG entry, dual version bump to 0.6.46, release commit + tag.
- Priority: P1
- Status: done

## Key Insights

- Repo rule (carried from .45): the full suite carries ~110 pre-existing
  failures on Windows — the gate is ZERO NEW FAILURES vs a clean checkout of
  a916ec20+, not a green suite. Diff the failing sets (same method as v0.6.44/
  v0.6.45, serial runs, correct node_modules in BOTH trees — .45 incident (2)
  showed a worktree without node_modules produces a bogus diff).
- Route-level tests already exist from the start (phase 02, the .45 lesson);
  this phase only adds the cross-phase lifecycle + release mechanics.
- Version must bump BOTH package.json:3 and cli/package.json:3 (both read
  0.6.45 today, verified) — same commit (CI drift guard).
- Release = commit `release: v0.6.46 — …` + tag `v0.6.46` (triggers the Build
  and Release CLI workflow).
- AGENTS.md hard rules at commit time: `detect_changes()` before commit;
  impact was run per-phase on the hot symbols.

## Requirements

- New `tests/unit/archive-lifecycle.test.js` (or extend
  key-portability-lifecycle.test.js): the whole v0.6.46 promise in one file —
  install A (secrets, keys) → F-export (generate → sealArchive) → install B →
  openArchive+import → `validateApiKey` true AND `parseApiKey` non-null (CRC
  adopted); wrong passphrase → importDb never reached (route-level mock) /
  openArchive throws; F-off export from the same install still carries
  authSecretEnvelope + crcSecretEnvelope and imports on .45 semantics.
- Full suite `npx vitest run` from tests/ on the branch vs clean a916ec20:
  failing set must be a SUBSET of baseline (zero new).
- CHANGELOG.md: `# v0.6.46 (2026-09-06)` entry (draft in Implementation
  Steps) — honest copy: what F protects, the unrecoverable-loss rule, the
  ~100MB one-shot ceiling note, CRC adoption + env-override behavior,
  commandcode rotation + github fail-fast preservation.
- package.json + cli/package.json → `0.6.46`.
- Release commit + tag `v0.6.46`; detect_changes() summary in the commit body.

## Architecture

```
lifecycle (fake adapter + stateful installSecret mock, .45 harness):
  A: secrets{hmac:A,crc:A}, installId A, createApiKey ×2
     ├─ exportDb({plainSecrets:true}) → sealArchive(json, generated) → FILE
     └─ exportDb({password:pw})  → authSecretEnvelope + crcSecretEnvelope (.45+B)
  B: secrets{hmac:B,crc:B}, installId B
     ├─ openArchive(FILE, pass) → importDb(inner,{password:""}) 
     │     → validateApiKey(raw)===true · parseApiKey(raw)!==null · needsRekeyCount===0
     ├─ openArchive(FILE, "wrong") → throws ArchiveError (hard fail, no import)
     └─ importDb(F-off payload,{password:pw}) → both envelopes adopted (CRC too)
  release: failing-set diff → CHANGELOG → dual bump → detect_changes → commit+tag
```

## Related code files

- CREATE tests/unit/archive-lifecycle.test.js (harness:
  tests/unit/key-portability-lifecycle.test.js + s7-followup-regressions.test.js)
- CHANGELOG.md (new top entry)
- package.json (:3), cli/package.json (:3)
- No source changes expected (fix-forward returns to the owning phase if the
  sweep finds regressions)

## Implementation Steps

1. Write archive-lifecycle.test.js per Architecture (fake adapter + stateful
   installSecret mock + `vi.mock("@/lib/auth/backupEnvelope.js", …)`-free real
   crypto with `N9R_TEST_ENVELOPE_N`-style fast-N via
   `_setEnvelopeParamsForTests` — check the .45 harness idiom and copy it).
2. Run it + the three phase test files: green.
3. Baseline: on a CLEAN worktree/checkout of a916ec20 (WITH node_modules —
   `npm ci` if needed), `npx vitest run` from tests/ (serial) → record failing
   list. Repeat on the branch. Diff sets. Gate: zero new.
4. Boot smoke on a copy of a real .45 data dir (DATA_DIR pointed at a temp
   copy): boot once, export F-off + F-on via the dashboard, import both back —
   no errors, warnings sane.
5. CHANGELOG.md — prepend:
   ```md
   # v0.6.46 (2026-09-06)

   Backups can now be encrypted end-to-end with a passphrase.

   ## Features
   - **Encrypted backups (opt-in)**: exporting can seal the ENTIRE backup —
     provider tokens, settings, API-key hashes, install secrets — into one
     scrypt (N=2^16) + AES-256-GCM archive (`9router-encrypted-archive`).
     Two passphrase modes: your own (min 10 chars) or a generated 100-bit
     Crockford-Base32 passphrase shown ONCE (copy/download + mandatory
     retype). If the passphrase is lost the backup cannot be recovered and
     nothing is stored server-side. Intended for archives up to ~100MB
     (one-shot encryption; no chunking).
   - **Cross-install key-CRC adoption**: password exports now also embed the
     key-CRC secret (wrapped, alongside the .45 key-hash secret) and imports
     adopt both — pasted keys from the exporting install pass key-format CRC
     validation again. When the API_KEY_SECRET env override is active the
     file secret is neither exported nor adopted (env wins; a warning says so).
   - **commandcode payment-required rotation**: provider-scoped error rules;
     commandcode billing-402 errors rotate to the next account while GitHub's
     bare "Payment required" 402 still fails fast (C4 preserved).
   - CLI: encrypted export/import with masked passphrase prompts and
     show-once generated passphrase; dashboard: encrypt step in the export
     flow and passphrase prompt on import.
   ```
6. Bump both package.json versions to 0.6.46 (one commit with CHANGELOG).
7. `detect_changes()` — verify affected symbols match the phase map
   (backupEnvelope, archive.js, exportDb/importDb, database routes, apiKey.js,
   profile page, CLI client/backup menu, errorConfig/accountFallback/auth/
   combo); attach the summary to the commit body.
8. Commit `release: v0.6.46 — whole-archive encryption, dual-scope secret wrapping, provider-scoped payment-required rules` + tag `v0.6.46`; push tag.

## Todo list

- [x] archive-lifecycle.test.js green (F happy/wrong-pass/F-off matrix)
- [x] Full-suite failing-set diff vs clean a916ec20 → zero new failures
- [x] Boot + round-trip smoke on copied .45 data dir
- [x] CHANGELOG.md v0.6.46 entry (honest copy incl. ceiling + env-override)
- [x] Dual version bump 0.6.46 (package.json + cli/package.json, same commit)
- [x] detect_changes() scope check in commit body
- [x] Release commit + tag v0.6.46

## Success Criteria

- Lifecycle test asserts the three headline promises in one file: F import →
  keys validate + CRC validates + needsRekeyCount 0; wrong passphrase →
  ArchiveError, importDb never called; F-off export still carries both
  envelopes and .45-semantics import adopts both.
- Failing set identical to baseline (zero new; known Windows flake list
  unchanged).
- `git tag --list 'v0.6.46*'` shows the tag; CI release workflow triggered.
- CHANGELOG renders correctly; version headings in both package.json files
  read 0.6.46.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Sweep finds a regression from phases 01–05 | Medium | Medium | Failing-set diff pinpoints the owning phase; per-phase tests cover units | new failing test names | Fix-forward in the owning phase's scope; re-run sweep before release |
| Lifecycle test fights module caches (installSecret Map, scrypt speed) | Medium | Medium | .45 harness idioms: stateful installSecret mock, `_setEnvelopeParamsForTests({N:small})`, no cache poking | flaky order-dependent failures | Copy the key-portability-lifecycle mock setup verbatim; beforeEach resets |
| Worktree/node_modules trap (bogus diff, .45 incident) | Medium | High | Serial runs; verify node_modules exist in BOTH trees before running; never `git worktree remove --force` across the junction | sudden 50+ "new failures" | Stop; verify node_modules; re-run baseline before touching code |
| Boot smoke reveals migration/serialization surprise on real .45 data | Low | Medium | Smoke runs on a COPY under a temp DATA_DIR | boot log errors, round-trip warnings | Restore copy; fix in the owning phase; re-smoke |
| Tag pushed before diff reviewed | Low | High | Ordered steps: diff gate (3) precedes bump (6) and tag (8) | review checklist | Delete + retag if scope unexpected (release workflow only publishes the CLI artifact) |
| CHANGELOG copy overstates protection (honesty rule) | Low | Medium | Draft above reviewed against the copy matrix; ceiling + unrecoverable + env-override all stated | review comments | Amend before tag |

## Security Considerations

- Lifecycle test uses synthetic secrets/passphrases only; no real backup files
  or install secrets committed; raw keys kept out of assertion messages
  (compare masked/hashed forms where possible — vitest prints diffs).
- CHANGELOG carries no example envelopes, real passphrases, or default
  passwords; mechanics only.
- Release commit body carries the detect_changes summary, never secret
  material.
- The threat-model documentation duty from the .45 red team (pre-S7 2-part
  keys exposed in .45 backups; F as the real fix) is discharged by the
  CHANGELOG entry's "Entire backup" framing — note in the PR body that F-on
  archives close the provider-token exposure gap too.

## Red-Team Amendments (BINDING — 2026-09-06)

1. **RT46-O1 harness rework (supersedes risk row 2's "Copy the key-portability-lifecycle mock setup verbatim" — copying it verbatim produces a VACUOUS dual-scope test):** the .45 mock aliases both scopes to one `state.secret`. Build the per-fileName Map mock per phase-02 RT46-O1 (`getOrCreate(fileName)` / `adopt(fileName, secret)` / `readInstallSecret(fileName)`, installs driven by `becomeInstall(id, {hmac, crc})`) — only then are "both adopted" and "CRC skipped under env override" distinguishable from a scope-swap bug.
2. **RT46-A8 honest "entire" copy (amends the CHANGELOG draft + Security Considerations):** `providerSpecificData.loginToken` is redacted to `"[REDACTED]"` in EVERY export — F included (X12 invariant, db/index.js:142-144) — so: first Features bullet reads "…seal the ENTIRE backup — provider tokens, settings, API-key hashes, install secrets — everything except session login tokens, which are redacted in all exports by design — into one scrypt…"; the Security Considerations note "F-on archives close the provider-token exposure gap" gains the same qualifier (OAuth refresh/access tokens are covered; session login tokens never ride in any export).
3. **RT46-A7 CHANGELOG discloses normalization:** add to the passphrase bullet: "I and L are treated as 1, O as 0; spaces and hyphens are ignored."
4. **RT46-O8 effort/risk:** phase 06 2h → 3h and phase 02 4.5h → 5.5h (first-ever POST route tests + harness rework + "first route-test session may surface a contract surprise" contingency, mirroring .45's actuals); plan.md total 15.5h → 17.5h.
5. Baseline ref: 1ff29d9b (= a916ec20 + docs-only commits; test-identical) — cite this, not a916ec20.

## Next steps

- After release: update plan.md frontmatter to `status: completed` and record
  the completion record (commits, verification numbers, deferred items) as
  .45 did.
