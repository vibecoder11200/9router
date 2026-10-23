// Image provider adapter registry
import createOpenAIAdapter from "./openai.js";
import gemini from "./gemini.js";
import codex from "./codex.js";
import sdwebui from "./sdwebui.js";
import comfyui from "./comfyui.js";
import huggingface from "./huggingface.js";
import nanobanana from "./nanobanana.js";
import falAi from "./falAi.js";
import stabilityAi from "./stabilityAi.js";
import blackForestLabs from "./blackForestLabs.js";
import runwayml from "./runwayml.js";
import cloudflareAi from "./cloudflareAi.js";
import antigravity from "./antigravity.js";
import geminiWeb from "./geminiWeb.js";
import museWeb from "./muse-web.js";
import chatgptWeb from "./chatgpt-web.js";
// Upstream's browser-pool gemini-web image adapter lives beside the fork's
// RPC-driven one; it is registered under the distinct id "gemini-web-ui".
import geminiWebUi from "./gemini-web.js";
import grokWeb from "./grok-web.js";
import veoAiFreeWeb from "./veoaifree-web.js";
import ucWeb from "./uc-web.js";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  sensenova: createOpenAIAdapter("sensenova"),
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
  "gemini-web": geminiWeb,
  "gemini-web-ui": geminiWebUi,
  "muse-web": museWeb,
  "chatgpt-web": chatgptWeb,
  "grok-web": grokWeb,
  "veoaifree-web": veoAiFreeWeb,
  "uc-web": ucWeb,
};

export function getImageAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isImageProvider(provider) {
  return provider in ADAPTERS;
}
