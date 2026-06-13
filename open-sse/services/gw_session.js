/**
 * Gemini Web Session — bootstrap, session params extraction.
 *
 * Handles session initialization for gemini.google.com:
 *   1. Fetch /app page with cookies → extract build_label, session_id, language
 *   2. Build SAPISIDHASH auth header from SAPISID cookie
 *   3. Query user account status via BatchExecute RPC
 *
 * Auth is done via `Authorization: SAPISIDHASH <ts>_<sha1>` header,
 * calculated as SHA1(timestamp + " " + SAPISID + " " + origin).
 * SNlM0e is no longer used by Google for auth.
 */

import { serializeGeminiWebCookieHeader, validateGeminiWebCookies } from "./geminiWebCookie.js";
import { buildBatchExecuteBody, parseResponseFrames, extractModelList, getNestedValue } from "./geminiWebRpc.js";
import crypto from "crypto";

const GEMINI_BASE = "https://gemini.google.com";
const GEMINI_APP_URL = `${GEMINI_BASE}/app`;
const BATCHEXECUTE_URL = `${GEMINI_BASE}/_/BardChatUi/data/batchexecute`;

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// Regex patterns for extraction from HTML
const BUILD_LABEL_PATTERN = /"cfb2h":\s*"(.*?)"/;
const SESSION_ID_PATTERN = /"FdrFJe":\s*"(.*?)"/;
const LANGUAGE_PATTERN = /"TuX5cc":\s*"(.*?)"/;
const PUSH_ID_PATTERN = /"qKIAYe":\s*"(.*?)"/;
const SNLM0E_PATTERN = /"SNlM0e":\s*"(.*?)"/;

// RPC IDs
const RPC_GET_USER_STATUS = "otAQ7b";
const RPC_BARD_SETTINGS = "ESY5D";

// ---------------------------------------------------------------------------
// Request timing jitter — avoids machine-like request patterns
// ---------------------------------------------------------------------------

function requestJitter() {
  const delay = 20 + Math.random() * 60;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ---------------------------------------------------------------------------
// SAPISIDHASH auth
// ---------------------------------------------------------------------------

/**
 * Build SAPISIDHASH authorization header value.
 *
 * Formula: SAPISIDHASH <timestamp>_<SHA1(timestamp + " " + SAPISID + " " + origin)>
 *
 * @param {string} sapisid  The SAPISID cookie value
 * @param {string} [origin="https://gemini.google.com"]
 * @returns {{ headerValue: string, timestamp: number }}
 */
export function buildSapisidHash(sapisid, origin = "https://gemini.google.com") {
  const ts = Math.floor(Date.now() / 1000);
  const data = `${ts} ${sapisid} ${origin}`;
  const hash = crypto.createHash("sha1").update(data).digest("hex");
  return { headerValue: `SAPISIDHASH ${ts}_${hash}`, timestamp: ts };
}

/**
 * Extract SAPISID from cookies.
 *
 * @param {Object} cookies  Cookie key-value map
 * @returns {string|null}
 */
export function extractSapisid(cookies) {
  return (cookies && cookies["SAPISID"]) || null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCookieHeader(cookies) {
  return serializeGeminiWebCookieHeader(cookies);
}

function browserHeaders(cookieHeader) {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cookie": cookieHeader,
    "Referer": `${GEMINI_BASE}/`,
    "Origin": GEMINI_BASE,
    "Sec-CH-UA": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=0, i",
  };
}

function rpcHeaders(cookieHeader, authHeader, contentType = "application/x-www-form-urlencoded;charset=utf-8") {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": contentType,
    "Cookie": cookieHeader,
    "Authorization": authHeader,
    "Referer": `${GEMINI_BASE}/app`,
    "Origin": GEMINI_BASE,
    "X-Same-Domain": "1",
    "Sec-CH-UA": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=0, i",
  };
}

