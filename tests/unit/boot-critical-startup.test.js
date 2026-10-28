// Boot-critical startup (audit F2): the must-run-every-boot set (reapers,
// connection cleanup, auto-resumes) must be single-flight and must drive the
// auto-starts — and the shutdown-handler registration must be idempotent so
// instrumentation.register() and the layout-driven initializeApp() can both
// call it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  cleanupProviderConnections: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => {}),
}));
vi.mock("@/lib/tunnel", () => ({
  enableTunnel: vi.fn(async () => {}),
  enableTailscale: vi.fn(async () => {}),
  isTunnelManuallyDisabled: vi.fn(() => false),
  isTunnelReconnecting: vi.fn(() => false),
  isTailscaleReconnecting: vi.fn(() => false),
  getTunnelService: vi.fn(() => ({ cancelToken: { cancelled: false }, spawnInProgress: false, lastRestartAt: 0 })),
  getTailscaleService: vi.fn(() => ({ cancelToken: { cancelled: false }, spawnInProgress: false, lastRestartAt: 0 })),
  setTunnelUnexpectedExitCallback: vi.fn(),
  killCloudflared: vi.fn(),
  isCloudflaredRunning: vi.fn(() => false),
  ensureCloudflared: vi.fn(async () => {}),
  isTailscaleRunning: vi.fn(() => false),
  isTailscaleRunningStrict: vi.fn(async () => false),
  isDaemonAlive: vi.fn(() => false),
  startFunnel: vi.fn(async () => {}),
  checkInternet: vi.fn(async () => false),
  RESTART_COOLDOWN_MS: 30000,
  NETWORK_SETTLE_MS: 1000,
  WATCHDOG_INTERVAL_MS: 60000,
  NETWORK_CHECK_INTERVAL_MS: 15000,
  VIRTUAL_IFACE_REGEX: /^(lo|tun|tap|docker)/i,
}));
vi.mock("@/mitm/manager", () => ({
  getMitmStatus: vi.fn(async () => ({ running: false })),
  startMitm: vi.fn(async () => {}),
  loadEncryptedPassword: vi.fn(async () => null),
  initDbHooks: vi.fn(),
  restoreToolDNS: vi.fn(async () => {}),
  removeAllDNSEntriesSync: vi.fn(),
}));
vi.mock("@/lib/mitmAliasCache", () => ({ syncToJson: vi.fn(async () => {}) }));
vi.mock("@/lib/ds2api/install", () => ({ getInstallStatus: vi.fn(() => ({ installed: false })) }));
vi.mock("@/lib/ds2api/lifecycle", () => ({ startManagedDS2API: vi.fn(async () => ({ pid: 1, injection: {} })) }));
vi.mock("@/lib/ds2api/process", () => ({
  reapOrphanedManagedDS2API: vi.fn(async () => ({ killed: false, reason: "not_running" })),
  stopDS2API: vi.fn(() => ({ stopped: false, reason: "not_running" })),
}));
vi.mock("@/lib/headroom/process", () => ({
  reapOrphanedManagedHeadroom: vi.fn(async () => ({ killed: false, reason: "not_running" })),
  stopHeadroomProxy: vi.fn(() => ({ stopped: false, reason: "not_running" })),
  startHeadroomProxy: vi.fn(async () => ({ pid: 424242, alreadyRunning: false })),
}));
vi.mock("@/lib/headroom/detect", () => ({ findHeadroomBinary: vi.fn(() => "/fake/headroom") }));
vi.mock("@/lib/ds2api/detect", () => ({
  DEFAULT_DS2API_URL: "http://127.0.0.1:5001",
  isLoopbackDS2APIUrl: vi.fn(() => true),
}));
vi.mock("@/lib/mcp/stdioSseBridge", () => ({ killAllBridges: vi.fn() }));
vi.mock("@/lib/xray/process.js", () => ({ stopXray: vi.fn(() => ({ stopped: false, reason: "not_running" })) }));
vi.mock("open-sse/services/browserPool.js", () => ({ shutdownPool: vi.fn(async () => {}) }));
vi.mock("open-sse/services/obscura.js", () => ({ killSharedObscuraServer: vi.fn() }));
vi.mock("open-sse/services/virtualDisplay.js", () => ({ stopVirtualDisplay: vi.fn() }));
vi.mock("@/lib/xray/reaper.js", () => ({ reapOrphanedTempProbes: vi.fn(async () => ({ unlinked: 0, killed: 0, drainedKilled: 0 })) }));
vi.mock("@/lib/xray/installer.js", () => ({ isXrayInstalled: vi.fn(() => true) }));
vi.mock("@/lib/xray/manager.js", () => ({
  startXrayService: vi.fn(async () => ({ pid: 424243, configId: "cfg" })),
  stopXrayService: vi.fn(async () => ({ stopped: false, reason: "not_running" })),
}));

