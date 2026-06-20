/**
 * Gemini Web Keep-Alive Service
 * Periodically pinks gemini.google.com to keep cookies alive.
 *
 * Strategy:
 * - Every 30 min: GET /app (full bootstrap — refreshes session params)
 * - Every 15 min: POST batchexecute RPC (small ping — shows "activity")
 * - Auto-stop after 3 consecutive failures
 * - Track health per cookie set
 *
 * All errors are caught and logged — keep-alive failures NEVER crash the main process.
 */

import crypto from "crypto";
import { bootstrapGeminiWebSession, sendBardSettings } from "./geminiWebSession.js";

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, {
 *   bootstrapTimer: NodeJS.Timeout|null,
 *   pingTimer: NodeJS.Timeout|null,
 *   failures: number,
 *   lastSuccess: Date|null,
 *   lastFailure: Date|null,
 *   lastError: string|null,
 *   running: boolean,
 *   cookies: Object,
 *   options: Object,
 *   startedAt: Date,
 * }>}
 */
const keepAliveState = new Map();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BOOTSTRAP_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const PING_INTERVAL_MS = 15 * 60 * 1000;        // 15 minutes
const MAX_FAILURES = 3;
const JITTER_FACTOR = 0.10; // ±10% random variation

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply ±10% jitter to an interval to avoid clock-like patterns.
 * @param {number} baseMs
 * @returns {number}
 */
function withJitter(baseMs) {
  const variation = baseMs * JITTER_FACTOR;
  const offset = (Math.random() * 2 - 1) * variation; // -variation .. +variation
  return Math.max(1000, Math.round(baseMs + offset));
}

/**
 * Hash cookies to produce a stable unique key.
 *
 * Uses the same key cookies as the executor's cookieHashKey for compatibility,
 * but produces a SHA-256 based hex hash for collision resistance.
 *
 * @param {Object} cookies - Cookie key-value map
 * @returns {string} 16-char hex hash
 */
export function cookieHash(cookies) {
  if (!cookies || typeof cookies !== "object") return "unknown";
  const values = Object.entries(cookies)
    .filter(([k]) => k.startsWith("__Secure-") || k === "SAPISID")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  if (!values) return "unknown";
  return crypto.createHash("sha256").update(values).digest("hex").slice(0, 16);
}

/**
 * Get a safe logger — falls back to no-op if log not provided.
 * @param {Object|undefined} log
 * @returns {Object}
 */
function safeLog(log) {
  const noop = () => {};
  return {
    debug: log?.debug?.bind(log) || noop,
    info: log?.info?.bind(log) || noop,
    warn: log?.warn?.bind(log) || noop,
    error: log?.error?.bind(log) || noop,
  };
}

/**
 * Perform a bootstrap ping (GET /app).
 * Returns true on success, false on failure.
 *
 * @param {Object} cookies
 * @param {Object} options - { proxy, log }
 * @returns {Promise<boolean>}
 */
