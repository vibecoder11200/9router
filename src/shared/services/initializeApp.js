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
import { reapOrphanedManagedDS2API, stopDS2API } from "@/lib/ds2api/process";
import { reapOrphanedManagedHeadroom, stopHeadroomProxy } from "@/lib/headroom/process";
import { DEFAULT_DS2API_URL, isLoopbackDS2APIUrl } from "@/lib/ds2api/detect";
import { killAllBridges } from "@/lib/mcp/stdioSseBridge";
import { stopXray } from "@/lib/xray/process.js";
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
  bootCriticalStarted: false,
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

/**
 * Register the app-wide shutdown handler (idempotent). Called from BOTH
 * instrumentation.register() at server start and initializeApp() — the
 * layout path can no longer be the only registrant, because headless/API-only
 * boots never render the root layout and used to end up with NO signal
 * handler at all (audit F3): `systemctl stop` then killed Node with the
 * default disposition, skipping the xray stop and DNS cleanup entirely.
 */
export function registerShutdownHandlers() {
  if (g.signalHandlersRegistered) return;
  g.signalHandlersRegistered = true;

  const shutdown = () => {
    // Double-SIGINT: the user insists — exit immediately.
    if (g.isShuttingDown) process.exit(0);
    g.isShuttingDown = true;
    // CRITICAL stops run SYNCHRONOUSLY, before any await (SIGTERM-race fix,
    // v0.6.72): Next.js registers its own SIGTERM handler whose graceful-exit
    // path can call process.exit() while our async cleanup is still awaiting
    // its first dynamic import — on a headless box the old order never
    // reached stopXrayService at all (xray survived SIGTERM with the pid file
    // intact). Signals sent synchronously cannot be un-sent by a later
    // process.exit; everything past the first await is best-effort.
    try { stopXray(); } catch { /* best effort */ }
    try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
    try { killAllBridges(); } catch { /* best effort */ }
    killCloudflared();
    try { stopDS2API(); } catch { /* best effort */ }
    try { stopHeadroomProxy(); } catch { /* best effort */ }
    // Best-effort remainder, bounded by the hard timeout (X3): the draining
    // sweep (stopXray above already handled the active pid + its pid file),
    // the browser-engine children, and a final DNS pass.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      process.exit(0);
    };
    const timeout = setTimeout(finish, SHUTDOWN_TIMEOUT_MS);
    timeout.unref?.();
    (async () => {
      try {
        const { stopXrayService } = await import("@/lib/xray/manager.js");
        await stopXrayService().catch(() => {});
      } catch { /* manager unavailable — nothing more to stop */ }
      // v0.6.71 (audit F9): the browser-engine children have no other
      // shutdown coverage — best-effort, bounded by the race.
      try { (await import("open-sse/services/browserPool.js")).shutdownPool("app-shutdown").catch(() => {}); } catch { /* best effort */ }
      try { (await import("open-sse/services/obscura.js")).killSharedObscuraServer(); } catch { /* best effort */ }
      try { (await import("open-sse/services/virtualDisplay.js")).stopVirtualDisplay(); } catch { /* best effort */ }
      try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
    })().then(finish, finish);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => { try { removeAllDNSEntriesSync(); } catch { /* ignore */ } });
}

export async function initializeApp() {
  try {
    // Register cleanup + exit-respawn callback immediately so signals and
    // unexpected cloudflared exits are handled even during the deferred window.
    registerShutdownHandlers();

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

/**
 * The must-run-every-boot core (audit F2): stale-state reaping, connection
 * cleanup and every auto-resume/auto-start. Fired from
 * instrumentation.register() at SERVER START so headless/API-only boots (no
 * page ever renders the root layout) get it too — until v0.6.71 the
 * layout-driven runHeavyStartup was the only caller, which is why a rebooted
 * headless box never restarted its proxy, tunnels or DS2API.
 *
 * Single-flight via the global singleton: the runHeavyStartup copy becomes a
 * no-op after the first run. Every task here is individually idempotent as
 * well (already-running early-returns, once-per-process flags).
 */
export async function runBootCriticalTasks() {
  if (g.bootCriticalStarted) return;
  g.bootCriticalStarted = true;
  const settings = await getSettings();

  await cleanupProviderConnections();

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

  // Structural twins of the managed-xray orphan bug (audit F4/F5): reap
  // sidecars left by a PREVIOUS instance BEFORE the auto-starts below can
  // "adopt" them forever (stale binary/env/config never takes effect again).
  try {
    const reapedDs2api = await reapOrphanedManagedDS2API();
    if (reapedDs2api.killed) console.log(`[InitApp] Reaped orphaned DS2API (pid ${reapedDs2api.pid}) from a previous instance`);
  } catch (e) {
    console.warn(`[InitApp] DS2API orphan reap failed (non-fatal): ${e?.message || e}`);
  }

  // Fork: auto-start the managed DS2API sidecar (preserved from fork v0.5.32).
  // Unconditional like the original — DS2API is opt-in via its own install/start
  // state, not via a global settings flag.
  autoStartDs2api();

  try {
    const reapedHeadroom = await reapOrphanedManagedHeadroom();
    if (reapedHeadroom.killed) console.log(`[InitApp] Reaped orphaned headroom proxy (pid ${reapedHeadroom.pid}) from a previous instance`);
  } catch (e) {
    console.warn(`[InitApp] Headroom orphan reap failed (non-fatal): ${e?.message || e}`);
  }
  autoStartHeadroom(settings);

  // v2go/xray proxy: auto-start the local xray client if the user enabled it.
  // (The managed-xray ORPHAN reap already ran in instrumentation.register()
  // before anything here, so the ports are free for this start.)
  if (settings.xrayEnabled && settings.xrayAutoStart) {
    autoStartXray();
  }
}

async function runHeavyStartup() {
  // The must-run boot core already ran from instrumentation at server start
  // (audit F2); this layout-driven call is a defensive no-op afterwards but
  // still covers shapes where instrumentation somehow didn't register.
  await runBootCriticalTasks();

  const settings = await getSettings();

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
  // config catalog fresh even when the proxy itself is off).
  import("@/lib/xray/sync.js")
    .then(({ startSyncScheduler }) => startSyncScheduler())
    .catch((e) => console.log("[XraySync] scheduler start failed:", e.message));
}

// Cheap local check: keeps the scheduler module (and its provider graph) unloaded
// when nothing opted in. An enabled schedule counts on its own.
function hasQuotaAutoPingEnabled(settings) {
  return [settings?.claudeAutoPing, settings?.codexAutoPing].some((config) => (
    Object.values(config?.connections || {}).some(Boolean)
    || Object.values(config?.schedules || {}).some((schedule) => schedule?.enabled === true)
  ));
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

// Auto-start the managed headroom compression proxy on boot when the user
// enabled it (Token Saver). Mirrors autoStartDs2api: only acts when the
// binary is installed; never throws.
async function autoStartHeadroom(settings) {
  try {
    if (!settings?.headroomEnabled) return;
    const { findHeadroomBinary } = await import("@/lib/headroom/detect.js");
    if (!findHeadroomBinary()) {
      console.log("[InitApp] Headroom enabled but binary not installed, skipping auto-start");
      return;
    }
    const { startHeadroomProxy } = await import("@/lib/headroom/process.js");
    console.log("[InitApp] Headroom was enabled, auto-starting...");
    const result = await startHeadroomProxy();
    console.log(`[InitApp] Headroom auto-started (pid ${result.pid}${result.alreadyRunning ? ", already running" : ""})`);
  } catch (err) {
    console.log("[InitApp] Headroom auto-start failed:", err.message);
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
