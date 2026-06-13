/**
 * Gemini Web Usage Service.
 *
 * Gemini Web doesn't have a dedicated usage/quota API like other providers.
 * Instead, we probe the session health and attempt to detect rate-limit
 * signals from the generation RPC responses.
 *
 * Usage data is best-effort — we report:
 *   - Session health (valid/expired)
 *   - Model availability (from account status)
 *   - Any rate-limit warnings from recent interactions
 */

import { extractGeminiWebCredentials } from "./geminiWebCookie.js";
import { bootstrapGeminiWebSession, getGeminiWebUserStatus } from "./geminiWebSession.js";

/**
 * Get usage/quota info for a Gemini Web connection.
 *
 * @param {Object} connection  Provider connection object
 * @param {Object} proxyOptions  Proxy config (optional)
 * @returns {Object} Usage data
 */
export async function getGeminiWebUsage(connection, proxyOptions = null) {
  const extracted = extractGeminiWebCredentials(connection || {});
  if (!extracted.valid) {
    return {
      provider: "gemini-web",
      status: "invalid",
      message: extracted.error || "Invalid or missing cookies",
      quotas: [],
    };
  }

  const proxy = proxyOptions || null;
  const options = { proxy, timeoutMs: 15_000 };

  try {
    // Bootstrap session to check cookie validity + get SNlM0e
    const session = await bootstrapGeminiWebSession(extracted.cookies, options);

    // Try to get user status + model list
    let models = [];
    try {
      const status = await getGeminiWebUserStatus(extracted.cookies, session.snlToken, options);
      models = status.models || [];
    } catch {
      // Non-critical — session is valid even if status RPC fails
    }

    return {
      provider: "gemini-web",
      status: "active",
      message: "Session is valid",
      accountUser: session.accountUser || null,
      availableModels: models.length > 0 ? models : undefined,
      quotas: [
        {
          name: "Session Health",
          used: 0,
          limit: 1,
          unit: "session",
          status: "active",
          note: "Cookie-based session — no API quota tracking available",
        },
      ],
      warnings: session.warnings || [],
    };
  } catch (err) {
    const isExpired = err.status === 401 || err.code === "cookie_expired" || err.code === "snl_not_found";

    return {
      provider: "gemini-web",
      status: isExpired ? "expired" : "error",
      message: err.message,
      quotas: [
        {
          name: "Session Health",
          used: 0,
          limit: 1,
          unit: "session",
          status: isExpired ? "expired" : "error",
          note: err.message,
        },
      ],
    };
  }
}
