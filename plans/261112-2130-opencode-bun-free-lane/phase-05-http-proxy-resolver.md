# Phase 05 — socks→http resolver (derive + TCP-verify) + stopXrayService status fix

Depends on: nothing (parallel with P1, P2). Must land before P3's final wiring.

## Objective

Convert a fork-owned `socks5://127.0.0.1:P` proxy URL into the paired xray HTTP inbound `http://127.0.0.1:P+1` — by DERIVATION + TCP-verification at resolve time, not by a registry (red-team AD-F5 accepted the scope critic's simpler resolver: self-healing across HMR, restarts, blue-green drains, and `alreadyRunning` cold starts by construction). Plus one small latent-bug fix in manager status.

Rationale for socks+1 as derivation (not guess): `buildInbounds` (configBuilder.js:20-38) binds the http inbound at `httpPort` and every spawn site computes it as the socks port's fixed neighbor (managed :499/:537, blue-green :626/:690, temp :824-826 — `tempHttp = tempSocks + 1`). Derivation is a invariant of the codebase; the TCP-verify step is the ground truth that catches the invariant's rare misses (dead instance, foreign listener).

## Files

- `src/lib/xray/httpProxyResolver.js` (new)
- `src/lib/xray/manager.js` (edit — `stopXrayService` status fix ONLY; optional `httpPort` on spawnTempConfig return for introspection)
- `tests/unit/xray-http-proxy-resolver.test.js` (new)

## Steps

1. House rules: `impact({target: "stopXrayService", direction: "upstream"})` before the manager edit; `detect_changes()` before commit.
2. `httpProxyResolver.js` (node-only deps):
   - `resolveXrayHttpProxyUrl(proxyUrl, { verify = true } = {})` → `"http://127.0.0.1:<H>"` | `null`.
     - Accept ONLY `socks5(h)://127.0.0.1:<P>` (loopback host exact). Anything else → null.
     - Derive `H = P + 1`; **TCP-connect verify** `127.0.0.1:H` (200ms timeout) — open → return the http URL; closed → null.
     - Negative cache (port → timestamp, 30s TTL) so repeated resolves of a dead pair don't re-probe; positive results not cached (fresh verify each resolve keeps ground truth).
     - `__test__.setVerifyFn()` injection + cache reset.
   - NO manager.js hooks, NO registry, NO unregister choreography.
3. Manager edit (small, isolated):
   - `stopXrayService` (:551-559): add `httpPort: null` into `setStatus("stopped", …)` — today `state.httpPort` survives a stop (visible via `getStatus()`, :379) — latent bug the status route would inherit.
   - `spawnTempConfig` return: add `httpPort: tempHttp` (already computed :824) — purely additive, for probe introspection/logging (the lane itself derives, doesn't consume this).
4. Optional tunable: none (KISS — 200ms verify, 30s negative TTL as constants).

## Verification gate

- `cd tests && npx vitest run unit/xray-http-proxy-resolver.test.js`:
  - Loopback socks + open verify → http URL; closed verify → null; non-loopback host → null; `http://` input → null; `socks5h` accepted.
  - Negative cache: closed port resolves twice → verify called once within TTL.
  - No-derivation-without-verify guarantee: monkeypatched verify=false mode → returns derived URL (used by callers that already know the pair) — the default path ALWAYS verifies.
- `stopXrayService` regression: `getStatus().httpPort === null` after stop (mocked spawn per existing manager test patterns).
- `detect_changes()`: manager diff confined to the two spots.

## Risks

- A non-xray listener at P+1 accepting TCP → false-positive mapping → request dies at connect → lane retry → typed error (bounded blast: one request, visible). Accepted: loopback P+1 is xray's by construction; collision is the pre-existing R9.
- 200ms verify on the hot path: only on free-lane requests with a socks proxy, once per resolve (positive not cached but connection setup dominates anyway); if profiling objects later, add a 5s positive cache (follow-up).
