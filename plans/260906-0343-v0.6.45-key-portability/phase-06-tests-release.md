# Phase 06 — End-to-End Test Sweep, CHANGELOG, Version Bump, Release

## Context links

- Depends on: phases 01–05 all complete
- Parent: [plan.md](plan.md)
- Release precedent: CHANGELOG.md v0.6.44 entry (2026-09-06); FixLog failing-set-diff methodology (../../reports/FixLog-260906-0245-regression-batch-v0635-v0641.md §Tests)

## Overview

- Date: 2026-09-06
- Description: Cross-phase integration test pass (portability lifecycle), full-suite run with failing-set diff vs clean HEAD, CHANGELOG entry, dual version bump, release commit + tag.
- Priority: P1
- Status: done

## Key Insights

- Repo rule (FixLog §Tests): full suite currently carries ~110 pre-existing failures on Windows — the gate is ZERO NEW FAILURES vs a clean checkout, not a green suite. Diff the failing sets exactly as v0.6.44 did.
- Version must bump BOTH package.json:3 and cli/package.json:3 (CI guard against drift — both read `0.6.44` today, verified).
- Release = commit `release: v0.6.45 — ...` + tag `v0.6.45` (triggers "Build and Release CLI" workflow).
- AGENTS.md hard rules apply at commit time: `detect_changes()` before commit; impact analysis was done per-phase on hot symbols (exportDb/importDb/generateApiKeyWithMachine/rowToKey/makeRequest).
- Per-phase unit tests already exist (01–04); this phase adds ONE integration-style test covering the full lifecycle across module boundaries (envelope + export + import + re-key + keyId length) and then does release mechanics.

## Requirements

- New `tests/unit/key-portability-lifecycle.test.js`: cross-install lifecycle in one test file — build "install A" state (secret A, installId A, one key via createApiKey with a 12-char keyId mock), exportDb with password, tear down to "install B" (secret B, installId B), importDb with password → keys validate; importDb with wrong password on a second archive → needsRekey + rekeyApiKey round-trip restores validation.
- Full suite `npx vitest run` from `tests/`: failing set ⊆ baseline failing set (zero new).
- CHANGELOG.md: `# v0.6.45 (2026-09-06)` with `## Features` (portable backups, re-key, keyId, CLI menu) and `## Fixes`-style notes only if applicable.
- package.json + cli/package.json → `0.6.45`.
- Release commit + tag; `detect_changes()` output attached to the commit body/PR.

## Architecture

```
lifecycle test flow (one describe, mocked adapter + installSecret state):
  A: state.secret="A", create key (mocked generator → 12-char keyId)
     exportDb({password}) ──► payload{authSecretEnvelope, meta.installId=A}
  B: state.secret="B", meta installId=B
     importDb(payload,{password}) ──► adopted (state.secret==="A")
       validateApiKey(rawKey) === true        ← hashes now match
     exportDb({password}) on B ──► re-wraps A's (adopted) secret — portable chain
  C: importDb(secondArchive,{password:"wrong"})
       ──► needsRekeyCount===1, warning /re-key/i
       rekeyApiKey(id, rawKey) ──► validateApiKey(rawKey)===true, flag cleared
```

## Related code files

- CREATE `tests/unit/key-portability-lifecycle.test.js` (harness: tests/unit/s7-followup-regressions.test.js:16-75 + installSecret state mock from phase-02 test)
- `CHANGELOG.md` (new entry at top)
- `package.json` (:3), `cli/package.json` (:3)
- No source changes expected in this phase (fix-forward loop returns to the owning phase if the sweep finds regressions)

## Implementation Steps

1. Create `tests/unit/key-portability-lifecycle.test.js` per Architecture; reuse the extended fakeAdapter (13-param apiKeys INSERT incl. needsRekey) and the stateful installSecret mock (`getOrCreateInstallSecret` reads `state.secret`, `adoptInstallSecret` writes it) — do not re-mock per test; drive "installs" by swapping `state.secret` and `state.meta.get("install-id")`.
2. Run the new file: `npx vitest run unit/key-portability-lifecycle` from `tests/` → green.
3. Baseline capture: on clean HEAD (worktree or stash), `npx vitest run` from `tests/` → save failing test list; repeat on the feature branch; diff sets (FixLog method). Gate: zero new failures.
4. Spot-check boot migration on a copy of a real v0.6.44 data dir (optional but cheap): copy `%USERPROFILE%/.9router` → temp, point DATA_DIR, boot once, confirm `[DB][sync] +column apiKeys.needsRekey` appears and no errors.
5. CHANGELOG.md — prepend:
   ```md
   # v0.6.45 (2026-09-06)

   API keys become portable in backups. …

   ## Features
   - **Backups can now carry working API keys across installs**: exporting
     with the dashboard password embeds the key-hashing secret inside the
     backup, encrypted with that password (scrypt N=2^16 + AES-256-GCM).
     Importing with the same password adopts the secret, so every restored
     key validates immediately. Exports made via CLI token omit the secret.
   - **Re-key fallback**: importing with a wrong/missing password still
     imports everything; affected keys are flagged "needs re-key" and can
     be fixed by pasting their raw key once (Endpoint page or CLI).
   - **Stronger key IDs**: new keys use a 12-char crypto-random id
     (~62 bits, was 6 chars via Math.random); existing keys unaffected.
   - **CLI: Backup & Restore menu** (export to a JSON file in the current
     directory, import from a path, both password-gated).
   ```
