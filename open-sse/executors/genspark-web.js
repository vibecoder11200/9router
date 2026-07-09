/**
 * Genspark Web Executor — calls https://www.genspark.ai Copilot MOA backend.
 *
 * Architecture mirrors genspark2api (https://github.com/deanxv/genspark2api):
 *   Endpoint: POST https://www.genspark.ai/api/copilot/ask
 *   Auth:     Cookie header (`session_id=...`). Both bare session id and the full
 *             `session_id=abc` form are accepted — we normalise to the latter.
 *   Body:     JSON with shape:
 *             {
 *               "type": "COPILOT_MOA_CHAT",
 *               "current_query_string": "type=COPILOT_MOA_CHAT",
 *               "messages": [...OpenAI messages...],
 *               "action_params": {},
 *               "extra_data": { "models": [...], "run_with_another_model": false,
 *                               "writingContent": null, "request_web_knowledge": false }
 *             }
 *   Response: SSE stream of `data: {json}` frames. Frame types we care about:
 *             - project_start              → captures project_id (used for cleanup if needed)
 *             - message_field              → field_name + delta/content (full or start of field)
 *             - message_field_delta        → field_name + delta (incremental update)
 *             - message_result             → final content, signals completion
 *
 * Field routing (matches genspark2api handleMessageFieldDelta):
 *   - session_state.answer                       → assistant text delta
 *   - session_state.streaming_detail_answer      → assistant text delta (search-mode o1/o3 path)
 *   - session_state.streaming_markmap            → assistant text delta (rare)
 *   - session_state.answerthink                  → reasoning_content delta (wrapped in <think> tags)
 *   - session_state.answerthink_is_started       → emit "<think>\n"
 *   - session_state.answerthink_is_finished      → emit "\n</think>"
 *
 * Modes:
 *   - Text chat           → COPILOT_MOA_CHAT, models=[requested_model] or MixtureModelList
 *   - Search ("-search")  → COPILOT_MOA_CHAT with request_web_knowledge=true, model stripped of suffix
 *   - Image model         → COPILOT_MOA_IMAGE flow (handled in a follow-up commit)
 *
 * Reference: genspark2api/controller/chat.go (ChatForOpenAI, handleStreamRequest,
 * handleNonStreamRequest, processStreamData, handleMessageFieldDelta, handleMessageResult).
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const GENSPARK_BASE = "https://www.genspark.ai";
const GENSPARK_ASK_API = PROVIDERS["genspark-web"]?.baseUrl || `${GENSPARK_BASE}/api/copilot/ask`;
const GENSPARK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── Model catalogue (mirrors genspark2api/common/constants.go) ────────────────
// Single-model MOA chat — sent verbatim as extra_data.models=[<id>].
const TEXT_MODEL_LIST = new Set([
  "gpt-5-pro", "gpt-5.1-low", "gpt-5.2", "gpt-5.2-pro", "o3-pro",
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-6", "claude-opus-4-5",
  "claude-4-5-haiku", "gemini-2.5-pro", "gemini-3-flash-preview",
  "gemini-3.1-pro-preview", "gemini-3-pro-preview", "grok-4-0709",
]);

// Image models — trigger COPILOT_MOA_IMAGE flow (commit 2).
const IMAGE_MODEL_LIST = new Set([
  "nano-banana-pro", "nano-banana-2",
  "fal-ai/bytedance/seedream/v5/lite", "fal-ai/flux-2", "fal-ai/flux-2-pro",
  "fal-ai/z-image/turbo", "fal-ai/gpt-image-1.5", "recraft-v3", "ideogram/V_3",
  "qwen-image",
]);

// When the requested model is not in TEXT_MODEL_LIST (and not an image model), Genspark routes
// the request through its Mixture-of-Agents layer using these three models as candidates.
const MIXTURE_MODEL_LIST = ["gpt-5.1-low", "claude-sonnet-4-5", "gemini-3-pro-preview"];

const CHAT_TYPE = "COPILOT_MOA_CHAT";
const IMAGE_TYPE = "COPILOT_MOA_IMAGE";
const IMAGE_TASK_STATUS_URL = `${GENSPARK_BASE}/api/ig_tasks_status`;

// Field-name allowlist — everything else in message_field/message_field_delta is ignored.
// Matches genspark2api handleMessageFieldDelta baseAllowed + reasoning fields.
const FIELD_ANSWER = "session_state.answer";
const FIELD_STREAMING_DETAIL_ANSWER = "session_state.streaming_detail_answer";
const FIELD_STREAMING_MARKMAP = "session_state.streaming_markmap";
const FIELD_ANSWERTHINK = "session_state.answerthink";
const FIELD_ANSWERTHINK_STARTED = "session_state.answerthink_is_started";
const FIELD_ANSWERTHINK_FINISHED = "session_state.answerthink_is_finished";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise the user-supplied credential into a `session_id=...` cookie header value.
 * Accepts either the bare session id or a full `session_id=abc123` string (matching
 * genspark2api config.InitGSCookies behaviour).
 */