beforeEach(() => {
  // The module keeps its singleton on global.__appSingleton — reset it (and
  // the module registry) so each test starts from a cold boot.
  delete global.__appSingleton;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importModule() {
  return import("../../src/shared/services/initializeApp.js");
}

describe("runBootCriticalTasks (F2: must-run-every-boot set)", () => {
  it("runs the boot-critical work exactly once even when both instrumentation and the layout path call it", async () => {
    const mod = await importModule();
    await mod.runBootCriticalTasks();
    await mod.runBootCriticalTasks();

    const localDb = await import("@/lib/localDb");
    const reaper = await import("@/lib/xray/reaper.js");
    const ds2apiProcess = await import("@/lib/ds2api/process");
    const headroomProcess = await import("@/lib/headroom/process");

    expect(localDb.cleanupProviderConnections).toHaveBeenCalledTimes(1);
    expect(reaper.reapOrphanedTempProbes).toHaveBeenCalledTimes(1);
    expect(ds2apiProcess.reapOrphanedManagedDS2API).toHaveBeenCalledTimes(1);
    expect(headroomProcess.reapOrphanedManagedHeadroom).toHaveBeenCalledTimes(1);
  });

  it("auto-starts xray and headroom when enabled, skips them when disabled", async () => {
    const settingsRepo = await import("@/lib/localDb");
    const mod = await importModule();

    // Disabled (default {}): neither auto-start fires.
    await mod.runBootCriticalTasks();
    let manager = await import("@/lib/xray/manager.js");
    let headroom = await import("@/lib/headroom/process");
    expect(manager.startXrayService).not.toHaveBeenCalled();
    expect(headroom.startHeadroomProxy).not.toHaveBeenCalled();

    // Fresh boot (reset singleton + modules) with both enabled.
    delete global.__appSingleton;
    vi.resetModules();
    // Re-grab the settings mock AFTER resetModules — the factory re-ran, so
    // the pre-reset instance's mockResolvedValue no longer applies.
    const settingsFresh = await import("@/lib/localDb");
    settingsFresh.getSettings.mockResolvedValue({ xrayEnabled: true, xrayAutoStart: true, headroomEnabled: true });
    const mod2 = await importModule();
    await mod2.runBootCriticalTasks();
    // autoStartXray/autoStartHeadroom are fire-and-forget inside the boot
    // set — wait for them to land instead of racing the microtask queue.
    manager = await import("@/lib/xray/manager.js");
    headroom = await import("@/lib/headroom/process");
    await vi.waitFor(() => expect(manager.startXrayService).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(headroom.startHeadroomProxy).toHaveBeenCalledTimes(1));
  });
});

describe("registerShutdownHandlers (F3: signal handlers must exist on headless boots)", () => {
  it("registers SIGINT/SIGTERM/exit handlers exactly once across repeated calls", async () => {
    const mod = await importModule();
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    mod.registerShutdownHandlers();
    mod.registerShutdownHandlers();

    const signals = onSpy.mock.calls.map(([event]) => event).sort();
    expect(signals).toEqual(["SIGINT", "SIGTERM", "exit"]);
    onSpy.mockRestore();
  });

  // v0.6.72 SIGTERM-race regression: Next's own SIGTERM handler can call
  // process.exit() while our async cleanup is still awaiting its first
  // dynamic import. The xray stop must therefore run SYNCHRONOUSLY inside
  // the handler — before any await — or it never runs on a headless box.
  it("stops xray synchronously in the SIGTERM handler, before the async tail", async () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);

    const mod = await importModule();
    mod.registerShutdownHandlers();
    const handler = onSpy.mock.calls.find(([event]) => event === "SIGTERM")[1];
    onSpy.mockRestore();

    handler();

    // Synchronous section: no awaits have run yet, and the stop already fired.
    const xrayProcess = await import("@/lib/xray/process.js");
    expect(xrayProcess.stopXray).toHaveBeenCalledTimes(1);
    const tunnelMocks = await import("@/lib/tunnel");
    expect(tunnelMocks.killCloudflared).toHaveBeenCalledTimes(1);

    // Async best-effort tail settles afterwards (bounded), then exits once.
    await new Promise((r) => setTimeout(r, 30));
    const manager = await import("@/lib/xray/manager.js");
    expect(manager.stopXrayService).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});
