# Phase 03 — Bun stdio lane: child protocol + manager + semaphore + abort

Depends on: P2 (bun path). Developable against system bun in parallel with P2's tail via a `--bun-path` env override.

## Objective

The lane transport: per-request `bun` stdio children (genspark shape, `open-sse/services/gensparkTlsSidecar.js` as the in-repo precedent) performing upstream fetches with Bun's TLS stack — SSE passthrough over stdout, abort = kill child, concurrency capped at 3. No port, no auth surface, no persistent process, no boot/shutdown hooks (red-team SEC-1/FM-1/AD-F4 resolved by construction).

## Files

- `open-sse/services/opencodeBunSidecar.mjs` (new — the child script, spawned from the APP directory; never copied to DATA_DIR — SEC-3)
- `open-sse/services/opencodeBunLane.js` (new — Node manager)
- `tests/unit/bun-lane-stdio.test.js` (new)
- `tests/unit/bun-lane-manager.test.js` (new)

## Child protocol (stdio, one child per request)

1. Node spawns `<bunPath> <appDir>/open-sse/services/opencodeBunSidecar.mjs` with `{ stdio: ["pipe","pipe","pipe"], windowsHide: true }`, env `BUNLANE_REQ=<JSON>` (request on env — avoids stdin race; large bodies via stdin instead if > 100KB: write JSON to stdin then close stdin, script reads all of stdin).
2. Request JSON: `{ url, method, headers, body (string|null), timeoutMs, proxy (http url|null), idleTimeoutMs }`.
3. Child: `fetch(url, { method, headers, body, redirect: "follow", proxy: proxy || undefined, signal: AbortSignal.timeout(timeoutMs) })`.
4. Child emits on **stdout**: first line = JSON `{ "status": N, "headers": {...} }`; then the RAW response body bytes streamed verbatim (SSE passthrough — binary-safe via stdout as a byte stream, NOT line-oriented for the body); then exits 0 at stream end. Upstream/transport failure before headers: first line = `{ "error": "..." }` + exit 5.
5. **Abort**: Node kills the child (SIGKILL/taskkill) when the caller's signal fires or the Node-side response consumer cancels → child process death aborts the upstream fetch — quota-safe by construction (AD-F4/FM-2). Idle watchdog inside the child: if no body chunk for `idleTimeoutMs` (default `timeoutMs`), abort upstream and exit 6 (long generations are NOT killed by a total-duration cap — only by idleness or the hard `timeoutMs` ceiling).
6. Child exits when stdin closes (belt) and at stream end (braces) — no orphan class.

## Steps

1. Write `opencodeBunSidecar.mjs` (~60 lines, no deps): parse env/stdin request → fetch → write header line + stream body to stdout via `Bun.write(Bun.stdout, ...)` chunks → exit codes (0 ok / 5 upstream error / 6 idle timeout / 7 bad request). Nothing else ever written to stdout (stderr = debug only).
2. Write `opencodeBunLane.js`:
   - `opencodeFreeLaneFetch(url, init = {}, { signal, timeoutMs = 120000, proxyUrl = null } = {})` — SAME signature as `opencodeTlsFetch` (opencodeTlsClient.js:191) for the P4 drop-in.
   - Flow: resolve proxy (`resolveXrayHttpProxyUrl(proxyUrl)` from P5; until P5 lands a local stub returns null for any socks → tests still valid) → **acquire semaphore slot** (≤3 concurrent children; waiters queue, queue timeout 30s → typed error) → `ensureBunInstalled()` (P2) → spawn child → parse first stdout line → build a native `Response` (status/headers/body = child stdout stream tail) → wire caller `signal`/response-cancel → `child.kill()`.
   - **Fail-fast retry**: on spawn/first-line failure, ONE bounded retry (5s budget: re-ensure bun, respawn); second failure → throw `OpenCodeFreeLaneUnavailableError` (exported). Upstream 4xx/5xx (incl. 429) is a NORMAL response — never unavailable.
   - Proxy rule: socks5 loopback URL that the resolver cannot verify → typed `OpenCodeFreeLaneUnmappedProxyError` (distinct — P4 surfaces it as a config-state, not an incident).
   - `getBunLaneStatus()`: `{ installed, bunVersion, busy, queued, maxConcurrency: 3, lastErrorAt, lastError }` (P6 status route).
   - No initializeApp.js edit (no persistent process) — zero boot-path change.
3. House rules: new files only → no impact() needed; `detect_changes()` before commit.

## Verification gate

- `cd tests && npx vitest run unit/bun-lane-stdio.test.js unit/bun-lane-manager.test.js`:
  - Protocol (real child process in tests — a tiny **Node** script standing in for bun via `--bun-path` override pointing at `process.execPath`; the child script detects runtime and uses global fetch — Bun-only `proxy` option exercised in the manual smoke only): first-line parse; body chunks stream incrementally (two chunks delivered before end); upstream-error shape (exit 5); idle-timeout shape (exit 6); child exits at stream end (no lingering process handle).
  - Manager: signature parity vs `opencodeTlsFetch` options shape; semaphore ≤3 (4th concurrent call queues; 5th with tiny queue-timeout → typed error); abort: caller signal mid-stream → child killed within 100ms (assert process exit) — THE quota-safety test; fail-fast: two consecutive spawn failures → exactly one typed error, no third attempt; unmapped-proxy → distinct typed error; 429 passthrough is a normal Response.
- Manual smoke (dev machine, real bun): standalone spawn of the real child with the P1 fixture → 200 + first SSE chunk (re-proves the lane through the shipped child before executor wiring).

## Risks

- Bun stdout streaming backpressure for very fast SSE — `Bun.write` await per chunk provides flow control; test asserts incremental delivery.
- Windows spawn latency (~50-100ms/request) — acceptable vs chat latency; measured on the VPS checklist (which runs Linux anyway).
- Fresh TLS connection per request rejected by the gate — already gated by P0 rung 4; if it regresses later, branch B is the recorded fallback (plan R2).
