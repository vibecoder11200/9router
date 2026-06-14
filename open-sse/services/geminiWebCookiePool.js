// ---------------------------------------------------------------------------
// Gemini Web — Cookie Pool (Layer 3)
//
// Manages multiple Gemini Web cookie sets (accounts).
// Features:
//   - Multiple accounts → round-robin
//   - Auto-disable dead cookies
//   - Health-check on add
//   - Alert when all cookies are dead
// ---------------------------------------------------------------------------

import { extractGeminiWebCredentials, validateGeminiWebCookies } from "./geminiWebCookie.js";
import { bootstrapGeminiWebSession } from "./geminiWebSession.js";

const POOL_CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 min
const MAX_POOL_SIZE = 5;

let _pool = [];        // { id, cookies, valid, lastTestedAt, error, useCount }
let _currentIndex = 0;
let _checkTimer = null;
let _allDeadAlerted = false;

/**
 * Add a cookie set to the pool.
 * @param {Object} credentials - Provider credentials with cookies
 * @returns {{ id: string, valid: boolean, error: string|null }}
 */
export async function addToPool(credentials) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const extracted = extractGeminiWebCredentials(credentials || {});

  if (!extracted.valid || !extracted.cookies) {
    return { id, valid: false, error: extracted.error || "Invalid cookies" };
  }

  // Validate cookies first
  const validation = validateGeminiWebCookies(extracted.cookies, { throwOnError: false });
  let valid = validation.valid;
  let error = validation.error || null;

  // Try actual bootstrap to confirm
  if (valid) {
    try {
      const session = await bootstrapGeminiWebSession(extracted.cookies, { timeoutMs: 10_000 });
      valid = !!session.snlm0e;
      error = valid ? null : "Bootstrap failed — missing SNlM0e token";
    } catch (err) {
      valid = false;
      error = err.message;
    }
  }

  // Add or replace
  const existing = _pool.find(e => e.cookies?.SAPISID === extracted.cookies?.SAPISID);
  if (existing) {
    existing.valid = valid;
    existing.error = error;
    existing.lastTestedAt = Date.now();
    return { id: existing.id, valid, error };
  }

  if (_pool.length >= MAX_POOL_SIZE) {
    // Remove oldest invalid entry or the least-used entry
    const invalid = _pool.find(e => !e.valid);
    if (invalid) {
      _pool.splice(_pool.indexOf(invalid), 1);
    } else {
      _pool.shift(); // Remove oldest
    }
  }

  _pool.push({
    id,
    cookies: extracted.cookies,
    valid,
    error,
    lastTestedAt: Date.now(),
    useCount: 0,
  });

  _allDeadAlerted = false;
  return { id, valid, error };
}

/**
 * Remove a cookie set from the pool.
 */
export function removeFromPool(id) {
  const idx = _pool.findIndex(e => e.id === id);
  if (idx >= 0) {
    _pool.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Get next valid cookie set (round-robin).
 * @returns {{ cookies: Object, id: string }|null}
 */
export function getNextCookies() {
  if (_pool.length === 0) return null;

  const valid = _pool.filter(e => e.valid);
  if (valid.length === 0) return null;

  // Round-robin through valid entries
  const entry = valid[_currentIndex % valid.length];
  _currentIndex++;
  entry.useCount++;
  return { cookies: entry.cookies, id: entry.id };
}

/**
 * Mark a cookie set as invalid (cookie expired).
 */
export function markInvalid(id) {
  const entry = _pool.find(e => e.id === id);
  if (entry) {
    entry.valid = false;
    entry.error = "Cookie expired";
    entry.lastTestedAt = Date.now();
  }
}

/**
 * Get pool status.
 */
export function getPoolStatus() {
  return {
    total: _pool.length,
    valid: _pool.filter(e => e.valid).length,
    entries: _pool.map(e => ({
      id: e.id,
      valid: e.valid,
      error: e.error,
      lastTestedAt: e.lastTestedAt,
      useCount: e.useCount,
    })),
  };
}

/**
 * Start periodic pool health-check.
 */
export function startPoolHealthCheck() {
  stopPoolHealthCheck();
  _checkTimer = setInterval(async () => {
    for (const entry of _pool) {
      if (!entry.valid) continue;
      try {
        const session = await bootstrapGeminiWebSession(entry.cookies, { timeoutMs: 8_000 });
        if (!session.snlm0e) {
          entry.valid = false;
          entry.error = "Session expired";
        }
        entry.lastTestedAt = Date.now();
      } catch {
        entry.valid = false;
        entry.error = "Health check failed";
        entry.lastTestedAt = Date.now();
      }
    }

    const aliveCount = _pool.filter(e => e.valid).length;
    if (aliveCount === 0 && !_allDeadAlerted) {
      _allDeadAlerted = true;
      return { allDead: true, message: "All Gemini Web cookies have expired!" };
    }
    if (aliveCount > 0) _allDeadAlerted = false;
    return null;
  }, POOL_CHECK_INTERVAL_MS);
}

/**
 * Stop pool health-check.
 */
export function stopPoolHealthCheck() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
}
