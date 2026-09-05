// Phase 06 integration tests: the chat.js fallback loop wired to the real
// circuitBreaker module (SUT). Everything else — auth selection, chatCore
// executor, token refresh — is mocked. The real error.js/accountFallback.js
// run so terminal 503 shaping (Retry-After) is asserted against production
// code paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("open-sse/index.js", () => ({}));

// Scriptable account pool + executor behavior. behavior maps connectionId →
// "fail" | "ok"; handleChatCore records every attempt in `attempts`.
const harness = vi.hoisted(() => ({
  accounts: [],
  behavior: {},
  attempts: [],
  strikeBlocked: () => false,
}));

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
  getProviderCredentials: vi.fn(async (_provider, excludeSet) => {
    const next = harness.accounts.find((a) => !excludeSet.has(a.connectionId));
    return next || null;
  }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => { }),
  extractApiKey: vi.fn(() => "sk-test"),
  isTrustedInternalRequest: vi.fn(async () => false),
  isValidApiKey: vi.fn(async () => true),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(() => { }),
  isStrikeBlocked: vi.fn((connectionId, _model) => harness.strikeBlocked(connectionId)),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "antigravity", model: "gemini-2.5-pro" })),
  getComboModels: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => { }),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async (opts) => {
    const id = opts.connectionId;
    harness.attempts.push(id);
    if (harness.behavior[id] === "fail") {
      return {
        success: false,
        status: 429,
        error: "Upstream 429",
        resetsAtMs: undefined,
        response: new Response("err", { status: 429 }),
      };
    }
    // N7 signal: success is declared at first forwarded byte.
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
import {
  checkBreaker,
  getBreakerStates,
  recordFailure,
  __resetBreakersForTests,
} from "@/sse/services/circuitBreaker.js";

function account(id, name) {
  return { connectionId: id, connectionName: name, providerSpecificData: {} };
}

function chatRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "antigravity/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }),
  });
}

function state(id) {
  return getBreakerStates().find((s) => s.connectionId === id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  __resetBreakersForTests();
  harness.accounts = [account("conn-1", "acc-1"), account("conn-2", "acc-2")];
  harness.behavior = {};
  harness.attempts = [];
  harness.strikeBlocked = () => false;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("breaker wiring in the chat fallback loop", () => {
  it("opens after 5 account failures in the window, then skips attempts and 503s with a retry-after", async () => {
    harness.behavior = { "conn-1": "fail", "conn-2": "fail" };

    // 5 requests; each burns both accounts then hits the generic terminal.
    for (let i = 0; i < 5; i++) {
      const res = await handleChat(chatRequest());
      expect(res.status).toBe(429); // lastStatus passthrough on the generic path
    }
    expect(harness.attempts.filter((id) => id === "conn-1")).toHaveLength(5);
    expect(state("conn-1").state).toBe("open");
    expect(state("conn-2").state).toBe("open");

    // 6th request: both breakers deny at the gate — zero provider attempts,
    // terminal 503 with the breaker's cooldown as Retry-After.
    const attemptsBefore = harness.attempts.length;
    const res = await handleChat(chatRequest());
    expect(harness.attempts).toHaveLength(attemptsBefore); // no provider calls
    expect(res.status).toBe(503);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(55);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const body = await res.json();
    expect(body.error.message).toContain("circuit-broken");
  });

  it("open breaker on one account never harms the user — served by the next account", async () => {
    harness.behavior = { "conn-1": "fail", "conn-2": "ok" };
    for (let i = 0; i < 5; i++) recordFailure("conn-1", "antigravity");
    expect(checkBreaker("conn-1").allowed).toBe(false);

    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(harness.attempts).toEqual(["conn-2"]); // conn-1 skipped at the gate
    expect(state("conn-1").state).toBe("open"); // still open — no attempt, no feed
  });

  it("post-cooldown probe is admitted once; failed probe doubles the backoff AND the user is still served", async () => {
    harness.behavior = { "conn-1": "fail", "conn-2": "ok" };
    for (let i = 0; i < 5; i++) recordFailure("conn-1", "antigravity");

    vi.setSystemTime(Date.now() + 60_100); // cooldown elapsed
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200); // user served
    expect(harness.attempts).toEqual(["conn-1", "conn-2"]); // probe attempted conn-1, then fell through

    const st = state("conn-1");
    expect(st.state).toBe("open");
    expect(st.consecutiveOpens).toBe(2); // re-opened with doubled backoff
    expect(st.remainingMs).toBeGreaterThanOrEqual(110_000);
  });

  it("successful probe closes the breaker (recovery)", async () => {
    harness.behavior = { "conn-1": "fail", "conn-2": "ok" };
    for (let i = 0; i < 5; i++) recordFailure("conn-1", "antigravity");

    // First cooldown → probe fails → 120s backoff.
    vi.setSystemTime(Date.now() + 60_100);
    await handleChat(chatRequest());
    expect(state("conn-1").consecutiveOpens).toBe(2);

    // Second cooldown → probe succeeds → closed + recovered.
    harness.behavior["conn-1"] = "ok";
    vi.setSystemTime(Date.now() + 120_100);
    const res = await handleChat(chatRequest());
    expect(res.status).toBe(200);
    expect(harness.attempts[harness.attempts.length - 1]).toBe("conn-1");
    const st = state("conn-1");
    expect(st.state).toBe("closed");
    expect(st.consecutiveOpens).toBe(0);
    expect(st.lastRecoveredAt).not.toBeNull();
  });

  it("R9: strike-blocked antigravity failures are NOT double-counted by the breaker", async () => {
    harness.behavior = { "conn-1": "fail", "conn-2": "ok" };
    // Upstream strike-block owns conn-1's quota-429s from now on.
    harness.strikeBlocked = (id) => id === "conn-1";

    for (let i = 0; i < 8; i++) {
      await handleChat(chatRequest());
    }
    // conn-1 was attempted 8 times (fallback keeps re-picking it — the strike
    // mechanism, not the breaker, owns its exclusion) and never opened.
    expect(state("conn-1")).toBeUndefined(); // no record created: all feeds skipped
  });

  it("noauth credentials (no connectionId) bypass the gate entirely", async () => {
    harness.accounts = [{ connectionId: undefined, connectionName: "noauth", providerSpecificData: {} }];
    harness.behavior = { undefined: "fail" };
    for (let i = 0; i < 7; i++) {
      await handleChat(chatRequest());
    }
    expect(harness.attempts).toHaveLength(7); // every request still attempts
    expect(getBreakerStates()).toEqual([]); // nothing keyed on undefined
  });
});
