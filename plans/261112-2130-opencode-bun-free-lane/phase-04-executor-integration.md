# Phase 04 — Executor integration: v2 shaping + fail-fast semantics + settings

Depends on: P1 (wire snapshot), P3 (lane client), P5 (proxy resolver). Join point.

## Objective

Switch the free lane's `freeLaneFetch` to the Bun lane as primary engine: v2 CLI-identical shaping (rendered system, 12-tool manifest + caller tools, `stream_options`, v2 endpoint + identity headers) sent via `opencodeFreeLaneFetch`. **Fail-fast semantics** (user decision): on lane unavailability → the lane's own bounded retry (P3) → typed error surfaced; NO serving on the gate-dead legacy lane. Legacy stays reachable only via `opencodeFreeLaneEngine: "legacy"` (today's exact path).

## Files

- `open-sse/executors/opencode.js` (edit — `execute()` freeLaneFetch closure, :491-514)
- `src/lib/db/repos/settingsRepo.js` (edit — DEFAULT_SETTINGS)
- `tests/unit/opencode-bun-lane-executor.test.js` (new)

## Steps

1. House rules FIRST: GitNexus `context({name: "freeLaneFetch"})` + `impact` on the opencode executor's execute chain to enumerate chat flows; report blast radius (expected: wide — chat hot path; that is why the change is strictly additive inside the wrapper). HIGH/CRITICAL → note to user before proceeding (expected and accepted per plan R7).
2. Settings (`DEFAULT_SETTINGS`, next to `xraySocksPort`, settingsRepo.js:81):
   - `opencodeFreeLaneEngine: "bun"` (`"bun"` | `"legacy"`; default ON per contract)
   - (`opencodeWireSnapshotAutoSync` — dropped; sync is detect-only and always on, no knob — KISS per SC-F3.)
3. Edit `freeLaneFetch` (keep signature `(url, options, ctx)` and `freeLaneFetch.proxyBridge = true`, :508):
   ```
   freeLaneFetch = async (url, options, ctx) => {
     const legacy = () => opencodeTlsFetch(url, {method, headers, body}, {signal, proxyUrl: ctx?.proxyUrl || null});
     if (engine !== "legacy" && chat-completions-format model) {
       try {
         const snapshot = getEmbeddedWireSnapshot();
         const shaped = shapeV2FreeLaneRequestBody(parsedBody, snapshot);
         const headers = mintV2IdentityHeaders(snapshot, sessionIdFromCredentials);
         return await opencodeFreeLaneFetch(snapshot.endpoint, {method: "POST", headers, body: JSON.stringify(shaped)},
           {signal: options.signal, timeoutMs, proxyUrl: ctx?.proxyUrl || null});
       } catch (e) {
         if (e instanceof OpenCodeFreeLaneUnavailableError || e instanceof OpenCodeFreeLaneUnmappedProxyError) {
           emitAlert(OPENCODE_BUN_LANE_UNAVAILABLE, { reason: e.code, unmapped: e instanceof OpenCodeFreeLaneUnmappedProxyError }) deduped 1/h, severity critical;
           const err = new Error(e instanceof OpenCodeFreeLaneUnmappedProxyError
             ? "OpenCode free lane: proxy pool not mappable to the Bun lane (bind a fork xray pool or remove the pool binding)"
             : "OpenCode free lane unavailable (bun runtime/lane failure)");
           err.code = "OPENCODE_FREE_LANE_UNAVAILABLE"; err.statusCode = 503;
           throw err;   // fail-fast — do NOT serve on the gate-refused legacy lane
         }
         throw e;
       }
     }
     return legacy();  // engine="legacy" OR responses/messages-format model (known-refused lane, R8)
   }
   ```
   Details:
   - Lane gate: settings read via `getSettings()` per request (open-sse→@/lib import precedent chatCore.js:15; cache 30s if hot — implementer note, not scope).
   - Session id: exactly as `buildHeaders` does today (credentials `[SESSION_FIELD]` → `prepareRequestCredentials`, :533) — stable-session semantics untouched; rotation path untouched.
   - 429-rotation hook (:503-505) stays AFTER the response and inspects whichever lane's response came back (bun lane included — rotation on a real bun-lane 429 is CORRECT, it means the exit IP's quota is spent).
   - Unmapped-proxy is a config-state: alert severity info for it (distinct payload flag), critical only for true lane failure.
4. `detect_changes()` before commit; full opencode executor suites green.

## Verification gate

- `cd tests && npx vitest run unit/opencode-bun-lane-executor.test.js` + existing: `unit/opencode-session.test.js unit/opencode-fingerprint.test.js unit/opencode-free-tool-choice.test.js unit/opencode-go-transport-routing.test.js`
  - Primary: chat-format free model, lane mocked healthy → ONE `opencodeFreeLaneFetch` call with v2 endpoint, shaped body (harness system first, 12+caller tools, include_usage), v2 headers; ZERO `opencodeTlsFetch` calls.
  - Fail-fast: lane throws unavailable (both subclasses) → typed 503 error propagates, alert emitted once (1h dedupe), legacy NOT called.
  - Engine `"legacy"` → bun lane never called, legacy path byte-identical to today.
  - Responses/messages-format model → legacy regardless of engine (R8).
  - Upstream 429 via bun lane → response passes through, rotation hook fires exactly as today.
- `detect_changes()`: affected symbols confined to opencode executor flow + settings repo.

## Risks

- Hot-path regression (R7) — additive wrapper + `"legacy"` kill-switch + suite coverage.
- Double serialization of ~KB-scale bodies — negligible; harness prefix caching only if profiling demands (follow-up).
