/**
 * Data-access layer for cached Model Proxy Filter probe results.
 *
 * One row per (configId, model): the most recent probe outcome. The
 * xrayConfigs.id is a sha1 of the canonical share link (see syncParse.js),
 * so it doubles as a stable fingerprint — a config whose link changes is a
 * new id and therefore a fresh cache entry. The cache lifetime is the
 * subscription sync cycle: orphaned rows (config no longer active) are pruned
 * after each sync, and any row can be cleared manually via the UI.
 *
 * Follows the rowToX/XToRow + upsert + transaction pattern of the other repos
 * (see xrayRepo.js). Conforms to the db adapter API so it works across all
 * SQLite backends.
 */

import { getAdapter } from "../driver.js";

// ─── mapper ───────────────────────────────────────────────────────────────

function rowToResult(row) {
  if (!row) return null;
  return {
    configId: row.configId,
    model: row.model,
    ok: row.ok === 1 || row.ok === true,
    latencyMs: row.latencyMs,
    status: row.status,
    exitIp: row.exitIp,
    error: row.error,
    testedAt: row.testedAt,
  };
}

// ─── reads ────────────────────────────────────────────────────────────────

/** Get the cached result for a single (configId, model), or null. */
export async function getModelFilterResult(configId, model) {
  const db = await getAdapter();
  return rowToResult(db.get(
    `SELECT * FROM xrayModelFilterResults WHERE configId = ? AND model = ?`,
    [configId, model]
  ));
}

/**
 * Bulk-fetch cached results for a list of config ids under one model.
 * Returns a Map<configId, result>. Chunked defensively for big catalogs
 * (SQLite's parameter limit is generous, but IN (?,?,...) with thousands of
 * ids can still bite).
 *
 * @param {string[]} configIds
 * @param {string} model
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] - if set, rows older than this (by testedAt)
 *   are excluded so the caller re-tests them. 0/undefined = no age limit.
 */
export async function getModelFilterResultsByConfigIds(configIds = [], model, { maxAgeMs = 0 } = {}) {
  const out = new Map();
  if (!configIds.length || !model) return out;
  const db = await getAdapter();
  const CHUNK = 500;
  const ageCutoff = maxAgeMs > 0 ? new Date(Date.now() - maxAgeMs).toISOString() : null;
  for (let i = 0; i < configIds.length; i += CHUNK) {
    const slice = configIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const params = ageCutoff
      ? db.all(
          `SELECT * FROM xrayModelFilterResults
           WHERE model = ? AND configId IN (${placeholders}) AND testedAt > ?`,
          [model, ...slice, ageCutoff]
        )
      : db.all(
          `SELECT * FROM xrayModelFilterResults WHERE model = ? AND configId IN (${placeholders})`,
          [model, ...slice]
        );
    for (const row of params) out.set(row.configId, rowToResult(row));
  }
  return out;
}

/**
 * Find the next healthy config for a given model, excluding the currently
 * active config. Used by the managed-pool rotation (src/lib/xray/
 * managedRotation.js) to pick a replacement outbound server when the active
 * one hits a 429 / rate-limit.
 *
 * Joins xrayModelFilterResults with xrayConfigs so we only ever return a
 * config that is (a) still in the catalog (isActive = 1) and (b) most
 * recently verified to reach `model`. Ordered by probe latency ascending so
 * callers naturally prefer the fastest known-good server.
 *
 * @param {string} model           e.g. "oc/deepseek-v4-flash-free"
 * @param {string} excludeConfigId the currently active config id to skip
 * @param {object} [opts]
 * @param {number} [opts.limit=1]  how many candidates to return (1 = the best)
 * @returns {Promise<Array<{configId, latencyMs, exitIp, testedAt, name, protocol, country, host, port}>>}
 *          Empty array if no healthy candidate is available.
 */
export async function getNextHealthyConfigsForModel(model, excludeConfigId, { limit = 1 } = {}) {
  if (!model) return [];
  const db = await getAdapter();
  const rows = db.all(
    `SELECT
        r.configId AS configId,
        r.latencyMs AS latencyMs,
        r.exitIp    AS exitIp,
        r.testedAt  AS testedAt,
        c.name      AS name,
        c.protocol  AS protocol,
        c.country   AS country,
        c.host      AS host,
        c.port      AS port
      FROM xrayModelFilterResults r
      JOIN xrayConfigs c ON c.id = r.configId
      WHERE r.model = ?
        AND r.ok = 1
        AND c.isActive = 1
        AND (? IS NULL OR r.configId != ?)
      ORDER BY r.latencyMs IS NULL DESC, r.latencyMs ASC, r.testedAt DESC
      LIMIT ?`,
    [model, excludeConfigId ?? null, excludeConfigId ?? null, Math.max(1, Math.min(Number(limit) || 1, 50))]
  );
  return rows.map((r) => ({
    configId: r.configId,
    latencyMs: r.latencyMs,
    exitIp: r.exitIp,
    testedAt: r.testedAt,
    name: r.name,
    protocol: r.protocol,
    country: r.country,
    host: r.host,
    port: r.port,
  }));
}

