// Stable error-class taxonomy for xray model-filter results.
//
// The dashboard previously reported only "N tested / N usable / N failed" —
// answering "why did it fail" required SSH + sqlite (261113 prod run: 82
// tested / 0 usable; the table held 62 × 429 quota · 34 × timeout · 17 ×
// tunnel fail). This module is the SINGLE source of class ids for:
//   - run-level chips (manager.js errorBreakdown / lastFinishedRun, phase 2)
//   - the persistent results route (phase 3: SQL fragments + summary scan)
//   - the run-log modal + servers-table badges (phase 4)
//
// IMPORTANT (single-truth, plan red-team F5): the JS precedence array below
// and the SQL fragment table (phase 3, same file) MUST stay in lockstep —
// both live here so they cannot drift. The parity test
// (tests/unit/xray-model-filter-results-route.test.js) asserts every fixture
// row classifies identically in JS and in SQL, and that fragments are
// pairwise disjoint over the corpus.

// Ordered precedence — FIRST match wins. Order matters:
//  - ETIMEDOUT cause-text appears INSIDE strict-proxy tunnel messages
//    (error.js appends "(cause: ETIMEDOUT …)"), so `tunnel` wordings must
//    win over `timeout` or one row double-buckets.
//  - `edge-ban` (managedRotation, status 403) must win over `upstream-http`,
//    else a banned IP misbuckets as a model-gate rejection.
//  - `upstream-http` sits AFTER all text fragments it could collide with,
//    making it a residual in the persisted domain (see domain note below).
export const FILTER_ERROR_CLASSES = Object.freeze([
  "usable",
  "quota-429",
  "edge-ban",
  "tunnel",
  "upstream-net",
  "tunnel-check",
  "upstream-http",
  "timeout",
  "spawn",
  "other",
]);

const hasText = (row, needle) =>
  typeof row?.error === "string" && row.error.toLowerCase().includes(needle.toLowerCase());

// Strict-proxy wording inventory (red-team R2-F3): BOTH refusal sites
// (proxyFetch "strictProxy=true but connection proxy could not be resolved;
// refusing direct fetch" and "Proxy required but none resolved (strictProxy=
// true)") plus the annotate prefix — the prefix stays exactly once since
// v0.6.91 phase 1 (idempotent guard).
const TUNNEL_WORDINGS = Object.freeze([
  // One broad wording mirrored by the SQL fragment's '%proxy required%'
  // LIKE (single truth, phase 3): covers both the annotate prefix
  // ("Proxy required but failed …") and the refusal ("Proxy required but
  // none resolved …"). The two remaining wordings are exact.
  "Proxy required",
  "strictProxy=true but connection proxy could not be resolved",
  "refusing direct fetch",
]);

// Precedence predicates over a result row
// ({ ok, status, error, spawnFailed, infraError, tunnelOk }).
//
// Two domains (plan red-team F5 caveat):
//  - "in-memory": fresh run rows. `tunnelOk === true && status !== 429` is
//    the model-gate HTTP failure (403/5xx through a healthy tunnel).
//  - "persisted": xrayModelFilterResults rows — there is NO tunnelOk column
//    ("no schema change" constraint), so upstream-http degrades to the
//    residual "non-429 HTTP status matching no other fragment" (position in
//    the precedence list makes it residual). Run chips and History counts
//    may therefore differ for ambiguous non-429 HTTP rows without
//    distinguishing text; the UI labels the two views accordingly (phase 4).
const MATCHERS = Object.freeze([
  { id: "usable", match: (r) => r.ok === true },
  { id: "quota-429", match: (r) => r.status === 429 || hasText(r, "FreeUsageLimitError") },
  { id: "edge-ban", match: (r) => hasText(r, "cloudflare edge ip block") },
  { id: "tunnel", match: (r) => TUNNEL_WORDINGS.some((w) => hasText(r, w)) },
  { id: "upstream-net", match: (r) => hasText(r, "bun child upstream fetch failed") },
  { id: "tunnel-check", match: (r) => r.status === 0 && hasText(r, "tunnel connectivity check failed") },
  {
    id: "upstream-http",
    match: (r, domain) =>
      domain === "in-memory"
        ? r.tunnelOk === true && r.status !== 429
        : typeof r.status === "number" && r.status >= 400 && r.status !== 429,
  },
  // Mirrors the SQL base '%timed%out%' OR '%timeout%' exactly (single truth,
  // phase 3): "timed.*out" covers "timed out" / "timedout" / "ETIMEDOUT";
  // "timeout" the compact form. SQL LIKE has no equivalent of the old
  // /timed? ?out/ single-space variant, so JS widened to match SQL.
  { id: "timeout", match: (r) => /timed.*out|timeout/i.test(r?.error || "") },
  { id: "spawn", match: (r) => r.spawnFailed === true || Boolean(r.infraError) },
  { id: "other", match: () => true },
]);

