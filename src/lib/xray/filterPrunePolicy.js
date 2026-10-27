/**
 * Prune policy for the model filter — the decision of whether a failed probe
 * may delete the config, extracted pure so the destructive path is testable
 * without importing manager.js (which drags in the whole xray runtime).
 *
 * The distinction that matters: WHERE the probe failed.
 *  - Connection-level (timeout, SOCKS dial, TLS, xray setup): the tunnel never
 *    carried a request — the config is genuinely dead and safe to prune.
 *  - Upstream-level (probe.tunnelOk === true): an HTTP response came back
 *    THROUGH the tunnel (429 quota, 403 fingerprint, 5xx). The config works;
 *    the rejection lives on the exit IP / provider side and is frequently
 *    transient — shared free-tier quota resets, fingerprints are fixed
 *    client-side. Pruning here permanently destroys rotation inventory over a
 *    temporary condition ("108 tested, 0 usable" was exactly this misread:
 *    108 healthy tunnels whose shared IPs had spent quota).
 */

/**
 * @param {object|null} result - probe result: { ok, tunnelOk?, status?, configId? }
 * @param {{ prune?: boolean, runningActiveConfigId?: string|null, configId: string }} opts
 * @returns {{ prune: boolean, reason?: "upstream_rejected"|"active_config_running" }}
 */
export function shouldPruneFilterResult(result, { prune = false, runningActiveConfigId = null, configId } = {}) {
  if (!prune || result?.ok) return { prune: false };
  if (result?.tunnelOk === true) return { prune: false, reason: "upstream_rejected" };
  // App-side infra failure (e.g. wreq-js failing to load): the probe result
  // reflects OUR transport, not the node — deleting configs over it would
  // wipe healthy inventory one identical error at a time.
  if (result?.infraError === true) return { prune: false, reason: "infra_error" };
  if (runningActiveConfigId && configId === runningActiveConfigId) {
    return { prune: false, reason: "active_config_running" };
  }
  return { prune: true };
}