6. Bump `package.json` and `cli/package.json` to `"version": "0.6.45"` (both, same commit).
7. `detect_changes()` (GitNexus) — verify affected symbols match the phase scope (envelope module, exportDb/importDb, apiKeysRepo, keys routes, EndpointPageClient, CLI client/menus, apiKey.js); attach summary to the commit body.
8. Commit `release: v0.6.45 — portable key backups (wrapped secret export + adoption), re-key fallback, 62-bit key IDs, CLI backup menu` + tag `v0.6.45`; push tag (triggers Build and Release CLI workflow).

## Todo list

- [x] key-portability-lifecycle.test.js green (A→B adopt; B→C wrong-password → re-key)
- [x] Full-suite failing-set diff vs clean HEAD → zero new failures
- [x] Boot-migration spot check on copied v0.6.44 data dir (needsRekey column auto-add)
- [x] CHANGELOG.md v0.6.45 entry
- [x] Dual version bump 0.6.45 (package.json + cli/package.json)
- [x] detect_changes() scope check
- [x] Release commit + tag v0.6.45

## Success Criteria

- Lifecycle test asserts, in one file, the whole v0.6.45 promise: cross-install import with password → `validateApiKey(rawKey) === true`; wrong password → import succeeds + `needsRekeyCount === 1`; `rekeyApiKey` → validation restored, flag cleared; exported keyId is 12 chars.
- Full-suite failing set identical to baseline (zero new failures; Windows flake list unchanged).
- `git tag --list 'v0.6.45*'` shows the tag; CI release workflow triggered.
- CHANGELOG rendered correctly (version heading + date match release commit).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Full suite reveals a regression from phases 01–05 | Medium | Medium | Failing-set diff pinpoints owning phase; per-phase tests already cover units | new failing test names | Fix-forward in the owning phase file's scope; re-run sweep |
| Lifecycle test fights module-level caches (installSecret Map, cached secret in apiKey.js:7-11) | Medium | Medium (test flake) | Mock installSecret module entirely (stateful mock); for apiKey.js CRC cache, set `process.env.API_KEY_SECRET` in test env or mock the module — follow apikeys-hash-migration.test.js:62-64 precedent | flaky order-dependent failures | Prefer module mocks over cache poking; mark no shared state between tests (beforeEach resets) |
| Version drift between package.json and cli/package.json blocks CI | Low | Low | Bump both in one commit (step 6); CI guard | CI failure | Immediate follow-up commit |
| Boot migration surprises on real v0.6.44 data (additive column) | Low | Low | Step 4 spot check on a COPY; additive ADD COLUMN with DEFAULT 0 is non-destructive (migrate.js:87-101) | boot log line present, no error | Restore copied dir; fix sync declaration |
| Tag pushed before detect_changes reviewed | Low | Medium | Step 7 precedes step 8 in the ordered list | PR review | Delete+retag if scope unexpected (no cascading damage — release workflow only publishes the CLI artifact) |

## Security Considerations

- The lifecycle test handles secrets only in-memory; never commit real backup files or real install secrets — test fixtures use synthetic secrets (`"test-secret-A"` etc.).
- No passwords/raw keys in console output from tests (vitest may print object diffs — keep raw keys out of assertion messages; compare hashes/masked forms where possible).
- CHANGELOG must NOT include example envelopes, real secrets, or the default password; describe mechanics only.
- Release commit message carries the detect_changes summary, not secret material.
- Envelope/AAD/versioning concerns already enforced by phases 01–02 tests re-run here as part of the sweep.

## Red-Team Amendments (BINDING — 2026-09-06)

1. **RT-19 negative tests (add to the lifecycle file):** `importDb({})` and `importDb({unexpected:1})` throw the phase-02 RT-05 shape-guard error with ZERO `DELETE` statements executed (fake adapter records SQL runs — assert none start with "DELETE"). Wrong-password open still exercises the full GCM-fail path under the lighter test params (RT-02).
2. **RT-20 suite runtime:** run the full suite before/after on the same machine; record the delta in the release commit body. With RT-02's `N9R_TEST_ENVELOPE_N` override the envelope tests add < 2 s total. Any per-test timeout bump stays local to the new test files.
3. **RT-21 CHANGELOG honesty (amends step 5's first bullet):** end it with "…Exports made without a stored dashboard password, or via CLI token without one, omit the secret; the rest of the backup file — including provider access tokens — remains unencrypted (full-archive encryption is planned for v0.6.46)." Same disclosure rule for the CLI menu copy (phase-05 RT-16). Also amend the re-key bullet: re-key is offered only for flagged keys.
4. **RT-22 commit granularity:** every phase lands as ONE green commit (its own tests green + `detect_changes()` run first); phases 02→03→05 are strictly sequential — never parallel-worktree them (apiKeysRepo.js + db/index.js shared by 02/03; client.js shared by 03/05 — sequential sharing is fine, parallel is not; plan.md ownership note corrected accordingly).
5. Step 1's stateful mock must export `readInstallSecret: () => state.secret` too (phase-02 RT-10) or the flagship round-trip fails as specced.

## Next steps

- Phase 07 records the v0.6.46 Option F roadmap (design sketch only) — include a one-line "planned for v0.6.46" note in the CHANGELOG ONLY if owner approves; default is silence.
