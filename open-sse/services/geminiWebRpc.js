/**
 * Gemini Web RPC — Build & parse for StreamGenerate endpoint.
 *
 * This module implements the protocol used by gemini.google.com:
 *   - Endpoint: /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   - Payload:  69‑slot inner array (mirrors the Python gemini_webapi library)
 *   - Auth:     SAPISIDHASH header (not SNlM0e — Google removed it from HTML)
 *   - Response: Length‑prefixed JSON frames ("wrb.fr" frames)
 *
 * The generated text lives at: candidates[0][1][0] within the wrb.fr frame.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// 69‑slot payload builder (mirrors Gemini-API Python inner_req_list)
// ---------------------------------------------------------------------------

/**
 * Build the 69‑slot inner request array for StreamGenerate.
 *
 * @param {Object} options
 * @param {string} options.prompt          The user's text prompt
 * @param {Array}  [options.metadata]      Chat metadata [cid?, rid?, rcid?, ...]
 * @param {string} [options.language="en"] Language code
 * @param {boolean} [options.streaming=true] Streaming mode
 * @param {string|null} [options.gemId]    Gem ID for system prompt
 * @param {boolean} [options.temporary=false] Temporary chat
 * @param {Array|null} [options.fileData]  File attachments
 * @returns {Array} 69-slot array
 */
export function buildInnerPayload({
  prompt,
  metadata = null,
  language = "en",
  streaming = true,
  gemId = null,
  temporary = false,
  fileData = null,
}) {
  const inner = new Array(69).fill(null);

  inner[0] = [prompt, 0, null, fileData, null, null, 0];
  inner[1] = [language];
  inner[2] = metadata || ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [1];
  inner[7] = streaming ? 1 : 0;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  if (gemId) inner[19] = gemId;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  if (temporary) inner[45] = 1;
  inner[53] = 0;
  inner[59] = crypto.randomUUID().toUpperCase();
  inner[61] = [];
  inner[68] = 2;

  return inner;
}

/**
 * Build the full `f.req` value for StreamGenerate.
 * Format: [null, JSON.stringify(inner69Array)]
 *
 * @param {Array} innerPayload  The 69-slot inner array
 * @returns {string} JSON string ready for f.req body parameter
 */
export function buildFreqPayload(innerPayload) {
  const outer = [null, JSON.stringify(innerPayload)];
  return JSON.stringify(outer);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse length-prefixed JSON frames from a Google API response.
 *
 * Format:
 *   )]}'
 *   <length>\n
 *   <json_data_of_length_utf16_units>
 *
 * @param {string} text  Raw response text
 * @returns {Array} Parsed JSON frames
 */
export function parseResponseFrames(text) {
  if (!text || typeof text !== "string") return [];

  let content = text.trim();
  if (content.startsWith(")]}'")) {
    content = content.slice(4).trimStart();
  }

  const results = [];
  let pos = 0;

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (pos >= content.length) break;

    // Read length digits
    let lenStr = "";
    while (pos < content.length && /\d/.test(content[pos])) {
      lenStr += content[pos];
      pos++;
    }
    if (!lenStr) break;

    const length = parseInt(lenStr, 10);
    if (!Number.isFinite(length) || length <= 0) break;

    const startContent = pos;

    // Count UTF-16 units (Google uses JS String.length = UTF-16 code units)
    let unitsCount = 0;
    let charsCount = 0;
    while (startContent + charsCount < content.length && unitsCount < length) {
      const codePoint = content.charCodeAt(startContent + charsCount);
      unitsCount += (codePoint >= 0xD800 && codePoint <= 0xDBFF) ? 2 : 1;
      charsCount++;
    }

    if (unitsCount < length) break; // Incomplete frame

    const chunk = content.slice(startContent, startContent + charsCount).trim();
    pos = startContent + charsCount;

    if (!chunk) continue;

    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else {
        results.push(parsed);
      }
    } catch {
      // Skip malformed chunks
    }
  }

  return results;
}

