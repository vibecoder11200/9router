/**
 * Proxy health testing: measure latency and exit IP through a local SOCKS port.
 *
 * Two probes:
 *  - testProxyLatency: GET a 204 endpoint through the SOCKS proxy, return ms.
 *  - testProxyExitIp:  GET cloudflare cdn-cgi/trace through the SOCKS proxy,
 *    parse the egress IP (ports the fetchExitIP logic from v2go's tester.go).
 *
 * Both ride the PACKAGE's undici fetch — never the global fetch. The server
 * runtime's patched globalThis.fetch strips the per-request `dispatcher`, so
 * probes silently went DIRECT (2026-11-10 production evidence: every free-lane
 * model-filter "pass" recorded the host's own IP as the exit IP — see
 * plans/reports/Audit-261111-opencode-free-filter-xray-leak.md). The package
 * undici fetch also pairs correctly with the package-built dispatchers below
 * (mixed undici copies reject with UND_ERR_INVALID_ARG). Same pattern as
 * src/lib/network/proxyTest.js and open-sse/utils/proxyFetch.js rawFetch.
 *
 * NOTE: undici-backed fetch ignores the legacy `agent` option — the proxy MUST
 * be supplied via `dispatcher`, otherwise the request silently goes direct.
 * This is why we previously saw exit IPs equal to the host IP (going direct)
 * instead of the proxy's egress IP. See open-sse/utils/proxyFetch.js.
 */

import net from "node:net";
import { fetch as undiciFetch } from "undici";
import { createSocksDispatcher, isSocksProxyUrl } from "@/lib/network/socksDispatcher";

const DEFAULT_TIMEOUT_MS = 6000;
const LATENCY_URL = "http://gstatic.com/generate_204";
const TRACE_URL = "http://www.cloudflare.com/cdn-cgi/trace";

// LRU-ish cache of dispatchers keyed by proxy URI, so we don't construct a new
// agent (and a fresh connection pool) on every probe. Mirrors
// open-sse/utils/proxyFetch.js getDispatcher().
const dispatcherCache = new Map();
const DISPATCHER_CACHE_MAX = 32;

async function getDispatcher(proxyUri) {
  if (!proxyUri) return null;
  const cached = dispatcherCache.get(proxyUri);
  if (cached) {
    // Move to end (most-recently used).
    dispatcherCache.delete(proxyUri);
    dispatcherCache.set(proxyUri, cached);
    return cached;
  }
  // SOCKS URIs go through the shared SOCKS-tunnelling dispatcher: undici's
  // ProxyAgent SOCKS5 support is experimental and unreliable for https
  // targets (mid-TLS disconnects), and it emits an ExperimentalWarning per
  // process. Mirrors proxyTest.js / proxyFetch.js.
  let dispatcher;
  if (isSocksProxyUrl(proxyUri)) {
    dispatcher = createSocksDispatcher(proxyUri);
  } else {
    const { ProxyAgent } = await import("undici");
    dispatcher = new ProxyAgent({ uri: proxyUri });
  }
  if (dispatcherCache.size >= DISPATCHER_CACHE_MAX) {
    // Evict oldest entry.
    const firstKey = dispatcherCache.keys().next().value;
    dispatcherCache.delete(firstKey);
  }
  dispatcherCache.set(proxyUri, dispatcher);
  return dispatcher;
}

function proxyUriForPort(socksPort) {
  return `socks5://127.0.0.1:${socksPort}`;
}

/**
 * Measure round-trip latency through the SOCKS proxy.
 * @returns {Promise<number>} latency in ms, or -1 on failure/timeout
 */
export async function testProxyLatency(socksPort, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  try {
    const dispatcher = await getDispatcher(proxyUriForPort(socksPort));
    const res = await undiciFetch(LATENCY_URL, {
      dispatcher,
      // Disable compression/redirect so the timing reflects a single round-trip.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "9router-xray-test/1.0" },
    });
    if (res.status === 204 || res.status === 200) {
      return Date.now() - start;
    }
    return -1;
  } catch {
    return -1;
  }
}

/**
 * Discover the exit IP as seen by the destination, through the SOCKS proxy.
 * Parses cloudflare's cdn-cgi/trace for an `ip=` line. Returns "" on failure.
 *
 * Ports v2go's fetchExitIP (internal/tester/tester.go): same endpoint, same
 * parsing, same empty-string-on-malformed behavior.
 */
export async function testProxyExitIp(socksPort, timeoutMs = 4000) {
  return testProxyExitIpWithUri(proxyUriForPort(socksPort), timeoutMs);
}

/**
 * Exit-IP probe taking a full SOCKS URI (allows username/password auth, used
 * by api-mode filter where each worker connects as `probe-<i>:x@...`). Same
 * cloudflare trace parsing as testProxyExitIp.
 */
export async function testProxyExitIpWithUri(socksUri, timeoutMs = 4000) {
  try {
    const dispatcher = await getDispatcher(socksUri);
    const res = await undiciFetch(TRACE_URL, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "9router-xray-test/1.0" },
    });
    if (!res.ok) return "";
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("ip=")) {
        const ip = line.slice(3).trim();
        // Basic IP validation — reject obviously garbage values.
        if (/^[\d.a-fA-F:]+$/.test(ip)) return ip;
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Combined health probe: latency + exit IP in one call.
 * @returns {Promise<{ ok: boolean, latencyMs: number, exitIp: string }>}
 */
export async function testProxy(socksPort, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const latencyMs = await testProxyLatency(socksPort, timeoutMs);
  if (latencyMs < 0) return { ok: false, latencyMs: -1, exitIp: "" };
  const exitIp = await testProxyExitIp(socksPort);
  return { ok: true, latencyMs, exitIp };
}

/**
 * Quick TCP-level probe: is anything listening on the SOCKS port?
 * Cheaper than a full proxy round-trip — used to detect port conflicts and
 * confirm the process is accepting connections before a latency test.
 */
export function isSocksPortOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/**
 * Poll the SOCKS port until it accepts connections, or until maxWaitMs elapses.
 * Used by the chat-loop retry path to wait out the ~1-10s teardown/respawn
 * window of a managed-pool rotation before retrying a victim request.
 *
 * @returns {Promise<boolean>} true if the port came up before the deadline
 */
export async function waitForSocksPortOpen(port, maxWaitMs = 6000, host = "127.0.0.1") {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  while (Date.now() < deadline) {
    if (await isSocksPortOpen(port, host, 800)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
