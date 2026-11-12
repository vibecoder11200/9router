// Regression (2026-11-10 production incident): tester.js probes went through
// the server runtime's patched GLOBAL fetch, which drops the per-request
// `dispatcher` — every latency/exit-IP check silently went DIRECT. Evidence:
// all 146 "pass" rows of the free-lane model-filter run recorded exitIp equal
// to the host's own IP (see plans/reports/Audit-261111-opencode-free-filter-
// xray-leak.md). Probes must ride the package's own undici fetch (same-copy
// dispatcher pairing, immune to globalThis.fetch patching).
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";

function releasedLocalPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

describe("xray tester probes bypass the patched global fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("testProxyLatency never calls globalThis.fetch", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("global fetch must not be used by tester probes")));
    globalThis.fetch = spy;
    const { testProxyLatency } = await import("../../src/lib/xray/tester.js");

    const deadPort = await releasedLocalPort();
    const latency = await testProxyLatency(deadPort, 1500);

    // Closed port → the socks tunnel itself is unreachable → -1 regardless.
    expect(latency).toBe(-1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("testProxyExitIp never calls globalThis.fetch", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("global fetch must not be used by tester probes")));
    globalThis.fetch = spy;
    const { testProxyExitIp } = await import("../../src/lib/xray/tester.js");

    const deadPort = await releasedLocalPort();
    const ip = await testProxyExitIp(deadPort, 1500);

    expect(ip).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });
});
