// The xray model filter must never send a chat completion against a noAuth
// free-lane provider (OpenCode Free): every probe spends real free-tier
// quota, and all probes share the process-wide stable session while hopping
// it across every tested exit IP — the pattern the upstream gate flags, after
// which the user's own traffic 429s FreeUsageLimitError. Free-lane probes
// judge nodes by tunnel connectivity (exit-IP fetch) instead.
//
// Mock surface copied from xray-filter-multi-sub-fixes.test.js.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (p, c) => c),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async () => {
    throw new Error("handleChatCore must not run for free-lane filter probes");
  }),
}), { virtual: true });
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "https://example.com" }), { virtual: true });
vi.mock("../../src/lib/xray/modelFilterTraffic.js", () => ({
  getActiveLiveTrafficCount: vi.fn(() => 0),
  getLiveTrafficQuietForMs: vi.fn(() => 99999),
  waitForLiveTrafficQuiet: vi.fn(async () => true),
  beginLiveModelTraffic: vi.fn(),
  wrapLiveModelResponse: vi.fn(),
}));

const { _probeModelViaChatCoreForTests } = await import("../../src/lib/xray/manager.js");
const { isNoAuthFreeChatProvider } = await import("../../src/lib/xray/modelProbe.js");
const { testProxyExitIpWithUri } = await import("../../src/lib/xray/tester.js");
const { handleChatCore } = await import("open-sse/handlers/chatCore.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const FREE_MODEL = { provider: "opencode", model: "beam-free" };
const SOCKS = "socks5://u:p@127.0.0.1:51999";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("model-filter free-lane guard (noAuth providers)", () => {
  it("flags noAuth free providers — opencode yes, keyed lanes no", () => {
    expect(isNoAuthFreeChatProvider("opencode")).toBe(true);
    expect(isNoAuthFreeChatProvider("opencode-zen")).toBe(false);
    expect(isNoAuthFreeChatProvider("opencode-go")).toBe(false);
    expect(isNoAuthFreeChatProvider("deepseek")).toBe(false);
    expect(isNoAuthFreeChatProvider("unknown-provider")).toBe(false);
  });

  it("api-mode probe on a free-lane model checks the exit IP and never calls handleChatCore", async () => {
    testProxyExitIpWithUri.mockResolvedValue("203.0.113.7");
    const result = await _probeModelViaChatCoreForTests(FREE_MODEL, SOCKS, 20000);

    expect(result).toMatchObject({ ok: true, status: 200, error: null, chatProbeSkipped: true });
    expect(handleChatCore).not.toHaveBeenCalled();
    expect(getProviderCredentials).not.toHaveBeenCalled();
    expect(testProxyExitIpWithUri).toHaveBeenCalledWith(SOCKS, expect.any(Number));
  });

  it("api-mode probe on a free-lane model fails cleanly when the tunnel routes nothing", async () => {
    testProxyExitIpWithUri.mockRejectedValue(new Error("socks connect timeout"));
    const result = await _probeModelViaChatCoreForTests(FREE_MODEL, SOCKS, 20000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(String(result.error)).toMatch(/free-lane/i);
    expect(handleChatCore).not.toHaveBeenCalled();
  });

  it("keyed providers keep the real chat probe path", async () => {
    // getProviderCredentials is mocked to null: reaching it (instead of the
    // free-lane branch) proves the guard did not intercept a keyed provider.
    const result = await _probeModelViaChatCoreForTests({ provider: "opencode-go", model: "glm-5.3" }, SOCKS, 20000);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(getProviderCredentials).toHaveBeenCalledWith("opencode-go", expect.any(Set), "glm-5.3");
    expect(testProxyExitIpWithUri).not.toHaveBeenCalled();
  });
});
