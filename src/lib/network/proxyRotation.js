/**
 * Proxy-pool rotation logic.
 *
 * A proxy pool can be a "group" (pool.isGroup === true): it holds an ordered
 * list of `entries`, each pointing to a proxy URL or a "direct" (no-proxy /
 * server-IP) slot. On each request the resolver picks one entry according to
 * the group's `rotationMode`:
 *
 *   - "on-error":   least-recently-used (spreads load, avoids the entry that
 *                   just failed). This is the default and the primary mode for
 *                   dodging per-IP rate limits — a 429 on one entry cools it
 *                   down and the next pick naturally skips it.
 *   - "round-robin": cycle through entries in order (advances every request).
 *   - "random":     uniform random per request.
 *
 * Cooldown state lives on each entry (cooldownUntil / lastError / lastUsedAt)
 * inside the pool's JSON `data` blob; it is mutated by the chat retry loop via
 * `markProxyEntryCooldown` when a request fails with a rotatable error.
 */

// --- error classification -------------------------------------------------

// Text substrings (case-insensitive) that indicate the upstream rejected us in
// a way that is often IP/proxy-specific and worth trying a different entry.
// These mirror the account-fallback ERROR_RULES but are evaluated independently
// here so proxy rotation and account rotation can disagree if needed.
const ROTATABLE_ERROR_TEXT = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "freeusagelimit", // Anthropic-style "FreeUsageLimitError"
  "capacity",
  "overloaded",
  "request not allowed",
];

// HTTP statuses that warrant a proxy switch. 5xx/408 are upstream/proxy
// trouble; 429 is the headline rate-limit case. 401/403 are NOT here because
// those are account/credential problems, not proxy problems.
const ROTATABLE_ERROR_STATUS = [408, 429, 500, 502, 503, 504];

/**
 * Does this error look like it could be resolved by switching proxy/IP?
 * Used by the chat retry loop to decide whether to cool down the current entry
 * and try another one before giving up on the account.
 */
export function isProxyRotatableError(status, errorText) {
  if (status && ROTATABLE_ERROR_STATUS.includes(status)) return true;
  const lower = errorText
    ? (typeof errorText === "string" ? errorText : String(errorText)).toLowerCase()
    : "";
  if (lower && ROTATABLE_ERROR_TEXT.some((t) => lower.includes(t))) return true;
  return false;
}

// --- cooldown durations ---------------------------------------------------

const PROXY_COOLDOWN_MS = {
  rateLimit: 60 * 1000, // 429 / rate-limit / quota → 60s
  server: 30 * 1000, // 5xx → 30s
  transient: 20 * 1000, // other rotatable → 20s
};

/**
 * How long to cool down an entry after a rotatable error.
 */
export function proxyCooldownForError(status, errorText) {
  if (status === 429) return PROXY_COOLDOWN_MS.rateLimit;
  const lower = errorText
    ? (typeof errorText === "string" ? errorText : String(errorText)).toLowerCase()
    : "";
  if (lower && ["rate limit", "too many requests", "quota exceeded", "freeusagelimit", "capacity", "overloaded"].some((t) => lower.includes(t))) {
    return PROXY_COOLDOWN_MS.rateLimit;
  }
  if (status >= 500) return PROXY_COOLDOWN_MS.server;
  return PROXY_COOLDOWN_MS.transient;
}

// --- entry selection ------------------------------------------------------

function isEntryAvailable(entry, now, excludeEntryIds) {
  if (!entry) return false;
  if (entry.isActive === false) return false;
  if (excludeEntryIds && excludeEntryIds.has(entry.id)) return false;
  const until = entry.cooldownUntil ? Number(entry.cooldownUntil) : 0;
  if (until && until > now) return false;
  return true;
}

/**
 * Pick the next entry from a proxy group.
 *
 * @param {object} pool - a proxy pool with isGroup=true and an `entries` array.
 * @param {Set<string>} [excludeEntryIds] - entry ids to skip this turn (already tried).
 * @returns {{entry: object, updatedPool: object}|null} the chosen entry plus the
 *   pool with lastUsedAt/rrCounter stamped (caller persists updatedPool). null
 *   when no entry is available (all inactive/cooled-down/excluded).
 */
export function pickProxyGroupEntry(pool, excludeEntryIds = new Set()) {
  if (!pool || !pool.isGroup || !Array.isArray(pool.entries)) return null;
  const now = Date.now();
  const available = pool.entries.filter((e) => isEntryAvailable(e, now, excludeEntryIds));
  if (available.length === 0) return null;

  const mode = pool.rotationMode || "on-error";
  let chosen;

  if (mode === "round-robin") {
    // Advance the persistent counter; wrap against available length.
    const counter = Number(pool.rrCounter || 0);
    chosen = available[counter % available.length];
    pool = { ...pool, rrCounter: counter + 1 };
  } else if (mode === "random") {
    chosen = available[Math.floor(Math.random() * available.length)];
  } else {
    // "on-error" (default): least-recently-used so we don't immediately retry
    // the entry that just failed. Entries never used sort first.
    const sorted = [...available].sort((a, b) => {
      const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return ta - tb;
    });
    chosen = sorted[0];
  }

  // Stamp lastUsedAt so subsequent picks in the same rotation window prefer
  // other entries. Return a shallow-updated pool for the caller to persist.
  const entries = pool.entries.map((e) =>
    e.id === chosen.id ? { ...e, lastUsedAt: new Date(now).toISOString() } : e
  );
  return { entry: { ...chosen, lastUsedAt: new Date(now).toISOString() }, updatedPool: { ...pool, entries } };
}

/**
 * Are there any entries in the group that are still usable (not cooled down /
 * excluded)? Used by the chat loop to decide whether to keep rotating proxies
 * on the same account or give up and fall back to the next account.
 */
export function groupHasAvailableEntry(pool, excludeEntryIds = new Set()) {
  if (!pool || !pool.isGroup || !Array.isArray(pool.entries)) return false;
  const now = Date.now();
  return pool.entries.some((e) => isEntryAvailable(e, now, excludeEntryIds));
}
