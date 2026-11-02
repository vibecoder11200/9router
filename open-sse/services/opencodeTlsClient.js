// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not on headers. A pinned cipher
// list alone is NOT sufficient: upstream #5325 measured every impersonated
// profile refused while Bun's own fetch passed — extension order, supported
// groups and signature algorithms also count. OmniRoute's production answer
// (#17869) is to ride a REAL browser profile from the installed wreq-js
// catalog, resolved at request time instead of frozen literals, so the
// fingerprint tracks whatever the newest wreq-js ships. That is the default
// here: the newest `chrome_*` profile in the installed catalog.
//
// wreq sessions are proxy-PINNED at creation ("Session proxy cannot be
// changed after creation"), so proxied egress (the model filter, per-connection
// proxies) needs one session per (profile, proxy) — served by a small LRU pool
// below. `OPENCODE_TLS_PROFILE` overrides resolution: an exact profile name
// ("chrome_142"), or "legacy" for the old pinned-cipher behavior.
//
// wreq-js is an optional dependency; when absent the caller keeps its native
// fetch and stays subject to the gate rather than failing the request here.

import { loadRuntimeDep } from "./lazyRuntime.js";

// BoringSSL/Chrome-family cipher list the upstream accepted in the
// cipher-list-only era. Kept as the "legacy" fallback for wreq builds without
// a profile catalog. Only the list's hash was compared, so it stays verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const DEFAULT_TIMEOUT_MS = 120000;
// One wreq session per (profile, proxy). The model filter walks hundreds of
// proxies with a handful of workers, so cap the pool and evict least-recently
// used; idle sessions are swept on acquire.
const MAX_TLS_SESSIONS = 24;
const SESSION_IDLE_MS = 5 * 60 * 1000;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

/** Newest `chrome_*` in the catalog — pure so tests can pin the ordering. */
export function resolveNewestChromeProfile(profiles) {
  const chrome = (Array.isArray(profiles) ? profiles : [])
    .filter((p) => /^chrome_\d+$/.test(p))
    .sort((a, b) => parseInt(b.slice(7), 10) - parseInt(a.slice(7), 10));
  return chrome[0] || null;
}

/**
 * Emulation choice for this process: an exact profile name via
 * OPENCODE_TLS_PROFILE, "legacy"/"off" for the pinned cipher list, otherwise
 * the newest chrome profile the installed wreq-js ships. Returns null for
 * legacy. A catalog that cannot be read degrades to legacy instead of
 * failing the module load.
 */
function resolveOpencodeEmulationProfile(wreq) {
  const override = String(process.env.OPENCODE_TLS_PROFILE || "").trim().toLowerCase();
  if (/^(legacy|off|none)$/.test(override)) return null;
  try {
    const profiles = typeof wreq.getProfiles === "function" ? wreq.getProfiles() : [];
    if (override && override !== "auto") {
      return profiles.includes(override) ? override : null;
    }
    // Default and OPENCODE_TLS_PROFILE=auto: newest chrome the catalog ships.
    return resolveNewestChromeProfile(profiles);
  } catch {
    return null;
  }
}

// key -> { session, promise, lastUsedAt }
const sessionPool = new Map();
let resolvedProfile; // undefined = not resolved yet, null = legacy, string = profile
let resolvedProfileLogged = false;
let wreqPromise = null;

function loadWreq() {
  // Cached across resets — the module never changes under us.
  if (!wreqPromise) {
    wreqPromise = loadRuntimeDep("wreq-js").then((wreq) => {
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return wreq;
    });
    wreqPromise.catch(() => { wreqPromise = null; });
  }
  return wreqPromise;
}

function ensureResolvedProfile(wreq) {
  if (resolvedProfile !== undefined) return;
  resolvedProfile = resolveOpencodeEmulationProfile(wreq);
  if (!resolvedProfileLogged) {
    resolvedProfileLogged = true;
    console.log(
      `[OpenCodeTLS] emulation: ${resolvedProfile || "legacy cipher list"} (OPENCODE_TLS_PROFILE=${process.env.OPENCODE_TLS_PROFILE || "auto"})`,
    );
  }
}

function sessionKey(profile, proxyUrl) {
  return `${profile || "legacy"}|${proxyUrl || "direct"}`;
}

function closeEntry(entry) {
  entry?.promise?.then((session) => session.close?.()).catch(() => {});
}

function sweepIdlePool() {
  const now = Date.now();
  for (const [key, entry] of sessionPool) {
    if (now - entry.lastUsedAt > SESSION_IDLE_MS) {
      sessionPool.delete(key);
      closeEntry(entry);
    }
  }
}

async function loadSession(proxyUrl) {
  sweepIdlePool();
  const wreq = await loadWreq();
  // Resolve BEFORE keying — the pool key must be stable across the first and
  // every later call, so the same proxy reuses its session.
  ensureResolvedProfile(wreq);
  const key = sessionKey(resolvedProfile, proxyUrl);
  const cached = sessionPool.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.promise;
  }

  const entry = { promise: null, lastUsedAt: Date.now() };
  entry.promise = (async () => {
    const proxy = proxyUrl ? { proxy: proxyUrl } : {};
    return resolvedProfile
      ? wreq.createSession({ browser: resolvedProfile, os: process.platform === "win32" ? "windows" : "linux", ...proxy })
      : wreq.createSession({ emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } }, ...proxy });
  })().catch((error) => {
    sessionPool.delete(key);
    throw error;
  });

  sessionPool.set(key, entry);
  // LRU cap — evict the least recently used entries (Map preserves insert
  // order; re-acquired entries re-set below to refresh their position).
  while (sessionPool.size > MAX_TLS_SESSIONS) {
    const oldest = sessionPool.keys().next().value;
    const evicted = sessionPool.get(oldest);
    sessionPool.delete(oldest);
    closeEntry(evicted);
  }
  return entry.promise;
}

/** Drop every cached session so the next call builds fresh ones. */
export function resetOpencodeTlsSession() {
  const entries = [...sessionPool.values()];
  sessionPool.clear();
  resolvedProfile = undefined;
  for (const entry of entries) closeEntry(entry);
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 *
 * `proxyUrl` pins the session's egress proxy (wreq sessions are created with
 * their proxy — it cannot be changed afterwards). Streaming is preserved: the
 * response body is handed over as the live ReadableStream, never buffered.
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxyUrl = null } = {}) {
  let session;
  try {
    session = await loadSession(proxyUrl);
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const __test__ = {
  OPENCODE_CIPHER_LIST,
  sessionPool,
  sessionKey,
  resolveOpencodeEmulationProfile,
  __setResolvedProfile(value) {
    resolvedProfile = value;
  },
};
