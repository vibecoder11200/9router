---
title: OpenCode Bun free lane shipped end-to-end; replay found 3 lane bugs; R4 pause on per-IP quota
date: 2026-11-12
summary: "Plan 261112-2130 executed P0-P7: bun stdio lane + wire snapshot + installer + resolver + probe classifier + status route; P7 live replay found cancel-crash / stdin-belt / exit-flush truncation bugs (fixed, 24/24 suites); replay paused per R4 after per-IP quota 429; VPS acceptance pending."
---

# OpenCode Bun free lane shipped end-to-end; replay found 3 lane bugs; R4 pause on per-IP quota

## What happened

Executed plan 261112-2130-opencode-bun-free-lane end-to-end (P0-P7, auto mode): the OpenCode Free lane now routes chat traffic through per-request Bun 1.4.0 stdio children with a CLI-identical v2 wire snapshot (P0-proven 7.7KB composition, 5/5 vs the live gate), Bun download-on-demand via a digest-pinned installer, fail-fast 503 semantics (no legacy fallback), a `opencodeFreeLaneEngine` kill-switch, socks->http proxy resolver, probe infra classifier, and a read-only status route. 9 commits, all phase-verified, GitNexus impact/detect_changes on every edit.

Root causes worth remembering (all found by the P7 live replay, unit-validated after):

1. **Cancel-crash**: consumer reader.cancel() left trailing child stdout hitting a closed ReadableStream controller - uncaught ERR_INVALID_STATE crashed the node process. Guarded push + closed flag (cancel sets closed; enqueue wrapped).
2. **stdin belt time bomb**: the sidecar belt-exited on stdin close, but env transport closes stdin AT SPAWN by design - the belt could kill a live stream at an arbitrary point after headers (200s with empty bodies). Belt removed; orphan protection = idle/total watchdogs + manager slot release on child exit.
3. **Exit-before-flush truncation**: the lane closed the stream controller on child exit-0, but on Windows the exit event can beat pending pipe data - 200 with an empty stream. Clean exits now defer closing to stdout end; abnormal codes (5/6) error immediately.

Process notes:
- base.execute returns a {response, url, headers, transformedBody} WRAPPER, not the raw Response - chatCore/probe consumers unwrap `.response`; executor-level tests that assert raw Response shape must drive the directFetch closure directly.
- formatProviderError wraps executor errors as "[<statusCode>]: <message>" - string-matching classifiers (isProbeInfraError) must match message text, never error.code.
- The lane entry point receives the SOCKS URL by design; the socks->http mapping happens INSIDE opencodeFreeLaneFetch (mapProxy). Test the mapping via spawn capture of BUNLANE_REQ, not by asserting on lane args.
- plain node (>=20.5) requires `with { type: "json" }` on JSON imports - vitest tolerates its absence, so runtime-only imports broke only under node. Fixed on the snapshot import.
- Windows node_modules-free worktrees: junction node_modules (mklink /J) to baseline-run old commits.
- Writing long files in this environment: Write tool mid-stream corruption and bash-heredoc 
 mangling both bit repeatedly; python3 heredoc + NL.join + node --check verification is the reliable path.

## Decision

- Replay (Mode A) paused per plan R4: the final run hit a per-IP free-tier quota 429 after ~12+ fresh-session completions from one IP in ~30 min (research pins 429 FreeUsageLimitError as per-IP; the same IP served 200s with the identical snapshot minutes earlier - replay cadence, not wire drift). Re-run `node scripts/replay-opencode-free-lane.mjs` for a clean 3/3 after the quota window resets (reports/mode-a-replay.md).
- VPS live acceptance checklist documented as PENDING in reports/vps-acceptance.md (VPS unreachable from the dev machine) - it is the operator runbook and the measurable "done".
- Known-refused R8 models (muse-spark-1.2/1.3-contributor-free, union-alpha) stay legacy; observable via GET /api/opencode-free-lane lane.modelsKnownRefused.

## Next steps

- Re-run Mode A replay 3/3 after the per-IP quota window resets.
- Execute reports/vps-acceptance.md on the VPS (9 checklist items, includes fail-fast + abort drills).
- Optional follow-ups named in the plan: rich dashboard card for the free-lane status (GET route only shipped), UI for the engine toggle.
- `node .gitnexus/run.cjs analyze` to reindex (P3+ symbols are post-index; GitNexus could not see opencodeBunLane exports).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
