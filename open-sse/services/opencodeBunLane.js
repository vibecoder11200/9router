/**
 * OpenCode Bun lane (plan P3): per-request `bun` stdio children performing
 * upstream fetches with Bun's BoringSSL TLS stack — SSE passthrough over
 * stdout, abort = kill child (quota-safe by construction), concurrency capped
 * by the user-configurable `opencodeFreeLaneMaxConcurrency` setting (default
 * 3, clamped 1..16) with a bounded waiter queue. No port, no auth surface,
 * no persistent process, no boot-path change.
 *
 * `opencodeFreeLaneFetch` has the SAME signature as `opencodeTlsFetch`
 * (opencodeTlsClient.js) — the executor's freeLaneFetch drop-in (P4).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureBunInstalled,
  getBunBinaryPath,
  getInstalledBunVersion,
  isBunInstalled,
} from "@/lib/runtime/bunInstaller.js";
import { resolveXrayHttpProxyUrl } from "@/lib/xray/httpProxyResolver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { dbg } from "../utils/debugLog.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const QUEUE_TIMEOUT_MS = 30_000;
// Default/fallback cap. The effective cap is the user's
// opencodeFreeLaneMaxConcurrency setting, clamped 1..16 — read per request
// (same per-request settings read the executor already does for the engine
// kill-switch), so changes apply to NEW requests immediately without restart.
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY_CEILING = 16;
const RETRY_BUDGET_MS = 5_000;
// Bodies larger than this go to the child over stdin instead of env (Windows
// env block-size limits make large env vars unreliable).
const STDIN_THRESHOLD_BYTES = 100_000;

// Webpack freezes import.meta.url to the BUILD machine (gensparkTlsSidecar
// lesson) — resolve the child script deterministically across candidates.
let sidecarDirname = null;
try {
  sidecarDirname = path.dirname(fileURLToPath(import.meta.url));
} catch { /* cross-platform bundle */ }

const SIDECAR_CANDIDATES = [
  sidecarDirname && path.join(sidecarDirname, "opencodeBunSidecar.mjs"),
  path.join("open-sse", "services", "opencodeBunSidecar.mjs"), // repo-root cwd
];
function resolveSidecarScript() {
  // env override wins verbatim — even when absent on disk (fail-fast tests)
  if (process.env.OPENCODE_BUN_SIDECAR_SCRIPT) return process.env.OPENCODE_BUN_SIDECAR_SCRIPT;
  return (
    SIDECAR_CANDIDATES.find((p) => p && fs.existsSync(p)) ||
    (sidecarDirname
      ? path.join(sidecarDirname, "opencodeBunSidecar.mjs")
      : path.join("open-sse", "services", "opencodeBunSidecar.mjs"))
  );
}

// ── Typed errors (P4 surfaces them; 503 on the chat path) ───────────────────

export class OpenCodeFreeLaneUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenCodeFreeLaneUnavailableError";
    this.code = "OPENCODE_BUN_LANE_UNAVAILABLE";
  }
}

export class OpenCodeFreeLaneUnmappedProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenCodeFreeLaneUnmappedProxyError";
    this.code = "OPENCODE_BUN_LANE_UNMAPPED_PROXY";
  }
}

// Semaphore saturation (>3 concurrent free streams): a healthy-but-busy lane
// must NOT page as "lane unavailable" — distinct code, info severity upstream.
export class OpenCodeFreeLaneBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenCodeFreeLaneBusyError";
    this.code = "OPENCODE_BUN_LANE_BUSY";
  }
}

// ── Lane semaphore: ≤cap concurrent children; waiters queue with a timeout ──

const laneState = {
  active: 0,
  waiters: [],
  // effective cap of the most recent request (status route observability);
  // DEFAULT until the first configured request lands
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  lastErrorAt: null,
  lastError: null,
};

// Clamp helper: user value wins within 1..ceiling; junk/absent → default.
function clampConcurrency(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY_CEILING, Math.max(1, Math.floor(n)));
}

