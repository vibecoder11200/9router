// ---------------------------------------------------------------------------
// Gemini Web — Session Keep-Alive (Layer 2)
//
// Periodically pings Gemini to keep session alive.
// Google may invalidate sessions that appear idle — this prevents that
// by simulating "user is active" signals.
//
// Strategy:
//   1. GET /app (page refresh) — every 30 min
//   2. Lightweight BatchExecute RPC (bard_settings) — every 20 min
//      This simulates UI interaction without consuming quota
// ---------------------------------------------------------------------------

import { bootstrapGeminiWebSession, sendBardSettings, buildSapisidHash } from "./geminiWebSession.js";
import { extractGeminiWebCredentials } from "./geminiWebCookie.js";
import { getNextUserAgent } from "./geminiWebFingerprint.js";

const KEEP_ALIVE_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const PAGE_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Timers
let _bootstrapRef = null;
let _pageRefreshRef = null;

/**
 * Start keep-alive for a cookie set.
 * Must be called with valid credentials.
 */
export function startSessionKeepAlive(credentials, proxy) {
  const extracted = extractGeminiWebCredentials(credentials || {});
  if (!extracted.valid || !extracted.cookies) {
    return { started: false, error: "Invalid credentials" };
  }

  stopSessionKeepAlive();

  // RPC ping every 20 min — lightweight
  _bootstrapRef = setInterval(async () => {
    try {
      const session = await bootstrapGeminiWebSession(extracted.cookies, { proxy });
      await sendBardSettings(extracted.cookies, session.authHeader, {
        buildLabel: session.buildLabel,
        sessionId: session.sessionId,
        language: session.language,
      }, { proxy });
    } catch (err) {
      // Silent — keep-alive failures are non-critical
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  // Page refresh every 30 min — stronger keep-alive
  _pageRefreshRef = setInterval(async () => {
    try {
      // Just fetch /app with fresh headers to simulate page visit
      const GEMINI_APP_URL = "https://gemini.google.com/app";
      const cookieHeader = Object.entries(extracted.cookies)
        .filter(([k, v]) => k && v)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");

      await fetch(GEMINI_APP_URL, {
        method: "GET",
        headers: {
          "User-Agent": getNextUserAgent(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": cookieHeader,
          "Referer": "https://gemini.google.com/",
          "Origin": "https://gemini.google.com",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Silent
    }
  }, PAGE_REFRESH_INTERVAL_MS);

  return { started: true };
}

/**
 * Stop all keep-alive timers.
 */
export function stopSessionKeepAlive() {
  if (_bootstrapRef) { clearInterval(_bootstrapRef); _bootstrapRef = null; }
  if (_pageRefreshRef) { clearInterval(_pageRefreshRef); _pageRefreshRef = null; }
}
