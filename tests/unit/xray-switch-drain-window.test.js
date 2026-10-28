// Regression tests for the blue-green switch crash window (audit F1):
//
//  1. The OLD instance must be registered in the draining FILE at the moment
//     the candidate takes over the PID file — not seconds later after the
//     readiness/health/promotion sequence. A crash or kill -9 inside that
//     window used to orphan the old instance holding 10808/10809 with no
//     reaper able to find it.
//  2. A failed candidate must UN-register the old instance again (rollback
//     restores it as the active one — a leftover drain entry would get the
//     live proxy killed by the boot reaper after a restart).
//  3. stopXrayService must also terminate file-registered draining pids that
//     were never scheduled in memory (crash leftovers), not just the
//     in-memory map.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => importOriginal());
vi.mock("../../src/lib/xray/configBuilder.js", () => ({
  buildClientConfig: vi.fn(() => ({})),
  validateLink: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../src/lib/xray/reaper.js", () => ({ reapOrphanedTempProbes: vi.fn() }));
vi.mock("../../src/lib/xray/parser.js", () => ({ convertLink: vi.fn() }));
vi.mock("../../src/lib/xray/installer.js", () => ({
  isXrayInstalled: vi.fn(() => true),
  getXrayConfigPath: vi.fn(),
  getXrayBinaryPath: vi.fn(() => "/tmp/xray/xray"),
  getInstalledVersion: vi.fn(() => null),
  getXrayRuntimeVersion: vi.fn(async () => null),
  installXray: vi.fn(),
  getXrayDir: vi.fn(),
}));
vi.mock("../../src/lib/xray/process.js", () => ({
  startManagedXray: vi.fn(),
  stopXray: vi.fn(() => ({ stopped: false })),
  getManagedPid: vi.fn(() => null),
  getVerifiedManagedPid: vi.fn(() => null),
  getXrayLogTail: vi.fn(() => ""),
  spawnTempXray: vi.fn(),
  spawnNextManagedXray: vi.fn(),
  setManagedPid: vi.fn(),
  terminateXrayPid: vi.fn(async () => {}),
  getDrainingPids: vi.fn(() => []),
  addDrainingPid: vi.fn(),
  removeDrainingPid: vi.fn(),
}));
vi.mock("../../src/lib/xray/tester.js", () => ({
  testProxy: vi.fn(),
  testProxyLatency: vi.fn(async () => 0),
  isSocksPortOpen: vi.fn(async () => true),
  testProxyExitIpWithUri: vi.fn(),
  waitForSocksPortOpen: vi.fn(async () => false),
}));
vi.mock("../../src/lib/xray/apiFilter.js", () => ({
  startFilterXray: vi.fn(),
  stopFilterXray: vi.fn(),
  probeConfigViaApi: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => null),
  getXrayConfigById: vi.fn(async () => null),
  setSelectedXrayConfig: vi.fn(async () => {}),
  updateXrayTestResult: vi.fn(async () => {}),
  getXrayConfigs: vi.fn(async () => []),
  getXraySyncState: vi.fn(async () => ({})),
  deleteXrayConfig: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getModelFilterResultsByConfigIds: vi.fn(async () => []),
  getModelFilterCacheStats: vi.fn(async () => ({})),
  upsertModelFilterResult: vi.fn(),
  clearModelFilterResultsByModel: vi.fn(),
  deleteModelFilterResultsByConfigIds: vi.fn(),
  getNextHealthyConfigsForModel: vi.fn(async () => []),
  getModelFilterResult: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => ({
  getProxyPoolById: vi.fn(async () => null),
  createProxyPool: vi.fn(async () => ({})),
  updateProxyPool: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }), { virtual: true });
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "https://example.com" }), { virtual: true });
vi.mock("../../src/lib/xray/modelFilterTraffic.js", () => ({
  getActiveLiveTrafficCount: vi.fn(() => 0),
  getLiveTrafficQuietForMs: vi.fn(() => 99999),
  waitForLiveTrafficQuiet: vi.fn(async () => true),
  beginLiveModelTraffic: vi.fn(),
  wrapLiveModelResponse: vi.fn(),
}));
vi.mock("../../src/lib/xray/modelProbe.js", () => ({
  buildModelProbeBody: vi.fn(),
  withProbeTimeout: vi.fn(),
}));

const PREV_PID = 4194301;
const NEW_PID = 4194302;
const ORPHAN_PID = 4194304;

let tempDir;
let originalDataDir;
let manager;
let processMocks;
let testerMocks;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-switch-drain-"));
  process.env.DATA_DIR = tempDir;
  // writeConfig() writes straight into the xray dir — create it up front.
  fs.mkdirSync(path.join(tempDir, "xray"), { recursive: true });
  const installer = await import("../../src/lib/xray/installer.js");
  installer.getXrayConfigPath.mockReturnValue(path.join(tempDir, "xray", "switch-config.json"));
  installer.getXrayDir.mockReturnValue(path.join(tempDir, "xray"));
  processMocks = await import("../../src/lib/xray/process.js");
  testerMocks = await import("../../src/lib/xray/tester.js");
  const repo = await import("../../src/lib/db/repos/xrayRepo.js");
  repo.getXrayConfigById.mockResolvedValue({ id: "cfg-1", name: "node-1", link: "vless://..." });
  manager = await import("../../src/lib/xray/manager.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake */ }
});

