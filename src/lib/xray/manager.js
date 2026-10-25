/**
 * V2Ray/xray proxy manager — the orchestration facade.
 *
 * Pulls together every moving piece: install xray, pick/select a config from
 * the DB catalog, build a client config, spawn the process, probe SOCKS health,
 * and expose a proxy pool to the rest of 9router so provider connections can
 * route through the active server.
 *
 * This is the single source of truth for xray runtime state. API routes and
 * the boot sequence talk to this module; nothing else spawns xray directly.
 *
 * Lifecycle: stopped → starting → running (↔ error). Switching servers is a
 * restart with a new config.json (the v2rayN convention, see plan).
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildClientConfig, validateLink } from "./configBuilder.js";
import { reapOrphanedTempProbes } from "./reaper.js";
import { convertLink } from "./parser.js";
import {
  isXrayInstalled,
  getXrayConfigPath,
  getXrayBinaryPath,
  getInstalledVersion,
  getXrayRuntimeVersion,
  installXray,
} from "./installer.js";
import {
  startManagedXray,
  stopXray,
  getManagedPid,
  getXrayLogTail,
  spawnTempXray,
  spawnNextManagedXray,
  setManagedPid,
  terminateXrayPid,
  getDrainingPids,
  addDrainingPid,
  removeDrainingPid,
} from "./process.js";
import { testProxy, testProxyLatency, isSocksPortOpen, testProxyExitIpWithUri } from "./tester.js";
import { startFilterXray, stopFilterXray, probeConfigViaApi } from "./apiFilter.js";
import { shouldPruneFilterResult } from "./filterPrunePolicy.js";
import {
  getSelectedXrayConfig,
  getXrayConfigById,
  setSelectedXrayConfig,
  updateXrayTestResult,
  getXrayConfigs,
  getXraySyncState,
  // Auto-prune (model filter) must HARD-delete: tombstones are user-intent
  // only — a pruning run would otherwise permanently ban hundreds of configs
  // with no restore path (RT-4).
  hardDeleteXrayConfig,
} from "../db/repos/xrayRepo.js";
import {
  getModelFilterResultsByConfigIds,
  getModelFilterCacheStats,
  upsertModelFilterResult,
  clearModelFilterResultsByModel,
  deleteModelFilterResultsByConfigIds,
} from "../db/repos/modelFilterResultsRepo.js";
import {
  getProxyPoolById,
  createProxyPool,
  updateProxyPool,
} from "../db/repos/proxyPoolsRepo.js";
import { getSettings, updateSettings } from "../db/repos/settingsRepo.js";
import { getModelInfo } from "@/sse/services/model.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import {
  getActiveLiveTrafficCount,
  getLiveTrafficQuietForMs,
  waitForLiveTrafficQuiet,
} from "./modelFilterTraffic.js";
import { buildModelProbeBody, withProbeTimeout } from "./modelProbe.js";
import { createSerialized } from "@/lib/serialize.js";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";

// Fixed pool id so re-runs update the same row rather than creating dupes.
const MANAGED_POOL_ID = "v2go-xray-managed";

const silentProbeLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  line() {},
  errorLine() {},
  request() {},
  response() {},
  stream() {},
  nextTag() { return ""; },
  tagForSession() { return ""; },
  fmtThink() { return null; },
  maskKey(key) { return key ? "***" : ""; },
};

// In-memory runtime state. Persisted bits (selected config id, ports, version)
// live in the settings blob + xrayConfigs table.
const state = {
  status: "stopped", // stopped | starting | running | error
  pid: null,
  activeConfigId: null,
  socksPort: null,
  httpPort: null,
  lastError: null,
  lastHealthAt: null,
  lastHealth: null, // { latencyMs, exitIp }
};

const modelFilterState = {
  status: "idle", // idle | running | done | cancelled | error
  startedAt: null,
  finishedAt: null,
  source: null,
  model: null,
  all: false,
  limit: 50,
  prune: false,
  concurrency: 2,
  pauseOnTraffic: true,
  quietMs: 15000,
  tested: 0,
  passed: 0,
  failed: 0,
  pruned: 0,
  cached: 0,
  trafficWaiters: 0,
  error: null,
  autoFilterSkipReason: null,
  autoFilterSkipAt: null,
};

// Mirror of getModelFilterCacheStats(), refreshed at job boundaries and on
// cache mutations. Kept in-memory so the (sync) status reader can surface it
// without making the status endpoint async.
let modelFilterCacheStats = { total: 0, byModel: {} };
// Whether the snapshot has been seeded since boot. getStatus() kicks off a
// background refresh once so the cache badge is correct on first page load.
let modelFilterCacheStatsSeeded = false;

async function refreshModelFilterCacheStats() {
  try {
    modelFilterCacheStats = await getModelFilterCacheStats();
  } catch {
    // leave the previous snapshot in place on failure
  }
}

export { refreshModelFilterCacheStats };

// True while a filter job is mid-flight. Used by the clear-cache endpoint to
// reject concurrent cache wipes that would race with in-progress writes.
export function isModelFilterRunning() {
  return modelFilterRunning != null;
}

let modelFilterRunning = null;
// Coalesced re-run latch (auto-filter skip-on-conflict): auto triggers that
// arrive while a filter job is running set this instead of being lost; the
// running job's completion consumes it for exactly ONE follow-up run with the
// latest saved settings. Never a queue — at most one pending re-run.
let autoFilterRerunQueued = false;

// Cooperative cancel flag for the running model-filter job. Set by
// requestModelFilterCancel() (the /stop endpoint); the worker loop checks it
// between configs so in-flight probes finish naturally, then the job winds
// down. Results already probed are persisted incrementally, so re-running
// resumes from where it stopped (the cache splitter skips fresh successes).
let modelFilterCancelRequested = false;

/** True if a stop has been requested for the running job. */
export function isModelFilterCancelRequested() {
  return modelFilterCancelRequested;
}

/**
 * Request a cooperative stop of the running model-filter job.
 * @returns {boolean} true if a job was running and a stop was requested
 */
export function requestModelFilterCancel() {
  if (!modelFilterRunning) return false;
  modelFilterCancelRequested = true;
  return true;
}

const allocatedTempSocksPorts = new Set();

// ─── blue-green switch infrastructure ──────────────────────────────────────
// switchConfig() no longer kills the active xray first. It spawns the NEXT
// instance on a fresh ephemeral port pair, health-probes it, and only then
// atomically repoints the managed pool at the new SOCKS port. The OLD
// instance keeps serving the requests already riding its dispatcher for a
// drain window before being terminated — this is what eliminates the
// mid-stream `TypeError: terminated` casualties of a rotation.

// Port range for switched (active) instances. Deliberately disjoint from the
// model-test range (51808..52807) so filter probes can't collide with the
// live proxy.
const SWITCH_PORT_BASE = 53108;
const SWITCH_PORT_SPAN = 300;
// How long a retired instance stays alive for in-flight requests to drain.
const XRAY_DRAIN_MS = Math.max(0, Number(process.env.NINEROUTER_XRAY_DRAIN_MS) || 90 * 1000);
// Cap on simultaneously draining instances — beyond this the oldest is killed.
const MAX_DRAINING_INSTANCES = 3;

// pid -> { timer, port } for instances retired by a blue-green switch.
const drainingInstances = new Map();

/** Is a TCP port actually bindable right now (nothing listening on it)? */
function tcpPortAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Pick a free port from [base, base+span): not currently reserved in the
 * in-process registry AND actually bindable (pre-flight EADDRINUSE check —
 * random collisions with a still-dying previous instance are the root cause
 * of "bind: address already in use" test failures). The port is reserved in
 * the registry the moment it is chosen so concurrent pickers can't take it.
 * Returns null after `attempts` tries.
 */
async function pickFreePort({ base, span, attempts = 25 }) {
  for (let i = 0; i < attempts; i++) {
    const port = base + Math.floor(Math.random() * span);
    if (allocatedTempSocksPorts.has(port)) continue;
    allocatedTempSocksPorts.add(port);
    if (await tcpPortAvailable(port)) return port;
    allocatedTempSocksPorts.delete(port);
  }
  return null;
}