function buildCookieHeader(credentials) {
  const raw = (credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  if (raw.includes("session_id=")) return raw;
  return `session_id=${raw}`;
}

/**
 * Parse the OpenAI-style `messages` array into the shape Genspark expects.
 *
 * Genspark's /api/copilot/ask accepts the same {role, content} objects as OpenAI, where content
 * may be a string or an array of {type, text/image_url} parts. We keep the structure intact so
 * multimodal requests round-trip, but we strip empty messages and convert the `developer` role
 * (OpenAI alias) to `system`.
 *
 * For deep-seek-r1 (which Genspark exposes via MOA), genspark2api demotes `system` → `user`
 * because the underlying DeepSeek model rejects system messages. We mirror that here.
 */
function transformMessages(messages, modelName) {
  const out = [];
  for (const msg of messages || []) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    if (modelName === "deep-seek-r1" && role === "system") role = "user";

    let content = msg.content;
    if (content == null) content = "";
    if (typeof content === "string") {
      if (!content.trim()) continue;
    } else if (Array.isArray(content)) {
      const filtered = content.filter((c) => {
        if (!c || typeof c !== "object") return false;
        if (c.type === "text") return String(c.text || "").trim().length > 0;
        return true; // keep image_url / private_file parts
      });
      if (filtered.length === 0) continue;
      content = filtered;
    }
    out.push({ role, content });
  }
  return out;
}

/**
 * Build the Genspark /api/copilot/ask request body for a text-chat request.
 *
 * The `current_query_string` carries the chat session id once we have one. For the first turn
 * of a new conversation we send `type=COPILOT_MOA_CHAT` only; Genspark assigns the project id
 * and we'd persist it for follow-ups. 9router is stateless across requests, so we always send
 * the first-turn form — Genspark reconstructs context from the messages array.
 */
function buildChatRequestBody(modelName, messages, isSearch) {
  // Strip "-search" suffix for the upstream models list; genspark2api does the same.
  let upstreamModel = modelName;
  if (isSearch) upstreamModel = upstreamModel.replace(/-search$/, "");

  // deepseek → deep-seek (Genspark's internal naming).
  if (upstreamModel.startsWith("deepseek")) {
    upstreamModel = upstreamModel.replace(/^deepseek/, "deep-seek");
  }

  const models = TEXT_MODEL_LIST.has(upstreamModel) ? [upstreamModel] : MIXTURE_MODEL_LIST;

  return {
    type: CHAT_TYPE,
    current_query_string: `type=${CHAT_TYPE}`,
    messages,
    action_params: {},
    extra_data: {
      models,
      run_with_another_model: false,
      writingContent: null,
      request_web_knowledge: isSearch,
    },
  };
}

/**
 * Read an SSE stream from a Response body and yield parsed JSON event objects.
 * Mirrors readPplxSseEvents in perplexity-web.js but treats each `data: <json>` line as a frame.
 * Lines without a `data:` prefix are ignored (comments, event: tags, keepalives).
 */
