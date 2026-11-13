import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Protocol tests run the REAL child script under plain node (the lane's test
// stand-in for bun — the child detects the runtime; the Bun-only proxy option
// is exercised in the manual smoke only).
const SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../open-sse/services/opencodeBunSidecar.mjs");

function runChild(request, { stdinPayload = null } = {}) {
  const env = { ...process.env };
  delete env.BUNLANE_REQ;
  if (!stdinPayload) env.BUNLANE_REQ = JSON.stringify(request);
  const child = spawn(process.execPath, [SIDECAR], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  if (stdinPayload) child.stdin.end(stdinPayload);
  else child.stdin.end();
  return child;
}

/** Collect the child's stdout as {header, chunks[], exitCode}. */
function collect(child, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const out = { header: null, chunks: [], exitCode: null, stderr: "" };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ...out, timedOut: true });
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!out.header) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          out.header = JSON.parse(buf.slice(0, nl).toString("utf8"));
          buf = buf.slice(nl + 1);
          out.chunks.push(buf);
        }
      } else {
        out.chunks.push(c);
      }
    });
    child.stderr.on("data", (c) => { out.stderr += c; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      out.exitCode = code;
      resolve(out);
    });
  });
}

let server;
let serverUrl;

beforeEach(async () => {
  server = http.createServer(() => {});
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((res) => server.close(res));
});

describe("opencodeBunSidecar protocol", () => {
  it("happy path: header line + chunks streamed incrementally + exit 0 at stream end", { timeout: 20_000 }, async () => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: chunk-1\n\n");
      setTimeout(() => {
        res.write("data: chunk-2\n\n");
        res.end();
      }, 250);
    });

    // ONE collector from the start — records arrival times per chunk
    const child = runChild({ url: serverUrl, method: "GET", timeoutMs: 10_000, idleTimeoutMs: 10_000 });
    const t0 = Date.now();
    const events = []; // {at, text}
    const result = await new Promise((resolve) => {
      const out = { header: null, chunks: [], exitCode: null };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve({ ...out, timedOut: true });
      }, 15_000);
      let buf = Buffer.alloc(0);
      child.stdout.on("data", (c) => {
        buf = Buffer.concat([buf, c]);
        if (!out.header) {
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            out.header = JSON.parse(buf.slice(0, nl).toString("utf8"));
            const rest = buf.slice(nl + 1);
            if (rest.length) events.push({ at: Date.now() - t0, text: rest.toString("utf8") });
            buf = Buffer.alloc(0);
          }
          return;
        }
        events.push({ at: Date.now() - t0, text: c.toString("utf8") });
        out.chunks.push(c);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        out.exitCode = code;
        resolve(out);
      });
    });

    expect(result.header).toMatchObject({ status: 200 });
    expect(result.header.headers["content-type"]).toContain("text/event-stream");
    expect(result.exitCode).toBe(0);
    const body = events.map((e) => e.text).join("") + result.chunks.map((c) => c.toString("utf8")).join("");
    expect(body).toContain("chunk-1");
    expect(body).toContain("chunk-2");
    // incremental delivery: chunk-2 lands ≥150ms after chunk-1 (server paces 250ms)
    const firstAt = events[0]?.at ?? 0;
    const secondEvent = events.find((e, i) => i > 0 && e.text.includes("chunk-2")) || events[events.length - 1];
    expect(secondEvent.at - firstAt).toBeGreaterThanOrEqual(150);
  });

  it("upstream transport failure → {error, phase:'upstream'} first line + exit 5", { timeout: 20_000 }, async () => {
    // closed port: fetch throws before headers
    const dead = net.createServer();
    const port = await new Promise((res) => {
      dead.listen(0, "127.0.0.1", () => res(dead.address().port));
    });
    dead.close();
    const child = runChild({ url: `http://127.0.0.1:${port}`, method: "GET", timeoutMs: 5_000 });
    const result = await collect(child, { timeoutMs: 15_000 });
    expect(result.exitCode).toBe(5);
    expect(result.header).toHaveProperty("error");
    // phase marks it as per-route evidence (dead node), not a lane fault —
    // the manager rethrows it typed so filter probes record a normal failure
    // instead of aborting the whole run as "infra".
    expect(result.header.phase).toBe("upstream");
  });

  it("idle timeout (no body chunk) → exit 6", { timeout: 20_000 }, async () => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      // never ends, never sends another chunk
    });
    const child = runChild({
      url: serverUrl, method: "GET", timeoutMs: 30_000, idleTimeoutMs: 400,
    });
    const result = await collect(child, { timeoutMs: 15_000 });
    expect(result.exitCode).toBe(6);
    expect(result.header).toMatchObject({ status: 200 }); // headers came first
  });

  it("malformed request → exit 7", { timeout: 20_000 }, async () => {
    const child = runChild({}, { stdinPayload: "not json at all" });
    const result = await collect(child, { timeoutMs: 15_000 });
    expect(result.exitCode).toBe(7);
    expect(result.header).toHaveProperty("error");
  });

  it("large request delivered via stdin (>100KB body)", { timeout: 20_000 }, async () => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let size = 0;
      req.on("data", (c) => { size += c.length; });
      req.on("end", () => {
        res.writeHead(200, { "x-echo-size": String(size) });
        res.end(`got ${size}`);
      });
    });
    const bigBody = "x".repeat(150_000);
    const request = { url: serverUrl, method: "POST", headers: { "content-type": "application/json" }, body: bigBody, timeoutMs: 10_000 };
    // force the stdin path even though the JSON is <100KB? it IS >100KB with body.
    expect(JSON.stringify(request).length).toBeGreaterThan(100_000);
    const child = runChild(request, { stdinPayload: JSON.stringify(request) });
    const result = await collect(child, { timeoutMs: 15_000 });
    expect(result.header.status).toBe(200);
    expect(result.header.headers["x-echo-size"]).toBe("150000");
    expect(Buffer.concat(result.chunks).toString("utf8")).toContain("got 150000");
  });
});
