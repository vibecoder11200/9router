import { beforeEach, describe, expect, it, vi } from "vitest";

const { settingsMock } = vi.hoisted(() => ({ settingsMock: vi.fn() }));

// No fs candidate exists anywhere -> the lane must refuse with the typed
// error + the tried-candidate list, NOT spawn bun at a missing path (bun
// exits 1 silently, which read as a mystery crash on a bare-standalone deploy).
vi.mock("node:fs", () => ({
  default: { existsSync: () => false, constants: {} },
  existsSync: () => false,
}));

vi.mock("@/lib/runtime/bunInstaller.js", () => ({
  BUN_VERSION: "1.4.0",
  ensureBunInstalled: vi.fn(async () => process.execPath),
  getBunBinaryPath: vi.fn(() => process.execPath),
  getInstalledBunVersion: vi.fn(() => "1.4.0"),
  isBunInstalled: vi.fn(() => true),
}));

vi.mock("@/lib/xray/httpProxyResolver.js", () => ({
  resolveXrayHttpProxyUrl: vi.fn(async () => null),
}));

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: (...a) => settingsMock(...a),
}));

import {
  __test__,
  getBunLaneStatus,
  opencodeFreeLaneFetch,
  OpenCodeFreeLaneUnavailableError,
} from "../../open-sse/services/opencodeBunLane.js";

describe("opencodeBunLane sidecar resolution", () => {
  beforeEach(() => {
    __test__.reset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue({ opencodeFreeLaneMaxConcurrency: 3 });
    delete process.env.OPENCODE_BUN_SIDECAR_SCRIPT;
  });

  it("no candidate on disk -> typed unavailable with the tried list, no spawn", async () => {
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toMatchObject({ code: "OPENCODE_BUN_LANE_UNAVAILABLE" });
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toThrow(/sidecar script not found/);
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toThrow(/tried:/);
    expect(getBunLaneStatus().busy).toBe(0); // slot never leaks on the refuse path
  });

  it("env override wins verbatim even when absent (fail-fast test affordance)", async () => {
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = "does/not/exist.mjs";
    // spawn ENOENT -> error event, not the typed not-found refuse
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toThrow(/failed twice/);
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = undefined;
  });
});