/**
 * Release a registry-held port once its listener is really gone. The kill is
 * asynchronous (Windows PowerShell / SIGKILL delivery lag), so releasing the
 * reservation immediately lets the next spawn re-pick a port whose socket is
 * still open — poll until the port stops accepting connections (bounded),
 * then release. On timeout release anyway so the registry can't leak.
 */
function releasePortWhenClosed(port, maxWaitMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  const poll = async () => {
    while (Date.now() < deadline) {
      if (!(await isSocksPortOpen(port, "127.0.0.1", 400))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    allocatedTempSocksPorts.delete(port);
  };
  poll().catch(() => allocatedTempSocksPorts.delete(port));
}

async function terminateDrainingInstance(pid) {
  const entry = drainingInstances.get(pid);
  if (entry?.timer) clearTimeout(entry.timer);
  drainingInstances.delete(pid);
  try {
    await terminateXrayPid(pid);
  } catch { /* already dead */ }
  removeDrainingPid(pid);
  if (entry?.port) allocatedTempSocksPorts.delete(entry.port);
}

/** Retire an instance: keep it draining for XRAY_DRAIN_MS, then kill it. */
function scheduleDrain(pid, port) {
  if (!pid || drainingInstances.has(pid)) return;
  addDrainingPid(pid);
  drainingInstances.set(pid, { port: port || null, timer: null });

  // Enforce the concurrent-drain cap: kill the OLDEST retiree beyond it.
  const sinceByPid = new Map(getDrainingPids().map((e) => [Number(e.pid), Number(e.since) || 0]));
  const excess = [...drainingInstances.keys()]
    .filter((p) => p !== pid)
    .sort((a, b) => (sinceByPid.get(a) || 0) - (sinceByPid.get(b) || 0))
    .slice(0, Math.max(0, drainingInstances.size - MAX_DRAINING_INSTANCES));
  for (const old of excess) terminateDrainingInstance(old);

  if (XRAY_DRAIN_MS <= 0) {
    terminateDrainingInstance(pid);
    return;
  }
  const timer = setTimeout(() => {
    terminateDrainingInstance(pid);
  }, XRAY_DRAIN_MS);
  timer.unref?.();
  drainingInstances.get(pid).timer = timer;
}

/** Kill every draining instance (stop service, tests). Fire-and-forget safe. */
async function terminateAllDrainingInstances() {
  for (const pid of [...drainingInstances.keys()]) {
    await terminateDrainingInstance(pid);
  }
}

/**
 * The SOCKS port of the currently active instance. After a blue-green switch
 * this is an ephemeral port recorded in the managed pool's proxyUrl; the
 * settings value (10808) is only the cold-start port. Resolve: in-memory
 * state → pool row (survives HMR / module-state resets) → settings default.
 */
async function getActiveSocksPort() {
  if (state.socksPort) return state.socksPort;
  try {
    const pool = await getProxyPoolById(MANAGED_POOL_ID);
    const m = /:\/\/127\.0\.0\.1:(\d+)/.exec(pool?.proxyUrl || "");
    if (m) return Number(m[1]);
  } catch { /* fall through */ }
  const settings = await getSettings();
  return Number(settings.xraySocksPort) || 10808;
}

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
}

/** Current runtime status snapshot. */
export function getStatus() {
  const pid = getManagedPid();
  // Reconcile in-memory state with reality: if a managed pid is alive but the
  // in-memory status says "stopped" (e.g. after Next.js HMR reset module state),
  // report "running". Ports are read from settings as a fallback.
  const effectiveStatus = pid && state.status === "stopped" ? "running" : (pid ? state.status : "stopped");
  // Lazy-seed the cache-stats snapshot once after boot so the badge reflects
  // rows persisted from prior sessions (survives restarts). Fire-and-forget;
  // the next poll picks up the refreshed numbers.
  if (!modelFilterCacheStatsSeeded) {
    modelFilterCacheStatsSeeded = true;
    refreshModelFilterCacheStats();
  }
  return {
    status: effectiveStatus,
    pid,
    binaryInstalled: isXrayInstalled(),
    binaryPath: isXrayInstalled() ? getXrayBinaryPath() : null,
    installedVersion: getInstalledVersion(),
    activeConfigId: state.activeConfigId,
    socksPort: state.socksPort,
    httpPort: state.httpPort,
    lastError: state.lastError,
    lastHealthAt: state.lastHealthAt,
    lastHealth: state.lastHealth,
    modelFilter: getModelFilterStatus(),
  };
}

export function getModelFilterStatus() {
  const quietForMs = getLiveTrafficQuietForMs();
  return {
    ...modelFilterState,
    liveTraffic: {
      active: getActiveLiveTrafficCount(),
      quietForMs: Number.isFinite(quietForMs) ? quietForMs : null,
    },
    cache: { ...modelFilterCacheStats },
  };
}

export function updateRunningModelFilterOptions(options = {}) {
  if (!modelFilterRunning) return false;
  if (Object.prototype.hasOwnProperty.call(options, "pauseOnTraffic")) {
    modelFilterState.pauseOnTraffic = options.pauseOnTraffic === true;
  }
  if (Object.prototype.hasOwnProperty.call(options, "quietMs")) {
    modelFilterState.quietMs = Math.max(3000, Math.min(Number(options.quietMs) || 15000, 120000));
  }
  return true;
}

/**
 * Write the client config.json for the given outbound to disk.
 * @param {object} outbound — from convertLink
 * @param {{ socksPort: number, httpPort: number }} ports
 */
function writeConfig(outbound, { socksPort, httpPort }) {
  const configPath = getXrayConfigPath();
  const config = buildClientConfig(outbound, { socksPort, httpPort });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// Re-export the orphan reaper (defined in ./reaper.js, a dependency-free module
// so it can be statically imported at app boot without pulling manager.js).
export { reapOrphanedTempProbes };

/**
 * Create or refresh the managed proxy pool so the rest of 9router can route
 * through the local SOCKS port like any other proxy pool. The pool is marked
 * with _v2goManaged so it is visually distinguishable from user-created pools.
 */
async function syncManagedPool(active, socksPort, configId) {
  const proxyUrl = `socks5://127.0.0.1:${socksPort}`;
  const existing = await getProxyPoolById(MANAGED_POOL_ID);
  const data = {
    name: "V2Ray Proxy (v2go)",
    proxyUrl,
    type: "socks5",
    isActive: active,
    strictProxy: true,
    testStatus: active ? "unknown" : "offline",
    _v2goManaged: true,
    _v2goConfigId: configId || null,
  };
  if (existing) {
    await updateProxyPool(MANAGED_POOL_ID, data);
  } else {
    await createProxyPool({ id: MANAGED_POOL_ID, ...data });
  }
}

/**
 * Start the xray service. If no configId is given, uses the selected config
 * from the DB (or the healthiest active one). Writes config.json, spawns the
 * process, waits for the SOCKS port, runs a health probe, and syncs the pool.
 *
 * @param {{ configId?: string }} opts
 * @throws {Error} with code NOT_INSTALLED | NO_CONFIG | NO_BINARY | STARTUP_FAILED
 */
export async function startXrayService(opts = {}) {
  if (!isXrayInstalled()) {
    const e = new Error("Xray binary is not installed. Install it from the dashboard first.");
    e.code = "NOT_INSTALLED";
    throw e;
  }

  // Note: orphan reaping runs at app boot in initializeApp.runHeavyStartup,
  // independent of this function, so it fires even when the managed xray is
  // already running and we early-return below.

  const settings = await getSettings();
  const socksPort = Number(settings.xraySocksPort) || 10808;
  const httpPort = Number(settings.xrayHttpPort) || 10809;

  // Resolve which config to run.
  let config = opts.configId ? await getXrayConfigById(opts.configId) : null;
  if (!config) config = await getSelectedXrayConfig();
  if (!config) {
    // Fall back to the first active config.
    const all = await getXrayConfigs({ isActive: true });
    config = all[0];
  }
  if (!config) {
    const e = new Error("No V2Ray configs available. Run a subscription sync first.");
    e.code = "NO_CONFIG";
    throw e;
  }

  // Validate the link produces a runnable outbound before spawning.
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config "${config.name}" is not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  setStatus("starting", { lastError: null });

  try {
    const configPath = writeConfig(v.outbound, { socksPort, httpPort });
    const { pid, alreadyRunning } = await startManagedXray({ configPath });

    // Idempotent start: the existing instance keeps running the outbound it
    // was started with — which after a blue-green switch lives on an
    // ephemeral port, not the configured one. Probe/sync THAT port; writing
    // the settings port into the pool here would break routing.
    const effectiveSocksPort = alreadyRunning ? await getActiveSocksPort() : socksPort;

    // Wait for the SOCKS port to accept connections (process is up + inbound bound).
    let ready = false;
    for (let i = 0; i < 20; i++) {
      if (await isSocksPortOpen(effectiveSocksPort)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) {
      stopXray();
      const e = new Error("SOCKS port did not open within 6s — check xray.log");
      e.code = "STARTUP_FAILED";
      setStatus("error", { lastError: e.message });
      throw e;
    }

    // Persist selection + ports.
    await setSelectedXrayConfig(config.id);
    await updateSettings({ xraySelectedConfigId: config.id });

    // Health probe (non-fatal if it fails — the process is up).
    const health = await testProxy(effectiveSocksPort);
    if (health.ok) {
      await updateXrayTestResult(config.id, health);
    }

    await syncManagedPool(true, effectiveSocksPort, config.id);
    setStatus("running", {
      pid,
      activeConfigId: config.id,
      socksPort: effectiveSocksPort,
      httpPort,
      lastHealth: health.ok ? health : null,
      lastHealthAt: new Date().toISOString(),
    });

    return { pid, configId: config.id, health };
  } catch (e) {
    setStatus("error", { lastError: e.message });
    await syncManagedPool(false, socksPort, null);
    throw e;
  }
}

/** Stop the xray process (and any draining instances) and mark the pool inactive. */
export async function stopXrayService() {
  const result = stopXray();
  // Blue-green retirees: the user asked to stop — no point draining.
  terminateAllDrainingInstances().catch(() => {});
  const settings = await getSettings();
  const socksPort = Number(settings.xraySocksPort) || 10808;
  await syncManagedPool(false, socksPort, null);
  setStatus("stopped", { pid: null, activeConfigId: null, socksPort: null, lastError: null });
  return result;
}

// X4: serialize config switches. doSwitchConfig performs blue-green promotion
// (spawn → probe → repoint → drain); overlapping callers (auto-rotate, health
// check, UI) previously raced the PID-file writes and could double-spawn
// instances. The promise-chain wrapper queues every caller while preserving
// each one's own result/error.
export const switchConfig = createSerialized(doSwitchConfig);

/**
 * Switch to a different server — BLUE-GREEN, zero-downtime.
 *
 * Old behavior (kill + respawn on the same port) tore down the shared SOCKS
 * port for 8-15s on every switch and destroyed every in-flight request with
 * `TypeError: terminated`. New behavior:
 *
 *  1. Spawn the NEXT xray instance with the new outbound on a fresh
 *     ephemeral port pair (readiness = port accepts connections, raced
 *     against early exit — no fixed 8s gate).
 *  2. Health-probe the new instance THROUGH its own port. A dead candidate
 *     is killed here and the OLD instance keeps serving — the pool never
 *     repoints at an unverified outbound.
 *  3. Optionally reject candidates whose live exit IP is in `avoidExitIps`
 *     (rotation on a per-IP rate limit must actually change the IP).
 *  4. Atomically promote: PID file → new pid, DB selection, managed-pool
 *     proxyUrl → new SOCKS port. New requests pick up the new IP on their
 *     next credential/proxy resolution.
 *  5. Retire the old instance on a drain timer (XRAY_DRAIN_MS): requests
 *     already riding the old dispatcher finish naturally; only after the
 *     window is the old process terminated.
 *
 * @param {string} configId
 * @param {{ avoidExitIps?: Set<string> }} [opts] exit IPs the new instance
 *   must NOT egress from (empty/unknown probe result passes).
 */
export async function doSwitchConfig(configId, opts = {}) {
  const config = await getXrayConfigById(configId);  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config "${config.name}" is not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  const settings = await getSettings();
  const configuredSocksPort = Number(settings.xraySocksPort) || 10808;
  const configuredHttpPort = Number(settings.xrayHttpPort) || 10809;

  const prevPid = getManagedPid();
  const prevSnapshot = { ...state };
  if (!prevSnapshot.socksPort) prevSnapshot.socksPort = await getActiveSocksPort();

  setStatus("starting", { lastError: null });

  const newSocksPort = await pickFreePort({ base: SWITCH_PORT_BASE, span: SWITCH_PORT_SPAN });
  if (!newSocksPort) {
    const e = new Error("No free SOCKS port available for switch");
    e.code = "STARTUP_FAILED";
    setStatus("error", { lastError: e.message });
    throw e;
  }
  // Fresh HTTP inbound too — the old instance still owns the configured pair.
  const newHttpPort = newSocksPort + 1;

  let handle = null;
  try {
    const configPath = writeConfig(v.outbound, { socksPort: newSocksPort, httpPort: newHttpPort });
    handle = await spawnNextManagedXray({ configPath });
    // The new instance owns the PID file from here; restored below on failure.
    setManagedPid(handle.pid);

    // Readiness: port open (success) raced against early exit (bad config /
    // port conflict) and a hard deadline.
    const deadline = Date.now() + 10000;
    const readiness = await Promise.race([
      (async () => {
        while (Date.now() < deadline) {
          if (await isSocksPortOpen(newSocksPort)) return "ready";
          await new Promise((r) => setTimeout(r, 150));
        }
        return "timeout";
      })(),
      handle.exitPromise.then((code) => `exit:${code}`),
    ]);
    if (readiness !== "ready") {
      const e = new Error(
        readiness === "timeout"
          ? "SOCKS port did not open after switch"
          : `xray exited during switch (code=${readiness.slice(5)}) — see xray.log`
      );
      e.code = "STARTUP_FAILED";
      throw e;
    }

    // Verify the candidate BEFORE repointing the pool at it.
    const health = await testProxy(newSocksPort);
    if (!health.ok) {
      const e = new Error(`Candidate "${config.name}" failed health probe (latency/exit-ip unreachable)`);
      e.code = "HEALTH_FAILED";
      throw e;
    }
    if (opts.avoidExitIps && opts.avoidExitIps.size && health.exitIp && opts.avoidExitIps.has(health.exitIp)) {
      const e = new Error(`Candidate "${config.name}" egresses from the same exit IP (${health.exitIp}) we are rotating away from`);
      e.code = "SAME_EXIT_IP";
      throw e;
    }

    // Promote: DB selection, test result, pool URL, runtime state.
    await setSelectedXrayConfig(config.id);
    await updateSettings({ xraySelectedConfigId: config.id });
    await updateXrayTestResult(config.id, health).catch(() => {});
    await syncManagedPool(true, newSocksPort, config.id);
    setStatus("running", {
      pid: handle.pid,
      activeConfigId: config.id,
      socksPort: newSocksPort,
      httpPort: newHttpPort,
      lastHealth: health,
      lastHealthAt: new Date().toISOString(),
    });

    // Retire the old instance — in-flight requests drain through it.
    if (prevPid && prevPid !== handle.pid) {
      scheduleDrain(prevPid, prevSnapshot.socksPort || configuredSocksPort);
    }

    return { pid: handle.pid, configId: config.id, health, replacedPid: prevPid || null };
  } catch (e) {
    // Roll back: kill the failed new instance and restore the previous one
    // (which never stopped serving — unlike the old kill-first restart).
    if (handle) {
      try { await terminateXrayPid(handle.pid); } catch { /* already dead */ }
    }
    allocatedTempSocksPorts.delete(newSocksPort);
    allocatedTempSocksPorts.delete(newHttpPort);
    setManagedPid(prevPid);
    if (prevPid) {
      setStatus(prevSnapshot.status === "stopped" ? "stopped" : "running", {
        pid: prevPid,
        activeConfigId: prevSnapshot.activeConfigId,
        socksPort: prevSnapshot.socksPort || configuredSocksPort,
        httpPort: prevSnapshot.httpPort || configuredHttpPort,
        lastHealth: prevSnapshot.lastHealth,
        lastHealthAt: prevSnapshot.lastHealthAt,
        lastError: null,
      });
    } else {
      setStatus("error", { lastError: e.message, pid: null });
    }
    throw e;
  }
}

/** Restart the active config (e.g. after a port change in settings). */
export async function restartXrayService() {
  const current = state.activeConfigId;
  if (!current) return startXrayService();
  return switchConfig(current);
}

/**
 * Test a single config's latency without disturbing the active service.
 * Spawns an ISOLATED temporary xray on an ephemeral port, probes, kills —
 * the active proxy (if any) keeps running untouched. Used by the per-row
 * "Test" button in the UI.
 *
 * @returns {Promise<{ latencyMs: number, exitIp: string }>}
 */
export async function testSingleConfig(configId) {
  const config = await getXrayConfigById(configId);
  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }
  if (!isXrayInstalled()) {
    const e = new Error("Xray binary is not installed");
    e.code = "NOT_INSTALLED";
    throw e;
  }
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  // Use an ephemeral high port unlikely to collide with the active instance.
  // Pre-flight availability check + registry coordination with the model
  // filter's temp probes (shared range) — a random collision here fails the
  // whole test with "bind: address already in use".
  const tempSocks = await pickFreePort({ base: 51808, span: 1000 });
  if (!tempSocks) {
    const e = new Error("No free SOCKS port available for test");
    e.code = "STARTUP_FAILED";
    throw e;
  }
  const tempHttp = tempSocks + 1;
  const tempConfigPath = getXrayConfigPath() + `.test-${configId}.json`;
  const tempConfig = buildClientConfig(v.outbound, { socksPort: tempSocks, httpPort: tempHttp });
  fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig, null, 2));

  let tempHandle = null;
  try {
    tempHandle = await spawnTempXray({ configPath: tempConfigPath });
    // Wait briefly for the temp port to accept connections.
    for (let i = 0; i < 15; i++) {
      if (await isSocksPortOpen(tempSocks)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const health = await testProxy(tempSocks, 8000);
    await updateXrayTestResult(config.id, health);
    return health;
  } finally {
    // Kill the isolated temp instance — does NOT touch the shared PID file.
    if (tempHandle) tempHandle.kill();
    try { fs.unlinkSync(tempConfigPath); } catch {}
    releasePortWhenClosed(tempSocks);
  }
}

async function spawnTempConfig(config, timeoutMs = 8000) {
  if (!isXrayInstalled()) {
    const e = new Error("Xray binary is not installed");
    e.code = "NOT_INSTALLED";
    throw e;
  }
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  // One retry on "port did not open": with the pre-flight availability check
  // this is now rare (a race with an external process binding between check
  // and spawn), but retrying once with a fresh port beats failing the config
  // and polluting the filter cache with a false negative.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tempSocks = await pickFreePort({ base: 51808, span: 1000 });
    if (!tempSocks) {
      const e = new Error("No free SOCKS port available for temp model test");
      e.code = "STARTUP_FAILED";
      throw e;
    }
    const tempHttp = tempSocks + 1;
    const tempConfigPath = getXrayConfigPath() + `.model-test-${config.id}.json`;
    const tempConfig = buildClientConfig(v.outbound, { socksPort: tempSocks, httpPort: tempHttp });
    fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig, null, 2));

    let tempHandle;
    try {
      tempHandle = await spawnTempXray({ configPath: tempConfigPath });
    } catch (error) {
      allocatedTempSocksPorts.delete(tempSocks);
      try { fs.unlinkSync(tempConfigPath); } catch {}
      throw error;
    }
    let ready = false;
    for (let i = 0; i < 15; i++) {
      if (await isSocksPortOpen(tempSocks)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (ready) {
      return {
        socksPort: tempSocks,
        cleanup() {
          tempHandle.kill();
          // Hold the port reservation until the listener is really gone —
          // the kill is async and the next probe could re-pick the port
          // while the socket is still open ("bind: address already in use").
          releasePortWhenClosed(tempSocks);
          try { fs.unlinkSync(tempConfigPath); } catch {}
        },
        timeoutMs,
      };
    }
    // Port never opened — either the process died (bad config / bind
    // conflict) or it's wedged. Clean up and maybe retry on a fresh port.
    tempHandle.kill();
    try { fs.unlinkSync(tempConfigPath); } catch {}
    releasePortWhenClosed(tempSocks);
    lastError = new Error("SOCKS port did not open for temp model test");
    lastError.code = "STARTUP_FAILED";
  }
  throw lastError;
}

function summarizeProbeBody(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || parsed?.error || text.slice(0, 240);
  } catch {
    return text.slice(0, 240);
  }
}

