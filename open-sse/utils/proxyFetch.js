import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { canonicalizeProxyUrl } from "@/lib/proxy/parseProxy.js";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";

const originalFetch = globalThis.fetch;

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize a proxy URL into a canonical form undici's ProxyAgent accepts.
 * Handles every common shape — standard `scheme://user:pass@host:port`, reversed
 * `scheme://host:port@user:pass`, and bare colon forms like `host:port:user:pass`
 * (proxyxoay's `proxyhttp`) or `host:port` — by delegating to the shared parser.
 * Returns null for empty / unparseable input.
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;
  return canonicalizeProxyUrl(normalizedInput);
}

/**
 * Dispatcher cache: normalized proxy url → { agent, refCount, closeOnRelease }.
 * - refCount tracks in-flight requests using the agent so an evicted agent is
 *   only closed once idle (closing a busy agent aborts its streams).
 * - closeOnRelease defers that close to the moment the last request finishes.
 */
const proxyDispatchers = new Map();
// Single-flight creation guard: concurrent requests for the same proxy must not
// each build their own agent before the first lands in the cache (P5).
const dispatcherCreation = new Map();

function closeDispatcherEntry(agent) {
  Promise.resolve(agent.close?.()).catch((e) =>
    console.warn(`[ProxyFetch] failed closing evicted proxy dispatcher: ${e?.message || e}`)
  );
}

function maybeCloseEntry(entry) {
  if (entry.refCount > 0) {
    entry.closeOnRelease = true;
    return;
  }
  closeDispatcherEntry(entry.agent);
}

async function createDispatcherEntry(normalized) {
  // ProxyAgent speaks HTTP CONNECT only — SOCKS proxies (e.g. the local
  // xray socks inbound) need a SOCKS-tunnelling connector instead.
  const { createSocksDispatcher, isSocksProxyUrl } = await import("@/lib/network/socksDispatcher.js");
  const agent = isSocksProxyUrl(normalized)
    ? createSocksDispatcher(normalized)
    : new (await import("undici")).ProxyAgent({ uri: normalized });
  return { agent, refCount: 0, closeOnRelease: false };
}

function evictOldestDispatcher() {
  if (proxyDispatchers.size < MEMORY_CONFIG.proxyDispatchersMaxSize) return;
  const oldestKey = proxyDispatchers.keys().next().value;
  const evicted = proxyDispatchers.get(oldestKey);
  proxyDispatchers.delete(oldestKey);
  if (evicted) maybeCloseEntry(evicted);
}

async function getDispatcherEntry(normalized) {
  const cached = proxyDispatchers.get(normalized);
  if (cached) return cached;
  let creating = dispatcherCreation.get(normalized);
  if (!creating) {
    creating = createDispatcherEntry(normalized)
      .then((entry) => {
        evictOldestDispatcher();
        proxyDispatchers.set(normalized, entry);
        dispatcherCreation.delete(normalized);
        return entry;
      })
      .catch((err) => {
        dispatcherCreation.delete(normalized);
        throw err;
      });
    dispatcherCreation.set(normalized, creating);
  }
  return creating;
}

/**
 * Acquire a proxy dispatcher with usage tracking. The returned release() must
 * be called when the request finishes; it closes an evicted agent once idle.
 */
async function acquireDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  const entry = await getDispatcherEntry(normalized);
  entry.refCount += 1;
  return {
    agent: entry.agent,
    release: () => {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0 && entry.closeOnRelease) {
        entry.closeOnRelease = false;
        closeDispatcherEntry(entry.agent);
      }
    },
  };
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  // Strict connections must egress via THEIR proxy only (P1): an env-var
  // proxy is never an acceptable substitute, and a direct fetch is worse.
  const strict = proxyOptions?.strictProxy === true;
  const proxyEnabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  const rawConnUrl = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  let connectionProxyUrl = null;
  let noProxyBypassed = false;
  if (proxyEnabled && rawConnUrl) {
    const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
    if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) {
      // Explicit per-host direct exclusion — honored even under strictProxy.
      noProxyBypassed = true;
    } else {
      connectionProxyUrl = normalizeProxyUrl(rawConnUrl);
    }
  }
  if (strict && proxyEnabled && !connectionProxyUrl && !noProxyBypassed) {
    // Enabled but unresolvable (empty/unparseable URL) under strict — refuse
    // rather than silently egressing from the origin IP.
    emitAlert(EVENT_TYPES.STRICTPROXY_VIOLATION, {
      severity: SEVERITY.CRITICAL,
      title: "strictProxy direct-fetch refused",
      body: "strictProxy=true but the connection proxy could not be resolved; the direct fetch was refused.",
    });
    const err = new Error("[ProxyFetch] strictProxy=true but connection proxy could not be resolved; refusing direct fetch");
    err.proxyInfra = true; // proxy-side outage — never lock/feed the account (chat loop)
    throw err;
  }
  const envProxyUrl = connectionProxyUrl || noProxyBypassed || strict
    ? null
    : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const { agent: dispatcher, release } = await acquireDispatcher(proxyUrl);
        try {
          return await originalFetch(url, { ...options, dispatcher });
        } finally {
          release();
        }
      } catch (proxyError) {
        if (strict) {
          const err = new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
          err.proxyInfra = true; // proxy-side outage — never lock/feed the account (chat loop)
          throw err;
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const { agent: dispatcher, release } = await acquireDispatcher(proxyUrl);
      try {
        return await originalFetch(url, { ...options, dispatcher });
      } finally {
        release();
      }
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (strict) {
        const err = new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        err.proxyInfra = true; // proxy-side outage — never lock/feed the account (chat loop)
        throw err;
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return originalFetch(url, options);
    }
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return originalFetch(url, options);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
