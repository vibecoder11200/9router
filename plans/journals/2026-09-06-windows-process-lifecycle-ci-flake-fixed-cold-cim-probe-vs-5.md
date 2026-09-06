---
title: windows-process-lifecycle CI flake fixed — cold CIM probe vs 5s bound
date: 2026-09-06
summary: Test-only retry fix pushed alone as f502d4de; X7 production semantics untouched; all CI green
---

# windows-process-lifecycle CI flake fixed — cold CIM probe vs 5s bound

## What happened
- CI job windows-process-lifecycle (run 34009200959, commit 1ff29d9b) failed: AssertionError "expected false to be true" at tests/unit/process-guard.test.js:102.
- Root cause: environmental flake, NOT a production bug. The test asserts one cold Get-CimInstance (WMI) probe completes within probeProcess's deliberate 5s bound. On a freshly provisioned windows-latest runner the cold query exceeded 5s; probeProcess correctly returned "unknown" (X7 design: unprovable != dead, != ours) so isOurProcess -> false. Evidence: failing test took 5558ms ~= 500ms sleep + 5000ms timeout; local warm CIM ~0.5s and passes; same code passed the two prior runs; failing commit was docs-only.
- Fix (test-only, tests/unit/process-guard.test.js): retry the positive probe up to 3x with 700ms waits + per-test { timeout: 30000 } (required: execFileSync blocks the event loop; awaits between probes would trip vitest's default 5s). Mismatch/dead-pid assertions unchanged — retry cannot manufacture a false positive.
- Verified: exact CI command + blast radius (xray-reaper-patterns, xray-manager-smoke, xray-health-check-result) 17/17 pass; 3x stability loop; code-review PASS; detect_changes: zero production symbols touched.

## Decision
- Production probeProcess 5s bound and three-state semantics stay untouched — raising the bound or reclassifying "unknown" would break kill-safety (reaper.js kill path).
- Pushed ONLY the fix to master via an isolated temp worktree (cherry-pick 9f7740f3 onto origin/master -> f502d4de). The v0.6.46 WIP commits stay local: a concurrent session in the same tree had committed them locally (phases 01/02/05) and had also swept the test fix into its own commit 9f7740f3.

## Next steps
- CI run 34012161113 on f502d4de: ALL 6 jobs green, windows-process-lifecycle included.
- When the v0.6.46 session pushes its stack, it must git pull --rebase; local 9f7740f3 (same patch as f502d4de) drops out as already-applied.
- Code-review note for later: mismatch assertion could be strictly stronger via probeProcess(...) === "gone" instead of isOurProcess false.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
