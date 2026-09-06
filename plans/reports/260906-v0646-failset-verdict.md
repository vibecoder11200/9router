# v0.6.46 Failing-Set Diff Verdict (2026-09-06)

Method: serial full-suite runs, JSON reporter, correct node_modules in BOTH trees
(worktree via junctions; junctions removed before worktree removal — .45 incident
protocol). Baseline = clean checkout of 1ff29d9b (= a916ec20 + docs-only).

| Tree | Total | Passed | Failed |
|---|---|---|---|
| baseline 1ff29d9b | 2918 | 2747 | 107 |
| feature a9e91e42 | 2984 | 2813 | 107 |

- NEW failures: **0** (gate: zero new — PASS)
- Fixed/absent: 0 — failing sets byte-identical (same 107 pre-existing Windows
  failures; incl. the process-guard cold-WMI flake, now also hardened by 9f7740f3)
- Delta: +66 tests (archive-encryption 29 incl. phase-02 additions, database-route
  +18, archive-import 5, archive-lifecycle 4, account-fallback provider-scoped
  describe +7, process-guard retry unchanged count), all green.

Artifacts: 260906-v0646-{baseline,feature}-{run.log,vitest.json},
260906-v0646-baseline-failures.txt, 260906-v0646-failset-diff.txt.

Boot smoke (separate, tester-run real server `next dev` + temp DATA_DIR): all
contracts live-verified — F-on wrapper {format,v,envelope} with production scrypt
N=65536 + aad "9router-archive-v1", no plaintext keys/secrets in wrapper, F-off
carries both envelopes, archive-passphrase endpoint regex+no-store, wrong-passphrase
400 constant with no decrypted-payload leak in logs, legacy + F imports 200 with
sane warnings, 401 limiter counting. Zero product bugs found.

**Verdict: PASS — zero new failures; release may proceed.**