async function* readGensparkSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by \n\n; individual lines by \n. We process line-by-line and
      // treat each `data:` line as a self-contained event (Genspark doesn't multi-line data).
      let nlIdx;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed JSON frames — Genspark occasionally emits partial keepalives.
        }
      }
    }
    // Flush any trailing line.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trimStart();
      if (payload && payload !== "[DONE]") {
        try { yield JSON.parse(payload); } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Classify a response body chunk for the genspark2api-style error short-circuits.
 * Returns one of: "rate_limit" | "free_limit" | "not_login" | "cloudflare" | "server_error"
 * | "service_unavailable" | null.
 *
 * Mirrors genspark2api/common/utils.go IsRateLimit / IsFreeLimit / IsNotLogin / IsServerError /
 * IsServerOverloaded / IsCloudflareChallenge / IsServiceUnavailablePage.
 */
function classifyError(data) {
  if (typeof data !== "string") return null;
  // Rate-limit and not-login are emitted as bare strings by Genspark's edge layer.
  if (data === "Rate limit exceeded cf1" || data === "Rate limit exceeded cf2") return "rate_limit";
  if (data.includes('"status":-5,"message":"not login"')) return "not_login";
  if (data === "Internal Server Error") return "server_error";
  // Free-limit and server-overloaded come through as message_result frames with specific content.
  if (data.includes('"content":"You\'ve reached your free usage limit today"')) return "free_limit";
  if (data.includes('"content":"Server overloaded, please try again later."')) return "service_unavailable";
  // Cloudflare interstitials are full HTML pages.
  if (data.includes("<title>Just a moment...</title>") || data.includes("cdn-cgi/challenge-platform")) {
    return "cloudflare";
  }
  return null;
}

/**
 * Decide whether a `message_field` / `message_field_delta` event should be emitted to the client
 * and, if so, whether it carries reasoning or answer content.
 *
 * Returns one of:
 *   { kind: "answer",   delta: <string> }
 *   { kind: "reasoning_open" }
 *   { kind: "reasoning_close" }
 *   { kind: "reasoning", delta: <string> }
 *   null  → ignore this field
 */
function classifyFieldEvent(event, modelName, isSearch, hideReasoning) {
  const fieldName = event.field_name;
  if (!fieldName) return null;

  // Answer path.
  if (
    fieldName === FIELD_ANSWER ||
    fieldName === FIELD_STREAMING_DETAIL_ANSWER ||
    fieldName === FIELD_STREAMING_MARKMAP
  ) {
    // o1 in search mode emits the full answer in message_field.delta on the FIELD_ANSWER event.
    // For other models, FIELD_ANSWER on message_field carries the full field value (not delta)
    // — genspark2api reads event["delta"] for everything except that one special case, which
    // reads event["field_value"]. The delta channel is the safer default for streaming UX.
    const delta = (modelName === "o1" && isSearch && fieldName === FIELD_ANSWER)
      ? String(event.field_value || "")
      : String(event.delta || "");
    return delta ? { kind: "answer", delta } : null;
  }

  if (hideReasoning) return null;

  if (fieldName === FIELD_ANSWERTHINK_STARTED) return { kind: "reasoning_open" };
  if (fieldName === FIELD_ANSWERTHINK_FINISHED) return { kind: "reasoning_close" };
  if (fieldName === FIELD_ANSWERTHINK) {
    const delta = String(event.delta || "");
    return delta ? { kind: "reasoning", delta } : null;
  }
  return null;
}

/**
 * For non-streaming requests, genspark2api accumulates the full answer + reasoning across all
 * message_field/message_field_delta events and emits them in the final chat.completion response.
 * This generator centralises that accumulation so both streaming and non-streaming paths can
 * consume the same event stream.
 *
 * Yields { type: "answer_delta"|"reasoning_open"|"reasoning_close"|"reasoning_delta"|"done"|"error",
 *          delta?, message?, projectId? }
 */
async function* extractContent(responseBody, modelName, isSearch, hideReasoning, signal) {
  let projectId = "";
  for await (const event of readGensparkSseEvents(responseBody, signal)) {
    if (!event || typeof event !== "object") continue;
    const eventType = event.type;

    if (eventType === "project_start") {
      projectId = String(event.id || "");
      continue;
    }

    if (eventType === "message_field" || eventType === "message_field_delta") {
      const classified = classifyFieldEvent(event, modelName, isSearch, hideReasoning);
      if (!classified) continue;
      if (classified.kind === "answer") {
        yield { type: "answer_delta", delta: classified.delta };
      } else if (classified.kind === "reasoning_open") {
        yield { type: "reasoning_open" };
      } else if (classified.kind === "reasoning_close") {
        yield { type: "reasoning_close" };
      } else if (classified.kind === "reasoning") {
        yield { type: "reasoning_delta", delta: classified.delta };
      }
      continue;
    }

    if (eventType === "message_result") {
      // message_result is the terminal frame. Its `content` field carries the final answer for
      // non-streaming consumers; for streaming we've already emitted every delta, so we just
      // signal completion. genspark2api also has a special o1+search path that reads the
      // detailAnswer from a nested JSON inside content — we replicate it for completeness.
      let finalContent = "";
      if (modelName === "o1" && isSearch && typeof event.content === "string") {
        try {
          const inner = JSON.parse(event.content);
          finalContent = inner?.detailAnswer || "";
        } catch {
          finalContent = String(event.content || "");
        }
      } else if (typeof event.content === "string") {
        finalContent = event.content;
      }
      yield { type: "done", message: finalContent, projectId };
      return;
    }
  }
  // Stream ended without an explicit message_result — treat as done with whatever we have.
  yield { type: "done", message: "", projectId };
}

/**
 * Build a streaming Response that emits OpenAI chat.completion.chunk frames from the Genspark
 * SSE event stream. Reasoning deltas are emitted as `reasoning_content` (DeepSeek/Anthropic
 * convention) wrapped in `<think>...</think>` tags so downstream clients that don't understand
 * reasoning_content still see the trace.
 */
function buildStreamingResponse(responseBody, model, cid, created, modelName, isSearch, hideReasoning, signal) {
  const encoder = new TextEncoder();
  let thinkOpen = false;

  return new ReadableStream({
    async start(controller) {
      try {
        // Initial role chunk.
        controller.enqueue(encoder.encode(sseChunk({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          system_fingerprint: null,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
        })));

        for await (const ev of extractContent(responseBody, modelName, isSearch, hideReasoning, signal)) {
          if (ev.type === "answer_delta") {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null, logprobs: null }],
            })));
          } else if (ev.type === "reasoning_open") {
            thinkOpen = true;
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: "<think>\n" }, finish_reason: null, logprobs: null }],
            })));
          } else if (ev.type === "reasoning_close") {
            thinkOpen = false;
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: "\n</think>" }, finish_reason: null, logprobs: null }],
            })));
          } else if (ev.type === "reasoning_delta") {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { reasoning_content: ev.delta, content: ev.delta }, finish_reason: null, logprobs: null }],
            })));
          } else if (ev.type === "done") {
            // If the upstream closed the <think> tag never sent a close event, close it now.
            if (thinkOpen) {
              controller.enqueue(encoder.encode(sseChunk({
                id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
                choices: [{ index: 0, delta: { content: "\n</think>" }, finish_reason: null, logprobs: null }],
              })));
            }
            // message_result.content typically repeats what we've already streamed via deltas.
            // Avoid emitting it here to prevent duplicate assistant content in streamed responses.
            break;
          }
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Build a non-streaming Response by consuming the full event stream and assembling the final
 * chat.completion JSON. Mirrors genspark2api handleNonStreamRequest accumulation logic.
 */
