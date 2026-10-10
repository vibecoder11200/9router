// The chat.js fallback loop only classifies RESULTS — but a mid-stream abort
// (`TypeError: terminated`) happens after handleChatCore already resolved
// success, so the loop's failure handling never re-runs for it. The fix wires
// the new onStreamError callback into the same status-agnostic flaky-node
// counter the result path uses: three connection-level mid-stream strikes on
// the managed pool in a rolling 5-min window must rotate the outbound.
//
// SUT: real chat.js loop + real managedRotation + real proxyRotation
// classification. Only the executor (chatCore) and the persistence edges
// (repos, manager) are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("open-sse/index.js", () => ({}));

const harness = vi.hoisted(() => ({
  accounts: [],
  onStreamError: null,
}));

const switchConfigMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/alerts", () => ({
  emitAlert: vi.fn(),
  EVENT_TYPES: {
    ALL_ACCOUNTS_LOCKED: "all-accounts-locked",
    BREAKER_OPEN: "breaker-open",
    BREAKER_RECOVERED: "breaker-recovered",
    PROXY_POOL_EXHAUSTED: "proxy-pool-exhausted",
    STRICTPROXY_VIOLATION: "strictproxy-violation",
    QUOTA_NEAR_LIMIT: "quota-near-limit",
    BUDGET_THRESHOLD: "budget-threshold",
    XRAY_NODE_DOWN: "xray-node-down",
    XRAY_ROTATION_FAILED: "xray-rotation-failed",
    TOTU_FETCH_FAILED: "totu-fetch-failed",
  },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => harness.accounts[0] || null),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => { }),
  extractApiKey: vi.fn(() => "sk-test"),
  isTrustedInternalRequest: vi.fn(async () => false),
  isValidApiKey: vi.fn(async () => true),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(() => { }),
  isStrikeBlocked: vi.fn(() => false),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "opencode", model: "mimo-v2.6-flash-free" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => { }),
}));

// The executor is the seam: capture the onStreamError handle chat.js passes,
// resolve success immediately (as chatCore does at 200-headers time), then let
// each test fire the callback later — exactly the real mid-stream timing.
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async (opts) => {
    harness.onStreamError = opts.onStreamError || null;
    return { success: true, response: new Response("ok", { status: 200 }) };
  }),
}));

vi.mock("@/models", () => ({
  markProxyEntryCooldown: vi.fn(async () => { }),
  getProxyPoolById: vi.fn(async () => null),
  stampProxyEntryUsed: vi.fn(async () => null),
  getProxyPools: vi.fn(async () => []),
  updateProxyPool: vi.fn(async () => null),
}));

vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));
vi.mock("@/lib/xray/modelFilterTraffic.js", () => ({
  beginLiveModelTraffic: vi.fn(() => null),
  wrapLiveModelResponse: vi.fn((r) => r),
}));
vi.mock("@/lib/xray/tester.js", () => ({ waitForSocksPortOpen: vi.fn(async () => true) }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((f) => f),
  getActiveAdapterStrategy: vi.fn(() => null),
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn(() => { }) }));
vi.mock("open-sse/utils/modelMarkers.js", () => ({
  stripModelContextMarker: vi.fn((model) => ({ model, contextMarker: null })),
}));
vi.mock("open-sse/translator/formats.js", () => ({
  detectFormatByEndpoint: vi.fn(() => null),
  // helpers.js reads FORMATS at module scope (keyAccess → model chain).
  FORMATS: {
    OPENAI: "openai", OPENAI_RESPONSES: "openai-responses", OPENAI_RESPONSE: "openai-response",
    CLAUDE: "claude", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", GEMINI_WEB: "gemini-web",
    VERTEX: "vertex", CODEX: "codex", ANTIGRAVITY: "antigravity", KIRO: "kiro",
    CURSOR: "cursor", OLLAMA: "ollama", COMMANDCODE: "commandcode",
  },
}));
vi.mock("open-sse/config/runtimeConfig.js", () => ({
  // searxng.js (keyAccess → model import chain) reads SEARXNG_URL at module scope.
  SEARXNG_URL: "http://localhost:8888/search",
  HTTP_STATUS: {
    BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405, PAYLOAD_TOO_LARGE: 413, UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
  },
}));

