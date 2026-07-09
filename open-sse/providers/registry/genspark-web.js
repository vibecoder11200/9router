/**
 * Genspark Web (cookie-based) — exposes https://www.genspark.ai Copilot MOA backend
 * as an OpenAI-compatible chat completions endpoint.
 *
 * Auth: paste the `session_id=...` cookie value harvested from genspark.ai (F12 → Network →
 * any /api/copilot/ask request → Request Headers → Cookie). Both the bare session id and the
 * full `session_id=abc123` form are accepted; the executor normalises to the latter.
 *
 * Upstream endpoint: POST https://www.genspark.ai/api/copilot/ask (SSE for streaming,
 * application/json for non-streaming). The response is a stream of `data: {json}` frames with
 * types: project_start | message_field | message_field_delta | message_result.
 *
 * Models mirror genspark2api/common/constants.go:
 *   - TextModelList  → exposed directly (single-model MOA chat)
 *   - "-search" suffix on any text model → enables request_web_knowledge (web grounding)
 *   - ImageModelList → routed by the executor to COPILOT_MOA_IMAGE flow (polls /api/ig_tasks_status,
 *     returns markdown image links inside the chat completion)
 *   - MixtureModelList is used as a fallback when the requested model is not in TextModelList and
 *     is not an image model — this triggers Genspark's Mixture-of-Agents routing.
 *
 * Reference: https://github.com/deanxv/genspark2api
 */
export default {
  id: "genspark-web",
  priority: 240,
  alias: "genspark-web",
  aliases: ["gs-web", "gspark", "genspark"],
  uiAlias: "gspark",
  display: {
    name: "Genspark Web (Subscription)",
    icon: "auto_awesome",
    color: "#FF6B35",
    textIcon: "GS",
    website: "https://www.genspark.ai",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your session_id cookie value from genspark.ai (e.g. session_id=abc123)",
  transport: {
    baseUrl: "https://www.genspark.ai/api/copilot/ask",
    format: "genspark-web",
    authType: "cookie",
  },
  passthroughModels: true,
  // Text models — single-model MOA chat. Source: genspark2api/common/constants.go TextModelList.
  // Search variants are derived at runtime by appending "-search" to any id below.
  models: [
    // ── OpenAI family ───────────────────────────────────────────────────────
    { id: "gpt-5-pro", name: "GPT-5 Pro" },
    { id: "gpt-5.1-low", name: "GPT-5.1 Low" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
    { id: "o3-pro", name: "o3 Pro" },
    // ── Anthropic family ────────────────────────────────────────────────────
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-4-5-haiku", name: "Claude 4.5 Haiku" },
    // ── Google family ───────────────────────────────────────────────────────
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
    // ── xAI family ──────────────────────────────────────────────────────────
    { id: "grok-4-0709", name: "Grok 4 (0709)" },
    // ── Image generation models (routed to COPILOT_MOA_IMAGE flow) ──────────
    { id: "nano-banana-pro", name: "Nano Banana Pro", kind: "image" },
    { id: "nano-banana-2", name: "Nano Banana 2", kind: "image" },
    { id: "fal-ai/bytedance/seedream/v5/lite", name: "Seedream v5 Lite", kind: "image" },
    { id: "fal-ai/flux-2", name: "Flux 2", kind: "image" },
    { id: "fal-ai/flux-2-pro", name: "Flux 2 Pro", kind: "image" },
    { id: "fal-ai/z-image/turbo", name: "Z-Image Turbo", kind: "image" },
    { id: "fal-ai/gpt-image-1.5", name: "GPT-Image 1.5", kind: "image" },
    { id: "recraft-v3", name: "Recraft v3", kind: "image" },
    { id: "ideogram/V_3", name: "Ideogram V3", kind: "image" },
    { id: "qwen-image", name: "Qwen Image", kind: "image" },
  ],
};
