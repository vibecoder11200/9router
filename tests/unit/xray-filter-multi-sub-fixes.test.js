// Multi-subscription model-filter fixes:
//   1. Slice ranking — configs due for a probe (new sub's untested servers,
//      TTL-expired rows) outrank fresh-cache entries so limit mode can't
//      starve newly synced subscriptions out of the rotation pools.
//   2. Auto-filter skip-on-conflict — sync-triggered runs latch exactly one
//      coalesced re-run instead of vanishing, and the skip is observable.
//   3. api-mode probes persist latency/exit-IP like spawn-mode probes.
//
// Mock surface copied from xray-manager-smoke.test.js (manager's heavy deps).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => importOriginal());
vi.mock("../../src/lib/xray/configBuilder.js", () => ({
  buildClientConfig: vi.fn(),
  validateLink: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../src/lib/xray/reaper.js", () => ({ reapOrphanedTempProbes: vi.fn() }));
vi.mock("../../src/lib/xray/parser.js", () => ({ convertLink: vi.fn() }));
vi.mock("../../src/lib/xray/installer.js", () => ({
  isXrayInstalled: vi.fn(() => false),
  getXrayConfigPath: vi.fn(() => "/tmp/xray/config.json"),
  getXrayBinaryPath: vi.fn(() => "/tmp/xray/xray"),
  getInstalledVersion: vi.fn(() => null),
  getXrayRuntimeVersion: vi.fn(async () => null),
  installXray: vi.fn(),
  getXrayDir: vi.fn(() => "/tmp/xray"),
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
  isSocksPortOpen: vi.fn(async () => false),
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
  setSelectedXrayConfig: vi.fn(),
  updateXrayTestResult: vi.fn(),
  getXrayConfigs: vi.fn(async () => []),
  getXraySyncState: vi.fn(async () => ({})),
  deleteXrayConfig: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  // Must return a real Map — filterConfigsByModel calls .has/.get on it.
  getModelFilterResultsByConfigIds: vi.fn(async () => new Map()),
  getModelFilterCacheStats: vi.fn(async () => ({})),
  upsertModelFilterResult: vi.fn(),
  clearModelFilterResultsByModel: vi.fn(),
  deleteModelFilterResultsByConfigIds: vi.fn(),
  getNextHealthyConfigsForModel: vi.fn(async () => []),
  getModelFilterResult: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => ({
  getProxyPoolById: vi.fn(async () => null),
  createProxyPool: vi.fn(),
  updateProxyPool: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn(async () => null) }));
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

const manager = await import("../../src/lib/xray/manager.js");
const xrayRepo = await import("../../src/lib/db/repos/xrayRepo.js");
const apiFilter = await import("../../src/lib/xray/apiFilter.js");
const settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await sleep(10);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  manager._setModelFilterRunningForTests(null);
});

afterEach(() => {
  manager._setModelFilterRunningForTests(null);
});

describe("slice ranking — never-tested → stale-due → fresh, stable inside tiers", () => {
  it("tiers configs so a new subscription's untested servers never wait behind stale-measured ones", () => {
    const configs = [
      { id: "sel-tested", rank: 2 },
      { id: "stale-old", rank: 1 },
      { id: "new-sub-a", rank: 0 },
      { id: "stale-new", rank: 1 },
      { id: "new-sub-b", rank: 0 },
      { id: "fast-tested", rank: 2 },
    ];
    expect(manager.orderConfigsForFilterSelection(configs, (c) => c.rank).map((c) => c.id)).toEqual([
      "new-sub-a",
      "new-sub-b", // never filter-tested first
      "stale-old",
      "stale-new", // stale/retry-due next
      "sel-tested",
      "fast-tested", // fresh cache last
    ]);
  });

  it("is the identity permutation when all ranks are equal (no backlog → legacy slice)", () => {
    const configs = [{ id: "a" }, { id: "b" }];
    expect(manager.orderConfigsForFilterSelection(configs, () => 2)).toEqual(configs);
  });
});

describe("api-mode probe bookkeeping", () => {
  const handle = { socksPort: 53080 };
  const config = { id: "cfg-1", link: "vless://x@h:1#n" };

  it("persists latency + exit IP on success (spawn-mode parity)", async () => {
    apiFilter.probeConfigViaApi.mockResolvedValueOnce({
      ok: true, latencyMs: 123, status: 200, exitIp: "1.1.1.1", error: null,
    });
    const probe = manager._makeApiProbeFn(handle, { provider: "p", model: "m" }, "p/m", 100);
    const result = await probe(config, 0);
    expect(result.ok).toBe(true);
    expect(xrayRepo.updateXrayTestResult).toHaveBeenCalledWith("cfg-1", {
      latencyMs: 123,
      exitIp: "1.1.1.1",
      ok: true,
    });
  });

  it("persists the failure marker on a returned failure (e.g. upstream 429)", async () => {
    apiFilter.probeConfigViaApi.mockResolvedValueOnce({
      ok: false, tunnelOk: true, latencyMs: 5, status: 429, exitIp: "", error: "HTTP 429",
    });
    const probe = manager._makeApiProbeFn(handle, { provider: "p", model: "m" }, "p/m", 100);
    await probe(config, 0);
    expect(xrayRepo.updateXrayTestResult).toHaveBeenCalledWith("cfg-1", { ok: false });
  });

  it("does not touch test results when the probe throws (testConfig owns that path)", async () => {
    apiFilter.probeConfigViaApi.mockRejectedValueOnce(new Error("setup boom"));
    const probe = manager._makeApiProbeFn(handle, { provider: "p", model: "m" }, "p/m", 100);
    await expect(probe(config, 0)).rejects.toThrow("setup boom");
    expect(xrayRepo.updateXrayTestResult).not.toHaveBeenCalled();
  });
});

describe("auto-filter skip-on-conflict — coalesced re-run instead of a lost trigger", () => {
  it("latches a queued re-run when an auto trigger hits a running filter, then re-runs from settings", async () => {
    settingsRepo.getSettings.mockResolvedValue({
      xrayModelFilterEnabled: true,
      xrayModelFilterModel: "test/model",
      xrayModelFilterLimit: 5,
      xrayModelFilterCacheTtlH: 24,
      xrayModelFilterRetryFailAfterH: 1,
    });
    // Hold the FIRST job inside filterConfigsByModel (blocked on the catalog read).
    const gate = { resolve: null };
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    xrayRepo.getXrayConfigs.mockReturnValueOnce(gate.promise).mockResolvedValue([]);

    const firstJob = manager.runModelFilterJob({ model: "test/model", source: "manual" });
    await pollUntil(() => manager.getModelFilterStatus().status === "running");

    // A sync-triggered run arrives while the first job is running.
    const skipped = await manager.runModelFilterJob({
      model: "test/model", source: "manual-sync", queueRerunIfBusy: true,
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toBe("already_running");
    expect(manager._getAutoFilterRerunQueuedForTests()).toBe(true);
    expect(manager.getModelFilterStatus().autoFilterSkipReason).toBe("already_running");
    expect(manager.getModelFilterStatus().autoFilterSkipAt).toBeTruthy();

    // Settle the running job — the latch must fire exactly one follow-up run.
    gate.resolve([]);
    await firstJob;
    // The first job's own completion also flips status to "done", so poll on
    // the rerun's OWN signals: its catalog read AND its final settled state.
    await pollUntil(() => xrayRepo.getXrayConfigs.mock.calls.length >= 2);
    await pollUntil(
      () => manager.getModelFilterStatus().status === "done" && manager.getModelFilterStatus().autoFilterSkipReason === null,
    );
    expect(manager._getAutoFilterRerunQueuedForTests()).toBe(false);
    // Two catalog reads total: the original job + the coalesced re-run.
    expect(xrayRepo.getXrayConfigs).toHaveBeenCalledTimes(2);
  });

  it("clears the skip message when the latched re-run is a no-op (feature disabled) — no stale promise", async () => {
    settingsRepo.getSettings.mockResolvedValue({ xrayModelFilterEnabled: false });
    const gate = { resolve: null };
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    xrayRepo.getXrayConfigs.mockReturnValueOnce(gate.promise);

    const firstJob = manager.runModelFilterJob({ model: "m", source: "manual" });
    await pollUntil(() => manager.getModelFilterStatus().status === "running");
    await manager.runModelFilterJob({ model: "m", source: "manual-sync", queueRerunIfBusy: true });
    expect(manager.getModelFilterStatus().autoFilterSkipReason).toBe("already_running");

    gate.resolve([]);
    await firstJob;
    await pollUntil(() => manager.getModelFilterStatus().autoFilterSkipReason === null);
    expect(manager._getAutoFilterRerunQueuedForTests()).toBe(false);
    // The re-run never executed a job (disabled) — only the original read.
    expect(xrayRepo.getXrayConfigs).toHaveBeenCalledTimes(1);
  });

  it("runModelFilterFromSettings wires queueRerunIfBusy (deleting the flag would resurrect the lost-trigger bug)", async () => {
    settingsRepo.getSettings.mockResolvedValue({
      xrayModelFilterEnabled: true,
      xrayModelFilterModel: "test/model",
    });
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    manager._setModelFilterRunningForTests(pending);
    try {
      const autoSkip = await manager.runModelFilterFromSettings("scheduled-sync");
      expect(autoSkip.skipped).toBe(true);
      expect(manager._getAutoFilterRerunQueuedForTests()).toBe(true);
    } finally {
      settle();
    }
  });

  it("manual runs are not latched — they only report the skip", async () => {
    const gate = { resolve: null };
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    xrayRepo.getXrayConfigs.mockReturnValueOnce(gate.promise);

    const firstJob = manager.runModelFilterJob({ model: "m", source: "manual" });
    await pollUntil(() => manager.getModelFilterStatus().status === "running");

    const skipped = await manager.runModelFilterJob({ model: "m", source: "manual" });
    expect(skipped.skipped).toBe(true);
    expect(manager._getAutoFilterRerunQueuedForTests()).toBe(false);
    expect(manager.getModelFilterStatus().autoFilterSkipReason).toBeNull();

    gate.resolve([]);
    await firstJob;
    await pollUntil(() => manager.getModelFilterStatus().status === "done");
    expect(xrayRepo.getXrayConfigs).toHaveBeenCalledTimes(1);
  });
});

describe("infra abort is visible — abortedReason on the status, not a silent 'done'", () => {
  // prod 261113: a genuine infra abort ended the run "done" with the tail
  // skipped and nothing on the status explaining why — the dashboard read a
  // truncated run (2-3 of 1297 tested) as full success. The reason must land
  // on modelFilterState.
  it("surfaces abortedReason on the job result AND the status when a probe reports an infra failure", async () => {
    settingsRepo.getSettings.mockResolvedValue({
      xrayFilterMode: "api",
      xrayFilterApiSocksPort: 53080,
      xrayFilterApiPort: 15491,
      xrayFilterApiAccounts: 16,
    });
    const { startFilterXray, stopFilterXray, probeConfigViaApi } = await import("../../src/lib/xray/apiFilter.js");
    startFilterXray.mockResolvedValue({ socksPort: 53080, apiPort: 15491, pid: 4242 });
    stopFilterXray.mockResolvedValue(); // finally-block awaits .catch on this
    const { getModelInfo } = await import("@/sse/services/model.js");
    getModelInfo.mockResolvedValue({ provider: "p", model: "m" });

    const configs = [
      { id: "cfg-a", link: "vless://a@h:1#n", name: "A", host: "h", country: "US" },
      { id: "cfg-b", link: "vless://b@h:2#n", name: "B", host: "h", country: "US" },
    ];
    xrayRepo.getXrayConfigs.mockResolvedValue(configs);
    // Genuine infra wording (what a real lane-down still produces): the run
    // aborts — that part is by design — but it must not be silent anymore.
    probeConfigViaApi.mockResolvedValue({
      ok: false, status: 503, error: "[503]: OpenCode free lane unavailable (bun runtime/lane failure)", infraError: true,
    });

    // concurrency 1 → deterministic: config A probes, aborts, B never runs.
    const result = await manager.runModelFilterJob({
      model: "p/m", limit: 10, all: false, prune: false, concurrency: 1, pauseOnTraffic: false, source: "manual",
    });

    expect(result.tested).toBe(1); // A only — B skipped by the abort
    expect(result.abortedReason).toContain("free lane unavailable");
    const status = manager.getModelFilterStatus();
    expect(status.status).toBe("done");
    expect(status.abortedReason).toContain("free lane unavailable");
    await vi.waitFor(() => expect(stopFilterXray).toHaveBeenCalled(), { timeout: 5000 });
  });
});