/**
 * Test whether a single Xray config can actually reach a routed model/provider.
 * This uses the same chatCore/executor path as normal requests, but injects a
 * temporary strict SOCKS proxy so failure cannot silently fall back to direct.
 */
export async function testSingleConfigWithModel(configId, { model: modelStr, timeoutMs = 20000 } = {}) {
  if (!modelStr || typeof modelStr !== "string") {
    const e = new Error("model is required");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const config = await getXrayConfigById(configId);
  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo?.provider || !modelInfo?.model) {
    const e = new Error(`Invalid model: ${modelStr}`);
    e.code = "BAD_MODEL";
    throw e;
  }

  const temp = await spawnTempConfig(config, timeoutMs);
  const startedAt = Date.now();
  try {
    const baseCredentials = await getProviderCredentials(modelInfo.provider, new Set(), modelInfo.model);
    if (!baseCredentials || baseCredentials.allRateLimited) {
      const e = new Error(`No active credentials for provider: ${modelInfo.provider}`);
      e.code = "NO_CREDENTIALS";
      throw e;
    }

    const refreshed = await checkAndRefreshToken(modelInfo.provider, baseCredentials);
    const credentials = {
      ...refreshed,
      providerSpecificData: {
        ...(refreshed.providerSpecificData || {}),
        connectionProxyEnabled: true,
        connectionProxyUrl: `socks5://127.0.0.1:${temp.socksPort}`,
        connectionNoProxy: "",
        connectionProxyPoolId: "xray-model-filter",
        strictProxy: true,
      },
    };
    const settings = await getSettings();
    const result = await withProbeTimeout(handleChatCore({
      body: buildModelProbeBody(modelInfo),
      modelInfo,
      credentials,
      log: silentProbeLog,
      clientRawRequest: {
        endpoint: "/api/xray/configs/model-test",
        body: { ...buildModelProbeBody(modelInfo), model: modelStr },
        headers: { accept: "application/json", "content-type": "application/json", "x-9r-internal": "xray-model-filter" },
      },
      connectionId: baseCredentials.connectionId,
      userAgent: "9router-xray-model-filter/1.0",
      apiKey: null,
      ccFilterNaming: false,
      rtkEnabled: false,
      headroomEnabled: false,
      headroomUrl: settings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: false,
      cavemanEnabled: false,
      cavemanLevel: "full",
      ponytailEnabled: false,
      ponytailLevel: "full",
      pxpipeEnabled: false,
      pxpipeMinChars: settings.pxpipeMinChars,
      pxpipeTimeoutMs: settings.pxpipeTimeoutMs,
      pxpipeTransform: null,
      providerThinking: null,
      sourceFormatOverride: "openai",
    }), timeoutMs, "spawn");

    const latencyMs = Date.now() - startedAt;
    if (!result.success) {
      await updateXrayTestResult(config.id, { ok: false });
      return { ok: false, latencyMs, status: result.status || 502, error: result.error || "Model probe failed" };
    }

    const rawText = await result.response.text().catch(() => "");
    if (!result.response.ok) {
      // HTTP response through the tunnel = config works; failure is upstream
      // (429/403/5xx), not a dead node — see probeModelViaChatCore tunnelOk.
      await updateXrayTestResult(config.id, { ok: false });
      return {
        ok: false,
        tunnelOk: true,
        latencyMs,
        status: result.response.status,
        error: summarizeProbeBody(rawText) || `HTTP ${result.response.status}`,
      };
    }

    const health = await testProxy(temp.socksPort, Math.min(timeoutMs, 8000));
    await updateXrayTestResult(config.id, health.ok ? health : { ok: true, latencyMs });
    return {
      ok: true,
      latencyMs,
      status: result.response.status,
      exitIp: health.exitIp || "",
      error: null,
    };
  } finally {
    temp.cleanup();
  }
}