async function doFetch(url, options, proxy) {
  await requestJitter();
  if (proxy && (proxy.connectionProxyEnabled || proxy.vercelRelayUrl)) {
    const { proxyAwareFetch } = await import("../utils/proxyFetch.js");
    return proxyAwareFetch(url, options, {
      connectionProxyEnabled: proxy.connectionProxyEnabled || false,
      connectionProxyUrl: proxy.connectionProxyUrl || "",
      connectionNoProxy: proxy.connectionNoProxy || "",
      vercelRelayUrl: proxy.vercelRelayUrl || "",
    });
  }
  return fetch(url, options);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bootstrap a Gemini Web session by fetching /app and extracting session params.
 *
 * Extracts SNlM0e from HTML for XSRF protection in StreamGenerate requests.
 * Auth is done via SAPISIDHASH header + SNlM0e (at token) in form body.
 *
 * @param {Object} cookies     Cookie key-value map (from geminiWebCookie parser)
 * @param {Object} options     { proxy, signal, timeoutMs }
 * @returns {{ sapisid: string, authHeader: string, buildLabel: string|null, sessionId: string|null, language: string, pushId: string|null, snlm0e: string|null, accountUser: string|null, warnings: string[] }}
 * @throws {Error} If cookies invalid or fetch fails
 */
export async function bootstrapGeminiWebSession(cookies, options = {}) {
  await requestJitter();
  const warnings = [];

  // Validate cookies first
  const validation = validateGeminiWebCookies(cookies, { throwOnError: false });
  if (!validation.valid) {
    const err = new Error(validation.error || "Invalid Gemini Web cookies");
    err.status = 401;
    err.code = "invalid_cookie";
    throw err;
  }
  warnings.push(...(validation.warnings || []));

  const sapisid = extractSapisid(cookies);
  if (!sapisid) {
    // Note: SAPISID is not strictly required but highly recommended
    warnings.push("SAPISID cookie not found — auth may fail");
  }

  const { headerValue: authHeader } = buildSapisidHash(sapisid);
  const cookieHeader = buildCookieHeader(cookies);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const signal = options.signal || controller.signal;

    const res = await doFetch(GEMINI_APP_URL, {
      method: "GET",
      headers: browserHeaders(cookieHeader),
      redirect: "manual",
      signal,
    }, options.proxy);

    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const err = new Error("Cookie expired — redirected to login page");
      err.status = 401;
      err.code = "cookie_expired";
      throw err;
    }

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Authentication failed (HTTP ${res.status})`);
      err.status = res.status;
      err.code = "auth_failed";
      throw err;
    }

    if (!res.ok) {
      const err = new Error(`Gemini returned HTTP ${res.status}`);
      err.status = res.status;
      err.code = "http_error";
      throw err;
    }

    const html = await res.text();

    // Extract session parameters from HTML
    const buildLabel = extractField(html, BUILD_LABEL_PATTERN);
    const sessionId = extractField(html, SESSION_ID_PATTERN);
    const language = extractField(html, LANGUAGE_PATTERN) || "en";
    const pushId = extractField(html, PUSH_ID_PATTERN);
    const snlm0e = extractField(html, SNLM0E_PATTERN);
    const accountUser = extractField(html, /"userId"\s*:\s*"(\d+)"/);

    if (!snlm0e) {
      warnings.push("SNlM0e token not found in HTML — StreamGenerate may fail with XSRF error");
    }

    return {
      sapisid,
      authHeader,
      buildLabel,
      sessionId,
      language,
      pushId,
      snlm0e,
      accountUser,
      cookies,
      warnings,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Session bootstrap timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      timeoutErr.status = 408;
      timeoutErr.code = "timeout";
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * Extract a value from HTML using a regex pattern.
 */
function extractField(html, pattern) {
  if (!html) return null;
  const m = html.match(pattern);
  return m ? m[1] : null;
}

/**
 * Get user account status and available models via BatchExecute RPC.
 *
 * @param {Object} cookies       Cookie key-value map
 * @param {string} authHeader    SAPISIDHASH auth header
 * @param {Object} sessionParams { buildLabel, sessionId, language }
 * @param {Object} options       { proxy, signal, timeoutMs }
 * @returns {{ user: string|null, status: number|null, models: Array<{id:string,name:string}>, warnings: string[] }}
 */
export async function getGeminiWebUserStatus(cookies, authHeader, sessionParams = {}, options = {}) {
  const warnings = [];
  const cookieHeader = buildCookieHeader(cookies);

  if (!authHeader) {
    warnings.push("No auth header — cannot fetch user status");
    return { user: null, status: null, models: [], warnings };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const signal = options.signal || controller.signal;

    const rpcPayload = buildBatchExecuteBody([
      { rpcId: RPC_GET_USER_STATUS, payload: "[]" },
    ]);

    const params = new URLSearchParams();
    params.set("f.req", rpcPayload);
    if (sessionParams.buildLabel) params.set("bl", sessionParams.buildLabel);
    if (sessionParams.sessionId) params.set("f.sid", sessionParams.sessionId);
    params.set("hl", sessionParams.language || "en");
    params.set("_reqid", String(Math.floor(Math.random() * 90000) + 10000));
    params.set("rt", "c");

    const headers = {
      ...rpcHeaders(cookieHeader, authHeader),
      "x-goog-ext-525001261-jspb": "[1,null,null,null,null,null,null,null,[4]]",
      "x-goog-ext-73010989-jspb": "[0]",
    };

    const res = await doFetch(BATCHEXECUTE_URL, {
      method: "POST",
      headers,
      body: params.toString(),
      signal,
    }, options.proxy);

    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      const err = new Error("Authentication failed");
      err.status = res.status;
      throw err;
    }

    if (!res.ok) {
      warnings.push(`User status RPC returned HTTP ${res.status}`);
      return { user: null, status: null, models: [], warnings };
    }

    const text = await res.text();
    const frames = parseResponseFrames(text);
    const modelIds = extractModelList(frames);

    // Try to extract account status code
    let status = null;
    for (const frame of frames) {
      if (!Array.isArray(frame) || typeof frame[2] !== "string") continue;
      try {
        const inner = JSON.parse(frame[2]);
        const statusCode = getNestedValue(inner, [14]);
        if (typeof statusCode === "number") {
          status = statusCode;
          break;
        }
      } catch {
        continue;
      }
    }

    return { user: null, status, models: modelIds, warnings };
  } catch (err) {
    if (err.name === "AbortError") {
      warnings.push(`User status request timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      return { user: null, status: null, models: [], warnings };
    }
    throw err;
  }
}

