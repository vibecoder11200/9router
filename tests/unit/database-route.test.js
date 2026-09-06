// Route-level tests for GET/POST /api/settings/database. The code review
// that gated v0.6.45 found the route layer had zero tests — and the one
// blocker lived exactly there (fresh installs 401ing on export because
// sealing and auth shared a single bcrypt-only check). Pins the auth-vs-seal
// split (RT-03/RT-17/RT-Cli) and, for v0.6.46 phase 02, the whole-archive
// encryption (Option F) contracts: F-on wrapper response, plainSecrets
// release gate (RT46-A1), printable-ASCII charset gate (RT46-A3), constant
// error for wrong passphrase/corrupted archive with importDb never called
// (RT46-A4), wrapper-as-payload guard, and the archive-passphrase generator.
import { describe, it, expect, beforeEach, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  verifyDashboardPasswordAgainstStoredHash: vi.fn(),
  hasValidCliToken: vi.fn(),
  checkLock: vi.fn(),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  // archive.js mocks (RT46-O4: harness previously had none of these)
  sealArchive: vi.fn(),
  openArchive: vi.fn(),
  validateArchivePassphrase: vi.fn(),
  generateArchivePassphrase: vi.fn(),
  ArchiveError: class ArchiveError extends Error {
    constructor(message = "wrong archive passphrase or corrupted archive") {
      super(message);
      this.name = "ArchiveError";
    }
  },
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: routeMocks.exportDb,
  importDb: routeMocks.importDb,
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
vi.mock("@/lib/db/archive.js", () => ({
  sealArchive: routeMocks.sealArchive,
  openArchive: routeMocks.openArchive,
  validateArchivePassphrase: routeMocks.validateArchivePassphrase,
  generateArchivePassphrase: routeMocks.generateArchivePassphrase,
  ArchiveError: routeMocks.ArchiveError,
}));

const { GET, POST } = await import("@/app/api/settings/database/route.js");
const { GET: GET_PASSPHRASE } = await import(
  "@/app/api/settings/database/archive-passphrase/route.js"
);

function request(headers = {}) {
  return { headers: { get: (k) => headers[k] ?? null } };
}

// POST helper (RT46-O4): the route only reads body JSON + password header.
function postRequest(body, headers = {}) {
  return { headers: { get: (k) => headers[k] ?? null }, json: async () => body };
}

const SHORT_PASSPHRASE_ERROR =
  "Passphrase too short (minimum 10 characters after removing spaces and hyphens)";
const CHARSET_ERROR =
  "passphrase must be printable ASCII; spaces and hyphens are ignored by normalization";
const WRONG_ARCHIVE_ERROR = "Wrong archive passphrase or corrupted archive";
const ENCRYPTED_FILE_GUARD =
  "This backup file is encrypted — re-import it and provide its passphrase";

// Synthetic test values only — never real credentials. The passphrase literal
// is asserted to appear in NO console/log call (RT46-A4 grep discipline).
const TEST_PASSPHRASE = "archive-test-passphrase-2609";

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.checkLock.mockReturnValue({ locked: false });
  routeMocks.exportDb.mockResolvedValue({ meta: {}, settings: {}, apiKeys: [] });
  routeMocks.importDb.mockResolvedValue({ warnings: [], needsRekeyCount: 0 });
  routeMocks.validateArchivePassphrase.mockReturnValue(true);
  routeMocks.sealArchive.mockResolvedValue({
    format: "9router-encrypted-archive",
    v: 1,
    envelope: { v: 1, cipher: "aes-256-gcm", ct: "mock" },
  });
  routeMocks.generateArchivePassphrase.mockReturnValue("MOCK-GENERATED-PASSPHRASE");
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

describe("GET /api/settings/database — F mode (x-9r-archive-passphrase)", () => {
  it("pwOk + valid passphrase: 200, body IS the sealed wrapper, exportDb called with EXACTLY {plainSecrets:true}", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(true);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET(
      request({ "x-9r-password": "correct", "x-9r-archive-passphrase": TEST_PASSPHRASE })
    );
    expect(res.status).toBe(200);
    expect(routeMocks.exportDb).toHaveBeenCalledTimes(1);
    expect(routeMocks.exportDb).toHaveBeenCalledWith({ plainSecrets: true });
    // NEVER {password} + plainSecrets together (F suppresses the inner envelope).
    const call = routeMocks.exportDb.mock.calls[0][0];
    expect(call.password).toBeUndefined();

    const body = await res.json();
    expect(body.format).toBe("9router-encrypted-archive");
    expect(body.meta).toBeUndefined(); // wrapper shape, not the payload
    expect(body.envelope).toBeDefined();

    expect(routeMocks.sealArchive).toHaveBeenCalledTimes(1);
    const [jsonArg, passArg] = routeMocks.sealArchive.mock.calls[0];
    expect(JSON.parse(jsonArg).meta).toEqual({}); // the serialized payload
    expect(passArg).toBe(TEST_PASSPHRASE);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("valid CLI token (no password) + valid passphrase: F export allowed (release gate is pwOk || viaCliToken)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(false);
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(true);

    const res = await GET(request({ "x-9r-archive-passphrase": TEST_PASSPHRASE }));
    expect(res.status).toBe(200);
    expect(routeMocks.exportDb).toHaveBeenCalledWith({ plainSecrets: true });
  });

  it("short passphrase: 400 with the length message, exportDb and sealArchive never called", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(true);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    routeMocks.validateArchivePassphrase.mockReturnValue(false);

    const res = await GET(
      request({ "x-9r-password": "correct", "x-9r-archive-passphrase": "short" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(SHORT_PASSPHRASE_ERROR);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
    expect(routeMocks.sealArchive).not.toHaveBeenCalled();
  });

  it("non-printable-ASCII passphrase: 400 charset error before any export (RT46-A3)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(true);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    // validate mocked true — proves the charset gate runs FIRST.
    routeMocks.validateArchivePassphrase.mockReturnValue(true);

    const res = await GET(
      request({ "x-9r-password": "correct", "x-9r-archive-passphrase": "pass-with-ü-and-✓-chars" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(CHARSET_ERROR);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
    expect(routeMocks.sealArchive).not.toHaveBeenCalled();
  });

  it("authOk-only (default/initial password, NOT pwOk, no CLI token): 401, exportDb NEVER called with plainSecrets (RT46-A1)", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(false);
    routeMocks.verifyDashboardPassword.mockResolvedValue(true); // local default accepted
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET(
      request({ "x-9r-password": "123456", "x-9r-archive-passphrase": TEST_PASSPHRASE })
    );
    expect(res.status).toBe(401);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
    expect(routeMocks.sealArchive).not.toHaveBeenCalled();
  });

  it("wrong password with F header: 401 from the limiter path, exportDb never called", async () => {
    routeMocks.verifyDashboardPasswordAgainstStoredHash.mockResolvedValue(false);
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET(
      request({ "x-9r-password": "wrong", "x-9r-archive-passphrase": TEST_PASSPHRASE })
    );
    expect(res.status).toBe(401);
    expect(routeMocks.exportDb).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/database — archive import (F)", () => {
  it("happy path: importDb called once with the decrypted inner object + current password", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    const inner = { meta: { installId: "install-a" }, settings: {}, apiKeys: [] };
    routeMocks.openArchive.mockResolvedValue(JSON.stringify(inner));

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        archivePassphrase: TEST_PASSPHRASE,
        password: "current-password",
      })
    );
    expect(res.status).toBe(200);
    expect(routeMocks.openArchive).toHaveBeenCalledTimes(1);
    const [archiveArg, passArg] = routeMocks.openArchive.mock.calls[0];
    expect(archiveArg).toMatchObject({ format: "9router-encrypted-archive" });
    expect(passArg).toBe(TEST_PASSPHRASE);
    expect(routeMocks.importDb).toHaveBeenCalledTimes(1);
    expect(routeMocks.importDb).toHaveBeenCalledWith(inner, { password: "current-password" });
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("missing archivePassphrase: openArchive receives empty string, failure yields the constant 400", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    routeMocks.openArchive.mockRejectedValue(new routeMocks.ArchiveError());

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    expect(routeMocks.openArchive.mock.calls[0][1]).toBe("");
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("wrong passphrase (ArchiveError): 400 constant error, importDb NOT called (no wipe possible)", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    routeMocks.openArchive.mockRejectedValue(new routeMocks.ArchiveError());

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        archivePassphrase: "definitely-not-the-right-one",
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(WRONG_ARCHIVE_ERROR);
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("decrypted but non-JSON payload: 400 constant, importDb NOT called (RT46-A4 — parse errors never leak snippets)", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    routeMocks.openArchive.mockResolvedValue("this is not json {{{");

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        archivePassphrase: TEST_PASSPHRASE,
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(WRONG_ARCHIVE_ERROR);
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("decrypted JSON that is not an object: 400 constant, importDb NOT called (shape sanity)", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);
    routeMocks.openArchive.mockResolvedValue(JSON.stringify("just a string"));

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        archivePassphrase: TEST_PASSPHRASE,
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(WRONG_ARCHIVE_ERROR);
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("non-printable-ASCII archivePassphrase in the body: 400 charset error before openArchive (RT46-A3)", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await POST(
      postRequest({
        archive: { format: "9router-encrypted-archive", v: 1, envelope: { v: 1 } },
        archivePassphrase: "pass-with-ü-chars",
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(CHARSET_ERROR);
    expect(routeMocks.openArchive).not.toHaveBeenCalled();
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("wrapper accidentally posted as payload (format key, no archive key): clear 400, importDb NOT called", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await POST(
      postRequest({
        format: "9router-encrypted-archive",
        v: 1,
        envelope: { v: 1 },
        password: "current-password",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(ENCRYPTED_FILE_GUARD);
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });

  it("legacy plaintext branch stays byte-compatible: importDb gets payload minus password", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await POST(
      postRequest({
        meta: { installId: "install-a" },
        settings: {},
        apiKeys: [],
        password: "current-password",
      })
    );
    expect(res.status).toBe(200);
    expect(routeMocks.importDb).toHaveBeenCalledTimes(1);
    expect(routeMocks.importDb).toHaveBeenCalledWith(
      { meta: { installId: "install-a" }, settings: {}, apiKeys: [] },
      { password: "current-password" }
    );
  });

  it("unauthenticated POST: 401, importDb never called", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await POST(postRequest({ archive: { v: 1 }, archivePassphrase: TEST_PASSPHRASE }));
    expect(res.status).toBe(401);
    expect(routeMocks.importDb).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/database/archive-passphrase — generator endpoint", () => {
  it("authenticated (password): 200 {passphrase}, no-store", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(true);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET_PASSPHRASE(request({ "x-9r-password": "correct" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passphrase).toBe("MOCK-GENERATED-PASSPHRASE");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("authenticated (CLI token, no password): 200", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(true);

    const res = await GET_PASSPHRASE(request());
    expect(res.status).toBe(200);
    expect((await res.json()).passphrase).toBe("MOCK-GENERATED-PASSPHRASE");
  });

  it("unauthenticated: 401 via the limiter path", async () => {
    routeMocks.verifyDashboardPassword.mockResolvedValue(false);
    routeMocks.hasValidCliToken.mockResolvedValue(false);

    const res = await GET_PASSPHRASE(request());
    expect(res.status).toBe(401);
  });
});
