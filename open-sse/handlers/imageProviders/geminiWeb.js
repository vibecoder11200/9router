/**
 * Gemini Web Image Adapter
 *
 * Gemini Web doesn't have a separate image API — image generation happens
 * through the same StreamGenerate chat endpoint. The prompt is sent as a
 * chat message, and the response contains generated image URLs at
 * candidate[12][7][0] (plain) or candidate[12][0]["8"][0] (image-to-image).
 *
 * This adapter reuses the GeminiWebExecutor to send the request, then
 * extracts image URLs from the response and converts to base64.
 */

import { extractGeminiWebCredentials } from "../../services/geminiWebCookie.js";
import {
  bootstrapGeminiWebSession,
  buildSapisidHash,
  extractSapisid,
} from "../../services/geminiWebSession.js";
import {
  buildInnerPayload,
  buildFreqPayload,
  parseResponseFrames,
  extractGeminiMedia,
} from "../../services/geminiWebRpc.js";
import { resolveGeminiWebModel } from "../../services/geminiWebModels.js";
import { urlToBase64, nowSec } from "./_base.js";
import crypto from "crypto";

const GEMINI_BASE = "https://gemini.google.com";
const STREAMGENERATE_URL = `${GEMINI_BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

function buildCookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export default {
  // Gemini Web image gen uses the executor (chat endpoint), not a direct API call.
  // The imageGenerationCore handler calls buildUrl/buildBody/buildHeaders only when
  // fetch is used directly. For gemini-web, we override parseResponse to handle everything.
  noAuth: false,

  buildUrl: () => STREAMGENERATE_URL,

  buildHeaders: (creds) => {
    const extracted = extractGeminiWebCredentials(creds || {});
    if (!extracted.valid) return {};
    const cookies = extracted.cookies;
    const sapisid = extractSapisid(cookies);
    const auth = sapisid ? buildSapisidHash(sapisid).headerValue : "";
    return {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "Cookie": buildCookieHeader(cookies),
      ...(auth ? { Authorization: auth } : {}),
      "Origin": GEMINI_BASE,
      "Referer": `${GEMINI_BASE}/app`,
      "X-Same-Domain": "1",
    };
  },

  buildBody: (model, body) => {
    // The prompt for image generation
    const prompt = body.prompt || "";
    const inner = buildInnerPayload({
      prompt,
      streaming: false,
    });
    return buildFreqPayload(inner);
  },

  /**
   * Custom parseResponse — we need to:
   * 1. Bootstrap a session (get auth tokens)
   * 2. Send the StreamGenerate request with proper auth
   * 3. Parse media from response
   * 4. Download image URLs → base64
   */
  async parseResponse(providerResponse, { log }) {
    const responseText = await providerResponse.text();
    const frames = parseResponseFrames(responseText);
    const media = extractGeminiMedia(frames);

    if (media.images.length === 0) {
      // Check for error in response
      const errorMatch = responseText.match(/"Image Generation Limit Reached"/);
      if (errorMatch) {
        throw new Error(
          "Gemini Web image generation limit reached. Try again later or use a different account."
        );
      }
      throw new Error(
        "Gemini Web did not return any generated images. The account may not have image generation enabled."
      );
    }

    // Download first image URL → base64
    const firstImage = media.images[0];
    try {
      const b64 = await urlToBase64(firstImage.url);
      log?.info?.("IMAGE", `Gemini Web image fetched: ${media.images.length} images`);
      return {
        created: nowSec(),
        data: [{ b64_json: b64, revised_prompt: firstImage.alt || "" }],
      };
    } catch (err) {
      // If download fails, return URL instead
      log?.warn?.("IMAGE", `Failed to download Gemini Web image: ${err.message}`);
      return {
        created: nowSec(),
        data: [{ url: firstImage.url, revised_prompt: firstImage.alt || "" }],
      };
    }
  },

  normalize: (responseBody) => responseBody,
};
