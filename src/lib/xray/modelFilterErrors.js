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
  "Proxy required but failed",
  "Proxy required but none resolved",
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
  { id: "timeout", match: (r) => /timed? ?out/i.test(r?.error || "") },
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