async function resolveMaxConcurrency() {
  try {
    const settings = await getSettings();
    return clampConcurrency(settings?.opencodeFreeLaneMaxConcurrency);
  } catch {
    // settings read failure must not take the lane down (same fail-open as
    // the executor's engine kill-switch read)
    return DEFAULT_MAX_CONCURRENCY;
  }
}

function acquireSlot(cap, queueTimeoutMs) {
  return new Promise((resolve, reject) => {
    if (laneState.active < cap) {
      laneState.active++;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      // remove THIS entry (identity, not a closure comparison — the entry's
      // resolve is a wrapper closure, not the promise executor's resolve)
      const i = laneState.waiters.indexOf(waiter);
      if (i >= 0) laneState.waiters.splice(i, 1);
      reject(new OpenCodeFreeLaneBusyError(
        `bun lane queue timeout after ${queueTimeoutMs}ms (max ${cap} concurrent children)`,
      ));
    }, queueTimeoutMs);
    if (timer.unref) timer.unref();
    const waiter = {
      resolve: () => {
        clearTimeout(timer);
        laneState.active++;
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    laneState.waiters.push(waiter);
  });
}

function releaseSlot() {
  const next = laneState.waiters.shift();
  if (next) {
    next.resolve();
  } else {
    laneState.active = Math.max(0, laneState.active - 1);
  }
}

function recordLaneError(err) {
  laneState.lastErrorAt = new Date().toISOString();
  laneState.lastError = err?.message || String(err);
}

// ── Bun path resolution ──────────────────────────────────────────────────────

async function resolveBunPath() {
  if (process.env.OPENCODE_BUN_PATH) return process.env.OPENCODE_BUN_PATH;
  return ensureBunInstalled();
}

// ── Child spawn + first-line protocol ────────────────────────────────────────

const BUNLANE_ENV_KEY = "BUNLANE_REQ";

function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  } catch { /* already dead */ }
}

function spawnChild({ bunPath, url, method, headers, body, timeoutMs, proxy, idleTimeoutMs }) {
  const requestJson = JSON.stringify({
    url,
    method,
    headers,
    body: body ?? null,
    timeoutMs,
    proxy: proxy || null,
    idleTimeoutMs,
  });
  const useStdin = Buffer.byteLength(requestJson) > STDIN_THRESHOLD_BYTES;

  const env = { ...process.env };
  delete env[BUNLANE_ENV_KEY]; // never inherit a stale request
  if (!useStdin) env[BUNLANE_ENV_KEY] = requestJson;

  const child = spawn(bunPath, [resolveSidecarScript()], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  if (useStdin) child.stdin.end(requestJson);
  else child.stdin.end(); // request via env — stdin is closed for the child's whole life
  return child;
}

/**
 * Spawn the child and resolve the FIRST stdout line (header JSON). Rejects
 * on: child spawn error, non-protocol exit (exit 7 bad request, crash),
 * malformed first line, or the first line not arriving inside `deadlineMs`.
 */
function readFirstLine(child, { deadlineMs }) {
  return new Promise((resolve, reject) => {
    // Raw-byte accumulation: the header window may already carry the start of
    // the SSE body, and re-decoding/re-encoding across chunk boundaries would
    // corrupt a multibyte character split mid-sequence — bytes stay verbatim.
    let chunks = [];
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const deadline = setTimeout(() => {
      finish(reject, new Error("bun child first-line deadline exceeded"));
    }, deadlineMs);
    if (deadline.unref) deadline.unref();

    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const joined = Buffer.concat(chunks);
      const nl = joined.indexOf(0x0a); // first newline, byte-wise
      if (nl < 0) return;
      const line = joined.slice(0, nl).toString("utf8");
      const restBuffer = joined.slice(nl + 1);
      finish(resolve, { headerLine: line, restBuffer });
    });
    child.on("error", (e) => finish(reject, e));
    child.on("exit", (code) => {
      finish(reject, new Error(`bun child exited before headers (code ${code})`));
    });
  });
}