async function doBootstrapPing(cookies, options = {}) {
  const log = safeLog(options.log);
  try {
    const session = await bootstrapGeminiWebSession(cookies, {
      proxy: options.proxy,
      timeoutMs: 20_000,
    });
    if (session && session.authHeader) {
      log.debug("GEMINI-WEB-KEEPALIVE", `bootstrap ping success (buildLabel=${session.buildLabel || "n/a"})`);
      return true;
    }
    log.warn("GEMINI-WEB-KEEPALIVE", "bootstrap ping returned no auth header");
    return false;
  } catch (err) {
    log.warn("GEMINI-WEB-KEEPALIVE", `bootstrap ping failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Perform a small RPC ping (POST batchexecute with bard_settings).
 * Requires a valid authHeader, so we bootstrap first if needed.
 * Returns true on success, false on failure.
 *
 * @param {Object} cookies
 * @param {Object} options - { proxy, log }
 * @returns {Promise<boolean>}
 */
async function doRpcPing(cookies, options = {}) {
  const log = safeLog(options.log);
  try {
    // We need an auth header for the RPC — bootstrap to get it.
    // This is lightweight since bootstrap is also a valid "activity" signal.
    const session = await bootstrapGeminiWebSession(cookies, {
      proxy: options.proxy,
      timeoutMs: 20_000,
    });
    if (!session || !session.authHeader) {
      log.warn("GEMINI-WEB-KEEPALIVE", "rpc ping: no auth header from bootstrap");
      return false;
    }

    const ok = await sendBardSettings(cookies, session.authHeader, {
      buildLabel: session.buildLabel,
      sessionId: session.sessionId,
      language: session.language,
    }, {
      proxy: options.proxy,
      timeoutMs: 15_000,
    });

    if (ok) {
      log.debug("GEMINI-WEB-KEEPALIVE", "rpc ping success (sendBardSettings)");
      return true;
    }
    log.warn("GEMINI-WEB-KEEPALIVE", "rpc ping: sendBardSettings returned false");
    return false;
  } catch (err) {
    log.warn("GEMINI-WEB-KEEPALIVE", `rpc ping failed: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start keep-alive for a cookie set.
 *
 * Sets up two independent timers:
 *   - bootstrap timer: every ~30 min, calls bootstrapGeminiWebSession
 *   - ping timer: every ~15 min, calls sendBardSettings (small RPC)
 *
 * On success: resets failure count, updates lastSuccess.
 * On failure: increments failure count. After MAX_FAILURES consecutive
 * failures, stops all timers and calls the onExpired callback.
 *
 * @param {Object} cookies - Cookie key-value map
 * @param {Object} options - { proxy, onExpired, log, bootstrapIntervalMs, pingIntervalMs }
 * @returns {{ stop: Function, getStatus: Function, cookieHash: string }}
 */
export function startKeepAlive(cookies, options = {}) {
  const log = safeLog(options.log);
  const hash = cookieHash(cookies);

  // If already running for this cookie set, return existing handle
  const existing = keepAliveState.get(hash);
  if (existing && existing.running) {
    log.debug("GEMINI-WEB-KEEPALIVE", `keep-alive already running for hash=${hash}`);
    return {
      stop: () => stopKeepAlive(hash),
      getStatus: () => getSingleStatus(hash),
      cookieHash: hash,
    };
  }

  const bootstrapInterval = options.bootstrapIntervalMs || BOOTSTRAP_INTERVAL_MS;
  const pingInterval = options.pingIntervalMs || PING_INTERVAL_MS;

  /** @type {Object} */
  const state = {
    bootstrapTimer: null,
    pingTimer: null,
    failures: 0,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    running: true,
    cookies,
    options,
    startedAt: new Date(),
  };

  keepAliveState.set(hash, state);

  log.info("GEMINI-WEB-KEEPALIVE", `keep-alive started for hash=${hash} (bootstrap=${Math.round(bootstrapInterval / 1000)}s, ping=${Math.round(pingInterval / 1000)}s)`);

  /**
   * Handle a ping result — update failure count, possibly trigger expiry.
   * @param {boolean} success
   */
  function handleResult(success) {
    if (success) {
      state.failures = 0;
      state.lastSuccess = new Date();
      state.lastError = null;
    } else {
      state.failures += 1;
      state.lastFailure = new Date();
      log.warn("GEMINI-WEB-KEEPALIVE", `failure count=${state.failures}/${MAX_FAILURES} for hash=${hash}`);

      if (state.failures >= MAX_FAILURES) {
        log.error("GEMINI-WEB-KEEPALIVE", `max failures reached (${MAX_FAILURES}), stopping keep-alive for hash=${hash}`);
        stopKeepAlive(hash);

        // Call onExpired callback if provided
        if (typeof options.onExpired === "function") {
          try {
            options.onExpired({
              cookieHash: hash,
              failures: state.failures,
              lastError: state.lastError,
              cookies,
            });
          } catch (cbErr) {
            log.error("GEMINI-WEB-KEEPALIVE", `onExpired callback threw: ${cbErr?.message || cbErr}`);
          }
        }
      }
    }
  }

  /**
   * Bootstrap tick — async, self-contained error handling.
   */
  async function bootstrapTick() {
    if (!state.running) return;
    try {
      const ok = await doBootstrapPing(cookies, options);
      if (!ok) state.lastError = "bootstrap ping failed";
      handleResult(ok);
    } catch (err) {
      // Should never reach here due to internal try/catch, but guard anyway
      state.lastError = err?.message || String(err);
      handleResult(false);
    }
  }

  /**
   * RPC ping tick — async, self-contained error handling.
   */
  async function pingTick() {
    if (!state.running) return;
    try {
      const ok = await doRpcPing(cookies, options);
      if (!ok) state.lastError = "rpc ping failed";
      handleResult(ok);
    } catch (err) {
      state.lastError = err?.message || String(err);
      handleResult(false);
    }
  }

  // Schedule intervals with jitter.
  // First tick fires after the interval (not immediately) to avoid
  // hammering Google right after a real request just completed.
  state.bootstrapTimer = setInterval(() => {
    bootstrapTick().catch(() => {});
  }, withJitter(bootstrapInterval));

  state.pingTimer = setInterval(() => {
    pingTick().catch(() => {});
  }, withJitter(pingInterval));

  // Prevent timers from keeping the process alive
  if (state.bootstrapTimer.unref) state.bootstrapTimer.unref();
  if (state.pingTimer.unref) state.pingTimer.unref();

  return {
    stop: () => stopKeepAlive(hash),
    getStatus: () => getSingleStatus(hash),
    cookieHash: hash,
  };
}

/**
 * Stop keep-alive for a specific cookie set.
 *
 * @param {string} hash - Hash key from cookieHash()
 */
export function stopKeepAlive(hash) {
  const state = keepAliveState.get(hash);
  if (!state) return;

  if (state.bootstrapTimer) {
    clearInterval(state.bootstrapTimer);
    state.bootstrapTimer = null;
  }
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }

  state.running = false;
  keepAliveState.delete(hash);
}

/**
 * Stop all keep-alive timers.
 * Useful for graceful shutdown.
 */
export function stopAllKeepAlive() {
  for (const hash of keepAliveState.keys()) {
    stopKeepAlive(hash);
  }
}

/**
 * Get status of a single keep-alive session by hash.
 *
 * @param {string} hash
 * @returns {{ cookieHash: string, running: boolean, failures: number, lastSuccess: Date|null, lastFailure: Date|null, lastError: string|null, startedAt: Date|null }|null}
 */
function getSingleStatus(hash) {
  const state = keepAliveState.get(hash);
  if (!state) return null;
  return {
    cookieHash: hash,
    running: state.running,
    failures: state.failures,
    lastSuccess: state.lastSuccess,
    lastFailure: state.lastFailure,
    lastError: state.lastError,
    startedAt: state.startedAt,
  };
}

/**
 * Get status of all active keep-alive sessions.
 *
 * @returns {Array<{ cookieHash: string, running: boolean, failures: number, lastSuccess: Date|null, lastFailure: Date|null, lastError: string|null, startedAt: Date|null }>}
 */
export function getKeepAliveStatus() {
  const result = [];
  for (const [hash] of keepAliveState) {
    const status = getSingleStatus(hash);
    if (status) result.push(status);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  BOOTSTRAP_INTERVAL_MS,
  PING_INTERVAL_MS,
  MAX_FAILURES,
};
