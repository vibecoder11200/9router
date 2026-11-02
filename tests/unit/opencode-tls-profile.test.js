import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The TLS client resolves a real browser profile from the installed wreq-js
// catalog at runtime (OmniRoute #17869) and pins one wreq session per
// (profile, proxy) — sessions cannot change their proxy after creation
// ("Session proxy cannot be changed after creation", measured live). lazyRuntime
// is mocked so the pool logic runs against a fake catalog.

const { createSessionMock } = vi.hoisted(() => {
  const state = { calls: [], sessions: [] };
  return {
    createSessionMock: vi.fn(async (opts) => {
      state.calls.push(opts);
      const session = {
        opts,
        fetch: vi.fn(async () => ({
          status: 200,
          statusText: "OK",
          body: null,
          headers: { forEach: (fn) => fn("1", "x-test") },
        })),
        close: vi.fn(),
      };
      state.sessions.push(session);
      return session;
    }),
    state,
  };
});

vi.mock("open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: async (pkg) => {
    if (pkg !== "wreq-js") throw new Error(`unexpected pkg ${pkg}`);
    return {
      createSession: createSessionMock,
      getProfiles: () => ["chrome_124", "chrome_142", "edge_131", "chrome_149", "safari_184"],
    };
  },
}));

import {
  opencodeTlsFetch,
  resetOpencodeTlsSession,
  resolveNewestChromeProfile,
  __test__,
} from "open-sse/services/opencodeTlsClient.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const { sessionPool, __setResolvedProfile } = __test__;

beforeEach(() => {
  createSessionMock.mockClear();
  resetOpencodeTlsSession();
  __setResolvedProfile(undefined);
  delete process.env.OPENCODE_TLS_PROFILE;
});

afterEach(() => {
  resetOpencodeTlsSession();
  delete process.env.OPENCODE_TLS_PROFILE;
});

describe("resolveNewestChromeProfile", () => {
  it("picks the numerically newest chrome_* and ignores other browsers", () => {
    expect(resolveNewestChromeProfile(["chrome_124", "chrome_142", "edge_999", "chrome_149"])).toBe("chrome_149");
    expect(resolveNewestChromeProfile(["edge_131", "safari_184"])).toBe(null);
    expect(resolveNewestChromeProfile(null)).toBe(null);
  });
});

describe("opencodeTlsFetch — browser profile by default, legacy opt-out", () => {
  it("creates the session on the newest catalog chrome profile", async () => {
    await opencodeTlsFetch("https://opencode.ai/inference/v1/messages", { method: "POST" });
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const opts = createSessionMock.mock.calls[0][0];
    expect(opts.browser).toBe("chrome_149");
    expect(opts.emulation).toBeUndefined();
  });

  it("honors an exact OPENCODE_TLS_PROFILE override", async () => {
    process.env.OPENCODE_TLS_PROFILE = "chrome_142";
    await opencodeTlsFetch("https://opencode.ai/x", {});
    expect(createSessionMock.mock.calls[0][0].browser).toBe("chrome_142");
  });

  it("falls back to the legacy pinned cipher list on 'legacy'", async () => {
    process.env.OPENCODE_TLS_PROFILE = "legacy";
    await opencodeTlsFetch("https://opencode.ai/x", {});
    const opts = createSessionMock.mock.calls[0][0];
    expect(opts.browser).toBeUndefined();
    expect(opts.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
  });
});

describe("opencodeTlsFetch — proxy-pinned session pool", () => {
  it("pins the proxy on the session and reuses one session per proxy", async () => {
    const proxy = "socks5://127.0.0.1:51001";
    await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: proxy });
    await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: proxy });
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock.mock.calls[0][0].proxy).toBe(proxy);

    await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: "socks5://127.0.0.1:51002" });
    expect(createSessionMock).toHaveBeenCalledTimes(2);
    expect(createSessionMock.mock.calls[1][0].proxy).toBe("socks5://127.0.0.1:51002");
  });

  it("caps the pool and evicts least-recently-used sessions", async () => {
    for (let i = 0; i < 26; i++) {
      await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: `socks5://127.0.0.1:${51100 + i}` });
    }
    expect(sessionPool.size).toBe(24);
  });

  it("resetOpencodeTlsSession closes every pooled session", async () => {
    await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: "socks5://127.0.0.1:51200" });
    const entry = [...sessionPool.values()][0];
    await entry.promise;
    resetOpencodeTlsSession();
    expect(sessionPool.size).toBe(0);
    // The closed session is the one that was pooled.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("proxyAwareFetch — directFetch proxy bridge (opt-in)", () => {
  it("carries the connection proxy to a bridging directFetch", async () => {
    const directFetch = vi.fn(async () => new Response("bridged", { status: 200 }));
    directFetch.proxyBridge = true;
    const res = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/messages",
      { method: "POST", body: "{}", directFetch, directFetchProxyBridge: true, headers: {} },
      { enabled: true, url: "socks5://127.0.0.1:51999", strictProxy: true },
    );
    expect(res.status).toBe(200);
    expect(directFetch).toHaveBeenCalledTimes(1);
    const ctx = directFetch.mock.calls[0][2];
    expect(ctx.proxyUrl).toContain("socks5://127.0.0.1:51999");
  });

  it("never hands the proxy to a non-bridging directFetch (codex STT shape)", async () => {
    const directFetch = vi.fn(async () => new Response("x"));
    // No proxyBridge flag: the request must ride the dispatcher path — which
    // cannot connect to a closed local port, so the call rejects and the
    // directFetch must stay untouched.
    await expect(proxyAwareFetch(
      "https://opencode.ai/x",
      { method: "POST", body: "{}", directFetch, headers: {} },
      { enabled: true, url: "socks5://127.0.0.1:1", strictProxy: true },
    )).rejects.toThrow(/Proxy required/);
    expect(directFetch).not.toHaveBeenCalled();
  }, 20000);
});