// Build the native Response whose body streams the child stdout tail.
function buildLaneResponse({ child, first }) {
  const header = JSON.parse(first.headerLine);
  if (header.error) {
    const err = new Error(header.error);
    err.childExitCode = child.exitCode;
    throw err;
  }
  let remaining = first.restBuffer;
  let childEnded = false;
  let closed = false; // controller closed/cancelled — trailing stdout must not enqueue
  const stream = new ReadableStream({
    start(controller) {
      const push = (chunk) => {
        if (closed || !chunk.length) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true; // enqueue raced a close/cancel — stop pushing
        }
      };
      if (remaining.length) push(remaining);
      child.stdout.on("data", (chunk) => push(chunk));
      child.stdout.on("end", () => {
        childEnded = true;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      });
      child.on("exit", (code) => {
        if (childEnded) return;
        if (code === 6) {
          childEnded = true;
          closed = true;
          controller.error(new Error("bun child idle timeout"));
        } else if (code === 5) {
          childEnded = true;
          closed = true;
          controller.error(new Error("bun child upstream error after headers"));
        } else if (code === 0) {
          // Clean exit: do NOT close here — the exit event can beat pending
          // pipe data (Windows), which truncated bodies (200 + empty stream).
          // stdout 'end' below closes the stream after the last byte lands.
        } else {
          childEnded = true;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        }
      });
      child.on("error", () => {
        if (!childEnded) {
          childEnded = true;
          closed = true;
          try { controller.error(new Error("bun child stream error")); } catch {}
        }
      });
    },
    cancel() {
      // consumer cancelled the response body → kill the child (quota-safe);
      // trailing stdout data after the cancel must never enqueue (crash guard)
      closed = true;
      killChild(child);
    },
  });
  return new Response(stream, { status: header.status, headers: new Headers(header.headers || {}) });
}

// ── Proxy mapping ────────────────────────────────────────────────────────────

/**
 * Map the caller's proxy URL to what the bun child can use:
 *   - null/empty → null (direct)
 *   - http(s):// → passed through (Bun fetch supports http proxies)
 *   - socks5(h):// loopback → resolver maps to the paired xray HTTP inbound;
 *     unmappable (foreign host, dead pair) → typed OpenCodeFreeLaneUnmappedProxyError
 *   - anything else (socks4, non-loopback socks, …) → unmapped
 */
async function mapProxy(proxyUrl) {
  if (!proxyUrl) return null;
  const s = String(proxyUrl).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^socks5h?:\/\//i.test(s)) {
    const mapped = await resolveXrayHttpProxyUrl(s);
    if (!mapped) {
      throw new OpenCodeFreeLaneUnmappedProxyError(
        `socks proxy ${s} has no verifiable xray HTTP inbound at the neighboring port — bind a fork xray pool or remove the pool binding`,
      );
    }
    return mapped;
  }
  throw new OpenCodeFreeLaneUnmappedProxyError(`unsupported proxy scheme for the bun lane: ${s}`);
}

// ── One lane attempt: acquire → spawn → first line → live Response ──────────

