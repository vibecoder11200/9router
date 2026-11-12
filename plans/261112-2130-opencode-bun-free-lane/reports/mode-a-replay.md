# P7 Mode A replay — shipped bun lane -> live v2 gate

Date: 2026-11-12/13 (dev machine, node runner + bun 1.4.0 child)
Harness: `scripts/replay-opencode-free-lane.mjs` (fixture -> shapeV2FreeLaneRequestBody
+ mintV2IdentityHeaders with a FRESH session id per run -> real `opencodeFreeLaneFetch`
(manager + per-request bun child, NO executor), reader.cancel() per run as the
quota-safe abort proof).

## Replay history (honest ledger)

1. First full set: **3/3 PASS** - run 1 HTTP 200 in 1881ms (lazy bun install on demand,
   download->verify->extract->swap->prewarm happened inside the run), runs 2-3 HTTP 200
   in 3229ms/2188ms, first SSE chunks received. This set ran BEFORE the cancel-crash was
   observed (the crash happened on the following set).
2. Second set: run 1 200 + chunk; runs 2-3 200 but EMPTY body. Diagnosis (two real lane bugs
   found by the replay, both fixed):
   - **Cancel-crash**: consumer reader.cancel() left trailing child stdout data hitting
     controller.enqueue after close - uncaught ERR_INVALID_STATE crashing the node process.
     Fix: closed flag + guarded push (cancel() sets closed, killChild as before).
   - **stdin belt time bomb**: the sidecar belt-exits when stdin closes; env transport
     closes stdin AT SPAWN by design, so the belt could kill a live stream at an arbitrary
     point (empty-200s). Fix: belt removed - orphan protection = idle/total watchdogs +
     manager slot release on child exit.
   - **Exit-before-flush truncation**: the lane closed the controller on child exit-0, but
     the exit event can beat pending pipe data (Windows) - 200 with an empty stream.
     Fix: on clean exit defer closing to stdout end; abnormal codes (5/6) error as before.
3. Validation set after fixes: runs showed 200s with chunks (runs 2-3: 1330ms/1020ms);
   run 1 was still empty-200 in the set right before the 429 pause - the exit-before-flush
   fix above landed after that observation and is unit-validated (13/13 lane suites,
   including real-child streaming + incremental-delivery assertions).
4. Final set: run 1 **HTTP 429 in 567ms** -> harness STOP (plan R4). Reading: this is
   per-IP free-tier quota exhaustion from the replay cadence (~12+ fresh-session
   completions from one IP within ~30 minutes; the research report pins 429
   FreeUsageLimitError as per-IP), NOT a wire regression - the same IP served 200s with
   the identical snapshot minutes earlier. R4 discipline applied: replay paused;
   re-run `node scripts/replay-opencode-free-lane.mjs` for a clean 3/3 after the quota
   window resets before calling Mode A permanently green.

## Hardening deltas landed with P7 (validated by unit suites, not by live replay)

- opencodeBunLane.js: cancel-crash guard (closed flag + guarded push); exit-before-flush
  fix (clean exit defers close to stdout end).
- opencodeBunSidecar.mjs: stdin belt removed (time bomb), comment documents why.
- opencodeWire.js: snapshot JSON import gains `with { type: "json" }` (node >= 20.5
  requires the attribute; vitest tolerated its absence - plain node did not).
- scripts/lib/alias-loader.mjs (new): ESM resolve hook mapping @/ and open-sse/ aliases
  so dev scripts can import app modules under plain node.

## Clean 3/3 after quota reset (2026-11-13)

The R4 pause resolved as predicted: re-running the harness after the per-IP
quota window reset returned **3/3 PASS** (exit 0) - HTTP 200 + first SSE chunk
on every run (1607ms / 3700ms / 1075ms), fresh session per run, cancel per run,
snapshot 2.2.7 throughout. This validates the exit-before-flush fix live and
closes the Mode A gate. Quota cost: 3 completions.

## Gate status

- Mode A: **GREEN - 3/3 clean** after the quota reset (above); the earlier R4 pause was per-IP quota exhaustion from replay cadence, confirmed not wire drift.
- No STOP condition on wire drift: snapshot clientVersion 2.2.7 matched the gate
  (200s + real completions throughout).