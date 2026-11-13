// Real-path coverage for the free-lane session lifecycle (review 261113):
// a REAL BaseExecutor and REAL proxyAwareFetch drive the executor — only
// opencodeTlsFetch, settings, and lane-alert surfaces are mocked. Pins the two
// behaviors the in-adapter 429-hook removal changed:
//   1. overload-only 429s must NOT burn the stable session (retry keeps the id),
//   2. a session-class 429 must drop the hinted/translated id so the next
//      request re-mints (upstream #5559 on the real path, not the mocked base).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tlsFetchMock, getSettingsMock, emitAlertMock } = vi.hoisted(() => ({
  tlsFetchMock: vi.fn(),
  getSettingsMock: vi.fn(),
  emitAlertMock: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/alerts", () => ({
  emitAlert: emitAlertMock,
  EVENT_TYPES: { OPENCODE_BUN_LANE_UNAVAILABLE: "opencode-bun-lane-unavailable" },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));
vi.mock("../../open-sse/services/opencodeBunLane.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, opencodeFreeLaneFetch: vi.fn() };
});
vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
  OpencodeTlsUnavailableError: class extends Error {},
}));
vi.mock("../../open-sse/utils/opencodeCliRunner.js", () => ({
  findOpencodeBinary: () => null,
  formatOpencodeCliPrompt: () => "",
  executeOpencodeCli: vi.fn(),
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

const OVERLOAD = JSON.stringify({
  error: { type: "server_error", message: "The inference service is overloaded. Please try again later." },
});
const FREE_USAGE = JSON.stringify({
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Please try again later." },
});
const ok = () => new Response("data: ok\n\n", { status: 200 });
const sessionOf = (call) => call[1]?.headers?.["x-opencode-session"];
const sessionsUsed = () => tlsFetchMock.mock.calls.map(sessionOf).filter(Boolean);
const chat = (extra = {}) => ({
  model: "deepseek-v4.1-flash-free",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials: {},
  ...extra,
});

beforeEach(() => {
  tlsFetchMock.mockReset();
  emitAlertMock.mockClear();
  getSettingsMock.mockReset();
  // Legacy engine keeps every request on the mocked wreq transport.
  getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "legacy" });
});

describe("free-lane session lifecycle (real base + real proxyAwareFetch)", () => {
  it("overload-only 429s keep ONE stable session across retries and later requests", { timeout: 30_000 }, async () => {
    tlsFetchMock
      .mockResolvedValueOnce(new Response(OVERLOAD, { status: 429 }))
      .mockResolvedValueOnce(new Response(OVERLOAD, { status: 429 }))
      .mockResolvedValueOnce(ok());
    const executor = new OpenCodeExecutor("opencode", {});

    const first = await executor.execute(chat());
    expect(first.response.status).toBe(200); // both overload retries rode the same session
    expect(tlsFetchMock).toHaveBeenCalledTimes(3);

    tlsFetchMock.mockResolvedValueOnce(ok());
    const second = await executor.execute(chat());
    expect(second.response.status).toBe(200);

    const sessions = sessionsUsed();
    expect(sessions).toHaveLength(4);
    expect(sessions.every((s) => /^ses_/.test(s))).toBe(true);
    // No eviction happened anywhere: one session id across retries AND requests.
    expect(new Set(sessions).size).toBe(1);
  });

  it("a FreeUsageLimitError 429 drops the hinted (translated) session so the next request re-mints", { timeout: 15_000 }, async () => {
    tlsFetchMock
      .mockResolvedValueOnce(new Response(FREE_USAGE, { status: 429 }))
      .mockResolvedValueOnce(ok());
    const executor = new OpenCodeExecutor("opencode", {});
    const args = { providerSessionId: "conv-real-path-1" };

    const first = await executor.execute(chat(args));
    expect(first.response.status).toBe(429); // handed back intact, no retry

    const second = await executor.execute(chat(args));
    expect(second.response.status).toBe(200);

    const [a, b] = sessionsUsed();
    expect(a).toMatch(/^ses_/);
    expect(b).toMatch(/^ses_/);
    expect(b).not.toBe(a); // the flagged translation was dropped and re-minted
  });
});
