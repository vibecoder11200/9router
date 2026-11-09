// Phase 01 (P5/P1): proxyAwareFetch strict-proxy policy — an env-var proxy is
// never a substitute for a missing connection proxy under strictProxy, an
// enabled-but-unresolvable connection proxy refuses outright, and dispatcher
// usage is tracked (fetch receives the dispatcher when a proxy is used).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// proxyFetch fetches through the package's own undici instance (rawFetch,
// upstream v0.5.116) — the undici mock below is what requests hit.
// socksDispatcher/undici are mocked so no real agents are built (undici is
// not resolvable from src/** in this environment, and no sockets are touched).
const { fetchMock, FakeProxyAgent, FakeDirectAgent } = vi.hoisted(() => {
  class FakeProxyAgent {
    constructor(opts = {}) { this.uri = opts?.uri || "fake-proxy"; }
    close() { return Promise.resolve(); }
  }
  class FakeDirectAgent {
    constructor() { this.uri = "direct"; }
    close() { return Promise.resolve(); }
  }
  return { fetchMock: vi.fn(async () => new Response("ok")), FakeProxyAgent, FakeDirectAgent };
});
vi.mock("@/lib/network/socksDispatcher.js", () => ({
  isSocksProxyUrl: (u) => /^socks/i.test(u),
  createSocksDispatcher: () => ({ close: async () => {} }),
}), { virtual: true });
vi.mock("undici", () => ({
  ProxyAgent: FakeProxyAgent,
  Agent: FakeDirectAgent,
  fetch: fetchMock,
}), { virtual: true });

let proxyAwareFetch;
let proxyFetchModule;

beforeAll(async () => {
  proxyFetchModule = await import("open-sse/utils/proxyFetch.js");
  proxyAwareFetch = proxyFetchModule.proxyAwareFetch;
});

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

beforeEach(() => {
  fetchMock.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("strict env-proxy policy (P1/P5)", () => {
  it("strict + enabled + empty URL → refuses (never direct, never env)", async () => {
    await expect(
      proxyAwareFetch("https://api.example.com/v1", {}, {
        connectionProxyEnabled: true,
        connectionProxyUrl: "",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strict + no connection proxy + env proxy set → env proxy IGNORED, no dispatcher", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const res = await proxyAwareFetch("https://api.example.com/v1", {}, {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Direct call — the shared direct agent serves it; the env proxy must NOT
    // have contributed a ProxyAgent dispatcher.
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeInstanceOf(FakeDirectAgent);
  });

  it("strict + healthy connection proxy → fetch goes through the dispatcher", async () => {
    const res = await proxyAwareFetch("https://api.example.com/v1", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:8080",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeInstanceOf(FakeProxyAgent);
  });

  it("strict + proxy fetch failure → throws (no direct fallback)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("proxy tunnel collapsed"));
    await expect(
      proxyAwareFetch("https://api.example.com/v1", {}, {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://conn-proxy:8081",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
  });

  it("non-strict + env proxy set → env proxy dispatcher IS used", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    await proxyAwareFetch("https://api.example.com/v1", {}, null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeInstanceOf(FakeProxyAgent);
  });

  it("noProxy bypass is honored even under strict (explicit per-host direct)", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const res = await proxyAwareFetch("https://intranet.example.com/v1", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:8080",
      connectionNoProxy: "intranet.example.com",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    // Intentional direct hop — the shared direct agent, never the proxy.
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeInstanceOf(FakeDirectAgent);
  });
});
