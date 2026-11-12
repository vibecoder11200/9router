import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The lane runs the REAL child script under node (OPENCODE_BUN_PATH=node) —
// full protocol through the manager, no bun required for the unit suite.
const SIDECAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../open-sse/services/opencodeBunSidecar.mjs",
);

vi.mock("@/lib/runtime/bunInstaller.js", () => ({
  BUN_VERSION: "1.4.0",
  ensureBunInstalled: vi.fn(async () => process.execPath),
  getBunBinaryPath: vi.fn(() => process.execPath),
  getInstalledBunVersion: vi.fn(() => "1.4.0"),
  isBunInstalled: vi.fn(() => true),
}));

vi.mock("@/lib/xray/httpProxyResolver.js", () => ({
  resolveXrayHttpProxyUrl: vi.fn(async () => null),
}));

import {
  __test__,
  getBunLaneStatus,
  opencodeFreeLaneFetch,
  OpenCodeFreeLaneBusyError,
  OpenCodeFreeLaneUnavailableError,
  OpenCodeFreeLaneUnmappedProxyError,
} from "../../open-sse/services/opencodeBunLane.js";

const ORIG = {
  bunPath: process.env.OPENCODE_BUN_PATH,
  sidecar: process.env.OPENCODE_BUN_SIDECAR_SCRIPT,
};

let server;
let serverUrl;

function sseServer(handler) {
  server.removeAllListeners("request");
  server.on("request", handler);
}

beforeEach(async () => {
  __test__.reset();
  process.env.OPENCODE_BUN_PATH = process.execPath;
  process.env.OPENCODE_BUN_SIDECAR_SCRIPT = SIDECAR;
  server = http.createServer(() => {});
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((res) => server.close(res));
  if (ORIG.bunPath === undefined) delete process.env.OPENCODE_BUN_PATH;
  else process.env.OPENCODE_BUN_PATH = ORIG.bunPath;
  if (ORIG.sidecar === undefined) delete process.env.OPENCODE_BUN_SIDECAR_SCRIPT;
  else process.env.OPENCODE_BUN_SIDECAR_SCRIPT = ORIG.sidecar;
});

describe("opencodeBunLane manager", () => {
  it("streams a 200 through a real child and frees the slot at stream end", { timeout: 20_000 }, async () => {
    sseServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => {
        res.write("data: two\n\n");
        res.end();
      }, 150);
    });

    const res = await opencodeFreeLaneFetch(serverUrl, { method: "GET" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("one");
    expect(text).toContain("two");
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 10_000 });
  });

  it("429 passthrough is a normal Response (rotation semantics untouched)", { timeout: 20_000 }, async () => {
    sseServer((req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "FreeUsageLimitError" }));
    });
    const res = await opencodeFreeLaneFetch(serverUrl, { method: "GET" });
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toContain("FreeUsageLimitError");
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 10_000 });
  });

  it("fail-fast: spawn failure retried ONCE, then typed unavailable", { timeout: 30_000 }, async () => {
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = path.join("does", "not", "exist.mjs");
    await expect(opencodeFreeLaneFetch(serverUrl, { method: "GET" })).rejects.toThrow(/failed twice/);
    await expect(opencodeFreeLaneFetch(serverUrl, { method: "GET" })).rejects.toBeInstanceOf(
      OpenCodeFreeLaneUnavailableError,
    );
    expect(getBunLaneStatus().lastError).toMatch(/failed twice/);
    // restore for any later test in this file
    process.env.OPENCODE_BUN_SIDECAR_SCRIPT = SIDECAR;
  });
});

