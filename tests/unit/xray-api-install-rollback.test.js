// Route-level contract for POST /api/xray/install/rollback — the dashboard's
// one-click restore of the `.prev` binary (RT-5). Manager mocked: the file
// choreography is covered by xray-rollback-version.test.js.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/xray/manager", () => ({
  rollbackXrayOrchestrated: vi.fn(),
}));

const { POST } = await import("@/app/api/xray/install/rollback/route.js");
const { rollbackXrayOrchestrated } = await import("@/lib/xray/manager");

describe("POST /api/xray/install/rollback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the restored version and restart state", async () => {
    rollbackXrayOrchestrated.mockResolvedValue({ rolledBack: true, version: "v26.3.27", restarted: true });
    const res = await POST(new Request("http://localhost:20127/api/xray/install/rollback", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, rolledBack: true, version: "v26.3.27", restarted: true });
  });

  it("maps NO_PREV to 400 and INSTALL_IN_PROGRESS to 409", async () => {
    for (const [code, status] of [["NO_PREV", 400], ["INSTALL_IN_PROGRESS", 409]]) {
      const err = new Error("boom");
      err.code = code;
      rollbackXrayOrchestrated.mockRejectedValueOnce(err);
      const res = await POST(new Request("http://localhost:20127/api/xray/install/rollback", { method: "POST" }));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.code).toBe(code);
    }
  });

  it("a restart failure still reports 200 — the rollback itself succeeded", async () => {
    rollbackXrayOrchestrated.mockResolvedValue({
      rolledBack: true, version: "v26.3.27", restarted: false, restartError: "SOCKS port did not open",
    });
    const res = await POST(new Request("http://localhost:20127/api/xray/install/rollback", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restarted).toBe(false);
    expect(body.restartError).toBe("SOCKS port did not open");
  });

  it("unknown errors map to 500 with the message", async () => {
    rollbackXrayOrchestrated.mockRejectedValue(new Error("disk on fire"));
    const res = await POST(new Request("http://localhost:20127/api/xray/install/rollback", { method: "POST" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("disk on fire");
    expect(body.code).toBeNull();
  });
});
