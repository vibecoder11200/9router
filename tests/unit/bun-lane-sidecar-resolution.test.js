import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const { settingsMock, existsSyncMock, spawnSpy } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
  spawnSpy: vi.fn(),
}));

// existsSync drives the sidecar-candidate scan (default false = no candidate
// on disk anywhere). spawn is a pass-through to the real child_process so the
// spawn-flow tests below still behave, but every call is recorded for
// asserting WHICH candidate path got spawned.
vi.mock("node:fs", () => ({
  default: { existsSync: (...a) => existsSyncMock(...a), constants: {} },
  existsSync: (...a) => existsSyncMock(...a),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => {
      spawnSpy(...args);
      return actual.spawn(...args);
    },
  };
});

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
} from "../../open-sse/services/opencodeBunLane.js";

describe("opencodeBunLane sidecar resolution", () => {
  beforeEach(() => {
    __test__.reset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue({ opencodeFreeLaneMaxConcurrency: 3 });
    delete process.env.OPENCODE_BUN_SIDECAR_SCRIPT;
    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation(() => false);
    spawnSpy.mockClear();
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
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("env override wins verbatim even when absent (fail-fast test affordance)", async () => {
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = "does/not/exist.mjs";
    // spawn ENOENT -> error event, not the typed not-found refuse
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toThrow(/failed twice/);
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = undefined;
  });

  it("npm CLI layout: <pkg>/app/open-sse/services candidate resolves and is the spawned script", async () => {
    // Only the app/-relative candidate "exists" on the mocked fs — so if the
    // lane spawns anything, it MUST have resolved through the new candidate.
    const cliLayoutSuffix = path.join("app", "open-sse", "services", "opencodeBunSidecar.mjs");
    existsSyncMock.mockImplementation(
      (p) => typeof p === "string" && p.endsWith(cliLayoutSuffix),
    );
    // The mocked fs is the only place this path exists, so the real spawn
    // fails with ENOENT — that's fine: we're asserting resolution, and the
    // lane surfaces the spawn failure as its typed failed-twice error.
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }),
    ).rejects.toThrow(/failed twice/);
    const spawnedScripts = spawnSpy.mock.calls.map((c) => c[1] && c[1][0]);
    expect(
      spawnedScripts.some((s) => typeof s === "string" && s.endsWith(cliLayoutSuffix)),
    ).toBe(true);
    expect(spawnedScripts.some((s) => typeof s === "string" && !s.endsWith(cliLayoutSuffix))).toBe(false);
  });
});
