# v0.6.46 shipped — whole-archive encryption, dual-scope wrapping, provider-scoped rules

Date: 2026-09-06 · Plan: 260906-1047-v0.6.46-archive-encryption · ak:cook --auto --parallel

## What shipped

Four waves, one green commit per phase, detect_changes before every commit:
01∥05 → 02 → 03∥04 → 06 → release v0.6.46 (tag pushed; CLI + Docker workflows
auto-triggered). Failing-set diff vs 1ff29d9b: **zero new failures** (107/107
identical sets, 2918→2984 tests). Code review APPROVE, 0 blockers/0 majors.
Real-server boot smoke verified every wire contract including the wrong-passphrase
400 constant and absence of plaintext leaks in wrapper and logs.

## Incidents

1. **Phantom working-tree edit / duplicate upstream commit.** A process-guard
   flake fix appeared in my tree that no Wave-A/B agent claimed. It turned out to
   be a parallel earlier session's work (interrupted by a usage limit): it had
   committed AND pushed `f502d4de` to origin/master plus its journal, but never
   landed locally beyond the stray file edit. My local twin `9f7740f3`
   (content-identical) made the release push reject with "behind". Fix: rebase
   --empty=drop; the duplicate disappeared cleanly. Lesson: when an unexplained
   edit appears, check `git log origin/master` for a twin before assuming an agent
   overstepped ownership.
2. **Partial push split tag from master.** The rejected push still delivered the
   TAG (refs push independently) — remote v0.6.46 landed on the pre-rebase
   release commit 772a9442 while master moved to the rebased 27af5679. Verified
   both commits share the exact same tree SHA (5e2e65e1), so the workflows the
   tag triggered build the correct bytes; left the tag in place rather than
   force-retagging (would restart CI for zero content delta). Lesson: on a
   multi-ref push, read which refs failed — "failed to push some refs" hid a
   success.
3. **MSYS path mangling broke `mklink /J`** ("Invalid switch - node_modules").
   Quoting the whole command as one string (`cmd //c "mklink /J …"`) prevents
   per-argument path conversion. Junction removal stayed junction-first
   (rmdir, then worktree remove --force) — no repeat of the .45 node_modules wipe.

## Honest notes

- Boot smoke ran on a fresh synthetic DATA_DIR, not a copy of real .45 data
  (binding rule: never touch real user data). Migration coverage therefore rests
  on the suite's fake-adapter tests, same as .45.
- Two phase-02 deviations (CRC-before-HMAC adoption order; A2 warning scoped to
  plainSecrets adoption) were forced by unedited .45 test contracts, documented,
  and endorsed by the reviewer.
- Skipped the code-simplifier pass post-review: reviewer approved 0/0; a
  simplification sweep over red-team-pinned crypto lines would churn approved
  code for nothing.
- Still open: capture a real commandcode billing-402 to confirm account-specific
  rotation (revert is one config line if request-level).
