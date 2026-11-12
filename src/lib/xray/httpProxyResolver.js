/**
 * socks→http proxy resolver for the OpenCode Bun lane (plan P5).
 *
 * Bun's fetch only supports HTTP-proxy egress (CONNECT) — no SOCKS. The fork
 * always binds an xray HTTP inbound at the socks port's fixed neighbor
 * (`buildInbounds`, configBuilder.js — every spawn site computes
 * httpPort = socksPort + 1), so a fork-owned `socks5://127.0.0.1:P` URL maps
 * to `http://127.0.0.1:P+1` by DERIVATION, verified by an actual TCP connect
 * at resolve time (ground truth — self-healing across HMR, restarts,
 * blue-green drains and `alreadyRunning` cold starts; catches the invariant's
 * rare misses: dead instance, foreign listener).
 *
 * No registry, no manager hooks, no unregister choreography — derivation plus
 * verification is the whole mechanism.
 */

import net from "node:net";

const VERIFY_TIMEOUT_MS = 200;
const NEGATIVE_CACHE_TTL_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

// Module state (test-resettable): verify function seam + negative cache.
const state = {
  verifyFn: null, // (host, port, timeoutMs) => Promise<boolean>; default net probe
  negativeCache: new Map(), // port → last-failed ts
};

/** Default TCP-connect probe: does <host>:<port> accept a connection? */
function tcpVerify(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function runVerify(host, port, timeoutMs) {
  const fn = state.verifyFn || tcpVerify;
  return fn(host, port, timeoutMs);
}

/**
 * Map a fork-owned loopback socks proxy URL to the paired xray HTTP inbound.
 *
 * @param {string|null} proxyUrl - `socks5://127.0.0.1:<P>` or `socks5h://…`
 * @param {{ verify?: boolean }} [opts] - verify=false only for callers that
 *   already know the pair exists (tests); the default ALWAYS verifies.
 * @returns {Promise<string|null>} `http://127.0.0.1:<P+1>` when the HTTP
 *   inbound is live, else null (unmapped — the lane surfaces a typed
 *   config-state error, never a silent fallback).
 */
export async function resolveXrayHttpProxyUrl(proxyUrl, { verify = true } = {}) {
  if (typeof proxyUrl !== "string" || !proxyUrl.trim()) return null;
  let u;
  try {
    u = new URL(proxyUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") return null;
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return null;
  const socksPort = Number(u.port);
  if (!Number.isInteger(socksPort) || socksPort <= 0 || socksPort > 65534) return null;
  const httpPort = socksPort + 1;

  if (!verify) return `http://127.0.0.1:${httpPort}`;

  // Negative cache: repeated resolves of a dead pair don't re-probe. Positive
  // results are never cached — every resolve re-verifies ground truth.
  const now = Date.now();
  const lastFail = state.negativeCache.get(httpPort);
  if (lastFail !== undefined && now - lastFail < NEGATIVE_CACHE_TTL_MS) return null;

  const host = u.hostname === "[::1]" ? "::1" : u.hostname;
  const open = await runVerify(host, httpPort, VERIFY_TIMEOUT_MS);
  if (!open) {
    state.negativeCache.set(httpPort, now);
    return null;
  }
  return `http://127.0.0.1:${httpPort}`;
}

/** Test hooks: inject the verify fn, reset caches. */
export const __test__ = {
  setVerifyFn(fn) {
    state.verifyFn = fn;
  },
  reset() {
    state.verifyFn = null;
    state.negativeCache.clear();
  },
};
