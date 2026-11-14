# Research 02 — API/repo/auth recon (phase 4), hard-mode session 261114

All findings verified with file:line from the current working tree (v0.6.90, commit c6875a3a).

## 1. Auth middleware coverage

- Middleware: `src/proxy.js` → delegates to `dashboardGuard.proxy` (`src/dashboardGuard.js:244`). Matcher is a catch-all (`src/proxy.js:71-72`); no per-path allowlist in matcher.
- **LOCAL_ONLY gate**: `LOCAL_ONLY_PATHS` includes prefix `"/api/xray/configs/"` (`src/dashboardGuard.js:120`, comment "covers /api/xray/configs/[id]/test") — `startsWith` match → **every nested path under `/api/xray/configs/` is local-only-gated** (loopback+auth, CLI token, private-dashboard, or tunnel+auth; :169–194). A remote dashboard user gets 403 unless tunnel/private access applies.
- **Deny-by-default `/api/*`**: `:262–267` — public allowlists (`PUBLIC_API_PATHS` :33–45, `PUBLIC_PREFIXES` :49) contain no xray paths. `PROTECTED_API_PATHS` (:76–92) exists but is not consulted in `proxy()`.
- Sibling routes (`model-filter/`, `clear-cache/`, `stop/`) have ZERO explicit auth checks — fully implicit.
- ⇒ New route `configs/model-filter/results/route.js` is auto-covered (double: LOCAL_ONLY prefix + deny-by-default).

## 2. modelFilterResultsRepo surface (`src/lib/db/repos/modelFilterResultsRepo.js`)

Exports (line numbers): `getModelFilterResult` :37 · `getModelFilterResultsByConfigIds(configIds, model, {maxAgeMs}) → Map` :57 · `getNextHealthyConfigsForModel` :99 · `getNextHealthyConfigsAnyModel` :148 · `getModelFilterCacheStats → {total, byModel}` :184 · `upsertModelFilterResult` :198 (`ON CONFLICT(configId, model)`) · `clearModelFilterResultsByModel` :226 · `clearAllModelFilterResults` :234 · `deleteModelFilterResultsByConfigIds` :241 · `pruneOrphanModelFilterResults` :264.

Schema `src/lib/db/schema.js:223–239`:
- Columns: configId, model, ok, latencyMs, status, exitIp, error, testedAt (:224–233)
- `PRIMARY KEY (configId, model)` (:234)
- **Indexes EXIST**: `idx_xmfr_model(model)` :236 and `idx_xmfr_configId(configId)` :237. **No (testedAt) index** — an ORDER BY testedAt scoped by model rides idx_xmfr_model then sorts that model's rows (bounded by per-model row count; fine at 10k total).

## 3. Repo test pattern (canonical)

- **Real temp sqlite**: `tests/unit/db-concurrent.test.js:16–29` — `fs.mkdtempSync(path.join(os.tmpdir(), …))`, `process.env.DATA_DIR = tempDir`, `vi.resetModules()`, `db = await import("@/lib/db/index.js")`, `await db.initDb()`, cleanup `afterAll` (:31–36). Same in `db-sqlite-vs-lowdb.test.js:17`, `db-benchmark.test.js:33`.
- Alternative fake-adapter mock: `tests/unit/apikeys-budget-repo.test.js:70` (vi.mock on `driver.js`).

## 4. `/api/xray/configs` badge attach

- Feeding repo call: `getModelFilterResultsByConfigIds(configs.map(c => c.id), filterModel)`.
- Payload per config: `c.modelFilterResult = { ok, latencyMs, testedAt }` or `null` — the route **strips `status`, `exitIp`, `error`, `configId`, `model`** (route.js:45–50). Repo row already carries `error` (rowToResult, repo :27–29) ⇒ extending with `errorClass` is additive, no second fetch.
- Envelope: `NextResponse.json({ configs, facets, counts, deleted })`; errors `{ error }` 500; `export const dynamic = "force-dynamic"` (route.js:3).
- Model default from settings: `settings.xrayModelFilterModel.trim()` typed defensively (badge block).

## 5. Route conventions

- `force-dynamic` everywhere in xray routes.
- searchParams: `const { searchParams } = new URL(request.url)`, `.get()` with `=== "1"/"0"` coercion (configs/route.js:11–18).
- POST action routes answer `{ success: true, … }`; GET list routes answer flat keyed objects.

## Assumption audit

- (i) nested route auto-covered — CONFIRMED (and stricter: LOCAL_ONLY prefix)
- (ii) "only composite PK, no extra indexes" — **CONTRADICTED**: idx_xmfr_model + idx_xmfr_configId exist; no testedAt index
- (iii) repos tested against real sqlite — CONFIRMED (temp DATA_DIR + initDb pattern)
