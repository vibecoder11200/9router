// Pre-fetch remote image URLs into base64 BEFORE translation, for target
// formats whose upstream providers cannot fetch remote URLs themselves
// (they require inline base64). Runs on the source-format body.
import { FORMATS } from "../formats.js";
import { fetchImageAsBase64, parseDataUri } from "./image.js";

// Targets that require inline base64 images (cannot accept remote URLs).
const TARGETS_NEED_BASE64 = new Set([
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, FORMATS.KIRO,
]);

function isRemoteUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// C2 follow-up: the body isolation fix made every fallback attempt re-run
// prefetchRemoteImages on a pristine clone, so without memoization a request
// with remote images re-downloaded them per attempt (and per fusion member).
// Short TTL cache keyed by URL — chat images are effectively immutable over
// seconds, and a stale image is bounded by the TTL.
const IMAGE_FETCH_CACHE = new Map();
const IMAGE_FETCH_TTL_MS = 5 * 60 * 1000;
const IMAGE_FETCH_CACHE_MAX = 100;
// Data URIs are ~1.33x the image bytes — cap per-entry size and the total
// resident budget so a burst of multi-MB images cannot balloon the heap.
const IMAGE_FETCH_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
let imageCacheTotalBytes = 0;

async function fetchImageAsBase64Cached(url, options) {
  const now = Date.now();
  const hit = IMAGE_FETCH_CACHE.get(url);
  if (hit && now - hit.ts < IMAGE_FETCH_TTL_MS) return hit.value;
  const value = await fetchImageAsBase64(url, options);
  if (value) {
    const entryBytes = (value.url || "").length;
    if (entryBytes <= IMAGE_FETCH_MAX_ENTRY_BYTES) {
      while (IMAGE_FETCH_CACHE.size > 0
        && (imageCacheTotalBytes + entryBytes > IMAGE_FETCH_MAX_TOTAL_BYTES || IMAGE_FETCH_CACHE.size >= IMAGE_FETCH_CACHE_MAX)) {
        const oldestKey = IMAGE_FETCH_CACHE.keys().next().value;
        const oldest = IMAGE_FETCH_CACHE.get(oldestKey);
        imageCacheTotalBytes -= oldest?.bytes || 0;
        IMAGE_FETCH_CACHE.delete(oldestKey);
      }
      IMAGE_FETCH_CACHE.set(url, { value, ts: now, bytes: entryBytes });
      imageCacheTotalBytes += entryBytes;
    }
  }
  return value;
}

// Collect {get,set} accessors for every remote image URL in a source body.
function collectImageRefs(body, sourceFormat) {
  const refs = [];
  const pushOpenAI = (messages) => {
    for (const msg of messages || []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === "image_url") {
          const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
          if (isRemoteUrl(url)) refs.push({ get: () => url, set: (v) => {
            if (typeof block.image_url === "string") block.image_url = v; else block.image_url.url = v;
          } });
        }
      }
    }
  };
  const pushGemini = (contents) => {
    for (const c of contents || []) {
      for (const p of c.parts || []) {
        const uri = p?.fileData?.fileUri;
        if (isRemoteUrl(uri)) refs.push({ get: () => uri, part: p });
      }
    }
  };

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      pushOpenAI(body.messages);
      break;
    case FORMATS.CLAUDE:
      for (const msg of body.messages || []) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "image" && block.source?.type === "url" && isRemoteUrl(block.source.url)) {
            refs.push({ get: () => block.source.url, claudeBlock: block });
          }
        }
      }
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      pushGemini(body.contents);
      break;
    case FORMATS.ANTIGRAVITY:
      pushGemini(body?.request?.contents);
      break;
    default:
      pushOpenAI(body.messages);
  }
  return refs;
}

/**
 * Replace remote image URLs with base64 data when the target needs inline data.
 * No-op when target accepts remote URLs (e.g. openai, claude) or body has none.
 * @returns {Promise<number>} count of images converted
 */
export async function prefetchRemoteImages(body, sourceFormat, targetFormat, options = {}) {
  if (!body || !TARGETS_NEED_BASE64.has(targetFormat)) return 0;
  const refs = collectImageRefs(body, sourceFormat);
  if (!refs.length) return 0;

  let converted = 0;
  for (const ref of refs) {
    const url = ref.get();
    if (parseDataUri(url)) continue; // already inline
    const fetched = await fetchImageAsBase64Cached(url, options);
    if (!fetched) continue;
    if (ref.set) ref.set(fetched.url);
    else if (ref.part) { delete ref.part.fileData; ref.part.inlineData = { mimeType: fetched.mimeType, data: fetched.url.split(",")[1] }; }
    else if (ref.claudeBlock) ref.claudeBlock.source = { type: "base64", media_type: fetched.mimeType, data: fetched.url.split(",")[1] };
    converted++;
  }
  return converted;
}
