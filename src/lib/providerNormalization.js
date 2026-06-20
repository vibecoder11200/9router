import { AI_PROVIDERS } from "../shared/constants/providers.js";
import {
  GEMINI_WEB_COOKIE_SENTINEL,
  maskGeminiWebCookies,
  parseGeminiWebCookies,
  validateGeminiWebCookies,
} from "open-sse/services/geminiWebCookie.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "gemini-web") {
    const rawCookieInput =
      next.cookieText ||
      body.cookieText ||
      body.cookie ||
      body.cookies ||
      body.apiKey ||
      body.accessToken ||
      "";

    if (next.cookies && typeof next.cookies === "object") {
      const validation = validateGeminiWebCookies(next.cookies, { throwOnError: false });
      next.cookieFormat = next.cookieFormat || "normalized";
      next.cookieWarnings = validation.warnings;
      delete next.cookieText;
    } else if (rawCookieInput) {
      const parsed = parseGeminiWebCookies(rawCookieInput, { throwOnError: false });
      next.cookies = parsed.cookies;
      next.cookieFormat = parsed.sourceFormat;
      next.cookieWarnings = parsed.warnings;
      delete next.cookieText;
    }

    if (body.apiKey && next.cookies && Object.keys(next.cookies).length > 0) {
      next.cookieStoredInProviderSpecificData = true;
      next.apiKey = body.apiKey;
    }
  }

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function sanitizeProviderSpecificData(provider, providerSpecificData = null) {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return providerSpecificData;
  const next = { ...providerSpecificData };
  if (provider === "gemini-web") {
    if (next.cookies) next.cookies = maskGeminiWebCookies(next.cookies);
    if (next.cookieText) next.cookieText = "***";
    if (next.apiKeySentinel) next.apiKeySentinel = "***";
  }
  return next;
}

export function normalizeProviderApiKey(provider, apiKey, providerSpecificData = null) {
  if (provider === "gemini-web" && providerSpecificData?.cookies && Object.keys(providerSpecificData.cookies).length > 0) {
    return GEMINI_WEB_COOKIE_SENTINEL;
  }
  return apiKey || "";
}
