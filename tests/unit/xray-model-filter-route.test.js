// The model-filter POST must START the job and answer immediately. A run
// spans minutes; the old await-until-done held the HTTP request open for the
// whole job and got 408-killed by the transport while the job kept running,
// so the dashboard reported a failure for a healthy run.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runModelFilterJob: vi.fn(),
  isModelFilterRunning: vi.fn(),
  getModelFilterStatus: vi.fn(),
}));

vi.mock("@/lib/xray/manager", () => ({
  runModelFilterJob: mocks.runModelFilterJob,
  isModelFilterRunning: mocks.isModelFilterRunning,
  getModelFilterStatus: mocks.getModelFilterStatus,
}), { virtual: true });

const { POST } = await import("../../src/app/api/xray/configs/model-filter/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelFilterStatus.mockReturnValue({ status: "idle", tested: 0, passed: 0 });
});

describe("POST /api/xray/configs/model-filter", () => {
  it("starts the job and returns immediately without awaiting it", async () => {
    mocks.isModelFilterRunning.mockReturnValue(false);
    // A job that never settles: if the route awaits it, this test times out.
    let resolveJob;
    mocks.runModelFilterJob.mockReturnValue(new Promise((r) => { resolveJob = r; }));

    const startedAt = Date.now();
    const res = await POST(
      new Request("http://localhost/api/xray/configs/model-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opencode/beam-free", limit: "all" }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2000);
    const data = await res.json();
    expect(data.started).toBe(true);
    expect(data.status).toBe("idle");
    expect(mocks.runModelFilterJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opencode/beam-free", all: true, source: "manual" }),
    );
    resolveJob?.();
  });

  it("normalizes the body before starting the job", async () => {
    mocks.isModelFilterRunning.mockReturnValue(false);
    mocks.runModelFilterJob.mockResolvedValue({});

    await POST(
      new Request("http://localhost/api/xray/configs/model-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "  opencode/beam-free  ", limit: 99999, concurrency: 99, quietMs: 999999, timeoutMs: 999999, prune: true, forceRetest: true }),
      }),
    );

    expect(mocks.runModelFilterJob).toHaveBeenCalledWith(expect.objectContaining({
      model: "opencode/beam-free",
      limit: 500,        // clamped from 99999
      concurrency: 16,   // clamped from 99
      quietMs: 120000,   // clamped from 999999
      timeoutMs: 60000,  // clamped from 999999
      prune: true,
      forceRetest: true,
    }));
  });

  it("reports an already-running job as skipped instead of erroring", async () => {
    mocks.isModelFilterRunning.mockReturnValue(true);
    mocks.getModelFilterStatus.mockReturnValue({ status: "running", tested: 3, passed: 2 });

    const res = await POST(
      new Request("http://localhost/api/xray/configs/model-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opencode/beam-free" }),
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe("already_running");
    expect(mocks.runModelFilterJob).not.toHaveBeenCalled();
  });

  it("still requires a model", async () => {
    const res = await POST(
      new Request("http://localhost/api/xray/configs/model-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "   " }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.runModelFilterJob).not.toHaveBeenCalled();
  });

  it("swallows job rejections — the status endpoint reports them", async () => {
    mocks.isModelFilterRunning.mockReturnValue(false);
    let rejectJob;
    mocks.runModelFilterJob.mockReturnValue(new Promise((_, rej) => { rejectJob = rej; }));

    const res = await POST(
      new Request("http://localhost/api/xray/configs/model-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opencode/beam-free" }),
      }),
    );
    expect(res.status).toBe(200);
    // The route's .catch guard must consume the rejection: give it a tick and
    // confirm no unhandled rejection escapes.
    rejectJob?.(new Error("boom"));
    await new Promise((r) => setTimeout(r, 0));
    expect(true).toBe(true);
  });
});