async function buildNonStreamingResponse(responseBody, model, cid, created, modelName, isSearch, hideReasoning, signal) {
  let answer = "";
  const reasoningParts = [];
  let thinkOpen = false;

  for await (const ev of extractContent(responseBody, modelName, isSearch, hideReasoning, signal)) {
    if (ev.type === "answer_delta") {
      answer += ev.delta;
    } else if (ev.type === "reasoning_open") {
      thinkOpen = true;
      reasoningParts.push("<think>");
    } else if (ev.type === "reasoning_close") {
      thinkOpen = false;
      reasoningParts.push("</think>");
    } else if (ev.type === "reasoning_delta") {
      reasoningParts.push(ev.delta);
    } else if (ev.type === "done") {
      // For o1+search the final answer arrives once via message_result.content; in all other
      // cases we've already accumulated it via deltas. Only override if we have nothing.
      if (!answer && ev.message) answer = ev.message;
      break;
    }
  }

  if (thinkOpen) reasoningParts.push("</think>");

  const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join("\n") : undefined;
  const message = { role: "assistant", content: answer };
  if (reasoningContent) message.reasoning_content = reasoningContent;

  // Rough token estimate (4 chars/token) — Genspark doesn't return usage info.
  const promptTokens = Math.ceil(JSON.stringify(model).length / 4);
  const completionTokens = Math.ceil(answer.length / 4);

  return new Response(JSON.stringify({
    id: cid,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Image generation flow (COPILOT_MOA_IMAGE) ─────────────────────────────────
// Mirrors genspark2api/controller/chat.go ImageProcess + createImageRequestBody +
// extractTaskIDs + pollTaskStatus. The flow is:
//   1. POST /api/copilot/ask with type=COPILOT_MOA_IMAGE → NDJSON body (NOT SSE) containing
//      project_start + a frame with task_id list inside content.generated_images.
//   2. POST /api/ig_tasks_status SSE with {task_ids:[...]} → emits a TASKS_STATUS_COMPLETE
//      frame whose final_status[taskID].image_urls[0] holds the generated image URL.
//   3. Format the resulting URL(s) as Markdown image links inside a chat completion so
//      downstream OpenAI-compatible clients render them inline.

/**
 * Build the COPILOT_MOA_IMAGE request body. The image prompt is taken from the last user
 * message (matching genspark2api OpenAIChatCompletionRequest.GetUserContent behaviour).
 * If the user supplied an array of message parts, the text part is used as the prompt.
 */
function buildImageRequestBody(imageModel, prompt) {
  // dall-e-3 alias → Genspark's internal "dalle-3" id (kept for OpenAI-compat clients).
  const upstreamModel = imageModel === "dall-e-3" ? "dalle-3" : imageModel;

  const modelConfigs = [{
    model: upstreamModel,
    aspect_ratio: "auto",
    use_personalized_models: false,
    fashion_profile_id: null,
    hd: false,
    reflection_enabled: false,
    style: "auto",
  }];

  const messages = [{
    role: "user",
    content: prompt,
  }];

  return {
    type: IMAGE_TYPE,
    current_query_string: `type=${IMAGE_TYPE}`,
    messages,
    user_s_input: prompt,
    action_params: {},
    extra_data: {
      model_configs: modelConfigs,
      llm_model: "gpt-4o",
      imageModelMap: {},
      writingContent: null,
    },
  };
}

/**
 * Extract the project_id and the list of image task_ids from a COPILOT_MOA_IMAGE response body.
 *
 * The response is a stream of `data: <json>` lines (NDJSON-with-prefix, NOT SSE in the strict
 * sense — Genspark emits them without empty-line separators). Each line is one of:
 *   - {"id":"<project_id>", "type":"project_start", ...}
 *   - {"content":"{\"generated_images\":[{\"task_id\":\"...\"}]}", "type":"message_field", ...}
 *
 * We split on newlines, look for project_start to grab the project_id, and look for task_id
 * occurrences to collect the generated_images task ids.
 *
 * Returns [projectId, taskIds[]].
 */
function extractImageTaskIds(responseBody) {
  let projectId = "";
  const taskIds = [];
  const lines = responseBody.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr) continue;
    try {
      const outer = JSON.parse(jsonStr);
      if (outer.type === "project_start" && outer.id) {
        projectId = String(outer.id);
        continue;
      }
      // task_id appears inside a nested JSON string in the `content` field.
      if (typeof outer.content === "string" && outer.content.includes("task_id")) {
        try {
          const inner = JSON.parse(outer.content);
          const imgs = Array.isArray(inner?.generated_images) ? inner.generated_images : [];
          for (const img of imgs) {
            if (img?.task_id) taskIds.push(String(img.task_id));
          }
        } catch {
          // content wasn't JSON — skip.
        }
      }
    } catch {
      // line wasn't JSON — skip.
    }
  }
  return [projectId, taskIds];
}

/**
 * Poll /api/ig_tasks_status (SSE) until TASKS_STATUS_COMPLETE arrives, then collect the
 * image_urls for each requested task id. Matches genspark2api pollTaskStatus.
 *
 * Returns an array of image URL strings (one per successful task). Tasks that didn't reach
 * SUCCESS status are skipped silently — genspark2api does the same.
 */
async function pollImageTaskStatus(taskIds, cookieHeader, signal, log) {
  const imageUrls = [];
  const requestBody = JSON.stringify({ task_ids: taskIds });

  let response;
  try {
    response = await fetch(IMAGE_TASK_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Origin": GENSPARK_BASE,
        "Referer": `${GENSPARK_BASE}/`,
        "Cookie": cookieHeader,
        "User-Agent": GENSPARK_USER_AGENT,
      },
      body: requestBody,
      signal,
    });
  } catch (err) {
    log?.error?.("GENSPARK-WEB", `Image status poll fetch failed: ${err.message || String(err)}`);
    return imageUrls;
  }

  if (!response.body) return imageUrls;

  for await (const event of readGensparkSseEvents(response.body, signal)) {
    if (!event || typeof event !== "object") continue;
    if (event.type !== "TASKS_STATUS_COMPLETE") continue;
    const finalStatus = event.final_status;
    if (!finalStatus || typeof finalStatus !== "object") continue;
    for (const taskId of taskIds) {
      const task = finalStatus[taskId];
      if (!task || typeof task !== "object") continue;
      if (task.status !== "SUCCESS") continue;
      const urls = Array.isArray(task.image_urls) ? task.image_urls : [];
      if (urls.length > 0 && typeof urls[0] === "string") {
        imageUrls.push(urls[0]);
      }
    }
  }
  return imageUrls;
}

