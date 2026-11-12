import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  handleChatCoreMock,
  chatCoreCalls,
  exitIpProbeMock,
  tlsFetchMock,
  proxyAwareMock,
  resolverMock,
  getSettingsMock,
  localGetSettingsMock,
  getProviderCredentialsMock,
  checkAndRefreshTokenMock,
} = vi.hoisted(() => ({
  handleChatCoreMock: vi.fn(),
  chatCoreCalls: [],
  exitIpProbeMock: vi.fn(),
  tlsFetchMock: vi.fn(),
  proxyAwareMock: vi.fn(),
  resolverMock: vi.fn(),
  getSettingsMock: vi.fn(),
  localGetSettingsMock: vi.fn(),
  getProviderCredentialsMock: vi.fn(),
  checkAndRefreshTokenMock: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: (...a) => handleChatCoreMock(...a),
}));

vi.mock("@/lib/xray/tester.js", () => ({
  testProxy: vi.fn(),
  testProxyLatency: vi.fn(),
  isSocksPortOpen: vi.fn(),
  testProxyExitIpWithUri: (...a) => exitIpProbeMock(...a),
}));

vi.mock("@/lib/xray/modelProbe.js", () => ({
  isNoAuthFreeChatProvider: () => true,
  buildModelProbeBody: (modelInfo) => ({
    model: modelInfo.model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }),
  withProbeTimeout: (p) => p.catch((e) => ({ success: false, error: e?.message || String(e) })),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: (...a) => getProviderCredentialsMock(...a),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: (...a) => checkAndRefreshTokenMock(...a),
}));

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: (...a) => getSettingsMock(...a),
}));

vi.mock("@/lib/localDb.js", () => ({
  getSettings: (...a) => localGetSettingsMock(...a),
}));

vi.mock("@/lib/xray/httpProxyResolver.js", () => ({
  resolveXrayHttpProxyUrl: (...a) => resolverMock(...a),
}));

vi.mock("open-sse/utils/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyAwareMock,
}));

// The bun lane runs REAL; mock only the child spawn. Fake child: header line
// on stdout, then exit — enough for the lane to hand off a live Response.
const spawnCalls = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (...args) => {
      spawnCalls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {} };
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit("exit", 0); } return true; };
      const cfg = spawnBehavior();
      if (cfg.errorLine) {
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(cfg.errorLine + "\n")));
        setTimeout(() => { child.exitCode = cfg.exitCode ?? 5; child.emit("exit", child.exitCode); }, 20);
      } else {
        const header = JSON.stringify({ status: 200, headers: { "content-type": "text/event-stream" } });
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(header + "\n")));
        setTimeout(() => { child.exitCode = 0; child.emit("exit", 0); }, 20);
      }
      return child;
    },
  };
});

function spawnBehavior() { return spawnBehaviorImpl(); }
let spawnBehaviorImpl = () => ({});

import { isProbeInfraError, _probeModelViaChatCoreForTests } from "@/lib/xray/manager.js";
import { getEmbeddedWireSnapshot } from "open-sse/providers/opencodeWire.js";

const snapshot = getEmbeddedWireSnapshot();

const SOCKS = "socks5://127.0.0.1:53011";
const HTTP_MAPPED = "http://127.0.0.1:53012";
const MODEL_INFO = { provider: "opencode", model: "deepseek-v4.1-flash-free" };

beforeEach(() => {
  handleChatCoreMock.mockReset();
  chatCoreCalls.length = 0;
  exitIpProbeMock.mockReset();
  tlsFetchMock.mockReset();
  proxyAwareMock.mockReset();
  resolverMock.mockReset();
  getProviderCredentialsMock.mockReset();
  checkAndRefreshTokenMock.mockReset();
  getSettingsMock.mockResolvedValue({ headroomUrl: "http://h", pxpipeMinChars: 100, pxpipeTimeoutMs: 5000 });
  localGetSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "bun" });
  getProviderCredentialsMock.mockResolvedValue({ connectionId: "c1", rawHeaders: {}, allRateLimited: false });
  checkAndRefreshTokenMock.mockImplementation(async (_p, c) => c);
  process.env.OPENCODE_BUN_PATH = "bun-test-fixture";
  spawnBehaviorImpl = () => ({});
  spawnCalls.length = 0;
  // Mimic proxyAwareFetch's bridge branch: directFetchProxyBridge=true carries
  // the connection proxy into the 3rd arg (what runBunFreeLane receives as ctx).
  proxyAwareMock.mockImplementation(async (url, options, proxyOptions) => {
    const proxyUrl = proxyOptions?.connectionProxyEnabled ? proxyOptions.connectionProxyUrl : null;
    if (proxyUrl && options.directFetch && options.directFetchProxyBridge === true) {
      return options.directFetch(url, options, { proxyUrl });
    }
    return options.directFetch(url, options);
  });
});

describe("xray model-filter probe — free-lane infra classification", () => {
  it("classifier: lane-unavailable / unmapped wording → infraError, ordinary per-node failures → NOT infra", () => {
    expect(isProbeInfraError("[503]: OpenCode free lane unavailable (bun runtime/lane failure)")).toBe(true);
    expect(isProbeInfraError(
      "[503]: OpenCode free lane: proxy pool not mappable to the Bun lane (bind a fork xray pool or remove the pool binding)",
    )).toBe(true);
    expect(isProbeInfraError("OPENCODE_FREE_LANE_UNAVAILABLE raw code")).toBe(true);
    expect(isProbeInfraError("wreq-js unavailable (native module failed to load)")).toBe(true);
    // ordinary per-node failures must NOT abort the filter run
    expect(isProbeInfraError("[429]: FreeUsageLimitError — free tier quota spent for this identity")).toBe(false);
    expect(isProbeInfraError("HTTP 403")).toBe(false);
    expect(isProbeInfraError("")).toBe(false);
    expect(isProbeInfraError(null)).toBe(false);
  });
});

