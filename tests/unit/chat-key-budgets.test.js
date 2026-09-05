// Phase 08 integration: budget enforcement in handleChat's requireApiKey
// branch. Real keyBudgets module; auth/localDb/usageRepo/chatCore mocked.
// Verifies the enforcement point fires BEFORE any provider attempt.
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  keyRow: null,
  settings: { requireApiKey: true },
  spend: { usd: 0, tokens: 0 },
  attempts: [],
}));

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("open-sse/index.js", () => ({}));

const alerts = vi.hoisted(() => ({ emitAlert: vi.fn() }));
vi.mock("@/lib/alerts", () => ({
  emitAlert: alerts.emitAlert,
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
  getProviderCredentials: vi.fn(async () => ({
    connectionId: "conn-1",
    connectionName: "acc-1",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => { }),
  extractApiKey: vi.fn(() => "sk-machine-keyid01-abcd"),
  isTrustedInternalRequest: vi.fn(async () => false),
  getApiKeyRow: vi.fn(async () => harness.keyRow),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(() => { }),
  isStrikeBlocked: vi.fn(() => false),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "antigravity", model: "gemini-2.5-pro" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ ...harness.settings })) }));

vi.mock("@/lib/db/repos/usageRepo.js", () => ({
  getSpendForKey: vi.fn(async () => ({ ...harness.spend })),
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  maskApiKey: (k) => `sk-…${String(k).slice(-4)}`,
  hashApiKey: vi.fn(() => "hash"),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => { }),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async (opts) => {
    harness.attempts.push(opts.connectionId);
    await opts.onRequestSuccess?.();
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
vi.mock("@/lib/network/proxyRotation.js", () => ({
  isProxyRotatableError: vi.fn(() => false),
  proxyCooldownForError: vi.fn(() => 0),
  groupHasAvailableEntry: vi.fn(() => true),
  isConnectionFailure: vi.fn(() => false),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));
vi.mock("@/lib/xray/modelFilterTraffic.js", () => ({
  beginLiveModelTraffic: vi.fn(() => null),
  wrapLiveModelResponse: vi.fn((r) => r),
}));
vi.mock("@/lib/xray/managedRotation.js", () => ({
  triggerManagedRotationOnProxyError: vi.fn(async () => null),
  waitForManagedRotationSettle: vi.fn(async () => true),
  noteManagedPoolConnFailure: vi.fn(() => { }),
}));
vi.mock("@/lib/xray/manager.js", () => ({ MANAGED_POOL_ID: "managed" }));
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
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => null) }));
vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: {
    BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503,
  },
}));

import { handleChat } from "@/sse/handlers/chat.js";
import { getSpendForKey } from "@/lib/db/repos/usageRepo.js";
import { __resetKeyBudgetsForTests } from "@/sse/services/keyBudgets.js";

function chatRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-machine-keyid01-abcd" },
    body: JSON.stringify({ model: "antigravity/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }),
  });
}

function keyRow(overrides = {}) {
  return {
    id: "k1",
    name: "team-key",
    isActive: 1,
    budgetType: "usd",
    budgetLimit: 10,
    budgetWindow: "daily",
    softThresholdPct: 80,
    hardBlock: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetKeyBudgetsForTests();
  harness.keyRow = keyRow();
  harness.settings = { requireApiKey: true };
  harness.spend = { usd: 0, tokens: 0 };
  harness.attempts = [];
});

describe("budget enforcement in the chat auth path", () => {
  it("invalid key still 401s (getApiKeyRow null)", async () => {
    harness.keyRow = null;
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(401);
    expect(harness.attempts).toHaveLength(0);
  });

  it("inactive key 401s", async () => {
    harness.keyRow = keyRow({ isActive: 0 });
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(401);
  });

  it("budget off: request passes with ZERO spend queries", async () => {
    harness.keyRow = keyRow({ budgetType: "off" });
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(getSpendForKey).not.toHaveBeenCalled();
  });

  it("budgeted under threshold: passes, no alert", async () => {
    harness.spend = { usd: 3, tokens: 0 };
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(getSpendForKey).toHaveBeenCalledWith("sk-machine-keyid01-abcd", expect.any(Date));
  });

  it("threshold crossing alerts once; second request same window does not re-alert", async () => {
    harness.spend = { usd: 8.5, tokens: 0 }; // 85%
    expect((await handleChat(chatRequest())).status).toBe(200);
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
    expect((await handleChat(chatRequest())).status).toBe(200);
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
  });

  it("hard block at limit: 429 BEFORE any provider attempt, with Retry-After + header", async () => {
    harness.spend = { usd: 10, tokens: 0 };
    harness.keyRow = keyRow({ hardBlock: 1 });
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(429);
    expect(res.headers.get("X-9Router-Budget")).toBe("limit-exceeded");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(harness.attempts).toHaveLength(0); // enforcement precedes selection
    const body = await res.json();
    expect(body.error.code).toBe("api_key_budget_exceeded");
  });

  it("requireApiKey off: budgets are inert (documented scope caveat)", async () => {
    harness.settings = { requireApiKey: false };
    harness.spend = { usd: 10, tokens: 0 };
    harness.keyRow = keyRow({ hardBlock: 1 });
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(getSpendForKey).not.toHaveBeenCalled();
  });
});