/**
 * Navigate through a nested structure using a path of keys/indices.
 */
export function getNestedValue(data, path, defaultVal = null) {
  let current = data;
  for (const key of path) {
    if (current == null) return defaultVal;
    if (typeof key === "number") {
      if (!Array.isArray(current) || key < 0 || key >= current.length) return defaultVal;
      current = current[key];
    } else if (typeof key === "string") {
      if (typeof current !== "object" || !(key in current)) return defaultVal;
      current = current[key];
    }
  }
  return current;
}

/**
 * Extract generated text from parsed Gemini Web response frames.
 *
 * The response structure:
 *   ["wrb.fr", null, "<json_string>"]
 *
 * Where <json_string> parses to:
 *   [null, ["c_xxx", "r_xxx"], null, null, [
 *     ["rc_xxx", ["Hello World!"], null, ...]  // candidate
 *   ]]
 *
 * Text is at: candidate[1][0]
 *
 * @param {Array} parsedFrames  Parsed response frames
 * @returns {{ text: string, thoughts: string, cid: string, rid: string, rcid: string }|null}
 */
export function extractGeminiResponse(parsedFrames) {
  if (!parsedFrames || !Array.isArray(parsedFrames)) return null;

  let bestText = "";
  let bestThoughts = "";
  let cid = "";
  let rid = "";
  let rcid = "";

  for (const frame of parsedFrames) {
    if (!Array.isArray(frame) || frame[0] !== "wrb.fr") continue;

    const innerJsonStr = frame[2];
    if (typeof innerJsonStr !== "string") continue;

    try {
      const inner = JSON.parse(innerJsonStr);

      // inner[1] = ["c_xxx", "r_xxx"]
      const meta = getNestedValue(inner, [1]);
      if (Array.isArray(meta)) {
        if (meta[0]) cid = meta[0];
        if (meta[1]) rid = meta[1];
      }

      // inner[4] = [candidate1, candidate2, ...]
      const candidates = getNestedValue(inner, [4], []);
      if (!Array.isArray(candidates)) continue;

      for (const cand of candidates) {
        if (!Array.isArray(cand)) continue;

        const candRcid = getNestedValue(cand, [0], "");
        if (candRcid) rcid = candRcid;

        // Text: candidate[1][0]
        const text = getNestedValue(cand, [1, 0], "");
        if (text && text.length > bestText.length) {
          bestText = text;
        }

        // Thoughts: candidate[37][0][0]
        const thoughts = getNestedValue(cand, [37, 0, 0], "");
        if (thoughts && thoughts.length > bestThoughts.length) {
          bestThoughts = thoughts;
        }
      }
    } catch {
      continue;
    }
  }

  if (!bestText) return null;

  // Clean HTML entities
  bestText = cleanText(bestText);
  if (bestThoughts) bestThoughts = cleanText(bestThoughts);

  return { text: bestText, thoughts: bestThoughts, cid, rid, rcid };
}

/**
 * Clean HTML entities from text.
 */
function cleanText(text) {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .trim();
}

/**
 * Extract model list from batchexecute user-status response.
 *
 * @param {Array} parsedFrames
 * @returns {string[]} Array of model ID strings
 */
