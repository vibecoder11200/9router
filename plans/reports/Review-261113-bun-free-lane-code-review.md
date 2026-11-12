# Code review disposition — OpenCode Bun free lane

Review: code-reviewer agent, 2026-11-13, scope 09fe00f5..190d2453.
Verdict: **SHIP-WITH-FIXES**. Fixes landed in f39b1964; verification: lane
suites 30/30, full suite all 11 feature suites green under load,
detect_changes low / 0 affected processes.

## Fixed

- **P0-1 abort-during-headers quota safety**: signal wired at spawn; abort
  before first line surfaces as AbortError (base rethrows, no retry of an
  abandoned request); release listeners attach before any await (the old
  finally-attached ones missed the already-fired exit event and leaked the
  slot - found by the new test); pre-start abort never spawns.
- **P1-1 honest 503**: chatCore catch honors error.statusCode (was blanket
  502, dropping the fail-fast 503).
- **P1-2 noRetry**: surfaced lane error marks itself; base loop skips
  tryRetry - lane-down is 2 child spawns, not 8 (probe e2e 9s -> 0.5s).
- **P1-3 per-kind alert dedupe** (down/unmapped/busy) - an unmapped info can
  no longer mask a lane-down critical for an hour.
- **P2-1** harness text renders real - Name:/- Model ID: (executor + replay).
- **P2-2** caller-param drop documented in shapeV2FreeLaneRequestBody.
- **P2-3** readFirstLine raw-Buffer accumulation (multibyte chunk boundary).
- **P2-4** queue saturation -> OPENCODE_BUN_LANE_BUSY (info), not critical.

## Deferred (accepted, tracked)

- **P2-5** first-use bun install runs inside a lane slot with no download
  timeout - pre-install/prewarm on status read is the follow-up; bounded by
  the OS TCP stack today, worst case a slow first request.
- **P2-6** isProbeInfraError prose coupling - structured err.laneInfra
  marker through chatCore error plumbing is the cleaner shape; prose match
  is tested for both wordings today.
- **P2-7** test gaps: stdin-threshold spawn decision untested; resolver
  source-line assertion brittle. Low risk.
- **P2-8** process note: VPS live acceptance (acceptance #2) remains the
  operator runbook (reports/vps-acceptance.md, all items PENDING); Mode A
  replay is GREEN 3/3 after the quota reset.

## Security review (from the reviewer, all clear)

Status route behind the deny-by-default /api/* middleware; sidecar spawned
from app dir with BUNLANE_REQ scrubbed from inherited env; socks mapping
loopback-restricted + TCP-verified; contamination regex over snapshot+fixture
clean; bun digest pinning fail-closed. No P0 security findings.