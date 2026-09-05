import os from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { cleanupProviderConnections, getSettings, updateSettings } from "@/lib/localDb";
import {
  enableTunnel, enableTailscale,
  isTunnelManuallyDisabled, isTunnelReconnecting, isTailscaleReconnecting,
  getTunnelService, getTailscaleService, setTunnelUnexpectedExitCallback,
  killCloudflared, isCloudflaredRunning, ensureCloudflared,
  isTailscaleRunning, isTailscaleRunningStrict, isDaemonAlive, startFunnel,
  checkInternet,
  RESTART_COOLDOWN_MS, NETWORK_SETTLE_MS,
  WATCHDOG_INTERVAL_MS, NETWORK_CHECK_INTERVAL_MS, VIRTUAL_IFACE_REGEX,
} from "@/lib/tunnel";
import { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks, restoreToolDNS, removeAllDNSEntriesSync } from "@/mitm/manager";
import { syncToJson as syncMitmAliasCache } from "@/lib/mitmAliasCache";
import { getInstallStatus } from "@/lib/ds2api/install";
import { startManagedDS2API } from "@/lib/ds2api/lifecycle";
import { DEFAULT_DS2API_URL, isLoopbackDS2APIUrl } from "@/lib/ds2api/detect";
import { killAllBridges } from "@/lib/mcp/stdioSseBridge";
import { reapOrphanedTempProbes } from "@/lib/xray/reaper.js";

// Inject correct paths and DB hooks into manager.js (CJS) from ESM context
(function bootstrapMitm() {
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile));
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) process.env.MITM_SERVER_PATH = candidate;
    } catch { /* ignore */ }
  }
  try { initDbHooks(getSettings, updateSettings); } catch { /* ignore */ }
})();

process.setMaxListeners(20);

// Defer heavy startup work so the first HTTP request (login → dashboard) isn't
// starved by DB cleanup, cloudflared download, lsof/DNS probes and OAuth pings.
const STARTUP_DEFER_MS = 3000;

// Survive Next.js hot reload
const g = global.__appSingleton ??= {
  signalHandlersRegistered: false,
  isShuttingDown: false,
  watchdogInterval: null,
  networkMonitorInterval: null,
  lastNetworkFingerprint: null,
  lastWatchdogTick: Date.now(),
  lastOnline: null,
  mitmStartInProgress: false,
  tunnelAutoResumed: false,
  tailscaleAutoResumed: false,
};

// Hard upper bound for shutdown work (X3): a stuck managed-stop must not hang
// Ctrl+C forever — bounded wait, then exit.
const SHUTDOWN_TIMEOUT_MS = 5000;