/**
 * Classify one model-filter result row. Pure — no I/O, no imports.
 * First matcher in FILTER_ERROR_CLASSES precedence wins.
 *
 * @param {{ ok?: boolean, status?: number|null, error?: string|null,
 *          spawnFailed?: boolean, infraError?: boolean, tunnelOk?: boolean }} row
 * @param {{ domain?: "in-memory"|"persisted" }} [opts]
 * @returns {string} one of FILTER_ERROR_CLASSES
 */
export function classifyFilterError(row, { domain = "in-memory" } = {}) {
  for (const { id, match } of MATCHERS) {
    if (match(row, domain)) return id;
  }
  return "other"; // unreachable: "other" matches everything
}

/** Persisted-domain wrapper (xrayModelFilterResults rows, no tunnelOk). */
export function classifyPersistedFilterError(row) {
  return classifyFilterError(row, { domain: "persisted" });
}

// UI labels (chips, modal) — short; counts render as "N× <label>".
export const FILTER_ERROR_LABELS = Object.freeze({
  "usable": "usable",
  "quota-429": "429 quota",
  "edge-ban": "edge ban",
  "tunnel": "tunnel fail",
  "upstream-net": "upstream net",
  "tunnel-check": "tunnel check",
  "upstream-http": "upstream http",
  "timeout": "timeout",
  "spawn": "spawn fail",
  "other": "other",
});

// Badge variants per class (src/shared/components/Badge.js variants).
export const FILTER_ERROR_VARIANTS = Object.freeze({
  "usable": "success",
  "quota-429": "warning",
  "edge-ban": "error",
  "tunnel": "error",
  "upstream-net": "error",
  "tunnel-check": "error",
  "upstream-http": "error",
  "timeout": "error",
  "spawn": "error",
  "other": "warning",
});

/**
 * Increment a breakdown counter for a row. Mutates `breakdown` in place
 * (manager.js onProgress accumulator); returns the same object.
 */
export function bumpErrorBreakdown(breakdown, row, opts) {
  const cls = classifyFilterError(row, opts);
  breakdown[cls] = (breakdown[cls] || 0) + 1;
  return breakdown;
}

/**
 * Ordered chip entries for a breakdown: non-zero classes only, FILTER_ERROR
 * _CLASSES precedence order (usable first, "other" last).
 */
export function errorBreakdownEntries(breakdown) {
  if (!breakdown) return [];
  return FILTER_ERROR_CLASSES
    .filter((cls) => (breakdown[cls] || 0) > 0)
    .map((cls) => ({ cls, count: breakdown[cls], label: FILTER_ERROR_LABELS[cls], variant: FILTER_ERROR_VARIANTS[cls] }));
}

