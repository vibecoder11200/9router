// In-memory progressive lockout for the re-key endpoint (phase-03 RT-11).
// Resets on process restart. The masked-compare proof's unknown material is
// only ~16 bits (keyId is published in listings; last4 of a 4-part key is CRC
// hex), so mismatches are rate-limited to make online forgery uneconomical:
// 5 mismatches per key id → 15-minute lock; 20 mismatches globally per hour.

const PER_KEY_MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILS = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const perKey = new Map(); // keyId → { fails, lockedUntil, lastFailAt }
let global = { fails: 0, windowStart: 0 };

function now() { return Date.now(); }

/** Is this key id currently locked out (per-key or via the global budget)? */
export function checkRekeyLock(keyId) {
  const e = perKey.get(keyId);
  if (e?.lockedUntil && now() < e.lockedUntil) {
    return { locked: true, retryAfter: Math.ceil((e.lockedUntil - now()) / 1000) };
  }
  if (global.fails >= GLOBAL_MAX_FAILS && now() - global.windowStart < GLOBAL_WINDOW_MS) {
    return { locked: true, retryAfter: Math.ceil((global.windowStart + GLOBAL_WINDOW_MS - now()) / 1000) };
  }
  return { locked: false };
}

/** Record one mismatch for this key id; returns whether the lock just engaged. */
export function recordRekeyFail(keyId) {
  const t = now();
  if (t - global.windowStart >= GLOBAL_WINDOW_MS) global = { fails: 0, windowStart: t };
  global.fails += 1;

  const e = perKey.get(keyId) || { fails: 0, lockedUntil: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = t;
  let lockedNow = false;
  if (e.fails >= PER_KEY_MAX_FAILS) {
    e.lockedUntil = t + LOCK_MS;
    e.fails = 0;
    lockedNow = true;
  }
  perKey.set(keyId, e);
  return { lockedNow, retryAfter: lockedNow ? Math.ceil(LOCK_MS / 1000) : 0 };
}

/** Successful re-key clears the per-key counter. */
export function recordRekeySuccess(keyId) {
  perKey.delete(keyId);
}

/** Test hook: wipe all counters. */
export function resetRekeyLimiter() {
  perKey.clear();
  global = { fails: 0, windowStart: 0 };
}
