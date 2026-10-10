// A managed-pool status-level rotatable error (429 FreeUsageLimitError keyed to
// the egress IP) used to surface raw to the client — omp classifies that body
// as a terminal rate limit and never replays, so the turn stalled until a
// human typed Continue. The loop now settle-waits the rotation it triggers and
// replays the same request once on the fresh egress (bounded by
// MAX_MANAGED_ROTATABLE_RETRIES), mirroring the connection-failure retry path.
//
// SUT: real chat.js loop + real managedRotation. Only the executor (chatCore)
// and persistence edges are mocked — same harness pattern as
// chat-midstream-flaky-rotation.test.js.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("open-sse/index.js", () => ({}));

const harness = vi.hoisted(() => ({ accounts: [], results: [] }));

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
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
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
  getModelInfo: vi.fn(async () => ({ provider: "opencode", model: "muse-spark-1.3-contributor-free" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => { }),
}));

// Executor seam: pop scripted results so the first 429 is followed by the
// replay's 200 — proving the loop healed the turn server-side.
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async () => harness.results.shift()),
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
const { handleChatCore } = await import("open-sse/handlers/chatCore.js");

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
    body: JSON.stringify({ model: "opencode/muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
}

const rateLimited = () => ({
  success: false,
  status: 429,
  error: '[429]: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."},"metadata":{}}',
  resetsAtMs: null,
  response: new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." } }), { status: 429 }),
});

const ok = () => ({ success: true, response: new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }) });

beforeEach(() => {
  _resetManagedRotationState();
  switchConfigMock.mockClear();
  handleChatCore.mockClear();
  harness.accounts = [managedAccount()];
  harness.results = [];
});

describe("managed-pool rotatable-error replay", () => {
  it("429 FreeUsageLimitError triggers rotation and replays once, healing the turn", async () => {
    harness.results = [rateLimited(), ok()];
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(handleChatCore).toHaveBeenCalledTimes(2);
    expect(switchConfigMock).toHaveBeenCalledTimes(1);
  });

  it("bounded: a persistent 429 replays exactly once, then surfaces the error", async () => {
    harness.results = [rateLimited(), rateLimited(), rateLimited()];
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(429);
    expect(handleChatCore).toHaveBeenCalledTimes(2);
  });
});