// ─── SQL fragments (phase 3) — the persisted-domain truth ────────────────
// One base predicate per class, over the xrayModelFilterResults (r) ⋈
// xrayConfigses (c) join, all fully parameterized at the call sites.
// SQLite LIKE is case-insensitive for ASCII — matching the JS classifier's
// toLowerCase().includes() comparisons.
//
// SINGLE TRUTH: the JS precedence array above and these bases are two views
// of the same taxonomy. fragment(cls) = base(cls) AND NOT(any earlier base)
// — pairwise disjoint BY CONSTRUCTION, mirroring first-match-wins.
// The parity test (tests/unit/xray-model-filter-results-route.test.js)
// proves it over the fixture corpus: every row matches exactly one
// fragment, and JS(persisted) === SQL for all of them.

export const FILTER_ERROR_BASE_PREDICATES = Object.freeze([
  { cls: "usable", sql: "r.ok = 1" },
  { cls: "quota-429", sql: "(COALESCE(r.status, -1) = 429 OR COALESCE(r.error, '') LIKE '%freeusagelimiterror%')" },
  { cls: "edge-ban", sql: "COALESCE(r.error, '') LIKE '%cloudflare edge ip block%'" },
  { cls: "tunnel",
    sql: `(COALESCE(r.error, '') LIKE '%proxy required%'
           OR COALESCE(r.error, '') LIKE '%strictproxy=true but connection proxy%'
           OR COALESCE(r.error, '') LIKE '%refusing direct fetch%')` },
  { cls: "upstream-net", sql: "COALESCE(r.error, '') LIKE '%bun child upstream fetch failed%'" },
  { cls: "tunnel-check", sql: "(COALESCE(r.status, -1) = 0 AND COALESCE(r.error, '') LIKE '%tunnel connectivity check failed%')" },
  // Persisted domain: no tunnelOk column, so upstream-http is the residual
  // non-429 HTTP status bucket. "other" is the complement of all bases.
  // COALESCE everywhere: `r.status = 429` on NULL status yields NULL and a
  // NULL inside NOT(...) silently excludes otherwise-matching rows (the
  // three-valued-logic trap the first draft hit).
  { cls: "upstream-http", sql: "(r.ok = 0 AND COALESCE(r.status, -1) >= 400 AND COALESCE(r.status, -1) <> 429)" },
  { cls: "timeout", sql: "(COALESCE(r.error, '') LIKE '%timed%out%' OR COALESCE(r.error, '') LIKE '%timeout%')" },
]);

// Classes WITHOUT a SQL base: `spawn` rows are never persisted (recordCache
// skips them — manager.js), `other` is the complement of every base above.
export const FILTER_ERROR_CLASSES_WITHOUT_FRAGMENT = Object.freeze(["spawn", "other"]);

function filterErrorEarlierBaseSql(cls) {
  const idx = FILTER_ERROR_BASE_PREDICATES.findIndex((p) => p.cls === cls);
  if (idx <= 0) return null;
  return FILTER_ERROR_BASE_PREDICATES.slice(0, idx).map((p) => p.sql).join(" OR ");
}

/**
 * The pairwise-disjoint SQL fragment for one error class (persisted rows).
 * fragment(cls) = base(cls) AND NOT(any earlier base) — first-match-wins in
 * SQL form. Returns null for classes without a persisted fragment
 * ("spawn" — never persisted; "other" — use FILTER_ERROR_SQL_OTHER_FRAGMENT).
 */
export function getFilterErrorFragmentSql(cls) {
  const base = FILTER_ERROR_BASE_PREDICATES.find((p) => p.cls === cls);
  if (!base) return null;
  const earlier = filterErrorEarlierBaseSql(cls);
  if (!earlier) return base.sql;
  return `(${base.sql} AND NOT (${earlier}))`;
}

/** The "other" fragment: complement of every base (residual bucket). */
export const FILTER_ERROR_SQL_OTHER_FRAGMENT =
  `NOT (${FILTER_ERROR_BASE_PREDICATES.map((p) => p.sql).join(" OR ")})`;
