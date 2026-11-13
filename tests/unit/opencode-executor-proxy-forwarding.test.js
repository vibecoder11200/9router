// The executor must forward the proxy URL it is handed by proxyAwareFetch.
// Isolated from the transport tests: mocking opencodeTlsClient.js here would
// otherwise replace the real module under test in sibling suites.
// Fork adaptation: the free lane is forced onto the legacy wreq transport
// (opencodeFreeLaneEngine: "legacy") so the bun lane never spawns, and the
// alerts module is stubbed like every other executor suite.
// vi.mock must live at module top level — vitest >=4 (we pin ^5.1.0) rejects
// mocks defined inside it() at collection time.
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

describe("opencode executor forwards the resolved proxy", () => {
  beforeEach(() => {
    getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "legacy" });
    tlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  it("passes the proxy URL through to opencodeTlsFetch", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    const exec = new OpenCodeExecutor("opencode", { baseUrl: "https://opencode.ai" });

    try {
      await exec.execute({
        model: "oc/gpt-oss-120b",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: {},
        proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050" },
      });
    } catch {
      // execute() talks to the real network upstream; the wiring assertion is
      // on the adapter call below, not on its outcome.
    }

    expect(tlsFetchMock).toHaveBeenCalled();
    expect(tlsFetchMock.mock.calls[0][2].proxyUrl).toBe("socks5://127.0.0.1:9050");
  });
});
