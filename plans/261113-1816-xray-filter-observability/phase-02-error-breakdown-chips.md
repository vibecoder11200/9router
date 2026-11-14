---
title: "Phase 2: Error classifier + breakdown chips"
status: done
---

# Phase 2 — Error classifier + breakdown chips

## Context Links

- Prod evidence 261113: run summary showed "82 tested, 0 usable, 82 failed" — useless without the WHY. (DB aggregation across recent runs: `62 × 429 quota · 34 × timeout · 17 × tunnel fail` — note these are CUMULATIVE table rows, not one run's counts; wording corrected per red-team R1-F8.)
- `src/lib/xray/manager.js` — `filterConfigsByModel` builds `results[]`; `runModelFilterJob` copies counters into `modelFilterState` (incl. `abortedReason` from v0.6.90)
- `src/app/(dashboard)/dashboard/xray/page.js` — running banner **:1290–1302** (counters :1296), completion watcher :330–358, idle badge :1157–1163 renders `visibleModelFilterResult` (:878–883)
- Research: [researcher-01-ui-recon.md](./research/researcher-01-ui-recon.md) (⚠️ its "(iii) CONFIRMED" checked symbol existence, NOT runtime population — see Red Team Review F1)
- Red-team findings applied: F3 (taxonomy), F9 (lastFinishedRun), F11 (aborted chip), F2 (stale badge), F14 (spawn in-memory)

## Overview

- Priority: P2
- Classify every run result into a stable error taxonomy server-side, accumulate per-class counts, and render chips for the last finished run. The classifier is the single class-id source for phases 3–4 (route SQL fragments derive from it).

## Key Insights

### Taxonomy v2 (red-team corrected)

The v1 taxonomy was derived from ONE chat-probe run's error strings. Red-team traced ALL probe-producing paths; three real classes were missing and one was unimplementable:

| class | Match (in-memory rows) | Variant | Notes |
|---|---|---|---|
| `usable` | `ok === true` | success | |
| `quota-429` | status 429 / `FreeUsageLimitError` | warning | node ALIVE, quota spent — recovers |
| `timeout` | `/timed? ?out/i` **checked AFTER tunnel/edge-ban** (see precedence) | error | matches "timed out", "ETIMEDOUT", "TIMEOUT" |
| `tunnel` | `[ProxyFetch] Proxy required but failed` OR `Proxy required but none resolved` OR `strictProxy=true but connection proxy could not be resolved` OR `refusing direct fetch` (all strictProxy wordings, incl. both refusal sites proxyFetch :641/:720) | error | tunnel/proxy never opened |
| `upstream-http` | `tunnelOk === true && status ∉ {429}` | error | healthy tunnel, model gate answered non-429 (403/5xx). **Requires `tunnelOk` in the signature** — the field exists on in-memory rows (manager.js:1008-1014 spread into results :1389) |
| `upstream-net` | `[502]: bun child upstream fetch failed:` (v0.6.90 `OpenCodeFreeLaneUpstreamError` surfaces via chatCore with statusCode defaulting 502) | error | bun child's fetch died on the route — distinct from strict-proxy tunnel failures |
| `tunnel-check` | status 0 + `tunnel connectivity check failed` | error | **the DEFAULT mode's failure string** (freeChatProbe=false: manager.js:937 spawn / :1120 api) — without this class, a default-mode run's every dead node lands in `other` |
| `edge-ban` | `cloudflare edge ip block` (exact-ish) | error | written ONLY by managedRotation (managedRotation.js:274-281, `status:403`) — PK-replaces the filter's verdict for the active config; must not misbucket as `upstream-http` |
| `spawn` | `spawnFailed/infraError` flags | error | **in-memory only** — `recordCache` never persists these rows (manager.js:1347); the persistent route has NO spawn fragment (phase 3 documents the empty fragment) |
| `other` | fallback | default | last |

**Rule precedence is explicit and test-pinned (first match wins):** `usable → quota-429 → edge-ban → tunnel (wordings) → upstream-net → tunnel-check → upstream-http → timeout → spawn → other`. Precedence matters: `ETIMEDOUT` cause-text appears inside strict-proxy tunnel messages (error.js:146-149 appends `(cause: ETIMEDOUT …)`) — `tunnel` wordings must win over `timeout`, or one row double-buckets.

**Classifier signature (v2):** `classifyFilterError({ ok, status, error, spawnFailed, infraError, tunnelOk })` — pure function; `tunnelOk` undefined for persistent rows, where `upstream-http`/`upstream-net`/`tunnel-check` degrade per phase 3's persisted-fields-only fragment set.

### State: snapshot, not live shadow (red-team F9/F2)

- `modelFilterState` gains `lastFinishedRun` — snapshotted ONCE in the completion assign: `{ finishedAt, startedAt, model, source, all, freeChatProbe, tested, passed, failed, cached, pruned, errorBreakdown, abortedReason, cancelled }`. Idle UI reads ONLY this snapshot — never live state — so background auto-runs (sync-triggered runs, the coalesced re-run latch manager.js:1596-1613) cannot silently replace what the user is reading.
- The run start resets `errorBreakdown: {}` (with the other counters, manager.js:1510-1533).
- **Fix the existing stale-badge bug (F2):** `visibleModelFilterResult` = `modelFilterResult || status.modelFilter…` (page.js:878-883) shadows live status with the frozen start snapshot after manual runs. The completion watcher (:330-358) must null `modelFilterResult` on the running→finished transition; idle badge renders from `status.modelFilter.lastFinishedRun`.

### Aborted runs (F11)

When `lastFinishedRun.abortedReason` is set, the chips row renders a leading `aborted after N — M untested` chip (M = selected − tested) — partial counts must never read as complete (the same class of silent truncation v0.6.90's `abortedReason` killed in the toast).

## Requirements

- [ ] `classifyFilterError` exported from `src/lib/xray/modelFilterErrors.js`; unit table covers: the 3 prod strings, the default-mode `tunnel-check` string, the v0.6.90 `upstream-net` string, BOTH refusal wordings (:641/:720), an ETIMEDOUT-cause tunnel row (asserts precedence), a managedRotation edge-ban row, an ok row, unknown junk → other
- [ ] Precedence table documented in the module (first-match order above) and pinned by test
- [ ] `errorBreakdown` accumulates via `onProgress` during runs; `lastFinishedRun` snapshot at completion; both serialize through `getModelFilterStatus()` (verified: it spreads modelFilterState — manager.js:387-397)
- [ ] Chips render in the running banner (:1290-1302) from live counts, and in the idle badge (:1157-1163) from `lastFinishedRun`; aborted chip when applicable; classes with count 0 hidden; `other` last
- [ ] Completion watcher nulls `modelFilterResult` (stale-badge fix)

## Architecture

```
filterConfigsByModel result row ──onProgress──► modelFilterState.errorBreakdown[class]++ (live)
completion assign ──► modelFilterState.lastFinishedRun = {snapshot incl. errorBreakdown, abortedReason}
GET /api/xray/status (spreads state) ──► page.js
  ├─ running banner (:1290-1302): live errorBreakdown
  └─ idle badge (:1157-1163): lastFinishedRun.errorBreakdown + aborted chip
```

- `modelFilterErrors.js` is dependency-free (pure) — importable from manager.js, the phase-3 route, and UI-adjacent code without cycles.

## Related Code Files

- Create: `src/lib/xray/modelFilterErrors.js` — classifier + precedence table + labels + class→Badge-variant map
- Modify: `src/lib/xray/manager.js` — start reset (`errorBreakdown: {}`), onProgress increment, completion `lastFinishedRun` snapshot
- Modify: `src/app/(dashboard)/dashboard/xray/page.js` — chips (2 sites), aborted chip, stale-badge fix
- Create: `tests/unit/xray-filter-error-breakdown.test.js`

## Implementation Steps

1. `impact({target: "runModelFilterJob"})` (LOW expected).
2. `modelFilterErrors.js` with the v2 taxonomy + explicit precedence array (the array IS the implementation — reduce over it).
3. manager.js wiring (reset/increment/snapshot).
4. page.js: chips ×2 + aborted chip + completion-watcher null-out.
5. Tests (the expanded table above). Run from `tests/`: `npx vitest run unit/xray-filter-error-breakdown.test.js unit/xray-filter-multi-sub-fixes.test.js unit/xray-model-filter-route.test.js`.

## Todo

- [ ] Classifier v2 + precedence + unit table (incl. all red-team-pinned strings)
- [ ] manager.js state wiring (reset/increment/lastFinishedRun)
- [ ] Chips UI (banner + badge + aborted) + stale-badge fix
- [ ] Suites green

## Success Criteria

- `getModelFilterStatus().lastFinishedRun.errorBreakdown` reflects the finished run and survives a subsequent auto-run's start (snapshot semantics)
- Default-mode (freeChatProbe=false) dead nodes bucket as `tunnel-check`, NOT `other`
- An ETIMEDOUT-cause strict-proxy row buckets as `tunnel` exactly once
- Idle badge updates after a manual run completes (no frozen "0 tested")

## Risk Assessment

- **Low-medium.** State accumulation mirrors existing counters; the classifier is pure and test-pinned. Biggest residual: taxonomy drift as new error paths land — mitigated by the pinned string table; new probes should extend it.

## Security Considerations

- Chips show counts + labels only; raw error text renders solely in phase-4's modal as escaped JSX.
