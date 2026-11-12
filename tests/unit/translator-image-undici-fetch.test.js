// Regression (2026-11-10 incident follow-up): fetchImageAsBase64 passed its
// SSRF IP-pinning undici Agent as a per-request `dispatcher` to the GLOBAL
// fetch — which the server runtime patches and silently strips, sending the
// request through the global dispatcher instead. That defeats the TOCTOU
// DNS-rebind pin (connect no longer pinned to the validated IP). The fetch
// must ride the package's own undici fetch, which honors the dispatcher.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  // Pin every hostname to TEST-NET-1 (192.0.2.1): passes the public-IP SSRF
  // guard, but the dial can never complete — deterministic null result.
  lookup: vi.fn(async () => [{ address: "192.0.2.1", family: 4 }]),
}));

describe("fetchImageAsBase64 bypasses the patched global fetch (SSRF pin)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("never routes through globalThis.fetch", { timeout: 10000 }, async () => {
    const spy = vi.fn(() => Promise.reject(new Error("global fetch must not be used for image prefetch")));
    globalThis.fetch = spy;
    const { fetchImageAsBase64 } = await import("../../open-sse/translator/concerns/image.js");

    const result = await fetchImageAsBase64("http://img.example/x.png", { timeoutMs: 1200 });

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