/**
 * Model-agnostic candidate fallback for managed-pool rotation: the best
 * known-good configs across ALL filter models. Used when the requested
 * model has no cache rows (the Model Filter never ran with it) so rotation
 * can still escape a rate-limited exit IP — switchConfig live-verifies
 * SOCKS + distinct-exit-IP, and the request loop re-rotates if the new
 * node also fails for this model.
 *
 * @param {string} excludeConfigId the currently active config id to skip
 * @param {object} [opts]
 * @param {number} [opts.limit=1]
 */
export async function getNextHealthyConfigsAnyModel(excludeConfigId, { limit = 1 } = {}) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT
        r.configId AS configId,
        r.latencyMs AS latencyMs,
        r.exitIp    AS exitIp,
        r.testedAt  AS testedAt,
        c.name      AS name,
        c.protocol  AS protocol,
        c.country   AS country,
        c.host      AS host,
        c.port      AS port
      FROM xrayModelFilterResults r
      JOIN xrayConfigs c ON c.id = r.configId
      WHERE r.ok = 1
        AND c.isActive = 1
        AND (? IS NULL OR r.configId != ?)
      ORDER BY r.latencyMs IS NULL DESC, r.latencyMs ASC, r.testedAt DESC
      LIMIT ?`,
    [excludeConfigId ?? null, excludeConfigId ?? null, Math.max(1, Math.min(Number(limit) || 1, 50))]
  );
  return rows.map((r) => ({
    configId: r.configId,
    latencyMs: r.latencyMs,
    exitIp: r.exitIp,
    testedAt: r.testedAt,
    name: r.name,
    protocol: r.protocol,
    country: r.country,
    host: r.host,
    port: r.port,
  }));
}

/** Aggregate counts for the UI status badge. */
export async function getModelFilterCacheStats() {
  const db = await getAdapter();
  const totalRow = db.get(`SELECT COUNT(*) AS n FROM xrayModelFilterResults`);
  const byModelRows = db.all(
    `SELECT model, COUNT(*) AS n FROM xrayModelFilterResults GROUP BY model`
  );
  const byModel = {};
  for (const r of byModelRows) byModel[r.model] = Number(r.n) || 0;
  return { total: Number(totalRow?.n) || 0, byModel };
}

// ─── writes ───────────────────────────────────────────────────────────────

/** Upsert the latest probe result for one (configId, model). */
export async function upsertModelFilterResult(data = {}) {
  const db = await getAdapter();
  const now = data.testedAt || new Date().toISOString();
  db.run(
    `INSERT INTO xrayModelFilterResults(configId, model, ok, latencyMs, status, exitIp, error, testedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(configId, model) DO UPDATE SET
       ok = excluded.ok,
       latencyMs = excluded.latencyMs,
       status = excluded.status,
       exitIp = excluded.exitIp,
       error = excluded.error,
       testedAt = excluded.testedAt`,
    [
      data.configId,
      data.model,
      data.ok ? 1 : 0,
      data.latencyMs ?? null,
      data.status ?? null,
      data.exitIp ?? null,
      data.error ?? null,
      now,
    ]
  );
  return getModelFilterResult(data.configId, data.model);
}

/** Clear every cached result for one model (used by force re-test). */
export async function clearModelFilterResultsByModel(model) {
  if (!model) return 0;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM xrayModelFilterResults WHERE model = ?`, [model]);
  return res?.changes || 0;
}

/** Wipe the entire cache (used by the "Clear cache" button). */
export async function clearAllModelFilterResults() {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM xrayModelFilterResults`);
  return res?.changes || 0;
}

/** Drop cached rows for the given config ids (used when configs are pruned). */
export async function deleteModelFilterResultsByConfigIds(configIds = []) {
  if (!configIds.length) return 0;
  const db = await getAdapter();
  let removed = 0;
  const CHUNK = 500;
  db.transaction(() => {
    for (let i = 0; i < configIds.length; i += CHUNK) {
      const slice = configIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const res = db.run(
        `DELETE FROM xrayModelFilterResults WHERE configId IN (${placeholders})`,
        slice
      );
      removed += res?.changes || 0;
    }
  });
  return removed;
}

/**
 * Drop cached rows whose config is no longer active in the catalog.
 * Called after each subscription sync so the cache tracks reality.
 */
export async function pruneOrphanModelFilterResults() {
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM xrayModelFilterResults
     WHERE configId NOT IN (SELECT id FROM xrayConfigs WHERE isActive = 1)`
  );
  return res?.changes || 0;
}
