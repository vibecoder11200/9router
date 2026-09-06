// Route-level tests for GET /api/settings/database (v0.6.45). The code
// review that gated this release found the route layer had zero tests —
// and the one blocker lived exactly there (fresh installs 401ing on
// export because sealing and auth shared a single bcrypt-only check).
// Pins the auth-vs-seal split: full baseline auth semantics (stored bcrypt
// OR local default/initial password), sealing gated separately on the
// stored-hash check (RT-03), token+wrong-password rejected (RT-Cli),
// fresh installs export envelope-less + warning (RT-17).
import { describe, it, expect, beforeEach, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  verifyDashboardPasswordAgainstStoredHash: vi.fn(),
  hasValidCliToken: vi.fn(),
  checkLock: vi.fn(),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: routeMocks.exportDb,
  importDb: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: routeMocks.verifyDashboardPassword,
  verifyDashboardPasswordAgainstStoredHash: routeMocks.verifyDashboardPasswordAgainstStoredHash,
}));
vi.mock("@/dashboardGuard", () => ({ hasValidCliToken: routeMocks.hasValidCliToken }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: routeMocks.checkLock,
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: routeMocks.recordSuccess,
  getClientIp: () => "127.0.0.1",
}));

const { GET } = await import("@/app/api/settings/database/route.js");

function request(headers = {}) {
  return { headers: { get: (k) => headers[k] ?? null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.checkLock.mockReturnValue({ locked: false });
  routeMocks.exportDb.mockResolvedValue({ meta: {}, settings: {}, apiKeys: [] });
});

describe("GET /api/settings/database — auth vs seal split", () => {
  it("stored bcrypt password: authenticates AND seals (exportDb gets the password)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(true);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET(request({ "x-9r-password": "correct" }));
    expect(res.status).toBe(200);
    expect(routeMocks.exportDb).toHaveBeenCalledWith({ password: "correct" });
    expect(routeMocks.recordSuccess).toHaveBeenCalled();
  });

  it("fresh install (no stored hash): default password authenticates, export is envelope-less + warning (RT-03/RT-17)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(false);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true); // local default/initial accepted
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET(request({ "x-9r-password": "123456" }));
    expect(res.status).toBe(200);
    expect(routeMocks.exportDb).toHaveBeenCalledWith({}); // NEVER sealed under a fallback password
    const body = await res.json();
    expect(JSON.stringify(body.warnings)).toMatch(/does not include the encrypted API-key secret/);
  });

  it("valid CLI token + WRONG password: 401, no silent envelope-less downgrade (RT-Cli)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(false);
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(true);

    const res = await GET(request({ "x-9r-password": "wrong" }));
    expect(res.status).toBe(401);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
  });

  it("no password, no token: 401 (baseline unauthenticated behavior)", async () => {
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
  });

  it("locked IP: 429 before any verification", async () => {
    routeMocks.checkLock.mockReturnValue({ locked: true, retryAfter: 900 });
    const res = await GET(request({ "x-9r-password": "anything" }));
    expect(res.status).toBe(429);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
  });
});