function primeHappySwitch() {
  processMocks.getManagedPid.mockReturnValue(PREV_PID);
  processMocks.spawnNextManagedXray.mockResolvedValue({
    pid: NEW_PID,
    exitPromise: new Promise(() => {}), // never exits during the test
  });
  testerMocks.isSocksPortOpen.mockResolvedValue(true);
  testerMocks.testProxy.mockResolvedValue({ ok: true, exitIp: "203.0.113.9" });
}

describe("blue-green switch drain registration (F1 crash window)", () => {
  it("registers the OLD pid in the draining file BEFORE the candidate takes the PID file", async () => {
    primeHappySwitch();
    await manager.doSwitchConfig("cfg-1");
    expect(processMocks.addDrainingPid).toHaveBeenCalledWith(PREV_PID);
    // Ordering is the point: the drain entry must exist by the time the PID
    // file is overwritten, or a crash in between orphans the old instance.
    // (addDrainingPid fires again later from scheduleDrain — the FIRST call
    // is the crash-safety one under test.)
    const drainCall = processMocks.addDrainingPid.mock.invocationCallOrder[0];
    const promoteCall = processMocks.setManagedPid.mock.invocationCallOrder[0];
    expect(drainCall).toBeLessThan(promoteCall);
    // Success path keeps the registration (the drain timer owns it from here).
    expect(processMocks.removeDrainingPid).not.toHaveBeenCalledWith(PREV_PID);
  });

  it("un-registers the OLD pid on rollback (failed candidate restores it as active)", async () => {
    vi.clearAllMocks();
    primeHappySwitch();
    testerMocks.testProxy.mockResolvedValue({ ok: false }); // health probe fails → rollback
    await expect(manager.doSwitchConfig("cfg-1")).rejects.toThrow(/failed health probe/i);
    expect(processMocks.removeDrainingPid).toHaveBeenCalledWith(PREV_PID);
    expect(processMocks.setManagedPid).toHaveBeenLastCalledWith(PREV_PID);
  });

  it("stopXrayService also terminates file-registered draining pids (crash leftovers)", async () => {
    vi.clearAllMocks();
    processMocks.getDrainingPids.mockReturnValueOnce([{ pid: ORPHAN_PID, since: Date.now() }]);
    processMocks.stopXray.mockReturnValue({ stopped: false, reason: "not_running" });
    await manager.stopXrayService();
    expect(processMocks.terminateXrayPid).toHaveBeenCalledWith(ORPHAN_PID);
    expect(processMocks.removeDrainingPid).toHaveBeenCalledWith(ORPHAN_PID);
  });
});