export function extractModelList(parsedFrames) {
  if (!parsedFrames || !Array.isArray(parsedFrames)) return [];
  const models = new Set();

  for (const frame of parsedFrames) {
    if (!Array.isArray(frame) || typeof frame[2] !== "string") continue;
    try {
      const inner = JSON.parse(frame[2]);
      const modelList = getNestedValue(inner, [15], []);
      if (Array.isArray(modelList)) {
        for (const modelData of modelList) {
          if (Array.isArray(modelData)) {
            const modelId = getNestedValue(modelData, [0], "");
            const displayName = getNestedValue(modelData, [1], "");
            if (modelId && displayName) models.add(modelId);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return [...models];
}

/**
 * Parse streaming buffer incrementally.
 * Returns parsed frames and remaining buffer.
 *
 * @param {string} buffer  Accumulated response text
 * @returns {{ frames: Array, remaining: string }}
 */
export function parseStreamFrames(buffer) {
  if (!buffer) return { frames: [], remaining: "" };

  let content = buffer;
  if (content.startsWith(")]}'")) {
    content = content.slice(4).trimStart();
  }

  const frames = [];
  let pos = 0;

  while (pos < content.length) {
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (pos >= content.length) break;

    let lenStr = "";
    while (pos < content.length && /\d/.test(content[pos])) {
      lenStr += content[pos];
      pos++;
    }
    if (!lenStr) break;

    const length = parseInt(lenStr, 10);
    if (!Number.isFinite(length) || length <= 0) break;

    const startContent = pos;
    let unitsCount = 0;
    let charsCount = 0;
    while (startContent + charsCount < content.length && unitsCount < length) {
      const codePoint = content.charCodeAt(startContent + charsCount);
      unitsCount += (codePoint >= 0xD800 && codePoint <= 0xDBFF) ? 2 : 1;
      charsCount++;
    }

    if (unitsCount < length) {
      return { frames, remaining: content.slice(pos) };
    }

    const chunk = content.slice(startContent, startContent + charsCount).trim();
    pos = startContent + charsCount;

    if (!chunk) continue;

    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return { frames, remaining: content.slice(pos) };
}

/**
 * Build f.req for batch execute (used by session init / user status).
 *
 * @param {Array<{rpcId: string, payload: string}>} rpcList
 * @returns {string} f.req value
 */
export function buildBatchExecuteBody(rpcList) {
  const items = rpcList.map(r => [r.rpcId, r.payload, null, "generic"]);
  return JSON.stringify([items]);
}

/**
 * Legacy: extract generated text from raw response text.
 * Combines parse + extract in one call.
 *
 * @param {string} text Raw response text from StreamGenerate
 * @returns {{ text: string, thoughts: string, cid: string, rid: string, rcid: string }|null}
 */
export function extractGeneratedText(text) {
  if (!text) return null;
  const frames = parseResponseFrames(text);
  return extractGeminiResponse(frames);
}

// ---------------------------------------------------------------------------
// Media extraction (images, videos, audio) — mirrors Python gemini_webapi
// ---------------------------------------------------------------------------

/**
 * Extract generated media (images, videos, audio) from parsed Gemini Web response frames.
 *
 * Field paths (from HanaokaYuzu/Gemini-API Python library):
 *   Generated Images:
 *     - Plain generation: candidate[12][7][0] -> array of gen_img_data
 *     - Image-to-image:   candidate[12][0]["8"][0] -> array of gen_img_data
 *     Each gen_img_data:
 *       URL:      [0][3][3]
 *       Alt:      [0][3][2]
 *       Image ID: [1][0]
 *
 *   Generated Videos:
 *     candidate[12][59][0][0][0] -> video_info
 *     video_info[0][7] = [thumbnail_url, video_url]
 *
 *   Generated Media (Audio/Music):
 *     candidate[12][86] -> media_data array
 *     media_data[0] = MP3 entry: [0][1][7] = [thumbnail_url, mp3_url]
 *     media_data[1] = MP4 entry: [1][1][7] = [thumbnail_url, mp4_url]
 *
 *   Web Images (search results, not AI-generated):
 *     candidate[12][1] -> array of web_img_data
 *     Each: [i][0][0][0] = URL, [i][0][4] = alt text
 *
 * @param {Array} parsedFrames  Parsed response frames
 * @returns {{ images: Array, videos: Array, audio: Array, webImages: Array }}
 */
export function extractGeminiMedia(parsedFrames) {
  const result = {
    images: [],
    videos: [],
    audio: [],
    webImages: [],
  };

  if (!parsedFrames || !Array.isArray(parsedFrames)) return result;

  for (const frame of parsedFrames) {
    if (!Array.isArray(frame) || frame[0] !== "wrb.fr") continue;

    const innerJsonStr = frame[2];
    if (typeof innerJsonStr !== "string") continue;

    try {
      const inner = JSON.parse(innerJsonStr);
      const candidates = getNestedValue(inner, [4], []);
      if (!Array.isArray(candidates)) continue;

      for (const cand of candidates) {
        if (!Array.isArray(cand)) continue;

        const cid = getNestedValue(cand, [0], "");
        const rcid = cid;

        // --- Generated Images ---
        const plainGenImages = getNestedValue(cand, [12, 7, 0], []);
        const imgToImg = getNestedValue(cand, [12, 0, "8", 0], []);
        const allGenImgData = [
          ...(Array.isArray(plainGenImages) ? plainGenImages : []),
          ...(Array.isArray(imgToImg) ? imgToImg : []),
        ];

        for (let i = 0; i < allGenImgData.length; i++) {
          const genImg = allGenImgData[i];
          const url = getNestedValue(genImg, [0, 3, 3], "");
          if (url) {
            const alt = getNestedValue(genImg, [0, 3, 2], "");
            let imageId = getNestedValue(genImg, [1, 0], "");
            if (!imageId) imageId = `gen_img_${i}`;
            result.images.push({ url, alt, imageId, rcid });
          }
        }

        // --- Generated Videos ---
        const videoInfo = getNestedValue(cand, [12, 59, 0, 0, 0], []);
        if (Array.isArray(videoInfo) && videoInfo.length > 0) {
          const urls = getNestedValue(videoInfo, [0, 7], []);
          if (Array.isArray(urls) && urls.length >= 2) {
            result.videos.push({
              url: urls[1],
              thumbnail: urls[0],
              rcid,
            });
          }
        }

        // --- Generated Media (Audio/Music) ---
        const mediaData = getNestedValue(cand, [12, 86], []);
        if (Array.isArray(mediaData)) {
          const mp3Entry = mediaData[0];
          if (mp3Entry) {
            const mp3List = getNestedValue(mp3Entry, [1, 7], []);
            if (Array.isArray(mp3List) && mp3List.length >= 2) {
              result.audio.push({
                url: mp3List[1],
                thumbnail: mp3List[0],
                format: "mp3",
                rcid,
              });
            }
          }
          const mp4Entry = mediaData[1];
          if (mp4Entry) {
            const mp4List = getNestedValue(mp4Entry, [1, 7], []);
            if (Array.isArray(mp4List) && mp4List.length >= 2) {
              result.audio.push({
                url: mp4List[1],
                thumbnail: mp4List[0],
                format: "mp4",
                rcid,
              });
            }
          }
        }

        // --- Web Images (search results) ---
        const webImages = getNestedValue(cand, [12, 1], []);
        if (Array.isArray(webImages)) {
          for (const webImg of webImages) {
            const url = getNestedValue(webImg, [0, 0, 0], "");
            const alt = getNestedValue(webImg, [0, 4], "");
            if (url) {
              result.webImages.push({ url, alt, rcid });
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return result;
}

/**
 * Extract ALL data from a Gemini Web response -- text, thoughts, and media.
 *
 * @param {Array} parsedFrames  Parsed response frames
 * @returns {{ text, thoughts, cid, rid, rcid, images, videos, audio, webImages }|null}
 */
export function extractGeminiFullResponse(parsedFrames) {
  const textResult = extractGeminiResponse(parsedFrames);
  const media = extractGeminiMedia(parsedFrames);

  if (!textResult && media.images.length === 0 && media.videos.length === 0 && media.audio.length === 0) {
    return null;
  }

  return {
    ...(textResult || { text: "", thoughts: "", cid: "", rid: "", rcid: "" }),
    images: media.images,
    videos: media.videos,
    audio: media.audio,
    webImages: media.webImages,
  };
}
