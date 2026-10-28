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
 * @returns {{ prune: boolean, reason?: "upstream_rejected"|"infra_error"|"spawn_failed"|"active_config_running" }}
 */
export function shouldPruneFilterResult(result, { prune = false, runningActiveConfigId = null, configId } = {}) {
  if (!prune || result?.ok) return { prune: false };
  if (result?.tunnelOk === true) return { prune: false, reason: "upstream_rejected" };
  // App-side infra failure (e.g. wreq-js failing to load): the probe result
  // reflects OUR transport, not the node — deleting configs over it would
  // wipe healthy inventory one identical error at a time.
  if (result?.infraError === true) return { prune: false, reason: "infra_error" };
  // Spawn-side failure (binary missing, link our shim can't render, SOCKS
  // port never opened): OUR test instance never ran, so the probe produced
  // no verdict about the node. The 2026-10-28 incident hard-deleted 351
  // configs this way when Xray 26.3.27 rejected the hysteria2 shim config
  // at load time and every spawn-mode probe failed identically in seconds.
  if (result?.spawnFailed === true) return { prune: false, reason: "spawn_failed" };
  if (runningActiveConfigId && configId === runningActiveConfigId) {
    return { prune: false, reason: "active_config_running" };
  }
  return { prune: true };
}

/**
 * Run-level mass-prune canary. A prune pass that has tested `minTested`
 * configs, passed NONE, and stacked `threshold` consecutive prunable
 * failures is not a cleanup — it is an anomaly wiping the inventory (the
 * 2026-10-28 binary/config-shape incident pruned 351/351; an earlier one
 * deleted 108). Once tripped it latches for the rest of the run: remaining
 * configs are still probed and recorded, just never deleted.
 *
 * Failures the policy already refuses to prune (upstream-rejected 429/403,
 * infra, spawn-side) do not count towards the streak — they signal upstream
 * conditions, not dead nodes.
 *
 * @param {{ minTested?: number, threshold?: number }} [opts]
 */
export function createPruneCanary({ minTested = 10, threshold = 10 } = {}) {
  let tested = 0;
  let passed = 0;
  let streak = 0;
  let suspended = false;
  return {
    /** Feed one fresh probe result (cached rows never reach the pruner). */
    record(result) {
      tested += 1;
      if (result?.ok) {
        passed += 1;
        streak = 0;
        return;
      }
      if (result?.tunnelOk === true || result?.infraError === true || result?.spawnFailed === true) {
        streak = 0;
        return;
      }
      streak += 1;
    },
    /** True once tripped (and latched) — callers gate pruning with this. */
    shouldSuspend() {
      if (!suspended && tested >= minTested && passed === 0 && streak >= threshold) {
        suspended = true;
      }
      return suspended;
    },
    get suspended() {
      return suspended;
    },
  };
}
