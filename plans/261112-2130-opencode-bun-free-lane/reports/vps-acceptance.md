# VPS live acceptance checklist — OpenCode Bun free lane

Status: **PENDING — not executed.** The VPS is not reachable from the dev machine
in this session; every item below is a run-book step for the operator. The checklist
is the measurable "done" from the plan and must be executed as-is, in order.

Prereqs: app deployed with this build; `bun` NOT pre-installed (exercises
download-on-demand) or pre-warmed via the installer; alerts channel configured.

## 1. Status route

- `GET /api/opencode-free-lane` -> `bun.installed: true`, `lane.busy: 0`,
  `snapshot.clientVersion: "2.2.7"`, `engine: "bun"`,
  `lane.modelsKnownRefused` = the 3 R8 models.

## 2. Chat 200 (acceptance #2)

- `oc/deepseek-v4.1-flash-free` via internal `/api/v1/chat/completions` with the
  opencode pool binding as-is -> streaming 200, content received.
- `getBunLaneStatus().lastErrorAt` null (check via the status route `lane.lastErrorAt`).
- Paced >= 2s. A 429 here with healthy lane + matching snapshot = STOP + research
  round (plan R4), NOT an implementation fix.

## 3. Filter probe (acceptance #4)

- Model-filter `freeChatProbe: true` over >= 2 configs -> per-node verdicts.
- One deliberately-dead config marked failed WITHOUT polluting others.
- Concurrency <= 3 children observed (`ps aux | grep -c "[b]un"` <= 3 during the run).
- If the lane is down mid-run: the runner must abort with infraError (not mark every
  node failed) - isProbeInfraError classification (P6).

## 4. RAM

- Peak bun child RSS < 80MB each; record box memory headroom before/during/after.

## 5. Test Model (acceptance #5)

- Dashboard Test on the free model -> success; `models/test/ping.js` diff = none.

## 6. Fail-fast drill (acceptance #3)

- `chmod -x <DATA_DIR>/bun/bun` (or rename) -> next chat returns the typed 503
  `OPENCODE_FREE_LANE_UNAVAILABLE` within the bounded retry window.
- Exactly ONE critical alert (`opencode-bun-lane-unavailable`, 1h dedupe).
- Restore permission -> next request 200 via bun.
- Legacy is NOT expected to serve during the outage - by design (fail-fast, no
  silent fallback).

## 7. Abort drill

- Start a chat, kill the client mid-stream -> bun child exits within ~1s
  (`ps` empty of stragglers) - quota-safety proof in production.
- Note: the consumer-cancel path also guards the trailing-stdout race
  (P7 cancel-crash fix), so mid-stream client kills are safe on the app side too.

## 8. Snapshot detect-only

- Verify NO file under `<DATA_DIR>` was written by the sync (embedded-only,
  detect-only): find the bun dir and check for stray snapshot/wire files.
- Drift alert path is unit-validated (`OPENCODE_WIRE_DRIFT`); prod spot-check
  optional.

## 9. Shutdown/restart hygiene

- App restart -> lane healthy again; no bun processes linger after stop
  (`ps aux | grep "[b]un"` empty post-stop).

## Replay (Mode A) on the dev machine - never the VPS

- `node scripts/replay-opencode-free-lane.mjs` -> 3/3 (200 + first SSE chunk).
- Current state: PAUSED per plan R4 after per-IP quota 429 (see
  `reports/mode-a-replay.md`); re-run after the quota window resets.

## Acceptance record

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1 | Status route | PENDING | |
| 2 | Chat 200 | PENDING | |
| 3 | Filter probe | PENDING | |
| 4 | RAM | PENDING | |
| 5 | Test Model | PENDING | |
| 6 | Fail-fast drill | PENDING | |
| 7 | Abort drill | PENDING | |
| 8 | Snapshot detect-only | PENDING | |
| 9 | Restart hygiene | PENDING | |