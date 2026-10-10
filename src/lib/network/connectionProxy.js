import { getProxyPoolById, stampProxyEntryUsed } from "@/models";
import { pickProxyGroupEntry } from "./proxyRotation.js";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Did proxy resolution fail in a way that must NEVER degrade to a direct
 * (origin-IP) request? (P1 fail-closed contract.)
 * - source "exhausted": a strictProxy pool had no usable entry (deactivated,
 *   all entries cooling down, or empty).
 * - source "error" with strictProxy=true: resolution threw after the pool's
 *   strict flag was known.
 * Callers must fail the operation / fall through to the next account instead
 * of fetching directly.
 */
export function isStrictProxyFailure(resolved) {
  return (
    !!resolved &&
    (resolved.source === "exhausted" ||
      (resolved.source === "error" && resolved.strictProxy === true))
  );
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
/**
 * Shape shared by the strict-failure returns. Carries no proxy URL on purpose:
 * callers must treat it as "this attempt cannot proceed", never as "go direct".
 */
function strictPoolFailure(source, proxyPoolId, proxyPool, noProxy) {
  // Fire-and-forget: this runs inside auth's selectionMutex — the alert
  // queues asynchronously and must never gate proxy resolution.
  try {
    emitAlert(EVENT_TYPES.PROXY_POOL_EXHAUSTED, {
      severity: source === "exhausted" ? SEVERITY.WARN : SEVERITY.CRITICAL,
      dedupKey: String(proxyPoolId || "unknown"),
      title: source === "exhausted" ? "Strict proxy pool exhausted" : "Strict proxy pool errored",
      body: `Pool ${proxyPoolId || "(unknown)"} has no usable entry (${source}); bound requests fail closed.`,
    });
  } catch { /* alerts must never break proxy resolution */ }
  return {
    source,
    proxyPoolId: proxyPoolId || null,
    proxyPool: proxyPool || null,
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: noProxy || "",
    vercelRelayUrl: "",
    strictProxy: true,
  };
}

export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  // Best-known strictness of the bound pool. Hoisted so the catch path can
  // propagate the real flag instead of a hard-coded false (N3).
  let poolStrict = false;
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // (Upstream #4333) a strict pool must keep its guarantee even when the pool
    // itself is not usable (inactive, or saved without a url): the legacy/none
    // returns below carry the pool's real strict flag — the fork's earlier
    // poolStrict hoist above already covers the error/catch path.

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);
      poolStrict = proxyPool?.strictProxy === true;

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      // A pool is usable if it is active AND either:
      //   - has a single proxyUrl (standard/relay pool), or
      //   - is a group with at least one entry (rotating pool — proxyUrl is
      //     intentionally empty; the resolver picks one entry below).
      const hasGroupEntries =
        proxyPool?.isGroup === true &&
        Array.isArray(proxyPool.entries) &&
        proxyPool.entries.length > 0;

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        (proxyUrl || hasGroupEntries);

      // A strict pool that is unusable (deactivated, emptied, group emptied)
      // must never degrade to legacy/direct — surface exhaustion so callers
      // fail the attempt or fall through to the next account (P1).
      if (poolStrict && !isValidPool) {
        return strictPoolFailure("exhausted", proxyPoolId, proxyPool, noProxy);
      }

      if (isValidPool) {
        /**
         * Proxy group (rotating): pick one entry from the group now. The entry
         * is chosen by rotationMode and skips cooled-down/inactive entries.
         * Falls through to the legacy path if no entry is available — EXCEPT
         * under strictProxy, where "no usable entry" is an exhausted signal.
         */
        if (proxyPool.isGroup === true) {
          const picked = pickProxyGroupEntry(proxyPool);
          if (picked) {
            const entry = picked.entry;
            // Persist the lastUsedAt stamp as a delta-write so concurrent and
            // subsequent picks spread load without clobbering each other's
            // snapshots (P2). Best-effort: failure must not break the request.
            stampProxyEntryUsed(proxyPoolId, entry.id).catch((err) => {
              console.warn(
                `[resolveConnectionProxyConfig] stampProxyEntryUsed failed for pool ${proxyPoolId}:`,
                err?.message || err
              );
            });
            // "direct" entry → use the server's own IP (no proxy).
            if (entry.type === "direct") {
              return {
                source: "group-direct",
                proxyPoolId,
                proxyPool,
                proxyEntryId: entry.id,
                connectionProxyEnabled: false,
                connectionProxyUrl: "",
                connectionNoProxy: noProxy,
                strictProxy: proxyPool.strictProxy === true,
              };
            }
            return {
              source: "group",
              proxyPoolId,
              proxyPool,
              proxyEntryId: entry.id,
              connectionProxyEnabled: true,
              connectionProxyUrl: normalizeString(entry.proxyUrl),
              connectionNoProxy: noProxy,
              strictProxy: proxyPool.strictProxy === true,
            };
          }
          // No usable entry (all inactive/cooled-down/empty-URL).
          if (poolStrict) {
            return strictPoolFailure("exhausted", proxyPoolId, proxyPool, noProxy);
          }
          // Non-strict → fall through to legacy/none (direct allowed).
        }

        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrict,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrict,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      // Propagate the pool's real strict flag when it was read before the
      // failure (N3): a strict pool must fail closed, a non-strict pool keeps
      // the graceful direct-allowed behavior.
      strictProxy: poolStrict,
    };
  }
}
