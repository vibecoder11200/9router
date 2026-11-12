import { beforeEach, describe, expect, it, vi } from "vitest";

const { laneStatusMock, bunInstalledMock, bunVersionMock, wireSnapshotMock, getSettingsMock } = vi.hoisted(() => ({
  laneStatusMock: vi.fn(),
  bunInstalledMock: vi.fn(),
  bunVersionMock: vi.fn(),
  wireSnapshotMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("open-sse/services/opencodeBunLane.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getBunLaneStatus: laneStatusMock,
  };
});

vi.mock("@/lib/runtime/bunInstaller.js", () => ({
  isBunInstalled: (...a) => bunInstalledMock(...a),
  getInstalledBunVersion: (...a) => bunVersionMock(...a),
}));

vi.mock("open-sse/providers/opencodeWire.js", () => ({
  getEmbeddedWireSnapshot: wireSnapshotMock,
}));

vi.mock("@/lib/localDb.js", () => ({
  getSettings: (...a) => getSettingsMock(...a),
}));

import { GET } from "../../src/app/api/opencode-free-lane/route.js";
import { __test__ as execTest, getLaneUnavailableAlertAt } from "open-sse/executors/opencode.js";

beforeEach(() => {
  laneStatusMock.mockReset();
  bunInstalledMock.mockReset();
  bunVersionMock.mockReset();
  wireSnapshotMock.mockReset();
  getSettingsMock.mockReset();
  execTest.resetLaneAlertDedupe();
  laneStatusMock.mockReturnValue({
    installed: true,
    bunVersion: "1.4.0",
    busy: 0,
    queued: 0,
    maxConcurrency: 3,
    lastErrorAt: null,
    lastError: null,
  });
  bunInstalledMock.mockReturnValue(true);
  bunVersionMock.mockReturnValue("1.4.0");
  wireSnapshotMock.mockReturnValue({
    clientVersion: "2.2.7",
    sourceSha: "abc123",
    capturedAt: "2026-11-12T00:00:00.000Z",
  });
  getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "bun" });
});

describe("GET /api/opencode-free-lane", () => {
  it("read-only shape: engine, bun, lane (+modelsKnownRefused), snapshot, lastUnavailableAlertAt", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.engine).toBe("bun");
    expect(body.bun).toEqual({ installed: true, version: "1.4.0" });
    expect(body.lane.modelsKnownRefused).toEqual([
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
      "union-alpha",
    ]);
    expect(body.snapshot).toEqual({ clientVersion: "2.2.7", sourceSha: "abc123", capturedAt: "2026-11-12T00:00:00.000Z" });
    expect(body.lastUnavailableAlertAt).toBeNull();
    expect(getLaneUnavailableAlertAt()).toBeNull();
  });

  it("engine from settings (legacy kill-switch observable)", async () => {
    getSettingsMock.mockResolvedValue({ opencodeFreeLaneEngine: "legacy" });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.engine).toBe("legacy");
  });

  it("settings read failure → fail-open (route catches, engine falls back to bun)", async () => {
    getSettingsMock.mockRejectedValue(new Error("db down"));
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.engine).toBe("bun");
    expect(getLaneUnavailableAlertAt()).toBeNull();
  });

  it("GET only: no POST/PUT/PATCH/DELETE exports", async () => {
    const route = await import("../../src/app/api/opencode-free-lane/route.js");
    expect(route.POST).toBeUndefined();
    expect(route.PUT).toBeUndefined();
    expect(route.PATCH).toBeUndefined();
    expect(route.DELETE).toBeUndefined();
  });
});