/**
 * Send bard settings RPC (initialization).
 */
export async function sendBardSettings(cookies, authHeader, sessionParams = {}, options = {}) {
  if (!authHeader) return false;
  const cookieHeader = buildCookieHeader(cookies);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const signal = options.signal || controller.signal;

    const rpcPayload = buildBatchExecuteBody([
      {
        rpcId: RPC_BARD_SETTINGS,
        payload: JSON.stringify([[["bard_activity_enabled"]]]),
      },
    ]);

    const params = new URLSearchParams();
    params.set("f.req", rpcPayload);
    if (sessionParams.buildLabel) params.set("bl", sessionParams.buildLabel);
    if (sessionParams.sessionId) params.set("f.sid", sessionParams.sessionId);
    params.set("hl", sessionParams.language || "en");
    params.set("_reqid", String(Math.floor(Math.random() * 90000) + 10000));
    params.set("rt", "c");

    const headers = {
      ...rpcHeaders(cookieHeader, authHeader),
      "x-goog-ext-525001261-jspb": "[1,null,null,null,null,null,null,null,[4]]",
      "x-goog-ext-73010989-jspb": "[0]",
    };

    const res = await doFetch(BATCHEXECUTE_URL, {
      method: "POST",
      headers,
      body: params.toString(),
      signal,
    }, options.proxy);

    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Simple session refresh: re-bootstrap to get fresh session params.
 *
 * @param {Object} cookies  Cookie key-value map
 * @param {Object} options  { proxy, signal, timeoutMs }
 * @returns {Promise<Object>} Fresh session
 */
export async function refreshGeminiWebSession(cookies, options = {}) {
  return bootstrapGeminiWebSession(cookies, options);
}