describe("xray model-filter probe — free lane skip + opt-in chat probe", () => {
  it("freeChatProbe=false → skip path unchanged: exit-IP only, chatCore never invoked", async () => {
    exitIpProbeMock.mockResolvedValue({ ok: true, exitIp: "1.2.3.4", latencyMs: 5 });
    const result = await _probeModelViaChatCoreForTests(MODEL_INFO, SOCKS, 10000, { freeChatProbe: false });
    expect(result.ok).toBe(true);
    expect(result.chatProbeSkipped).toBe(true);
    expect(handleChatCoreMock).not.toHaveBeenCalled();
    expect(exitIpProbeMock).toHaveBeenCalledTimes(1);
    expect(exitIpProbeMock.mock.calls[0][0]).toBe(SOCKS);
  });

  it("freeChatProbe=true + socks temp pair → probe hands the SOCKS to chatCore; the real lane spawns a child carrying the mapped HTTP proxy", async () => {
    resolverMock.mockImplementation(async (s) => (s === SOCKS ? HTTP_MAPPED : null));
    // chatCore bridge: mimic chatCore's contract — build proxyOptions from the
    // probe credentials and hand off to the real executor (whose freeLaneFetch
    // carries the proxyBridge flag into the real bun lane).
    handleChatCoreMock.mockImplementation(async (ctx0) => {
      chatCoreCalls.push(ctx0);
      const psd = ctx0.credentials?.providerSpecificData || {};
      const proxyOptions = psd.connectionProxyEnabled
        ? {
            connectionProxyEnabled: true,
            connectionProxyUrl: psd.connectionProxyUrl,
            connectionNoProxy: psd.connectionNoProxy || "",
            strictProxy: psd.strictProxy === true,
          }
        : null;
      const { OpenCodeExecutor } = await import("open-sse/executors/opencode.js");
      const executor = new OpenCodeExecutor();
      try {
        const out = await executor.execute({
          model: ctx0.modelInfo.model,
          body: ctx0.body,
          stream: true,
          credentials: ctx0.credentials,
          proxyOptions,
        });
        // base.execute returns a {response, url, headers, transformedBody} wrapper
        return { success: true, response: out.response };
      } catch (e) {
        return { success: false, status: e.statusCode || 502, error: `[${e.statusCode || 502}]: ${e.message}` };
      }
    });

    const result = await _probeModelViaChatCoreForTests(MODEL_INFO, SOCKS, 10000, { freeChatProbe: true, probeTag: "t1" });

    // probe → chatCore: temp SOCKS handed over verbatim (resolver owns mapping)
    expect(handleChatCoreMock).toHaveBeenCalledTimes(1);
    expect(chatCoreCalls[0].credentials.providerSpecificData.connectionProxyUrl).toBe(SOCKS);
    // executor → lane → child: the request env carries the MAPPED HTTP proxy
    expect(spawnCalls.length).toBe(1);
    const [bunPath, scriptArgs, spawnOpts] = spawnCalls[0];
    expect(bunPath).toBe("bun-test-fixture");
    expect(String(scriptArgs[0])).toContain("opencodeBunSidecar.mjs");
    const req = JSON.parse(spawnOpts.env.BUNLANE_REQ);
    expect(req.url).toBe(snapshot.endpoint);
    expect(req.proxy).toBe(HTTP_MAPPED);
    expect(tlsFetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("lane child fails twice during an opt-in chat probe → typed 503 surfaces through the base retry loop as infra-classified wording", { timeout: 20000 }, async () => {
    spawnBehaviorImpl = () => ({ errorLine: JSON.stringify({ error: "bun gone" }), exitCode: 5 });
    resolverMock.mockImplementation(async (s) => (s === SOCKS ? HTTP_MAPPED : null));
    handleChatCoreMock.mockImplementation(async (ctx0) => {
      chatCoreCalls.push(ctx0);
      const psd = ctx0.credentials?.providerSpecificData || {};
      const proxyOptions = psd.connectionProxyEnabled
        ? { connectionProxyEnabled: true, connectionProxyUrl: psd.connectionProxyUrl, connectionNoProxy: "", strictProxy: true }
        : null;
      const { OpenCodeExecutor } = await import("open-sse/executors/opencode.js");
      const executor = new OpenCodeExecutor();
      try {
        const out = await executor.execute({
          model: ctx0.modelInfo.model,
          body: ctx0.body,
          stream: true,
          credentials: ctx0.credentials,
          proxyOptions,
        });
        return { success: true, response: out.response };
      } catch (e) {
        return { success: false, status: e.statusCode || 502, error: `[${e.statusCode || 502}]: ${e.message}` };
      }
    });

    const result = await _probeModelViaChatCoreForTests(MODEL_INFO, SOCKS, 10000, { freeChatProbe: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(String(result.error)).toContain("free lane unavailable");
    expect(isProbeInfraError(result.error)).toBe(true);
    // fail-fast per execute: 2 lane attempts per base attempt; the base loop
    // maps the typed 503 throw to 502 retry (3 retries = 4 executes) → 8 spawns
    expect(spawnCalls.length).toBe(8);
  });
});