// Real rotation bookkeeping needs these persistence edges only.
vi.mock("@/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => ({ id: "active-1", name: "Active", lastExitIp: "1.1.1.1" })),
}));
vi.mock("@/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getNextHealthyConfigsForModel: vi.fn(async () => [
    { configId: "fresh-ip", name: "Fresh IP node", latencyMs: 150, exitIp: "2.2.2.2" },
  ]),
  getModelFilterResult: vi.fn(async () => ({ configId: "active-1", ok: 1, exitIp: "1.1.1.1" })),
  upsertModelFilterResult: vi.fn(async () => {}),
}));
vi.mock("@/lib/xray/manager.js", () => ({
  MANAGED_POOL_ID: "v2go-xray-managed",
  switchConfig: switchConfigMock,
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { _resetManagedRotationState } = await import("@/lib/xray/managedRotation.js");
const { isConnectionFailure } = await import("@/lib/network/proxyRotation.js");

function managedAccount() {
  return {
    connectionId: "noauth-1",
    connectionName: "Public",
    id: "noauth",
    providerSpecificData: {
      connectionProxyPoolId: "v2go-xray-managed",
      connectionProxyUrl: "socks5://127.0.0.1:53200",
    },
  };
}

function chatRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "opencode/mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
}

// Let the fire-and-forget rotation promise chain settle before asserting.
const flushRotation = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  _resetManagedRotationState();
  switchConfigMock.mockClear();
  harness.accounts = [managedAccount()];
  harness.onStreamError = null;
  vi.clearAllMocks();
});

describe("mid-stream aborts rotate the managed pool (flaky-node counter)", () => {
  it("three mid-stream terminated strikes trigger exactly one rotation", async () => {
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200); // request itself succeeded — only the stream died later
    expect(harness.onStreamError).toBeTypeOf("function");

    harness.onStreamError(new TypeError("terminated"));
    harness.onStreamError(new TypeError("terminated"));
    expect(switchConfigMock).not.toHaveBeenCalled(); // below threshold so far

    harness.onStreamError(new TypeError("terminated"));
    await flushRotation();
    expect(switchConfigMock).toHaveBeenCalledTimes(1);
  });

  it("non-connection mid-stream errors are not counted", async () => {
    await handleChat(chatRequest());
    for (let i = 0; i < 6; i++) harness.onStreamError(new Error("stream stall timeout"));
    await flushRotation();
    expect(switchConfigMock).not.toHaveBeenCalled();
  });

  it("mid-stream strikes outside the managed pool never rotate", async () => {
    harness.accounts = [{
      ...managedAccount(),
      providerSpecificData: { connectionProxyPoolId: "some-group-pool", connectionProxyUrl: "socks5://127.0.0.1:1080" },
    }];
    await handleChat(chatRequest());
    for (let i = 0; i < 6; i++) harness.onStreamError(new TypeError("terminated"));
    await flushRotation();
    expect(switchConfigMock).not.toHaveBeenCalled();
  });
});

describe("un-masked conversion errors stay classifiable as connection failures", () => {
  it("the SSE→JSON / SSE-read failure messages now carry the cause", () => {
    expect(isConnectionFailure("Failed to convert streaming response to JSON: terminated")).toBe(true);
    expect(isConnectionFailure("Failed to convert streaming response to JSON: fetch failed")).toBe(true);
    expect(isConnectionFailure("Failed to read streaming response: terminated")).toBe(true);
    // The old masked form — the reason these failures used to be invisible to
    // the retry path and the flaky counter.
    expect(isConnectionFailure("Failed to convert streaming response to JSON")).toBe(false);
  });
});
