import { AI_PROVIDERS } from "../shared/constants/providers.js";
import { parseGeminiWebCookies } from "../../open-sse/services/geminiWebCookie.js";

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

  // Cookie-based web providers (gemini-web, grok-web, perplexity-web)
  // Parse the raw cookie input from apiKey field into structured cookies
  if (provider === "gemini-web") {
    const rawCookie = next.cookieText || body.apiKey || "";
    if (rawCookie && !next.cookies) {
      const parsed = parseGeminiWebCookies(rawCookie, { throwOnError: false });
      if (parsed.cookies && Object.keys(parsed.cookies).length > 0) {
        next.cookies = parsed.cookies;
        next.cookieText = rawCookie;
      }
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}