async function attemptOnce({ url, init, timeoutMs, proxy, queueTimeoutMs, firstLineDeadlineMs, signal, cap }) {
  await acquireSlot(cap, queueTimeoutMs);
  let child = null;
  let handedOff = false; // response handed to the caller (child still streaming)
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
  try {
    const bunPath = await resolveBunPath();
    child = spawnChild({
      bunPath,
      url,
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      timeoutMs,
      proxy,
      idleTimeoutMs: timeoutMs,
    });
    // exit AND error both release — attached BEFORE any await so a child that
    // dies during the header phase (abort kill, crash) still frees its slot:
    // its exit event fires before the finally block would ever attach.
    child.on("exit", releaseOnce);
    child.on("error", releaseOnce);
    // Quota-safety: abort kills the child IMMEDIATELY — including during the
    // header phase (the most likely cancel moment). Wiring it only after
    // handoff left a pre-first-line abort ignored, and the lane would then
    // retry an already-abandoned request (review P0-1). The listener stays
    // live after handoff — abort mid-stream keeps killing the child.
    if (signal) {
      if (signal.aborted) killChild(child);
      else signal.addEventListener("abort", () => killChild(child), { once: true });
    }
    let first;
    try {
      first = await readFirstLine(child, { deadlineMs: firstLineDeadlineMs });
    } catch (e) {
      if (signal?.aborted && e.name !== "AbortError") {
        // the abort kill landed before headers — surface as AbortError so the
        // base retry loop rethrows instead of retrying an abandoned request
        const abortErr = new Error("aborted while awaiting bun child headers");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw e;
    }
    const header = JSON.parse(first.headerLine);
    if (header.error) {
      throw new Error(`bun child error before headers: ${header.error}`);
    }
    handedOff = true;
    return buildLaneResponse({ child, first });
  } finally {
    if (!child) {
      releaseOnce();
    } else {
      if (child.exitCode !== null) releaseOnce(); // already exited
      if (!handedOff) killChild(child); // failure → kill → exit → release
    }
  }
}

// ── The lane fetch (opencodeTlsFetch signature parity) ──────────────────────

/**
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string|Buffer|null }} init
 * @param {{ signal?: AbortSignal, timeoutMs?: number, proxyUrl?: string|null,
 *           queueTimeoutMs?: number }} opts
 * @returns {Promise<Response>} native Response with the live SSE stream body.
 */
export async function opencodeFreeLaneFetch(url, init = {}, opts = {}) {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxyUrl = null, queueTimeoutMs = QUEUE_TIMEOUT_MS } = opts;
  if (signal?.aborted) {
    // never spend a child (or a proxy verification) on an already-abandoned call
    const abortErr = new Error("bun lane request aborted before start");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  const cap = await resolveMaxConcurrency(); // per-request read — new value applies immediately
  laneState.maxConcurrency = cap;
  const proxy = await mapProxy(proxyUrl); // typed unmapped-proxy error — no slot consumed
  try {
    return await attemptOnce({ url, init, timeoutMs, proxy, queueTimeoutMs, firstLineDeadlineMs: timeoutMs, signal, cap });
  } catch (e) {
    if (e.name === "AbortError") throw e; // aborted: do NOT retry, never spawn a second child
    if (e instanceof OpenCodeFreeLaneBusyError) throw e; // healthy-but-saturated: fail-fast, no retry
    if (e instanceof OpenCodeFreeLaneUnavailableError) throw e; // queue/typed: fail-fast, no retry
    if (e instanceof OpenCodeFreeLaneUnmappedProxyError) throw e;
    if (signal?.aborted) {
      const abortErr = new Error("aborted during bun lane attempt");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    recordLaneError(e);
    dbg("[opencodeBunLane] first attempt failed — one bounded retry:", e?.message || e);
    // Fail-fast: ONE bounded retry (first-line deadline compressed into the
    // retry budget), then the typed unavailable error.
    try {
      return await attemptOnce({ url, init, timeoutMs, proxy, queueTimeoutMs, firstLineDeadlineMs: RETRY_BUDGET_MS, signal, cap });
    } catch (e2) {
      if (e2.name === "AbortError") throw e2;
      if (e2 instanceof OpenCodeFreeLaneBusyError || e2 instanceof OpenCodeFreeLaneUnavailableError || e2 instanceof OpenCodeFreeLaneUnmappedProxyError) throw e2;
      const wrapper = new OpenCodeFreeLaneUnavailableError(`bun lane failed twice (first: ${e?.message || e}; retry: ${e2?.message || e2})`);
      recordLaneError(wrapper);
      throw wrapper;
    }
  }
}

export function getBunLaneStatus() {
  return {
    installed: isBunInstalled(),
    bunVersion: getInstalledBunVersion(),
    busy: laneState.active,
    queued: laneState.waiters.length,
    maxConcurrency: laneState.maxConcurrency,
    lastErrorAt: laneState.lastErrorAt,
    lastError: laneState.lastError,
  };
}

export const __test__ = {
  state: laneState,
  reset() {
    laneState.active = 0;
    laneState.waiters = [];
    laneState.maxConcurrency = DEFAULT_MAX_CONCURRENCY;
    laneState.lastErrorAt = null;
    laneState.lastError = null;
  },
  mapProxy,
};
