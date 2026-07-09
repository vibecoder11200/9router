import { getProxyPoolById, updateProxyPool } from "@/models";
import { pickProxyGroupEntry } from "./proxyRotation.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
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
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        /**
         * Proxy group (rotating): pick one entry from the group now. The entry
         * is chosen by rotationMode and skips cooled-down/inactive entries.
         * Falls through to the standard/legacy path if no entry is available.
         */
        if (proxyPool.isGroup === true) {
          const excludeEntryIds = providerSpecificData?._excludedProxyEntryIds
            ? new Set(providerSpecificData._excludedProxyEntryIds)
            : new Set();
          const picked = pickProxyGroupEntry(proxyPool, excludeEntryIds);
          if (picked) {
            // Persist lastUsedAt / rrCounter stamp so concurrent + subsequent
            // picks spread load. Best-effort: a failure here must not break the
            // request.
            updateProxyPool(proxyPoolId, {
              entries: picked.updatedPool.entries,
              rrCounter: picked.updatedPool.rrCounter,
            }).catch(() => {});
            const entry = picked.entry;
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
          // No usable entry → fall through to legacy/none.
        }

        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
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

      strictProxy: false,
    };
  }
}
