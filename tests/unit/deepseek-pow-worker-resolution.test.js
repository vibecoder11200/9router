import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => false) }));

// existsSync drives the worker-candidate scan (default false = nothing on
// disk). deepseek-pow.js also imports findDeepSeekPowNonce from
// ./deepseek-pow-hash.js — the real module is fine (pure functions).
vi.mock("node:fs", () => ({
  existsSync: (...a) => existsSyncMock(...a),
}));

import { __test__ } from "../../open-sse/lib/deepseek-pow.js";

const WORKER_NAME = path.join("open-sse", "lib", "deepseek-pow-worker.mjs");

describe("DeepSeek PoW worker resolution", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation(() => false);
  });

  it("cwd candidate still wins first (back-compat: repo root / normal CLI launch)", () => {
    const entry = path.dirname(path.resolve(process.argv[1] || "x.js"));
    const cwdCandidate = path.join(process.cwd(), WORKER_NAME);
    const cliCandidate = path.join(entry, "app", WORKER_NAME);
    existsSyncMock.mockImplementation((p) => p === cwdCandidate || p === cliCandidate);
    expect(__test__.resolveWorkerPath()).toBe(cwdCandidate);
  });

  it("npm CLI layout (<entry-dir>/app/open-sse/lib) resolves when cwd misses", () => {
    const cliCandidate = path.join(
      path.dirname(path.resolve(process.argv[1] || "x.js")), "app", WORKER_NAME,
    );
    existsSyncMock.mockImplementation((p) => p === cliCandidate);
    expect(__test__.resolveWorkerPath()).toBe(cliCandidate);
  });

  it("bare-standalone layout (<entry-dir>/open-sse/lib) resolves when earlier candidates miss", () => {
    const standaloneCandidate = path.join(
      path.dirname(path.resolve(process.argv[1] || "x.js")), WORKER_NAME,
    );
    existsSyncMock.mockImplementation((p) => p === standaloneCandidate);
    expect(__test__.resolveWorkerPath()).toBe(standaloneCandidate);
  });

  it("nothing on disk -> error names every candidate tried", () => {
    expect(() => __test__.resolveWorkerPath()).toThrow(/DeepSeek PoW worker script not found \(tried:/);
  });
});