/**
 * Build the OpenAI chat completion response (streaming or non-streaming) that wraps the
 * generated image URLs as Markdown image links. This matches genspark2api ChatForOpenAI's
 * image-model branch: the image URLs are returned as a Markdown image inside the assistant
 * message content so any OpenAI-compatible client renders them inline.
 */
function buildImageChatResponse(imageUrls, prompt, model, stream) {
  const cid = `chatcmpl-genspark-img-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const markdown = imageUrls.map((u) => `![Image](${u})`).join("\n");

  if (stream) {
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream({
      start(controller) {
        try {
          // Initial role chunk.
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
          })));
          // Single content delta with all image URLs as Markdown.
          if (markdown) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: markdown }, finish_reason: null, logprobs: null }],
            })));
          }
          // Terminal chunk.
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
            choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
          })));
          controller.enqueue(encoder.encode(SSE_DONE));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(sseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
  }

  // Non-streaming: return the chat.completion JSON with the markdown content.
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(markdown.length / 4);
  return new Response(JSON.stringify({
    id: cid,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: null,
    choices: [{
      index: 0,
      message: { role: "assistant", content: markdown },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Executor ──────────────────────────────────────────────────────────────────

export class GensparkWebExecutor extends BaseExecutor {
  constructor() {
    super("genspark-web", PROVIDERS["genspark-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    const cookieHeader = buildCookieHeader(credentials);
    if (!cookieHeader) {
      const errResp = new Response(JSON.stringify({
        error: {
          message: "Genspark session_id cookie is required. Paste your session_id value (or the full 'session_id=abc123' string) into the provider's cookie field.",
          type: "invalid_request",
        },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    // Detect search mode: any text model with a "-search" suffix.
    const isSearch = typeof model === "string" && model.endsWith("-search");
    const baseModel = isSearch ? model.replace(/-search$/, "") : model;
    // Image model? → route to the COPILOT_MOA_IMAGE flow (image generation with task polling).
    if (IMAGE_MODEL_LIST.has(baseModel)) {
      return await this.executeImage({ model, baseModel, body, stream, cookieHeader, signal, log });
    }

    // Hide reasoning? Read from provider-specific data or default to showing it.
    const hideReasoning = credentials?.providerSpecificData?.hideReasoning === true;

    const transformedMessages = transformMessages(messages, baseModel);
    if (transformedMessages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Empty messages after processing", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    const requestBody = buildChatRequestBody(baseModel, transformedMessages, isSearch);
    const headers = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Origin": GENSPARK_BASE,
      "Referer": `${GENSPARK_BASE}/`,
      "Cookie": cookieHeader,
      "User-Agent": GENSPARK_USER_AGENT,
    };

    log?.info?.("GENSPARK-WEB", `Query to ${model} (search=${isSearch}), msg_count=${transformedMessages.length}`);

    let response;
    try {
      response = await fetch(GENSPARK_ASK_API, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (err) {
      log?.error?.("GENSPARK-WEB", `Fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: {
          message: `Genspark connection failed: ${err.message || String(err)}`,
          type: "upstream_error",
        },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Genspark returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        errMsg = "Genspark auth failed — session_id cookie may be expired or invalid. Re-paste the session_id value from genspark.ai.";
      } else if (status === 429) {
        errMsg = "Genspark rate limited. Wait a moment and retry, or rotate session_id cookies.";
      }
      log?.warn?.("GENSPARK-WEB", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    if (!response.body) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Genspark returned empty response body", type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    // Genspark sometimes returns 200 with an error body (rate-limit, not-login, Cloudflare).
    // We can't peek without consuming the stream, so we wrap the body in a small inspector that
    // reads the first chunk, classifies it, and either short-circuits with an error Response or
    // hands off a re-streamed body to the consumer.
    const inspected = await inspectFirstChunk(response.body, log);
    if (inspected.error) {
      const errResp = new Response(JSON.stringify({
        error: { message: inspected.error, type: "upstream_error", code: inspected.code },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    const cid = `chatcmpl-genspark-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingResponse(
        inspected.stream, model, cid, created, baseModel, isSearch, hideReasoning, signal,
      );
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { ...SSE_HEADERS_NO_BUFFER },
      });
    } else {
      finalResponse = await buildNonStreamingResponse(
        inspected.stream, model, cid, created, baseModel, isSearch, hideReasoning, signal,
      );
    }
    return { response: finalResponse, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
  }

  /**
   * Image generation flow. Mirrors genspark2api/controller/chat.go ImageProcess:
   *   1. Extract the prompt from the last user message (string or array text part).
   *   2. POST /api/copilot/ask with type=COPILOT_MOA_IMAGE → NDJSON body with task_ids.
   *   3. Parse the body to extract task_ids.
   *   4. Poll /api/ig_tasks_status until TASKS_STATUS_COMPLETE.
   *   5. Build an OpenAI chat completion (stream or non-stream) with the image URLs as
   *      Markdown image links in the assistant message content.
   *
   * Error handling mirrors the chat flow: Genspark returns 200 with an error body for
   * rate-limit / free-limit / not-login / Cloudflare cases, so we read the body and
   * classify before treating it as a successful image-task response.
   */
  async executeImage({ model, baseModel, body, stream, cookieHeader, signal, log }) {
    // Extract the prompt from the last user message. Accept both string content and
    // array content (OpenAI multipart format) — concatenate the text parts.
    const messages = body?.messages || [];
    let prompt = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string") {
        prompt = content;
      } else if (Array.isArray(content)) {
        prompt = content
          .filter((c) => c && typeof c === "object" && c.type === "text")
          .map((c) => String(c.text || ""))
          .join("\n");
      }
      if (prompt) break;
    }
    if (!prompt.trim()) {
      const errResp = new Response(JSON.stringify({
        error: {
          message: `Image generation requested with model ${model} but no prompt text was found in the messages array.`,
          type: "invalid_request",
        },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    const requestBody = buildImageRequestBody(baseModel, prompt);
    const headers = {
      "Content-Type": "application/json",
      // Image endpoint uses */* Accept (not text/event-stream) — matches genspark2api makeImageRequest.
      "Accept": "*/*",
      "Origin": GENSPARK_BASE,
      "Referer": `${GENSPARK_BASE}/`,
      "Cookie": cookieHeader,
      "User-Agent": GENSPARK_USER_AGENT,
    };

    log?.info?.("GENSPARK-WEB", `Image gen ${model} (prompt_len=${prompt.length})`);

    let response;
    try {
      response = await fetch(GENSPARK_ASK_API, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (err) {
      log?.error?.("GENSPARK-WEB", `Image fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: {
          message: `Genspark image connection failed: ${err.message || String(err)}`,
          type: "upstream_error",
        },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Genspark image API returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        errMsg = "Genspark auth failed — session_id cookie may be expired or invalid.";
      } else if (status === 429) {
        errMsg = "Genspark rate limited. Wait a moment and retry, or rotate session_id cookies.";
      }
      log?.warn?.("GENSPARK-WEB", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    // Read the full body — image endpoint returns a non-streaming NDJSON blob, not an SSE stream.
    let bodyText;
    try {
      bodyText = await response.text();
    } catch (err) {
      const errResp = new Response(JSON.stringify({
        error: { message: `Failed to read image response: ${err.message || String(err)}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    // Classify known error signatures (rate-limit, free-limit, not-login, Cloudflare, server-error).
    // These come through as 200 with an error payload — same pattern as the chat flow.
    const errKind = classifyError(bodyText);
    if (errKind) {
      let errMsg;
      switch (errKind) {
        case "rate_limit":
          errMsg = "Genspark rate limit exceeded. Rotate session_id cookies or wait a moment.";
          break;
        case "free_limit":
          errMsg = "Genspark free usage limit reached for this session_id. Switch to a Plus session or another cookie.";
          break;
        case "not_login":
          errMsg = "Genspark session is not logged in. The session_id cookie is invalid or expired.";
          break;
        case "cloudflare":
          errMsg = "Genspark is behind a Cloudflare challenge. Configure an outbound proxy (PROXY_URL) or retry from a different IP.";
          break;
        case "server_error":
          errMsg = "Genspark internal server error. Try again later.";
          break;
        case "service_unavailable":
          errMsg = "Genspark service is overloaded. Try again later.";
          break;
        default:
          errMsg = `Genspark upstream error (${errKind}).`;
      }
      log?.warn?.("GENSPARK-WEB", `${errKind}: ${errMsg}`);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: errKind.toUpperCase() },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    // Extract task_ids from the response body.
    const [projectId, taskIds] = extractImageTaskIds(bodyText);
    if (taskIds.length === 0) {
      log?.error?.("GENSPARK-WEB", `No image task_ids in response body (len=${bodyText.length}). First 200 chars: ${bodyText.slice(0, 200)}`);
      const errResp = new Response(JSON.stringify({
        error: {
          message: "Genspark image API returned no task_ids. The session may be rate-limited or the prompt may have been rejected.",
          type: "upstream_error",
          code: "NO_TASK_IDS",
        },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    log?.debug?.("GENSPARK-WEB", `Image tasks: ${taskIds.length} (project=${projectId})`);

    // Poll for completion.
    const imageUrls = await pollImageTaskStatus(taskIds, cookieHeader, signal, log);
    if (imageUrls.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: {
          message: "Genspark image generation produced no image URLs. The tasks may have failed or timed out.",
          type: "upstream_error",
          code: "NO_IMAGE_URLS",
        },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
    }

    log?.info?.("GENSPARK-WEB", `Image gen complete: ${imageUrls.length} image(s)`);

    const finalResponse = buildImageChatResponse(imageUrls, prompt, model, stream);
    return { response: finalResponse, url: GENSPARK_ASK_API, headers, transformedBody: requestBody };
  }
}

/**
 * Read the first chunk of a Genspark response body and check it against the genspark2api error
 * signatures. If we detect a known error, return { error, code } and discard the body. Otherwise
 * return { stream } — a ReadableStream that replays the buffered first chunk followed by the
 * remaining body, so downstream consumers see the full stream.
 *
 * This is necessary because Genspark returns 200 with an error payload (rather than a 4xx/5xx)
 * for rate-limit, free-limit, not-login, and Cloudflare-challenge cases.
 */
async function inspectFirstChunk(body, log) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunk;
  try {
    // Read enough to identify error patterns (they all fit in the first ~512 bytes).
    while (buffer.length < 2048) {
      const { value, done } = await reader.read();
      if (done) break;
      firstChunk = firstChunk || [];
      firstChunk.push(value);
      buffer += decoder.decode(value, { stream: true });
      // Quick exit: classify as soon as we have a complete error signature.
      const errKind = classifyError(buffer);
      if (errKind) {
        let message;
        let code;
        switch (errKind) {
          case "rate_limit":
            message = "Genspark rate limit exceeded. Rotate session_id cookies or wait a moment.";
            code = "RATE_LIMIT";
            break;
          case "free_limit":
            message = "Genspark free usage limit reached for this session_id. Switch to a Plus session or another cookie.";
            code = "FREE_LIMIT";
            break;
          case "not_login":
            message = "Genspark session is not logged in. The session_id cookie is invalid or expired — re-paste from genspark.ai.";
            code = "NOT_LOGIN";
            break;
          case "cloudflare":
            message = "Genspark is behind a Cloudflare challenge. Configure an outbound proxy (PROXY_URL) or retry from a different IP.";
            code = "CLOUDFLARE";
            break;
          case "server_error":
            message = "Genspark internal server error. Try again later.";
            code = "SERVER_ERROR";
            break;
          case "service_unavailable":
            message = "Genspark service is overloaded. Try again later.";
            code = "SERVICE_UNAVAILABLE";
            break;
          default:
            message = `Genspark upstream error (${errKind}).`;
            code = "UPSTREAM_ERROR";
        }
        log?.warn?.("GENSPARK-WEB", `${code}: ${message}`);
        return { error: message, code };
      }
      // If the buffer already contains a project_start event, we're past the error window.
      if (buffer.includes('"type":"project_start"') || buffer.includes('"type":"message_field"')) {
        break;
      }
    }
  } finally {
    if (!firstChunk) {
      // We never read anything (body was empty). Release and let downstream handle the empty stream.
      reader.releaseLock();
      return { stream: new ReadableStream({ start(c) { c.close(); } }) };
    }
  }

  // Reconstruct a stream that replays the buffered chunks then continues with the rest of body.
  const buffered = firstChunk;
  const restReader = reader;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of buffered) controller.enqueue(chunk);
        while (true) {
          const { value, done } = await restReader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      try { restReader.cancel(reason); } catch { /* ignore */ }
    },
  });
  return { stream };
}

export {
  buildCookieHeader,
  transformMessages,
  buildChatRequestBody,
  classifyFieldEvent,
  classifyError,
  buildImageRequestBody,
  extractImageTaskIds,
  TEXT_MODEL_LIST,
  IMAGE_MODEL_LIST,
  MIXTURE_MODEL_LIST,
};

export default GensparkWebExecutor;
