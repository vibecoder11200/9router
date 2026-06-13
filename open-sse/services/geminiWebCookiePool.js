/**
 * Gemini Web Cookie Pool
 * Manages multiple cookie sets with round-robin rotation and health tracking.
 *
 * Storage: Cookie sets are stored in provider connection's providerSpecificData.cookiePool[]
 * Each entry: { cookies: {...}, label: string, status: "active"|"dead"|"cooldown",
 *              failureCount: number, lastSuccess: string|null, lastFailure: string|null,
 *              addedAt: string }
 */

const MAX_FAILURES = 3;
const COOLDOWN_MINUTES = 30;

/**
 * Get the next healthy cookie set from the pool.
 * Uses round-robin with health checks.
 *
 * @param {Object} connection - Provider connection object
 * @returns {{ cookies: Object, poolIndex: number, label: string } | null}
 */
export function getNextCookieSet(connection) {
  const pool = getPool(connection);
  if (!pool.length) return null;

  const now = Date.now();

  // Find active entries (not dead, not in cooldown)
  const active = pool.filter(e => {
    if (e.status === "dead") return false;
    if (e.status === "cooldown") {
      // Check if cooldown expired
      const cooldownEnd = new Date(e.lastFailure).getTime() + COOLDOWN_MINUTES * 60 * 1000;
      if (now < cooldownEnd) return false;
      // Cooldown expired — reactivate
      e.status = "active";
      e.failureCount = 0;
      return true;
    }
    return true;
  });

  if (!active.length) return null;

  // Round-robin: pick the one used longest ago
  active.sort((a, b) => {
    const ta = a.lastSuccess ? new Date(a.lastSuccess).getTime() : 0;
    const tb = b.lastSuccess ? new Date(b.lastSuccess).getTime() : 0;
    return ta - tb; // oldest first
  });

  const entry = active[0];
  const poolIndex = pool.indexOf(entry);
  return { cookies: entry.cookies, poolIndex, label: entry.label || `set-${poolIndex}` };
}

/**
 * Report a successful request for a cookie set.
 * @param {Object} connection - Provider connection
 * @param {number} poolIndex - Index in the pool
 */
export function reportSuccess(connection, poolIndex) {
  const pool = getPool(connection);
  if (pool[poolIndex]) {
    pool[poolIndex].failureCount = 0;
    pool[poolIndex].status = "active";
    pool[poolIndex].lastSuccess = new Date().toISOString();
  }
}

/**
 * Report a failed request for a cookie set.
 * @param {Object} connection - Provider connection
 * @param {number} poolIndex - Index in the pool
 * @param {string} error - Error message
 * @returns {{ status: string, allDead: boolean }}
 */
export function reportFailure(connection, poolIndex, error = "") {
  const pool = getPool(connection);
  const entry = pool[poolIndex];
  if (!entry) return { status: "unknown", allDead: false };

  entry.failureCount = (entry.failureCount || 0) + 1;
  entry.lastFailure = new Date().toISOString();
  entry.lastError = error;

  if (entry.failureCount >= MAX_FAILURES) {
    entry.status = "dead";
  } else {
    entry.status = "cooldown";
  }

  const allDead = pool.every(e => e.status === "dead");
  return { status: entry.status, allDead };
}

/**
 * Add a cookie set to the pool.
 * @param {Object} connection - Provider connection
 * @param {Object} cookies - Cookie key-value map
 * @param {string} label - Human-readable label
 * @returns {number} Pool index
 */
export function addCookieSet(connection, cookies, label = "") {
  const pool = getPool(connection);
  const index = pool.length;
  pool.push({
    cookies,
    label: label || `set-${index}`,
    status: "active",
    failureCount: 0,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    addedAt: new Date().toISOString(),
  });
  return index;
}

/**
 * Remove a cookie set from the pool.
 * @param {Object} connection
 * @param {number} poolIndex
 */
export function removeCookieSet(connection, poolIndex) {
  const pool = getPool(connection);
  if (poolIndex >= 0 && poolIndex < pool.length) {
    pool.splice(poolIndex, 1);
  }
}

/**
 * Get pool status summary.
 * @param {Object} connection
 * @returns {{ total: number, active: number, cooldown: number, dead: number, sets: Array }}
 */
export function getPoolStatus(connection) {
  const pool = getPool(connection);
  return {
    total: pool.length,
    active: pool.filter(e => e.status === "active").length,
    cooldown: pool.filter(e => e.status === "cooldown").length,
    dead: pool.filter(e => e.status === "dead").length,
    sets: pool.map((e, i) => ({
      index: i,
      label: e.label || `set-${i}`,
      status: e.status,
      failureCount: e.failureCount || 0,
      lastSuccess: e.lastSuccess,
      lastFailure: e.lastFailure,
    })),
  };
}

/**
 * Reset a dead cookie set back to active.
 * @param {Object} connection
 * @param {number} poolIndex
 */
export function resetCookieSet(connection, poolIndex) {
  const pool = getPool(connection);
  if (pool[poolIndex]) {
    pool[poolIndex].status = "active";
    pool[poolIndex].failureCount = 0;
    pool[poolIndex].lastError = null;
  }
}

// --- Internal ---

function getPool(connection) {
  if (!connection.providerSpecificData) connection.providerSpecificData = {};
  if (!connection.providerSpecificData.cookiePool) {
    connection.providerSpecificData.cookiePool = [];
  }
  return connection.providerSpecificData.cookiePool;
}