describe("opencodeBunLane semaphore", () => {
  it("≤3 concurrent children; 4th queues; queue timeout → typed error", { timeout: 30_000 }, async () => {
    sseServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("hold\n");
      req.on("close", () => res.destroy());
    });
    const holders = [1, 2, 3].map(() => opencodeFreeLaneFetch(serverUrl, { method: "GET" }));
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(3), { timeout: 15_000 });
    const queued = opencodeFreeLaneFetch(serverUrl, { method: "GET" }, { queueTimeoutMs: 400 });
    // saturation is BUSY, not unavailable — a healthy lane under load must not
    // page as an outage (review P2-4)
    await expect(queued).rejects.toBeInstanceOf(OpenCodeFreeLaneBusyError);
    await expect(queued).rejects.toThrow(/queue timeout/);
    // drain the holders via their bodies (stream end frees slots)
    holders.forEach(async (p) => {
      try {
        const r = await p;
        await r.body?.cancel();
      } catch { /* holder may error when server closes */ }
    });
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 10_000 });
  });

  it("abort mid-stream kills the child fast (quota-safety)", { timeout: 20_000 }, async () => {
    sseServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: start\n\n");
      req.on("close", () => res.destroy());
    });
    const controller = new AbortController();
    const resPromise = opencodeFreeLaneFetch(serverUrl, { method: "GET" }, { signal: controller.signal });
    const res = await resPromise;
    expect(res.status).toBe(200);
    controller.abort();
    // child killed → exit → slot released within ~100ms of the abort
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 3_000, interval: 25 });
  });

  it("body cancel kills the child (consumer cancel path)", { timeout: 20_000 }, async () => {
    sseServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: start\n\n");
      req.on("close", () => res.destroy());
    });
    const res = await opencodeFreeLaneFetch(serverUrl, { method: "GET" });
    await res.body.cancel();
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 3_000, interval: 25 });
  });

  it("abort during the header phase rejects fast as AbortError and kills the child (review P0-1)", { timeout: 20_000 }, async () => {
    // silent upstream: headers never arrive — the pre-first-line window
    sseServer((req, res) => {
      req.on("close", () => res.destroy()); // never writes headers
    });
    const controller = new AbortController();
    const t0 = Date.now();
    const pending = opencodeFreeLaneFetch(serverUrl, { method: "GET" }, { signal: controller.signal, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(1), { timeout: 10_000 });
    const settle = pending.then(
      (r) => ({ kind: "resolved", status: r.status }),
      (e) => ({ kind: "rejected", name: e.name }),
    );
    controller.abort();
    const outcome = await settle;
    const dt = Date.now() - t0;
    expect(outcome.kind).toBe("rejected");
    expect(outcome.name).toBe("AbortError"); // base loop rethrows — no retry of an abandoned request
    expect(dt).toBeLessThan(5000); // bounded by the abort, not by the deadline/retry budget
    await vi.waitFor(() => expect(getBunLaneStatus().busy).toBe(0), { timeout: 3_000, interval: 25 });
  });

  it("pre-start abort never spawns a child", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      opencodeFreeLaneFetch(serverUrl, { method: "GET" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getBunLaneStatus().busy).toBe(0);
  });
});

describe("opencodeBunLane proxy mapping", () => {
  it("unmapped socks proxy → distinct typed error", async () => {
    const { resolveXrayHttpProxyUrl } = await import("@/lib/xray/httpProxyResolver.js");
    resolveXrayHttpProxyUrl.mockResolvedValue(null);
    await expect(
      opencodeFreeLaneFetch("https://example.invalid", { method: "GET" }, { proxyUrl: "socks5://127.0.0.1:59999" }),
    ).rejects.toBeInstanceOf(OpenCodeFreeLaneUnmappedProxyError);
    resolveXrayHttpProxyUrl.mockResolvedValue(null);
  });

  it("mappable socks proxy rides the mapped http URL", { timeout: 20_000 }, async () => {
    const { resolveXrayHttpProxyUrl } = await import("@/lib/xray/httpProxyResolver.js");
    resolveXrayHttpProxyUrl.mockResolvedValue("http://127.0.0.1:59998");
    // node's fetch has no proxy option — the child ignores it under node; the
    // assertion is that NO unmapped error is thrown and the request flows
    sseServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: ok\n\n");
    });
    const res = await opencodeFreeLaneFetch(serverUrl, { method: "GET" }, { proxyUrl: "socks5://127.0.0.1:59997" });
    expect(res.status).toBe(200);
    resolveXrayHttpProxyUrl.mockResolvedValue(null);
  });
});
