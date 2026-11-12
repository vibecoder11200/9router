import { beforeEach, describe, expect, it, vi } from "vitest";

const { laneFetchMock, tlsFetchMock, emitAlertMock, getSettingsMock, proxyAwareMock } = vi.hoisted(() => ({
  laneFetchMock: vi.fn(),
  tlsFetchMock: vi.fn(),
  emitAlertMock: vi.fn(),
  getSettingsMock: vi.fn(),
  proxyAwareMock: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getSettings: getSettingsMock,
}));

vi.mock("@/lib/alerts", () => ({
  emitAlert: emitAlertMock,
  EVENT_TYPES: {
    OPENCODE_WIRE_DRIFT: "opencode-wire-drift",
    OPENCODE_BUN_LANE_UNAVAILABLE: "opencode-bun-lane-unavailable",
  },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));

// Real error classes (instanceof consistency), mock only the transport fn.
vi.mock("../../open-sse/services/opencodeBunLane.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, opencodeFreeLaneFetch: laneFetchMock };
});

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
}));

// Capture the directFetch closure instead of running the base retry loop —
// the tests exercise the freeLaneFetch wrapper the way production calls it.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyAwareMock,
}));

import { OpenCodeExecutor, __test__ as opencodeExecTest } from "../../open-sse/executors/opencode.js";
import { getEmbeddedWireSnapshot } from "../../open-sse/providers/opencodeWire.js";

const snapshot = getEmbeddedWireSnapshot();
const executor = new OpenCodeExecutor();

function chatArgs(model = "deepseek-v4.1-flash-free") {
  return {
    model,
    body: { model, messages: [{ role: "system", content: "caller system" }, { role: "user", content: "hi" }] },
    stream: true,
    credentials: { connectionId: "c1", rawHeaders: {} },
  };
}

beforeEach(() => {
  laneFetchMock.mockReset();
  tlsFetchMock.mockReset();
  emitAlertMock.mockClear();
  getSettingsMock.mockReset();
  proxyAwareMock.mockReset();
  opencodeExecTest.resetLaneAlertDedupe();
  getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "bun" });
  laneFetchMock.mockResolvedValue(new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  tlsFetchMock.mockResolvedValue(new Response("legacy", { status: 200 }));
});

/** Capture the freeLaneFetch closure without running the base retry loop. */
async function captureDirectFetch(args) {
  proxyAwareMock.mockResolvedValue(new Response("captured", { status: 200 }));
  executor.execute(args).catch(() => {});
  await vi.waitFor(() => expect(proxyAwareMock).toHaveBeenCalled());
  const [, options] = proxyAwareMock.mock.calls[0];
  const bodyStr = JSON.stringify(args.body);
  return (ctx) => options.directFetch(executor.buildUrl(args.model), { method: "POST", headers: {}, body: bodyStr }, ctx);
}