function normalizeModelFilterLimit({ limit = 50, all = false } = {}) {
  if (all === true || limit === "all") return { all: true, limit: null };
  return { all: false, limit: Math.max(1, Math.min(Number(limit) || 50, 500)) };
}

/**
 * Stable tier partition for the filter slice: lower rank first, and order
 * inside each tier is preserved (selected first, latency asc from
 * getXrayConfigs) — equal ranks reduce to the legacy slice. The caller owns
 * the ranks: 0 = never filter-tested, 1 = due for a re-probe (stale cache or
 * retry-due fail), 2 = fresh cache.
 */
export function orderConfigsForFilterSelection(configs, rankOf) {
  const tiers = [[], [], []];
  for (const config of configs) {
    const rank = Math.min(2, Math.max(0, rankOf(config) | 0));
    tiers[rank].push(config);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

function normalizeModelFilterConcurrency(concurrency = 2) {
  return Math.max(1, Math.min(Number(concurrency) || 2, 16));
}

/**
 * Build the probe function used by api-mode filter. Each call:
 *  1. Adds the config's outbound + a user-routing rule to the shared filter xray.
 *  2. Probes the model endpoint via handleChatCore through the routed SOCKS.
 *  3. Records the exit IP observed through that SOCKS.
 *  4. Tears down rule + outbound (atomic).
 *
 * Returns the same shape as testSingleConfigWithModel so the rest of the
 * pipeline (cache, prune, results) is unchanged.
 */
function makeApiProbeFn(apiHandle, modelInfo, modelStr, timeoutMs) {
  return async (config, workerIdx) => {
    if (!modelInfo?.provider || !modelInfo?.model) {
      throw new Error(`Invalid model for api probe: ${modelStr}`);
    }
    const result = await probeConfigViaApi(apiHandle, config, workerIdx, {
      timeoutMs,
      probeExitIp: async ({ socksUri, timeoutMs: tm }) => testProxyExitIpWithUri(socksUri, tm),
      probeModel: async ({ socksUri, timeoutMs: tm }) =>
        probeModelViaChatCore(modelInfo, socksUri, tm),
    });
    // Mirror spawn-mode bookkeeping (testSingleConfigWithModel): persist the
    // measured latency/exit IP on success and the failure marker otherwise, so
    // latency-sorted slices and the rotation pools see api-mode runs too.
    try {
      await updateXrayTestResult(config.id, result.ok
        ? { latencyMs: result.latencyMs, exitIp: result.exitIp, ok: true }
        : { ok: false });
    } catch { /* bookkeeping is best-effort — the probe result still counts */ }
    return result;
  };
}
export { makeApiProbeFn as _makeApiProbeFn }; // for tests

/**
 * Probe the model endpoint through a given SOCKS URI by invoking handleChatCore
 * with a minimal "hi" request, mirroring testSingleConfigWithModel's chat path
 * but without spawning a temp xray (the SOCKS is already routed by api-mode).
 * Returns { ok, status, error }.
 */
async function probeModelViaChatCore(modelInfo, socksUri, timeoutMs) {
  const baseCredentials = await getProviderCredentials(modelInfo.provider, new Set(), modelInfo.model);
  if (!baseCredentials || baseCredentials.allRateLimited) {
    return { ok: false, status: 503, error: "No active credentials for provider" };
  }
  const refreshed = await checkAndRefreshToken(modelInfo.provider, baseCredentials);
  const credentials = {
    ...refreshed,
    providerSpecificData: {
      ...(refreshed.providerSpecificData || {}),
      connectionProxyEnabled: true,
      connectionProxyUrl: socksUri,
      connectionNoProxy: "",
      connectionProxyPoolId: "xray-model-filter-api",
      strictProxy: true,
    },
  };
  const settings = await getSettings();
  const startedAt = Date.now();
  const result = await withProbeTimeout(handleChatCore({
    body: buildModelProbeBody(modelInfo),
    modelInfo,
    credentials,
    log: silentProbeLog,
    clientRawRequest: {
      endpoint: "/api/xray/configs/model-test",
      body: buildModelProbeBody(modelInfo),
      headers: { accept: "application/json", "content-type": "application/json", "x-9r-internal": "xray-model-filter" },
    },
    connectionId: baseCredentials.connectionId,
    userAgent: "9router-xray-model-filter-api/1.0",
    apiKey: null,
    ccFilterNaming: false,
    rtkEnabled: false,
    headroomEnabled: false,
    headroomUrl: settings.headroomUrl || DEFAULT_HEADROOM_URL,
    headroomCompressUserMessages: false,
    cavemanEnabled: false,
    cavemanLevel: "full",
    ponytailEnabled: false,
    ponytailLevel: "full",
    pxpipeEnabled: false,
    pxpipeMinChars: settings.pxpipeMinChars,
    pxpipeTimeoutMs: settings.pxpipeTimeoutMs,
    pxpipeTransform: null,
    providerThinking: null,
    sourceFormatOverride: "openai",
  }), timeoutMs, "api");
  if (!result.success) {
    return { ok: false, status: result.status || 502, error: result.error || "probe failed" };
  }
  if (!result.response.ok) {
    // An HTTP response arrived through the tunnel — the config itself works;
    // the rejection is upstream (429 quota / 403 fingerprint / model gate).
    // Prune policy must keep such configs — they recover when the upstream
    // condition clears (e.g. free-tier quota resets on the shared exit IP).
    const text = await result.response.text().catch(() => "");
    return { ok: false, tunnelOk: true, status: result.response.status, error: summarizeProbeBody(text) || `HTTP ${result.response.status}` };
  }
  return { ok: true, status: result.response.status, error: null, _ttft: Date.now() - startedAt };
}

export async function filterConfigsByModel({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 2, pauseOnTraffic = true, quietMs = 15000, onProgress = null, forceRetest = false } = {}) {
  const configs = await getXrayConfigs({ isActive: true });
  // Resolve model info up front — api-mode needs it to build probe credentials.
  const modelInfo = await getModelInfo(model).catch(() => null);
  const settings = await getSettings();
  const runningActiveConfigId = getManagedPid()
    ? (state.activeConfigId || settings.xraySelectedConfigId || null)
    : null;
  const normalized = normalizeModelFilterLimit({ limit, all });

  // Cache layer: configs with a fresh cached result for this model are reused
  // instead of re-probed. forceRetest bypasses the cache entirely (the caller
  // also clears the model's cache before invoking). The cache key is the
  // (configId, model) pair — configId is a sha1 of the canonical link, so a
  // config whose underlying server/credentials change is naturally a new id
  // and therefore a fresh cache entry.
  //
  // Two freshness knobs (settings, in hours, 0 = legacy/forever):
  //  - xrayModelFilterCacheTtlH: a SUCCESS row older than this is re-tested.
  //  - xrayModelFilterRetryFailAfterH: a FAIL row older than this is retried,
  //    so a server that was temporarily down isn't blacklisted forever.
  // Bypass the cache entirely when forceRetest or prune is on:
  //  - forceRetest: caller already cleared this model's cache; nothing to hit.
  //  - prune: destructive mode — always re-probe fresh so maybePruneConfig
  //    gets the chance to run on every selected config. Otherwise a cached
  //    failed row would be reused and silently skip deletion.
  const useCache = !forceRetest && !prune;
  const cacheTtlMs = (Number(settings.xrayModelFilterCacheTtlH) || 0) * 3600 * 1000;
  // For the cache lookup, honor the success TTL: rows older than cacheTtlMs are
  // excluded entirely. Failed-row retry is handled separately below (fail rows
  // within retryFailAfterH are NOT in the success-TTL-gated map, so they'll be
  // treated as "to test" naturally; but fail rows older than the success TTL
  // would also drop out — which is fine, they need re-test anyway).
  const retryFailMs = (Number(settings.xrayModelFilterRetryFailAfterH) || 0) * 3600 * 1000;
  // Build TWO maps: success-only (for reuse), and all-recent (for fail-retry gating).
  // For reuse we want successes that are still within the success TTL.
  // For fail-retry we need to know which fails are old enough to re-test.
  // Maps are built over the FULL catalog, not the slice: the slice ranking
  // below needs per-config freshness to rank probe-starved configs first.
  const configIds = configs.map((c) => c.id);
  const reuseMap = useCache
    ? await getModelFilterResultsByConfigIds(configIds, model, {
        maxAgeMs: cacheTtlMs > 0 ? cacheTtlMs : 0,
      })
    : new Map();
  const failMap = useCache
    ? await getModelFilterResultsByConfigIds(configIds, model, { maxAgeMs: 0 })
    : new Map();

  const now = Date.now();
  const isFailRetryDue = (configId) => {
    if (retryFailMs <= 0) return false; // policy disabled
    const row = failMap.get(configId);
    if (!row || row.ok) return false;
    const testedAt = row.testedAt ? Date.parse(row.testedAt) : 0;
    if (!testedAt) return true; // unparseable/missing timestamp → re-test
    return now - testedAt >= retryFailMs;
  };

  // True when this pass would actually probe the config: no fresh success
  // cache, and fail rows only when their retry policy is due. Shared by the
  // slice ranking and the toTest filter so the two can never drift.
  const isDueForProbe = (config) => {
    if (reuseMap.get(config.id)?.ok) return false; // reused
    const anyRow = failMap.get(config.id);
    if (!anyRow) return true; // never tested
    if (anyRow.ok) return true; // success but expired past TTL
    return isFailRetryDue(config.id); // fail: only when retry policy due
  };

  // Slice ranking (limit mode), three tiers: never-filter-tested configs come
  // FIRST — a newly synced subscription's untested servers must not wait
  // behind a backlog of stale-but-previously-measured entries (latency asc
  // sinks untested to the bottom of the raw order), or they never enter the
  // tested set and never reach the rotation pools. Stale/retry-due configs
  // follow, fresh-cache last. Ties keep the getXrayConfigs order; with no
  // backlog and nothing stale this reduces to the legacy slice.
  const rankForSelection = (config) => {
    if (!failMap.has(config.id)) return 0; // never filter-tested for this model
    return isDueForProbe(config) ? 1 : 2;
  };
  const selected = normalized.all
    ? configs
    : orderConfigsForFilterSelection(configs, rankForSelection).slice(0, normalized.limit);

  const results = [];
  for (const config of selected) {
    const cached = reuseMap.get(config.id);
    // Only reuse SUCCESS rows whose TTL is still valid. Fail rows are never
    // reused — they're either re-tested (if retry due) or skipped this pass.
    if (!cached || !cached.ok) continue;
    const result = {
      configId: config.id,
      name: config.name,
      host: config.host,
      country: config.country,
      ok: cached.ok,
      latencyMs: cached.latencyMs,
      status: cached.status,
      exitIp: cached.exitIp,
      error: cached.error,
      cached: true,
      testedAt: cached.testedAt,
    };
    results.push(result);
    onProgress?.(result);
  }
  // Re-test: same predicate as the slice ranking, so the two never drift.
  let toTest = selected.filter(isDueForProbe);

  // When every selected config is cached (toTest empty) the worker pool is a
  // no-op; keep at least 1 worker so the pool initializes harmlessly.
  const workerCount = Math.min(normalizeModelFilterConcurrency(concurrency), toTest.length || 1);
  let cursor = 0;

  const maybePruneConfig = async (config, result) => {
    const decision = shouldPruneFilterResult(result, { prune, runningActiveConfigId, configId: config.id });
    if (!decision.prune) {
      // Only the active-config case sets pruneSkipped (which also suppresses
      // recordCache — correct there: the running config's own result is
      // already known live). Every other kept config must fall through to
      // recordCache: an upstream-rejected row (ok=false, status=429) is
      // exactly what tells rotation "skip this exit for now" and paces
      // re-tests via the fail-retry policy. With prune disabled this is the
      // ONLY path that persists the whole quota map — never flag it.
      if (decision.reason === "active_config_running") {
        return { ...result, pruned: false, pruneSkipped: "active_config_running" };
      }
      return { ...result, pruned: false };
    }
    await hardDeleteXrayConfig(config.id);
    // Cascade: the config row is gone, so its cache entries are meaningless.
    await deleteModelFilterResultsByConfigIds([config.id]).catch(() => {});
    return { ...result, pruned: true };
  };

  // Persist a fresh probe result so subsequent runs (incl. after a restart or
  // re-sync that leaves the config unchanged) can skip it. Skipped when the
  // config was pruned — the row no longer exists. Awaited so the post-job
  // cache-stats snapshot reflects this run's writes.
  const recordCache = async (config, result) => {
    if (result.pruned === true || result.pruneSkipped) return;
    try {
      await upsertModelFilterResult({
        configId: config.id,
        model,
        ok: !!result.ok,
        latencyMs: result.latencyMs,
        status: result.status,
        exitIp: result.exitIp,
        error: result.error,
      });
    } catch {
      // cache write failure is non-fatal — next run will re-probe
    }
  };

  const testConfig = async (config, probeFn, workerIdx) => {
    const shouldPauseForTraffic = () => (modelFilterRunning ? modelFilterState.pauseOnTraffic : pauseOnTraffic === true);
    // A stop request also breaks the traffic-quiet wait so a cancelled job
    // doesn't sit idle for up to 10 min waiting for traffic to clear.
    const shouldContinueWait = () => shouldPauseForTraffic() && !modelFilterCancelRequested;
    if (shouldContinueWait()) {
      modelFilterState.trafficWaiters += 1;
      try {
        await waitForLiveTrafficQuiet({
          quietMs: modelFilterRunning ? modelFilterState.quietMs : quietMs,
          maxWaitMs: 10 * 60 * 1000,
          shouldContinue: shouldContinueWait,
        });
      } finally {
        modelFilterState.trafficWaiters = Math.max(0, modelFilterState.trafficWaiters - 1);
      }
    }
    // If a stop came in while waiting for traffic, skip the probe for this
    // config — it stays untested and will be picked up on the resume run.
    if (modelFilterCancelRequested) return;
    try {
      const probe = await probeFn(config, workerIdx);
      let result = { configId: config.id, name: config.name, host: config.host, country: config.country, ...probe };
      result = await maybePruneConfig(config, result);
      results.push(result);
      await recordCache(config, result);
      onProgress?.(result);
    } catch (error) {
      let failed = {
        configId: config.id,
        name: config.name,
        host: config.host,
        country: config.country,
        ok: false,
        latencyMs: -1,
        status: null,
        error: error.message,
      };
      await updateXrayTestResult(config.id, { ok: false }).catch(() => {});
      failed = await maybePruneConfig(config, failed);
      results.push(failed);
      await recordCache(config, failed);
      onProgress?.(failed);
    }
  };

  // Probe function + filter-xray lifecycle. api-mode keeps one long-lived xray
  // and swaps outbounds via the gRPC API; spawn-mode spawns a fresh temp xray
  // per config. api-mode falls back to spawn if the filter instance can't start
  // (binary too old, port conflict, etc.). forceRetest/prune always use spawn
  // mode (they need fully isolated temp xray state).
  const wantApiMode = settings.xrayFilterMode === "api" && !forceRetest && !prune;
  let apiHandle = null;
  let probeFn = null;
  let apiMode = false;
  if (wantApiMode) {
    try {
      apiHandle = await startFilterXray({
        socksPort: Number(settings.xrayFilterApiSocksPort) || 53080,
        apiPort: Number(settings.xrayFilterApiPort) || 15491,
        accountCount: Math.min(Math.max(Number(settings.xrayFilterApiAccounts) || 16, 1), Math.max(workerCount, 1)),
      });
      probeFn = makeApiProbeFn(apiHandle, modelInfo, model, timeoutMs);
      apiMode = true;
      console.log(`[Xray] model filter running in api-mode (socks=${apiHandle.socksPort} api=${apiHandle.apiPort} pid=${apiHandle.pid})`);
    } catch (e) {
      console.warn(`[Xray] api-mode filter start failed, falling back to spawn mode: ${e.message}`);
      apiHandle = null;
    }
  }
  if (!apiMode) {
    probeFn = (config) => testSingleConfigWithModel(config.id, { model, timeoutMs });
  }

  const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
    while (cursor < toTest.length && !modelFilterCancelRequested) {
      const index = cursor;
      cursor += 1;
      await testConfig(toTest[index], probeFn, workerIdx);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    if (apiHandle) {
      await stopFilterXray(apiHandle).catch(() => {});
    }
  }

  const cancelled = modelFilterCancelRequested;
  const cachedCount = results.filter((r) => r.cached).length;
  return {
    model,
    all: normalized.all,
    limit: normalized.all ? "all" : normalized.limit,
    concurrency: workerCount,
    filterMode: apiMode ? "api" : "spawn",
    tested: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    pruned: results.filter((r) => r.pruned === true).length,
    pruneSkipped: results.filter((r) => r.pruneSkipped).length,
    cached: cachedCount,
    cancelled,
    results,
  };
}

export async function runModelFilterJob({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 2, pauseOnTraffic = true, quietMs = 15000, source = "manual", forceRetest = false, queueRerunIfBusy = false } = {}) {
  if (modelFilterRunning) {
    if (queueRerunIfBusy) {
      // Auto trigger lost the race: latch ONE coalesced follow-up (the running
      // job re-runs from the latest saved settings when it settles) and record
      // the skip for the dashboard instead of dropping it into the console.
      autoFilterRerunQueued = true;
      Object.assign(modelFilterState, {
        autoFilterSkipReason: "already_running",
        autoFilterSkipAt: new Date().toISOString(),
      });
    }
    return { skipped: true, reason: "already_running", ...getModelFilterStatus() };
  }

  const normalized = normalizeModelFilterLimit({ limit, all });
  const normalizedConcurrency = normalizeModelFilterConcurrency(concurrency);
  const job = (async () => {
    modelFilterCancelRequested = false;
    Object.assign(modelFilterState, {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      source,
      model,
      all: normalized.all,
      limit: normalized.all ? "all" : normalized.limit,
      prune: prune === true,
      concurrency: normalizedConcurrency,
      pauseOnTraffic: pauseOnTraffic === true,
      quietMs,
      tested: 0,
      passed: 0,
      failed: 0,
      pruned: 0,
      cached: 0,
      trafficWaiters: 0,
      error: null,
      autoFilterSkipReason: null,
      autoFilterSkipAt: null,
    });

    try {
      // forceRetest wipes the cache for this model so every selected config is
      // re-probed fresh. Done before the probe loop so the splitter in
      // filterConfigsByModel finds nothing to skip.
      if (forceRetest) await clearModelFilterResultsByModel(model).catch(() => {});
      await refreshModelFilterCacheStats();

      const result = await filterConfigsByModel({
        model,
        limit: normalized.limit,
        all: normalized.all,
        prune,
        timeoutMs,
        concurrency: normalizedConcurrency,
        pauseOnTraffic,
        quietMs,
        forceRetest,
        onProgress: (result) => {
          modelFilterState.tested += 1;
          if (result.cached) modelFilterState.cached += 1;
          if (result.ok) modelFilterState.passed += 1;
          else modelFilterState.failed += 1;
          if (result.pruned === true) modelFilterState.pruned += 1;
        },
      });
      Object.assign(modelFilterState, {
        status: result.cancelled ? "cancelled" : "done",
        finishedAt: new Date().toISOString(),
        tested: result.tested,
        passed: result.passed,
        failed: result.failed,
        pruned: result.pruned,
        cached: result.cached,
        trafficWaiters: 0,
        error: null,
      });
      return result;
    } catch (error) {
      Object.assign(modelFilterState, {
        status: "error",
        finishedAt: new Date().toISOString(),
        trafficWaiters: 0,
        error: error.message,
      });
      throw error;
    } finally {
      modelFilterRunning = null;
      modelFilterCancelRequested = false;
      await refreshModelFilterCacheStats();
    }
  })();

  modelFilterRunning = job;
  // Consume the coalesced re-run latch when this job settles. A job may error
  // (rejection) — the latch must still fire, hence the swallowing catch; the
  // original caller still receives the rejection via `job` itself.
  job
    .catch(() => {})
    .then(async () => {
      if (!autoFilterRerunQueued || modelFilterRunning) return;
      autoFilterRerunQueued = false;
      // The dashboard line promises "re-runs once the running filter
      // finishes" — clear it now. If the re-run itself re-latches (busy), the
      // skip path re-stamps a fresh reason/at.
      Object.assign(modelFilterState, { autoFilterSkipReason: null, autoFilterSkipAt: null });
      try {
        const rerun = await runModelFilterFromSettings("auto-sync-rerun");
        if (rerun?.skipped) {
          console.log(`[XrayFilter] auto rerun skipped: ${rerun.reason || "unknown"}`);
        }
      } catch (error) {
        console.error("[XrayFilter] auto rerun failed:", error.message);
      }
    });
  return job;
}

export function _setModelFilterRunningForTests(jobPromise) {
  modelFilterRunning = jobPromise;
  autoFilterRerunQueued = false; // isolate tests from each other's latches
}
export function _getAutoFilterRerunQueuedForTests() {
  return autoFilterRerunQueued;
}

export async function runModelFilterFromSettings(source = "auto-sync") {
  const settings = await getSettings();
  if (settings.xrayModelFilterEnabled !== true) return { skipped: true, reason: "disabled" };
  const model = String(settings.xrayModelFilterModel || "").trim();
  if (!model) return { skipped: true, reason: "missing_model" };
  return runModelFilterJob({
    model,
    limit: settings.xrayModelFilterLimit,
    all: settings.xrayModelFilterAll === true,
    prune: settings.xrayModelFilterPrune === true,
    concurrency: Number(settings.xrayModelFilterConcurrency) || 2,
    pauseOnTraffic: settings.xrayModelFilterPauseOnTraffic !== false,
    quietMs: Number(settings.xrayModelFilterQuietMs) || 15000,
    timeoutMs: Number(settings.xrayModelFilterTimeoutMs) || 20000,
    source,
    // Sync-triggered runs coalesce instead of vanishing when a filter is
    // already running (manual UI runs pass no flag and only report the skip).
    queueRerunIfBusy: true,
  });
}

/**
 * Periodic health check of the active proxy + a sample of alternatives.
 * Updates latency rankings so the UI can recommend fast servers. If the
 * active server is dead and autoRotate is on, switches to the next best.
 */
export async function runHealthCheck() {
  const settings = await getSettings();
  // Recover from HMR: if the in-memory state was reset but a managed pid is
  // alive, treat the service as running and read the port from settings.
  const pid = getManagedPid();
  if (!pid) return { skipped: true };
  const socksPort = await getActiveSocksPort();
  const activeConfigId = state.activeConfigId || settings.xraySelectedConfigId || null;
  if (state.status === "stopped") setStatus("running", { pid, socksPort, activeConfigId });

  // Probe the active server.
  const latencyMs = await testProxyLatency(socksPort);
  state.lastHealthAt = new Date().toISOString();
  // Rotation outcome (visible to the phase-07 health scheduler, which maps a
  // total rotation failure to the xray-rotation-failed alert).
  let rotatedTo = null;
  let rotationError;
  if (latencyMs > 0 && activeConfigId) {
    state.lastHealth = { latencyMs, exitIp: state.lastHealth?.exitIp || "" };
    await updateXrayTestResult(activeConfigId, { latencyMs, ok: true });
  } else if (activeConfigId) {
    await updateXrayTestResult(activeConfigId, { ok: false });
    state.lastHealth = null;
    try {
      emitAlert(EVENT_TYPES.XRAY_NODE_DOWN, {
        severity: SEVERITY.CRITICAL,
        dedupKey: String(activeConfigId),
        title: "Active xray node down",
        body: `Health probe failed for the active node (${activeConfigId}) on port ${socksPort}.`,
      });
    } catch { /* alerts must never break the health check */ }
    // Auto-rotate to the next healthy server if enabled (X6): a candidate
    // whose switch fails is downgraded and the NEXT candidate is tried —
    // bounded at MAX_ROTATE_ATTEMPTS. If every candidate fails, keep the
    // current active node serving (never deactivate the whole cluster).
    if (settings.xrayAutoRotate) {
      const MAX_ROTATE_ATTEMPTS = 5;
      const all = await getXrayConfigs({ isActive: true, healthyOnly: false });
      const candidates = all.filter((c) => c.id !== activeConfigId).slice(0, MAX_ROTATE_ATTEMPTS);
      for (const next of candidates) {
        try {
          console.log(`[Xray] active server unhealthy, auto-rotating to ${next.name}`);
          await switchConfig(next.id);
          rotatedTo = next.id;
          break;
        } catch (e) {
          console.warn(`[Xray] auto-rotation to ${next.name} failed (${e.message}) — downgrading candidate, trying next`);
          try { await updateXrayTestResult(next.id, { ok: false }); } catch { /* best-effort */ }
        }
      }
      if (!rotatedTo) {
        const msg = `auto-rotation failed for all ${candidates.length} candidate(s); keeping current active node`;
        console.error(`[Xray] ${msg}`);
        setStatus("error", { lastError: msg });
        // Only a FAILED ATTEMPTED rotation is a rotation failure — a
        // single-node install (no candidates) must not alert on every tick.
        if (candidates.length > 0) rotationError = msg;
      }
    }
  }
  return {
    latencyMs,
    activeConfigId,
    rotatedTo,
    rotationFailed: rotationError !== undefined,
    rotationError,
  };
}

// ─── binary update orchestration (RT-5) ───────────────────────────────────
//
// installXray is a download/verify/swap lib; THIS owns the operational
// safety: single-flight install lock, quiescing rotations/draining/temp
// probes before the swap, capturing whether the proxy was running, and
// auto-rollback to `.prev` when the post-install restart fails.

const installLock = (global.__xrayInstallLock ??= { busy: false });

export function isInstallInFlight() {
  return installLock.busy;
}

/**
 * Install (or upgrade/downgrade to) an xray version with full orchestration.
 * Never concurrent: a second call while one is in flight rejects with
 * code INSTALL_IN_PROGRESS (route → 409).
 *
 * @returns {{ installed: true, version, path, alreadyInstalled?, restarted, rolledBack?, restartError? }}
 */
export async function installXrayOrchestrated({ version, onProgress } = {}) {
  if (installLock.busy) {
    const e = new Error("an xray install is already in progress");
    e.code = "INSTALL_IN_PROGRESS";
    throw e;
  }
  installLock.busy = true;

  // pauseXrayHealthCheck mutates scheduler state; keep a settings snapshot
  // around so resume can re-arm with the same cadence.
  let healthSettings = null;
  try {
    const { pauseXrayHealthCheck, resumeXrayHealthCheck } = await import("./healthScheduler.js");
    const { killTempXrayProcesses } = await import("./reaper.js");
    const { getDrainingPids, terminateXrayPid, removeDrainingPid } = await import("./process.js");
    const { rollbackXrayToPrev } = await import("./installer.js");

    try {
      healthSettings = await getSettings();
      pauseXrayHealthCheck();
    } catch { /* scheduler pause best-effort */ }

    // Quiesce: blue-green retirees (up to 3 xray processes can coexist for
    // the 90s drain window) and cmdline-verified temp probe/filter instances
    // — all spawned from the SAME BINARY_PATH the swap replaces. Windows
    // refuses to rename a running .exe; never leave stragglers holding it.
    for (const entry of getDrainingPids()) {
      try {
        await terminateXrayPid(entry.pid);
        removeDrainingPid(entry.pid);
      } catch { /* best-effort per pid */ }
    }
    try { killTempXrayProcesses(); } catch { /* best-effort */ }

    const wasRunning = Boolean(getStatus().pid);

    let result;
    try {
      result = await installXray({ version, onProgress });
    } catch (e) {
      // Swap already failed → restore from .prev is handled inside the
      // installer; nothing running to restart here.
      throw e;
    }

    const response = { ...result, restarted: false };
    if (!wasRunning) return response;

    // A previously-running proxy comes back automatically. If the NEW binary
    // can't start, roll back to `.prev` and retry once — then report
    // honestly which state the user is in.
    try {
      await restartXrayService();
      response.restarted = true;
      return response;
    } catch (restartErr) {
      response.restartError = restartErr.message;
      try {
        if (rollbackXrayToPrev()) {
          response.rolledBack = true;
          response.version = getInstalledVersion() || result.version;
          try {
            await restartXrayService();
            response.restarted = true;
          } catch (retryErr) {
            response.restartError = retryErr.message;
            response.restarted = false;
          }
          return response;
        }
      } catch (rbErr) {
        response.restartError = rbErr.message;
      }
      // Rollback unavailable or failed: report the broken state honestly.
      response.restarted = false;
      return response;
    }
  } finally {
    try {
      if (healthSettings) {
        const { resumeXrayHealthCheck } = await import("./healthScheduler.js");
        resumeXrayHealthCheck(healthSettings);
      }
    } catch { /* resume best-effort */ }
    installLock.busy = false;
  }
}

/**
 * One-click rollback to the `.prev` binary retained by the last install
 * (RT-5) — the user-facing path for "the new binary breaks my config". The
 * install route accepts any older tag, but the release picker only lists
 * recent releases, while `.prev` is always the exact binary that ran before.
 * Shares the install single-flight lock: a rollback racing an install would
 * swap files under each other.
 *
 * @returns {{ rolledBack: true, version, restarted, restartError? }}
 */
export async function rollbackXrayOrchestrated() {
  if (installLock.busy) {
    const e = new Error("an xray install is already in progress");
    e.code = "INSTALL_IN_PROGRESS";
    throw e;
  }
  installLock.busy = true;

  // pauseXrayHealthCheck mutates scheduler state; keep a settings snapshot
  // around so resume can re-arm with the same cadence.
  let healthSettings = null;
  try {
    const { pauseXrayHealthCheck, resumeXrayHealthCheck } = await import("./healthScheduler.js");
    const { killTempXrayProcesses } = await import("./reaper.js");
    const {
      getDrainingPids, terminateXrayPid, removeDrainingPid,
      getManagedPid, setManagedPid,
    } = await import("./process.js");
    const { rollbackXrayToPrev, getPrevXrayVersion } = await import("./installer.js");

    if (!getPrevXrayVersion()) {
      const e = new Error("no previous version retained (.prev is empty) — pick a specific older version from the dropdown instead");
      e.code = "NO_PREV";
      throw e;
    }

    try {
      healthSettings = await getSettings();
      pauseXrayHealthCheck();
    } catch { /* scheduler pause best-effort */ }

    // Same quiesce as an install: blue-green retirees and cmdline-verified
    // temp probes all run the SAME BINARY_PATH the restore replaces, and
    // Windows refuses to rename a running .exe.
    for (const entry of getDrainingPids()) {
      try {
        await terminateXrayPid(entry.pid);
        removeDrainingPid(entry.pid);
      } catch { /* best-effort per pid */ }
    }
    try { killTempXrayProcesses(); } catch { /* best-effort */ }

    const wasRunning = Boolean(getStatus().pid);
    const runningPid = getManagedPid();
    if (runningPid) {
      try {
        await terminateXrayPid(runningPid);
        setManagedPid(null);
      } catch { /* stale/unstoppable pid — proceed with the file swap */ }
    }

    if (!rollbackXrayToPrev()) {
      const e = new Error("rollback failed — .prev restore did not complete");
      e.code = "ROLLBACK_FAILED";
      throw e;
    }

    const response = { rolledBack: true, version: getInstalledVersion(), restarted: false };
    if (!wasRunning) return response;
    // The proxy was up before the rollback — bring it back on the restored
    // binary. A failure here is reported (restartError), not retried: the
    // files ARE the pre-update state the user asked for.
    try {
      await restartXrayService();
      response.restarted = true;
    } catch (restartErr) {
      response.restartError = restartErr.message;
    }
    return response;
  } finally {
    try {
      if (healthSettings) {
        const { resumeXrayHealthCheck } = await import("./healthScheduler.js");
        resumeXrayHealthCheck(healthSettings);
      }
    } catch { /* resume best-effort */ }
    installLock.busy = false;
  }
}

export { installXray, getXrayRuntimeVersion, getXrayLogTail, getXraySyncState };
export { MANAGED_POOL_ID };
