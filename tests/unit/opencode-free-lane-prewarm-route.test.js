import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureMock, isInstalledMock, versionMock } = vi.hoisted(() => ({
  ensureMock: vi.fn(),
  isInstalledMock: vi.fn(),
  versionMock: vi.fn(),
}));

vi.mock("@/lib/runtime/bunInstaller.js", () => ({
  ensureBunInstalled: (...a) => ensureMock(...a),
  isBunInstalled: (...a) => isInstalledMock(...a),
  getInstalledBunVersion: (...a) => versionMock(...a),
}));

import { POST } from "../../src/app/api/opencode-free-lane/prewarm/route.js";

beforeEach(() => {
  ensureMock.mockReset();
  isInstalledMock.mockReset();
  versionMock.mockReset();
  isInstalledMock.mockReturnValue(true);
  versionMock.mockReturnValue("1.4.0");
  ensureMock.mockResolvedValue("/data/bun/bun");
});

describe("POST /api/opencode-free-lane/prewarm", () => {
  it("installs and reports the resulting state", async () => {
    isInstalledMock.mockReturnValueOnce(false).mockReturnValueOnce(true); // before / after
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, installed: true, version: "1.4.0", alreadyInstalled: false });
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: already-installed stays a no-op success", async () => {
    isInstalledMock.mockReturnValue(true);
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alreadyInstalled).toBe(true);
    expect(body.installed).toBe(true);
  });

  it("installer failure -> 500 with ok:false + current install state", async () => {
    ensureMock.mockRejectedValue(new Error("download failed: ETIMEDOUT"));
    isInstalledMock.mockReturnValue(false);
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.installed).toBe(false);
    expect(body.error).toContain("ETIMEDOUT");
  });

  it("POST only: no GET/PUT/PATCH/DELETE exports", async () => {
    const route = await import("../../src/app/api/opencode-free-lane/prewarm/route.js");
    expect(route.GET).toBeUndefined();
    expect(route.PUT).toBeUndefined();
    expect(route.PATCH).toBeUndefined();
    expect(route.DELETE).toBeUndefined();
  });
});