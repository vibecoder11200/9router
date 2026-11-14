---
title: "Phase 3: Persistent results API"
status: done
---

# Phase 3 — Persistent results API (route + repo)

## Context Links

- Table `xrayModelFilterResults` (`configId, model, ok, latencyMs, status, exitIp, error, testedAt`) — written by filter probes (`upsertModelFilterResult`, repo :198) AND by **managedRotation** (managedRotation.js:274-281, `status:403, "cloudflare edge ip block …"` — second writer, PK-replace)
- Phase 2 classifier (`src/lib/xray/modelFilterErrors.js`) — single source of class ids
- Research: [researcher-02-api-recon.md](./research/researcher-02-api-recon.md)
- Red-team findings applied: F1 (this route is now the modal's data source — moved BEFORE the modal), F3 (persisted-fields-only fragments), F4 (edge-ban), F5 (single-truth parity), F6 (exitIp opt-in), F8 (deletedAt filter), F10 (minTestedAt), F14 (empty spawn fragment)
- Prod scale: 9,959 configs / 1,297 active — server-side pagination mandatory

## Research Evidence (hard-mode 261114)

- **Auth: auto-covered + stricter than assumed.** `dashboardGuard.js:120` puts prefix `"/api/xray/configs/"` in `LOCAL_ONLY_PATHS` (startsWith, :246-250) — the route is local-only (loopback+auth / CLI token / private dashboard / tunnel+auth, :169-194) PLUS deny-by-default `/api/*` (:262-267). No middleware change. ⚠️ Under `requireLogin === false` + tunnel dashboard access, `isAuthenticated` short-circuits true (dashboardGuard.js:221-226) — see Security.
- **Indexes exist:** `idx_xmfr_model(model)` + `idx_xmfr_configId(configId)` (schema.js:236-237); PK `(configId, model)` :234. No testedAt index; `ORDER BY r.testedAt DESC` scoped by `WHERE r.model = ?` rides idx_xmfr_model. No new index (YAGNI at 10k).
- **Repo test pattern (canonical):** real temp sqlite — `tests/unit/db-concurrent.test.js:16-29` (`fs.mkdtempSync`, `process.env.DATA_DIR`, `vi.resetModules()`, `import("@/lib/db/index.js")`, `await db.initDb()`). Parity tests use THIS, never adapter mocks (a mock's LIKE semantics make parity self-fulfilling — red-team F5).
- **Conventions:** `force-dynamic`; `new URL(request.url).searchParams` + `.get()` coercion (configs/route.js:11-18); flat keyed envelope; settings-default model precedent = configs/route.js badge block.

## Overview

- Priority: P2
- Read-only API over `xrayModelFilterResults JOIN xrayConfigs`. Powers phase 4's modal (History mode), the servers-table status upgrade, and the pool-health summary. This phase moved BEFORE the modal because the modal's originally-assumed data source (`modelFilterResult.results`) is dead code (red-team F1) — the persistent route is the modal's backend.

## Key Insights

- **Single-truth parity (red-team F5):** the SQL predicate fragments ARE the definition of row filtering; the JS classifier derives FROM them. The parity test feeds every fixture row through BOTH and asserts **exactly one fragment matches** — a row matching two fragments (e.g. `ETIMEDOUT` text matching `tunnel` wordings AND `timeout`) fails CI at authoring time, forcing precedence INTO the fragments (e.g. `tunnel` fragment excludes rows matching timeout text via `AND NOT`… no — precedence lives in fragment disjointness: each fragment must be provably disjoint; the test enforces pairwise disjointness over the corpus).
- **Persisted-fields-only classes:** `tunnelOk` is NOT persisted (schema has no column; "no schema change" holds). Persistent-row fragments therefore use `{ok, status, error-text}` only: `upstream-net` (the `[502]: bun child upstream fetch failed:` prefix) stays text-matched; `upstream-http` degrades to "non-429 HTTP status row that matches NO other fragment" (residual bucket after tunnel/upstream-net/edge-ban wordings) — **documented caveat: run chips (with tunnelOk) and History counts can differ for ambiguous 502s; the UI labels the two views accordingly (phase 4)**.
- **Fragment table (derived from phase 2 taxonomy; `spawn` deliberately ABSENT):**

| class | SQL fragment (model-scoped; `c.deletedAt IS NULL` always) |
|---|---|
| usable | `r.ok = 1` |
| quota-429 | `r.status = 429 OR r.error LIKE '%FreeUsageLimitError%'` |
| edge-ban | `r.error LIKE '%cloudflare edge ip block%'` |
| tunnel | `r.error LIKE '%Proxy required%' OR r.error LIKE '%strictProxy=true but connection proxy%' OR r.error LIKE '%refusing direct fetch%'` |
| upstream-net | `r.error LIKE '%bun child upstream fetch failed%'` |
| tunnel-check | `r.status = 0 AND r.error LIKE '%tunnel connectivity check failed%'` |
| upstream-http | `r.ok = 0 AND r.status >= 400 AND r.status <> 429 AND (no other fragment)` — implemented as residual: NOT (any fragment above) |
| timeout | `r.error LIKE '%timed%out%' OR r.error LIKE '%timed out%' OR r.error LIKE '%timeout%'` (disjointness enforced by test: tunnel wordings checked first) |
| other | residual NOT (any) |
| spawn | **empty fragment — in-memory only** (recordCache never persists spawn/infra rows, manager.js:1347); documented for the parity corpus |
- **Fragment disjointness vs precedence:** SQL fragments are tested PAIRWISE-DISJOINT over the fixture corpus (probe strings, refusal wordings, ETIMEDOUT-cause, edge-ban, default-mode string, UpstreamError string). Where natural text overlap exists (tunnel wordings containing "timed out" causes), the DISJOINT fragment narrows the later fragment (`timeout AND NOT (tunnel wordings)`) — the classifier's JS precedence array and these NOT-clauses must stay in lockstep; the same module exports both (fragments + precedence) so they cannot drift.
- **deletedAt filter (red-team F8):** user delete = soft tombstone (xrayRepo.js:194-219) which does NOT cascade results; orphan prune runs only at sync (sync.js:217). EVERY query: `JOIN xrayConfigs c ON c.id = r.configId … WHERE c.deletedAt IS NULL` (+ `c.isActive = 1` EXPOSED AS A QUERY PARAM defaulting to true — inactive-but-not-deleted keeps rows the user may still want in History). The old "no orphans" claim is deleted.
- **exitIp is opt-in (red-team F6):** rows omit `exitIp` unless `?includeExitIp=1`. This route is the FIRST endpoint exposing inventory-wide exitIp + full error text; under `requireLogin=false`+tunnel, that is a passwordless network map of the user's subscriptions.
- **Summary classifies FULL text in ONE ordered scan (red-team F5/F7):** `view=summary` does `SELECT ok, status, error FROM … WHERE model AND deletedAt-filter [AND testedAt >= minTestedAt]` and classifies in JS with running per-class counters — O(rows) time, O(classes) memory. NO `substr(error,1,60)` grouping (truncated prefixes merge rows of different classes), no "~dozens distinct combos" assumption (error text embeds per-node variables — summarizeProbeBody slices 240 chars, manager.js:874-876).
- **minTestedAt scoping (red-team F10):** `?minTestedAt=` (ISO) — the modal's "last run" mode passes the run's startedAt so History matches what the chips counted; without it History is explicitly labeled "all persisted verdicts (may span runs)" and rows show testedAt age.

## Requirements

- [ ] `GET /api/xray/configs/model-filter/results?model=&class=&ok=&search=&minTestedAt=&includeExitIp=&page=&pageSize=&view=summary|rows` → rows: `{configId, name, host, country, isActive, ok, status, latencyMs, error?, exitIp?, testedAt}` (error/exitIp omitted for ok rows; exitIp only with includeExitIp=1)
- [ ] Every query `JOIN … WHERE c.deletedAt IS NULL`; `isActive` param default 1
- [ ] `view=summary` = one ordered scan + JS classify (full text); shape `{ byClass: {class→n}, total, lastTestedAt, scope: {model, minTestedAt|null, activeOnly} }`
- [ ] Fragment table exported from `modelFilterErrors.js` alongside the JS precedence; parity test (real temp sqlite) asserts pairwise-disjoint matching over the full fixture corpus incl. a managedRotation-shaped row and an ETIMEDOUT-cause row; `spawn` documented empty
- [ ] `pageSize ≤ 200`, `force-dynamic`, search LIKE-escaped parameterized, model defaults from settings badge-block precedent
- [ ] Route header comment documents: LOCAL_ONLY coverage + the requireLogin=false/tunnel exposure note + exitIp opt-in rationale

## Architecture

```
GET /api/xray/configs/model-filter/results
  ├─ view=rows    → repo.listFilterResultsJoined({model, class, ok, search, minTestedAt, activeOnly, includeExitIp, page, pageSize})
  │                  JOIN + deletedAt filter + class fragment (parameterized) + ORDER BY r.testedAt DESC + LIMIT/OFFSET
  └─ view=summary → repo.scanFilterResults({model, minTestedAt, activeOnly}) → JS classify (full error text) → counters
UI consumers (phase 4 modal + servers-table status) — this route is the ONLY new backend surface
```

## Related Code Files

- Modify: `src/lib/db/repos/modelFilterResultsRepo.js` — `listFilterResultsJoined`, `scanFilterResults`, `countFilterResultsJoined` (for pagination totals)
- Modify: `src/lib/xray/modelFilterErrors.js` (phase 2) — export the SQL fragment table + precedence (single module owns both)
- Create: `src/app/api/xray/configs/model-filter/results/route.js`
- Create: `tests/unit/xray-model-filter-results-route.test.js` (route + repo parity, real temp sqlite)

## Implementation Steps

1. `impact({target: "getModelFilterResultsByConfigIds"})` before repo edits.
2. Fragments + precedence into `modelFilterErrors.js` (single owner).
3. Repo functions (deletedAt filter everywhere; parameterized LIKE; counts for pagination).
4. Route (params, envelope, exitIp opt-in, auth-comment header).
5. Tests: route (auth implicit — assert 401 via unauthenticated fetch in the established route-test style, pagination bounds, empty-cache state), repo parity on real temp sqlite (fixture corpus incl. edge-ban + ETIMEDOUT-cause + default-mode + UpstreamError rows; pairwise-disjoint assertion).
6. `cd tests && npx vitest run unit/xray-model-filter-results-route.test.js unit/xray-filter-error-breakdown.test.js`.

## Todo

- [ ] Fragment table + disjointness ownership in modelFilterErrors.js
- [ ] Repo functions (3) with deletedAt/parameterized-LIKE
- [ ] Route + exitIp opt-in + auth-comment
- [ ] Real-sqlite parity suite (disjoint corpus)
- [ ] Route tests green

## Success Criteria

- Parity: every fixture row matches EXACTLY one fragment in real sqlite AND exactly one class in JS — same id
- Soft-deleted configs' rows never appear (tombstone fixture in the repo test)
- `view=summary` on ~1.3k rows runs one query, classifies full text, returns in <100ms local
- exitIp absent from default row payloads (test-pinned)

## Risk Assessment

- **Medium (plan's highest, reduced from v1).** The drift risk between SQL and JS is neutralized by single-module ownership + disjointness testing. Residual: genuinely ambiguous persisted rows (upstream 502 without distinguishing text) land in `upstream-http` residual — documented, labeled in UI, and honest (cannot do better without a schema change this plan deliberately avoids).

## Security Considerations

- Auth: LOCAL_ONLY prefix + deny-by-default (verified) — BUT document the `requireLogin === false` + tunnel-dashboard configuration (dashboardGuard.js:221-226) under which this route is reachable without a password; exitIp opt-in + the header comment are the mitigations. Consider (follow-up, out of scope): requiring auth for this specific route even when requireLogin is off.
- `search`/`class` parameterized; LIKE-escaped (`%_`); no string interpolation into SQL
- Rows carry error/exitIp only — no credentials; error text is upstream-response summaries (manager.js:870-878), already displayed per-config today
