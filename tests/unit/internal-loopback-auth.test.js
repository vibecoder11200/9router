// v0.6.42 follow-up: with Require API Key ON, the dashboard model-test ping
// (which can never present a raw key — keys exist only as hashes since
// v0.6.36) got "HTTP 401: Missing API key" on every model. Server-internal
// callers now authenticate with the per-install machine token (x-9r-cli-token,
// the same credential dashboardGuard already trusts) plus provable loopback
// (x-9r-real-ip is stamped by custom-server.js from the TCP socket after
// stripping client-supplied values — it cannot be forged from off-box).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async (salt) => `machine-token[${salt}]`),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  validateApiKey: vi.fn(async () => false),
  updateProviderConnection: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  getApiKeyRow: vi.fn(async () => null),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  isStrictProxyFailure: vi.fn(),
}));

vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: vi.fn(),
  checkFallbackError: vi.fn(),
  isModelLockActive: vi.fn(),
  buildModelLockUpdate: vi.fn(),
  getEarliestModelLockUntil: vi.fn(),
}));

const { isTrustedInternalRequest } = await import("../../src/sse/services/auth.js");

function req(headers = {}) {
  return { headers: new Headers(headers) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isTrustedInternalRequest", () => {
  it("accepts loopback + correct machine token (the model-test ping)", async () => {
    const r = req({
      "x-9r-real-ip": "127.0.0.1",
      "x-9r-cli-token": "machine-token[9r-cli-auth]",
    });
    expect(await isTrustedInternalRequest(r)).toBe(true);
  });

  it("accepts IPv6-mapped loopback", async () => {
    const r = req({
      "x-9r-real-ip": "::ffff:127.0.0.1",
      "x-9r-cli-token": "machine-token[9r-cli-auth]",
    });
    expect(await isTrustedInternalRequest(r)).toBe(true);
  });

  it("rejects the correct token from an off-box IP", async () => {
    const r = req({
      "x-9r-real-ip": "203.0.113.7",
      "x-9r-cli-token": "machine-token[9r-cli-auth]",
    });
    expect(await isTrustedInternalRequest(r)).toBe(false);
  });

  it("rejects a wrong token from loopback", async () => {
    const r = req({
      "x-9r-real-ip": "127.0.0.1",
      "x-9r-cli-token": "forged",
    });
    expect(await isTrustedInternalRequest(r)).toBe(false);
  });

  it("rejects missing token/headers", async () => {
    expect(await isTrustedInternalRequest(req({}))).toBe(false);
    expect(await isTrustedInternalRequest(req({ "x-9r-real-ip": "127.0.0.1" }))).toBe(false);
  });

  it("does not trust a client-asserted real-ip when the wrapper did not stamp one (bare next start)", async () => {
    // Without custom-server there is no x-9r-real-ip; a client-supplied value
    // must NOT satisfy the loopback proof.
    const r = req({
      "x-9r-real-ip": "", // wrapper absent → empty
      "x-9r-cli-token": "machine-token[9r-cli-auth]",
    });
    expect(await isTrustedInternalRequest(r)).toBe(false);
  });
});