export async function initializeApp() {
  try {
    // Register cleanup + exit-respawn callback immediately so signals and
    // unexpected cloudflared exits are handled even during the deferred window.
    if (!g.signalHandlersRegistered) {
      const shutdown = () => {
        // Double-SIGINT: the user insists — exit immediately.
        if (g.isShuttingDown) process.exit(0);
        g.isShuttingDown = true;
        const finish = () => process.exit(0);
        // X3: the old handler called process.exit() BEFORE the dynamic
        // import() of the xray stopper resolved, leaking a detached xray on
        // every Ctrl+C. Await the managed stop, bounded by a hard timeout.
        Promise.race([
          (async () => {
            try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
            try { killAllBridges(); } catch { /* best effort */ }
            killCloudflared();
            try {
              const { stopXrayService } = await import("@/lib/xray/manager.js");
              await stopXrayService().catch(() => {});
            } catch { /* manager unavailable — nothing to stop */ }
            try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
          })(),
          new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
        ]).then(finish, finish);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("exit", () => { try { removeAllDNSEntriesSync(); } catch { /* ignore */ } });
      g.signalHandlersRegistered = true;
    }

    setTunnelUnexpectedExitCallback(() => {
      safeRestartTunnel("unexpected-exit").catch(() => {});
    });

    // Defer the heavy work — nothing here blocks incoming requests.
    setTimeout(() => {
      runHeavyStartup().catch((e) => console.error("[InitApp] deferred startup failed:", e.message));
    }, STARTUP_DEFER_MS);
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

async function runHeavyStartup() {
  await cleanupProviderConnections();
  const settings = await getSettings();

  // Reap orphaned temp-probe xray processes + files from any previous filter
  // job that was interrupted (crash/restart mid-job). Runs on every boot,
  // independent of xrayAutoStart, so orphans are cleared even when the managed
  // xray is already running and startXrayService early-returns.
  try {
    const reaped = await reapOrphanedTempProbes();
    if (reaped.unlinked > 0) {
      console.log(`[InitApp] Reaped ${reaped.unlinked} orphaned temp-probe config file(s)`);
    }
  } catch (e) {
    console.warn(`[InitApp] Reaper failed (non-fatal): ${e?.message || e}`);
  }

  // Auto-resume tunnel (once per process)
  if (settings.tunnelEnabled && !g.tunnelAutoResumed) {
    g.tunnelAutoResumed = true;
    console.log("[InitApp] Tunnel was enabled, auto-resuming...");
    safeRestartTunnel("startup").catch((e) => console.log("[InitApp] Tunnel resume failed:", e.message));
  }

  // Auto-resume tailscale (once per process)
  if (settings.tailscaleEnabled && !g.tailscaleAutoResumed) {
    g.tailscaleAutoResumed = true;
    console.log("[InitApp] Tailscale was enabled, auto-resuming...");
    safeRestartTailscale("startup").catch((e) => console.log("[InitApp] Tailscale resume failed:", e.message));
  }

  if (settings.tunnelEnabled) ensureCloudflared().catch(() => {});

  if (settings.mitmEnabled) {
    // Sync mitmAlias DB → JSON cache so standalone MITM server can read it.
    syncMitmAliasCache().catch(() => {});
    autoStartMitm(settings);
  }

  // perf(startup): only run tunnel watchdog/network monitor when a tunnel is on,
  // and only run quota auto-ping when a connection actually enables it.
  configureTunnelMonitoring(settings);

  // Fork: auto-start the managed DS2API sidecar (preserved from fork v0.5.32).
  // Unconditional like the original — DS2API is opt-in via its own install/start
  // state, not via a global settings flag.
  autoStartDs2api();

  if (hasQuotaAutoPingEnabled(settings)) {
    import("@/shared/services/quotaAutoPing")
      .then(({ startQuotaAutoPing }) => startQuotaAutoPing())
      .catch((e) => console.log("[AutoPing] scheduler start failed:", e.message));
  }

  // TOTU AI account auto-fetch scheduler. Idempotent; configure from settings
  // so the configured interval (including 0 = manual-only) is honored (X8/N6).
  import("@/lib/totuAutoFetch")
    .then(({ configureTotuAutoFetch }) => configureTotuAutoFetch(settings))
    .catch((e) => console.log("[TotuAutoFetch] scheduler start failed:", e.message));

  // v2go/xray health-check scheduler (phase 07): wires the existing
  // xrayHealthCheckIntervalMin setting. The tick self-guards via runHealthCheck's
  // {skipped} return when no managed xray runs, so non-v2go installs pay
  // ~nothing. Idempotent; 0 = manual-only.
  import("@/lib/xray/healthScheduler.js")
    .then(({ configureXrayHealthCheck }) => configureXrayHealthCheck(settings))
    .catch((e) => console.log("[XrayHealth] scheduler start failed:", e.message));

  // Proactive OAuth token refresh (e.g. grok-cli ~6h TTL). Module is idempotent
  // and also started from custom-server.js when that entry is used.
  import("@/sse/services/backgroundTokenRefresh.js")
    .then(({ startBackgroundTokenRefresh }) => startBackgroundTokenRefresh())
    .catch((e) => console.log("[BackgroundTokenRefresh] scheduler start failed:", e.message));

  // v2go/xray proxy: always start the subscription sync scheduler (keeps the
  // config catalog fresh even when the proxy itself is off), and auto-start
  // the local xray client if the user enabled it.
  import("@/lib/xray/sync.js")
    .then(({ startSyncScheduler }) => startSyncScheduler())
    .catch((e) => console.log("[XraySync] scheduler start failed:", e.message));
  if (settings.xrayEnabled && settings.xrayAutoStart) {
    autoStartXray();
  }
}

function hasQuotaAutoPingEnabled(settings) {
  return [settings?.claudeAutoPing, settings?.codexAutoPing]
    .some((config) => Object.values(config?.connections || {}).some(Boolean));
}

async function autoStartMitm(settings) {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    if (!settings.mitmEnabled) return;
    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    // S7 follow-up: apiKeys.key stores the MASKED display string now, so the
    // server cannot mint the credential the MITM child used to present to
    // /v1. When Require-API-Key is on, a keyless MITM would 401 every proxied
    // request — refuse loudly instead of auto-starting into a broken state.
    // With it off (the common local-mode setup), start with no ROUTER_API_KEY.
    if (settings.requireApiKey) {
      console.warn("[InitApp] MITM auto-start skipped: Require-API-Key is enabled and raw keys are never stored (v0.6.36+). Start MITM once from the dashboard and paste a raw API key.");
      return;
    }

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(null, password);
    console.log("[InitApp] MITM auto-started");
    try {
      await restoreToolDNS(password);
      console.log("[InitApp] DNS restored from saved state");
    } catch (e) {
      console.log("[InitApp] DNS restore failed:", e.message);
    }
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

// Auto-start the managed DS2API (DeepSeek Web) sidecar on boot when the user has
// enabled it — mirrors autoStartMitm. Only acts for the local/loopback managed
// case; an external sidecar is started outside 9router. Best-effort: never throws.
async function autoStartDs2api() {
  try {
    const settings = await getSettings();
    if (!settings.ds2apiEnabled) return;
    const url = settings.ds2apiUrl || DEFAULT_DS2API_URL;
    if (!isLoopbackDS2APIUrl(url)) return;
    if (!getInstallStatus().installed) {
      console.log("[InitApp] DS2API enabled but engine not installed, skipping auto-start");
      return;
    }
    console.log("[InitApp] DS2API was enabled, auto-starting...");
    const result = await startManagedDS2API();
    const inj = result.injection.skipped ? "skipped (already running)"
      : result.injection.injected ? "injected" : "no-change";
    console.log(`[InitApp] DS2API auto-started (pid ${result.pid}, injection: ${inj})`);
  } catch (err) {
    console.log("[InitApp] DS2API auto-start failed:", err.message);
  }
}

// Auto-start the managed xray-core proxy client on boot when the user has
// enabled both xrayEnabled and xrayAutoStart. Mirrors autoStartDs2api: only
// acts when the binary is installed; never throws.
async function autoStartXray() {
  try {
    const { isXrayInstalled } = await import("@/lib/xray/installer.js");
    if (!isXrayInstalled()) {
      console.log("[InitApp] Xray auto-start enabled but binary not installed, skipping");
      return;
    }
    const { startXrayService } = await import("@/lib/xray/manager.js");
    console.log("[InitApp] Xray was enabled, auto-starting...");
    const result = await startXrayService();
    console.log(`[InitApp] Xray auto-started (pid ${result.pid}, config ${result.configId})`);
  } catch (err) {
    console.log("[InitApp] Xray auto-start failed:", err.message);
  }
}

// Cooldown only applies to repeating watchdog ticks (anti hammer-loop).
// Network/exit events are one-shot transitions → bypass to recover fast.
const FORCE_RESTART_REASONS = /^(startup|netchange|sleep|sleep\+netchange|online|unexpected-exit)$/;

// ─── Safe restart (4 guards: spawn / cooldown / alive / internet) ────────────

async function safeRestartTunnel(reason) {
  const svc = getTunnelService();
  const settings = await getSettings();
  if (!settings.tunnelEnabled) return;
  if (svc.cancelToken.cancelled) return;
  if (svc.spawnInProgress) return;

  const force = FORCE_RESTART_REASONS.test(reason);

  // Process alive = trust cloudflared (self-reconnects via --retries 99, keeps same URL).
  // Killing a live process on network change drops the tunnel and rotates the quick-tunnel URL.
  if (isCloudflaredRunning()) return;

  if (!force && Date.now() - svc.lastRestartAt < RESTART_COOLDOWN_MS) {
    console.log(`[Tunnel] degraded but cooldown active, skip (${reason})`);
    return;
  }
  if (!await checkInternet()) return;

  console.log(`[Tunnel] safeRestart (${reason}) — tunnel unreachable${force ? " [force]" : ""}`);
  try {
    await enableTunnel();
    svc.lastRestartAt = Date.now();
    console.log("[Tunnel] restart success");
  } catch (err) {
    if (!/cloudflared killed|tunnel cancelled/.test(err.message)) {
      console.log("[Tunnel] restart failed:", err.message);
    }
  }
}

async function safeRestartTailscale(reason) {
  const svc = getTailscaleService();
  const settings = await getSettings();
  if (!settings.tailscaleEnabled) return;
  if (svc.cancelToken.cancelled) return;
  if (svc.spawnInProgress) return;

  // Tailscale daemon is OS-level with built-in reconnect; trust it when running (even on netchange).
  // Startup uses strict probe — cached state is cold after process/dev reload.
  const running = reason === "startup" ? await isTailscaleRunningStrict() : isTailscaleRunning();
  if (running) return;

  // Daemon alive but funnel dropped → recover funnel only; never full-restart (preserves login/daemon).
  if (isDaemonAlive() && svc.activeLocalPort) {
    try {
      await startFunnel(svc.activeLocalPort);
      svc.lastRestartAt = Date.now();
      console.log("[Tailscale] funnel re-established (daemon alive)");
    } catch (err) {
      console.log("[Tailscale] funnel recovery failed:", err.message);
    }
    return;
  }

  const force = FORCE_RESTART_REASONS.test(reason);
  if (!force && Date.now() - svc.lastRestartAt < RESTART_COOLDOWN_MS) {
    console.log(`[Tailscale] degraded but cooldown active, skip (${reason})`);
    return;
  }
  if (!await checkInternet()) return;

  console.log(`[Tailscale] safeRestart (${reason}) — daemon not running${force ? " [force]" : ""}`);
  try {
    await enableTailscale();
    svc.lastRestartAt = Date.now();
    console.log("[Tailscale] restart success");
  } catch (err) {
    console.log("[Tailscale] restart failed:", err.message);
  }
}

// ─── Watchdog: 60s tick check both services ──────────────────────────────────

function startWatchdog() {
  if (g.watchdogInterval) return;
  g.watchdogInterval = setInterval(() => {
    safeRestartTunnel("watchdog").catch(() => {});
    safeRestartTailscale("watchdog").catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
  if (g.watchdogInterval.unref) g.watchdogInterval.unref();
}

function stopWatchdog() {
  if (!g.watchdogInterval) return;
  clearInterval(g.watchdogInterval);
  g.watchdogInterval = null;
}

// ─── Network monitor: detect IPv4 fingerprint change + sleep/wake ────────────

function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (VIRTUAL_IFACE_REGEX.test(name)) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  return active.sort().join("|");
}

function startNetworkMonitor() {
  if (g.networkMonitorInterval) return;

  g.lastNetworkFingerprint = getNetworkFingerprint();
  g.lastWatchdogTick = Date.now();
  g.lastOnline = null;

  g.networkMonitorInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsed = now - g.lastWatchdogTick;
      g.lastWatchdogTick = now;

      const currentFingerprint = getNetworkFingerprint();
      const networkChanged = currentFingerprint !== g.lastNetworkFingerprint;
      const wasSleep = elapsed > NETWORK_CHECK_INTERVAL_MS * 6;
      if (networkChanged) g.lastNetworkFingerprint = currentFingerprint;

      // Real reachability check (TCP 1.1.1.1:443) — not just interface presence
      const online = await checkInternet();
      const wasOffline = g.lastOnline === false;
      g.lastOnline = online;

      if (!online) return; // no internet → idle, don't restart

      const onlineEdge = wasOffline; // offline → online transition
      if (!networkChanged && !wasSleep && !onlineEdge) return;

      // Wait for DHCP/DNS to settle before probing
      await new Promise((r) => setTimeout(r, NETWORK_SETTLE_MS));

      const reason = onlineEdge ? "online"
        : wasSleep && networkChanged ? "sleep+netchange"
        : wasSleep ? "sleep" : "netchange";
      safeRestartTunnel(reason).catch(() => {});
      safeRestartTailscale(reason).catch(() => {});
    } catch (err) {
      console.log("[NetworkMonitor] error:", err.message);
    }
  }, NETWORK_CHECK_INTERVAL_MS);

  if (g.networkMonitorInterval.unref) g.networkMonitorInterval.unref();
}


function stopNetworkMonitor() {
  if (!g.networkMonitorInterval) return;
  clearInterval(g.networkMonitorInterval);
  g.networkMonitorInterval = null;
  g.lastNetworkFingerprint = null;
  g.lastOnline = null;
}

export function configureTunnelMonitoring(settings) {
  if (settings?.tunnelEnabled || settings?.tailscaleEnabled) {
    startWatchdog();
    startNetworkMonitor();
    return;
  }
  stopWatchdog();
  stopNetworkMonitor();
}

export default initializeApp;