describe("opencode executor — bun free lane integration", () => {
  it("primary: v2-shaped request via the bun lane, ZERO legacy calls", async () => {
    const args = chatArgs();
    proxyAwareMock.mockImplementation(async (url, options) => {
      // mimic proxyAwareFetch's direct path: hand off to directFetch
      return options.directFetch(url, options);
    });
    await executor.execute(args);

    expect(laneFetchMock).toHaveBeenCalledTimes(1);
    expect(tlsFetchMock).not.toHaveBeenCalled();
    const [url, init] = laneFetchMock.mock.calls[0];
    expect(url).toBe(snapshot.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer public");
    expect(init.headers["user-agent"]).toBe("opencode/latest/2.2.7/cli");
    expect(init.headers["x-opencode-project"]).toBe("global");
    expect(init.headers["x-opencode-session"]).toBe(init.headers["x-session-id"]);
    expect(init.headers.accept).toBeUndefined();
    const shaped = JSON.parse(init.body);
    expect(shaped.messages[0].role).toBe("system");
    expect(shaped.messages[0].content).toContain("You are an AI agent");
    expect(shaped.messages.some((m) => m.content === "caller system")).toBe(false);
    expect(shaped.messages.some((m) => m.content === "hi")).toBe(true);
    expect(shaped.stream).toBe(true);
    expect(shaped.stream_options).toEqual({ include_usage: true });
    expect(shaped.tools.length).toBeGreaterThanOrEqual(12);
  });

  it("fail-fast: lane unavailable → typed 503, ONE critical alert, legacy NOT called", async () => {
    // real class instance for instanceof — import via the lane module
    const { OpenCodeFreeLaneUnavailableError } = await import("../../open-sse/services/opencodeBunLane.js");
    laneFetchMock.mockRejectedValue(new OpenCodeFreeLaneUnavailableError("bun gone"));

    const directFetch = await captureDirectFetch(chatArgs());
    const surfaced = await directFetch().catch((e) => e);
    expect(surfaced).toMatchObject({
      code: "OPENCODE_FREE_LANE_UNAVAILABLE",
      statusCode: 503,
      noRetry: true, // the base retry loop must not multiply lane failures
    });
    expect(surfaced.message).toContain("free lane unavailable");
    expect(tlsFetchMock).not.toHaveBeenCalled();
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitAlertMock.mock.calls[0];
    expect(eventType).toBe("opencode-bun-lane-unavailable");
    expect(payload.severity).toBe("critical");
    expect(payload.dedupKey).toBe("opencode-bun-lane");

    // second failure within the dedupe window → no second alert, still 503
    await expect(directFetch()).rejects.toMatchObject({ statusCode: 503 });
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe("opencode executor — engine kill-switch + known-refused models", () => {
  it('engine "legacy" → bun lane never called, legacy path byte-identical', async () => {
    getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "legacy" });
    const args = chatArgs();
    proxyAwareMock.mockImplementation(async (url, options) => options.directFetch(url, options));
    await executor.execute(args);
    expect(laneFetchMock).not.toHaveBeenCalled();
    expect(tlsFetchMock).toHaveBeenCalledTimes(1);
    const [url, init, opts] = tlsFetchMock.mock.calls[0];
    expect(url).toContain("/inference/v1/chat/completions");
    expect(opts.signal).toBeDefined();
  });

  it("responses/messages-format free model → legacy regardless of engine (R8)", async () => {
    const args = chatArgs("muse-spark-1.2-contributor-free"); // responses-format set
    proxyAwareMock.mockImplementation(async (url, options) => options.directFetch(url, options));
    await executor.execute(args);
    expect(laneFetchMock).not.toHaveBeenCalled();
    expect(tlsFetchMock).toHaveBeenCalledTimes(1);
    expect(tlsFetchMock.mock.calls[0][0]).toContain("/responses");
  });

  it("unmapped proxy → distinct typed 503, info-severity alert (deduped)", async () => {
    const { OpenCodeFreeLaneUnmappedProxyError } = await import("../../open-sse/services/opencodeBunLane.js");
    laneFetchMock.mockRejectedValue(new OpenCodeFreeLaneUnmappedProxyError("no inbound"));
    const directFetch = await captureDirectFetch(chatArgs());
    await expect(directFetch()).rejects.toMatchObject({
      code: "OPENCODE_FREE_LANE_UNAVAILABLE",
      statusCode: 503,
    });
    const errText = await directFetch().catch((e) => e.message);
    expect(errText).toContain("proxy pool not mappable");
    // fresh dedupe window (beforeEach resets it): the unmapped failure emits
    // ONE info-severity alert; the immediate second failure is deduped.
    const laneAlerts = emitAlertMock.mock.calls.filter((c) => c[0] === "opencode-bun-lane-unavailable");
    expect(laneAlerts.length).toBe(1);
    expect(laneAlerts[0][1].severity).toBe("info");
    await expect(directFetch()).rejects.toMatchObject({ statusCode: 503 });
    expect(emitAlertMock.mock.calls.filter((c) => c[0] === "opencode-bun-lane-unavailable").length).toBe(1);
  });

  it("upstream 429 via the bun lane passes through as a normal response", async () => {
    laneFetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "FreeUsageLimitError" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }));
    const directFetch = await captureDirectFetch(chatArgs());
    const res = await directFetch();
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("FreeUsageLimitError");
  });

  it("settings read failure does not degrade the lane decision (fail open to bun)", async () => {
    getSettingsMock.mockRejectedValue(new Error("db down"));
    const args = chatArgs();
    proxyAwareMock.mockImplementation(async (url, options) => options.directFetch(url, options));
    await executor.execute(args);
    expect(laneFetchMock).toHaveBeenCalledTimes(1);
  });
});
