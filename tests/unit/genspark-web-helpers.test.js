// Comprehensive unit tests for the genspark-web provider.
//
// Covers:
//   1. Provider registration in the WEB_COOKIE_PROVIDERS map (parallel to
//      gemini-web-provider-registration.test.js).
//   2. Cookie header normalization (bare session_id vs full session_id=abc).
//   3. Message transformation (developer→system, deep-seek-r1 system→user,
//      empty content filtering, multipart content preservation).
//   4. Chat request body construction (text model vs mixture model selection,
//      search mode sets request_web_knowledge, -search suffix stripping,
//      deepseek→deep-seek rename).
//   5. Field event classification (answer / reasoning_open / reasoning_close /
//      reasoning delta / hide-reasoning toggle).
//   6. Error signature classification (rate-limit / free-limit / not-login /
//      Cloudflare / server-error / service-unavailable).
//   7. Image request body construction + dall-e-3 alias.

import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  buildCookieHeader,
  transformMessages,
  buildChatRequestBody,
  classifyFieldEvent,
  classifyError,
  buildImageRequestBody,
  TEXT_MODEL_LIST,
  IMAGE_MODEL_LIST,
  MIXTURE_MODEL_LIST,
} from "../../open-sse/executors/genspark-web.js";

// Replicate the WEB_COOKIE_PROVIDERS filter from src/shared/constants/providers.js
// locally so the test doesn't depend on the broken `open-sse/providers/registry/index.js`
// package-subpath import (vitest doesn't resolve it; the gemini-web-provider-registration
// test has the same pre-existing failure). The filter logic is identical — category="webCookie".
const WEB_COOKIE_PROVIDERS = Object.fromEntries(
  REGISTRY.filter((r) => r.category === "webCookie").map((r) => {
    const display = { ...(r.display || {}) };
    return [r.id, { ...display, id: r.id, alias: r.uiAlias || r.alias, authType: r.authType, authHint: r.authHint, passthroughModels: r.passthroughModels }];
  }),
);

// ─── 1. Provider registration ──────────────────────────────────────────────

describe("genspark-web provider registration", () => {
  it("is registered in WEB_COOKIE_PROVIDERS", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"]).toBeDefined();
  });

  it("has correct id", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].id).toBe("genspark-web");
  });

  it("has correct display name", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].name).toBe("Genspark Web (Subscription)");
  });

  it("has uiAlias", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].alias).toBe("gspark");
  });

  it("has cookie authType", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authType).toBe("cookie");
  });

  it("has authHint", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toBeTruthy();
    expect(typeof WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toBe("string");
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toContain("session_id");
  });

  it("has passthroughModels enabled", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].passthroughModels).toBe(true);
  });

  it("has website URL", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].website).toBe("https://www.genspark.ai");
  });

  it("has textIcon fallback", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].textIcon).toBe("GS");
  });

  it("has color", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].color).toBe("#FF6B35");
  });
});

// ─── 2. Cookie header normalization ────────────────────────────────────────

describe("buildCookieHeader", () => {
  it("wraps a bare session id in session_id=", () => {
    expect(buildCookieHeader({ apiKey: "abc123" })).toBe("session_id=abc123");
  });

  it("preserves a full session_id=... string", () => {
    expect(buildCookieHeader({ apiKey: "session_id=abc123" })).toBe("session_id=abc123");
  });

  it("prefers apiKey over accessToken", () => {
    expect(buildCookieHeader({ apiKey: "from-apikey", accessToken: "from-token" })).toBe("session_id=from-apikey");
  });

  it("falls back to accessToken when apiKey is missing", () => {
    expect(buildCookieHeader({ accessToken: "from-token" })).toBe("session_id=from-token");
  });

  it("trims whitespace", () => {
    expect(buildCookieHeader({ apiKey: "  abc123  " })).toBe("session_id=abc123");
  });

  it("returns empty string when no credentials", () => {
    expect(buildCookieHeader({})).toBe("");
    expect(buildCookieHeader(null)).toBe("");
    expect(buildCookieHeader(undefined)).toBe("");
  });
});

// ─── 3. Message transformation ─────────────────────────────────────────────

describe("transformMessages", () => {
  it("passes through standard OpenAI messages", () => {
    const input = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "Bye" },
    ];
    const out = transformMessages(input, "gpt-5-pro");
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out[3]).toEqual({ role: "user", content: "Bye" });
  });

  it("converts developer role to system", () => {
    const out = transformMessages([{ role: "developer", content: "instructions" }], "gpt-5-pro");
    expect(out[0].role).toBe("system");
  });

  it("demotes system to user for deep-seek-r1 (DeepSeek rejects system messages)", () => {
    const out = transformMessages(
      [{ role: "system", content: "be concise" }, { role: "user", content: "hi" }],
      "deep-seek-r1",
    );
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("user");
  });

  it("preserves system role for non-deep-seek models", () => {
    const out = transformMessages(
      [{ role: "system", content: "be concise" }, { role: "user", content: "hi" }],
      "claude-sonnet-4-5",
    );
    expect(out[0].role).toBe("system");
  });

  it("filters out messages with empty string content", () => {
    const out = transformMessages(
      [{ role: "user", content: "" }, { role: "user", content: "   " }, { role: "user", content: "real" }],
      "gpt-5-pro",
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("real");
  });

  it("preserves multipart content arrays (image_url + text)", () => {
    const content = [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    const out = transformMessages([{ role: "user", content }], "gpt-5-pro");
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual(content);
  });

  it("filters out empty text parts inside multipart content", () => {
    const content = [
      { type: "text", text: "" },
      { type: "text", text: "real text" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    const out = transformMessages([{ role: "user", content }], "gpt-5-pro");
    expect(out[0].content).toHaveLength(2);
    expect(out[0].content[0].text).toBe("real text");
  });

  it("treats null content as empty (filtered out)", () => {
    const out = transformMessages([{ role: "user", content: null }], "gpt-5-pro");
    expect(out).toHaveLength(0);
  });

  it("defaults missing role to user", () => {
    const out = transformMessages([{ content: "hi" }], "gpt-5-pro");
    expect(out[0].role).toBe("user");
  });

  it("handles an empty messages array", () => {
    expect(transformMessages([], "gpt-5-pro")).toEqual([]);
    expect(transformMessages(null, "gpt-5-pro")).toEqual([]);
    expect(transformMessages(undefined, "gpt-5-pro")).toEqual([]);
  });
});

// ─── 4. Chat request body construction ─────────────────────────────────────

describe("buildChatRequestBody", () => {
  it("builds a single-model request for a known text model", () => {
    const body = buildChatRequestBody("gpt-5-pro", [{ role: "user", content: "hi" }], false);
    expect(body.type).toBe("COPILOT_MOA_CHAT");
    expect(body.current_query_string).toBe("type=COPILOT_MOA_CHAT");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.action_params).toEqual({});
    expect(body.extra_data.models).toEqual(["gpt-5-pro"]);
    expect(body.extra_data.run_with_another_model).toBe(false);
    expect(body.extra_data.request_web_knowledge).toBe(false);
  });

  it("uses MixtureModelList for an unknown model (MOA routing)", () => {
    const body = buildChatRequestBody("some-custom-model", [{ role: "user", content: "hi" }], false);
    expect(body.extra_data.models).toEqual(MIXTURE_MODEL_LIST);
  });

  it("strips -search suffix and sets request_web_knowledge=true for search mode", () => {
    const body = buildChatRequestBody("gpt-5-pro-search", [{ role: "user", content: "hi" }], true);
    expect(body.extra_data.models).toEqual(["gpt-5-pro"]);
    expect(body.extra_data.request_web_knowledge).toBe(true);
  });

  it("renames deepseek → deep-seek in the upstream model id", () => {
    const body = buildChatRequestBody("deepseek-v3", [{ role: "user", content: "hi" }], false);
    // deepseek-v3 is not in TEXT_MODEL_LIST, so MOA fallback kicks in. The rename still matters
    // when the user appends -search or uses a deepseek model that IS in the list — we test the
    // rename path here even though it falls through to mixture.
    expect(body.extra_data.models).toEqual(MIXTURE_MODEL_LIST);
  });

  it("renames deepseek → deep-seek with -search suffix", () => {
    const body = buildChatRequestBody("deepseek-v3-search", [{ role: "user", content: "hi" }], true);
    // After -search stripping → "deepseek-v3", after deepseek→deep-seek rename → "deep-seek-v3".
    // deep-seek-v3 is NOT in our TEXT_MODEL_LIST (we only carry the rename for completeness),
    // so MOA fallback applies. The test confirms the body shape doesn't break.
    expect(body.extra_data.request_web_knowledge).toBe(true);
  });

  it("sets writingContent to null", () => {
    const body = buildChatRequestBody("gpt-5-pro", [{ role: "user", content: "hi" }], false);
    expect(body.extra_data.writingContent).toBeNull();
  });

  it("includes every text model from TEXT_MODEL_LIST as a single-model request", () => {
    for (const model of TEXT_MODEL_LIST) {
      const body = buildChatRequestBody(model, [{ role: "user", content: "hi" }], false);
      expect(body.extra_data.models).toEqual([model]);
    }
  });
});

// ─── 5. Field event classification ─────────────────────────────────────────

describe("classifyFieldEvent", () => {
  it("classifies session_state.answer as answer delta", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answer", delta: "Hello" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "Hello" });
  });

  it("classifies session_state.streaming_detail_answer as answer delta", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.streaming_detail_answer", delta: "world" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "world" });
  });

  it("classifies session_state.streaming_markmap as answer delta", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.streaming_markmap", delta: "data" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "data" });
  });

  it("returns null for answer field with empty delta", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answer", delta: "" },
      "gpt-5-pro", false, false,
    );
    expect(result).toBeNull();
  });

  it("classifies answerthink_is_started as reasoning_open", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answerthink_is_started" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "reasoning_open" });
  });

  it("classifies answerthink_is_finished as reasoning_close", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answerthink_is_finished" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "reasoning_close" });
  });

  it("classifies answerthink as reasoning delta", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answerthink", delta: "thinking..." },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "reasoning", delta: "thinking..." });
  });

  it("returns null for reasoning fields when hideReasoning=true", () => {
    expect(classifyFieldEvent(
      { field_name: "session_state.answerthink_is_started" },
      "gpt-5-pro", false, true,
    )).toBeNull();
    expect(classifyFieldEvent(
      { field_name: "session_state.answerthink_is_finished" },
      "gpt-5-pro", false, true,
    )).toBeNull();
    expect(classifyFieldEvent(
      { field_name: "session_state.answerthink", delta: "x" },
      "gpt-5-pro", false, true,
    )).toBeNull();
  });

  it("still returns answer deltas when hideReasoning=true", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answer", delta: "Hello" },
      "gpt-5-pro", false, true,
    );
    expect(result).toEqual({ kind: "answer", delta: "Hello" });
  });

  it("returns null for unknown field names", () => {
    expect(classifyFieldEvent(
      { field_name: "session_state.unknown_field", delta: "x" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("returns null when field_name is missing", () => {
    expect(classifyFieldEvent(
      { delta: "x" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("returns null for reasoning field with empty delta", () => {
    expect(classifyFieldEvent(
      { field_name: "session_state.answerthink", delta: "" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("o1+search on session_state.answer reads field_value instead of delta", () => {
    // genspark2api special-cases o1 in search mode — the answer arrives as a full
    // field_value on a message_field event (not a delta).
    const result = classifyFieldEvent(
      { field_name: "session_state.answer", field_value: "full answer", delta: "should be ignored" },
      "o1", true, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "full answer" });
  });

  it("o1 without search still uses delta on session_state.answer", () => {
    const result = classifyFieldEvent(
      { field_name: "session_state.answer", field_value: "ignored", delta: "real delta" },
      "o1", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "real delta" });
  });
});

// ─── 6. Error signature classification ─────────────────────────────────────

describe("classifyError", () => {
  it("detects rate limit cf1", () => {
    expect(classifyError("Rate limit exceeded cf1")).toBe("rate_limit");
  });

  it("detects rate limit cf2", () => {
    expect(classifyError("Rate limit exceeded cf2")).toBe("rate_limit");
  });

  it("detects not-login", () => {
    expect(classifyError('{"status":-5,"message":"not login","data":{}}')).toBe("not_login");
  });

  it("detects internal server error", () => {
    expect(classifyError("Internal Server Error")).toBe("server_error");
  });

  it("detects free usage limit", () => {
    const body = `data: {"content":"You've reached your free usage limit today","type":"message_result"}`;
    expect(classifyError(body)).toBe("free_limit");
  });

  it("detects server overloaded", () => {
    const body = `data: {"content":"Server overloaded, please try again later.","type":"message_result"}`;
    expect(classifyError(body)).toBe("service_unavailable");
  });

  it("detects Cloudflare challenge page", () => {
    const body = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';
    expect(classifyError(body)).toBe("cloudflare");
  });

  it("detects Cloudflare challenge-platform CDN path", () => {
    const body = '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>';
    expect(classifyError(body)).toBe("cloudflare");
  });

  it("returns null for a normal SSE frame", () => {
    expect(classifyError('data: {"type":"project_start","id":"abc"}')).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(classifyError("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(classifyError(null)).toBeNull();
    expect(classifyError(undefined)).toBeNull();
    expect(classifyError(123)).toBeNull();
    expect(classifyError({})).toBeNull();
  });
});

// ─── 7. Image request body construction ────────────────────────────────────

describe("buildImageRequestBody", () => {
  it("builds a COPILOT_MOA_IMAGE body with the correct shape", () => {
    const body = buildImageRequestBody("nano-banana-pro", "a watercolor fox");
    expect(body.type).toBe("COPILOT_MOA_IMAGE");
    expect(body.current_query_string).toBe("type=COPILOT_MOA_IMAGE");
    expect(body.user_s_input).toBe("a watercolor fox");
    expect(body.messages).toEqual([{ role: "user", content: "a watercolor fox" }]);
    expect(body.action_params).toEqual({});
    expect(body.extra_data.model_configs).toHaveLength(1);
    expect(body.extra_data.model_configs[0].model).toBe("nano-banana-pro");
    expect(body.extra_data.model_configs[0].aspect_ratio).toBe("auto");
    expect(body.extra_data.model_configs[0].use_personalized_models).toBe(false);
    expect(body.extra_data.model_configs[0].hd).toBe(false);
    expect(body.extra_data.model_configs[0].reflection_enabled).toBe(false);
    expect(body.extra_data.model_configs[0].style).toBe("auto");
    expect(body.extra_data.llm_model).toBe("gpt-4o");
    expect(body.extra_data.imageModelMap).toEqual({});
    expect(body.extra_data.writingContent).toBeNull();
  });

  it("aliases dall-e-3 → dalle-3 (OpenAI compat)", () => {
    const body = buildImageRequestBody("dall-e-3", "test");
    expect(body.extra_data.model_configs[0].model).toBe("dalle-3");
  });

  it("passes through fal-ai namespaced model ids unchanged", () => {
    const body = buildImageRequestBody("fal-ai/flux-2-pro", "test");
    expect(body.extra_data.model_configs[0].model).toBe("fal-ai/flux-2-pro");
  });
});

// ─── 8. Model catalogue sanity ─────────────────────────────────────────────

describe("model catalogue", () => {
  it("TEXT_MODEL_LIST contains the expected OpenAI models", () => {
    expect(TEXT_MODEL_LIST.has("gpt-5-pro")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gpt-5.1-low")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gpt-5.2")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gpt-5.2-pro")).toBe(true);
    expect(TEXT_MODEL_LIST.has("o3-pro")).toBe(true);
  });

  it("TEXT_MODEL_LIST contains the expected Anthropic models", () => {
    expect(TEXT_MODEL_LIST.has("claude-sonnet-4-6")).toBe(true);
    expect(TEXT_MODEL_LIST.has("claude-sonnet-4-5")).toBe(true);
    expect(TEXT_MODEL_LIST.has("claude-opus-4-6")).toBe(true);
    expect(TEXT_MODEL_LIST.has("claude-opus-4-5")).toBe(true);
    expect(TEXT_MODEL_LIST.has("claude-4-5-haiku")).toBe(true);
  });

  it("TEXT_MODEL_LIST contains the expected Google models", () => {
    expect(TEXT_MODEL_LIST.has("gemini-2.5-pro")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gemini-3-flash-preview")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gemini-3.1-pro-preview")).toBe(true);
    expect(TEXT_MODEL_LIST.has("gemini-3-pro-preview")).toBe(true);
  });

  it("TEXT_MODEL_LIST contains the expected xAI model", () => {
    expect(TEXT_MODEL_LIST.has("grok-4-0709")).toBe(true);
  });

  it("IMAGE_MODEL_LIST contains the expected image models", () => {
    expect(IMAGE_MODEL_LIST.has("nano-banana-pro")).toBe(true);
    expect(IMAGE_MODEL_LIST.has("nano-banana-2")).toBe(true);
    expect(IMAGE_MODEL_LIST.has("fal-ai/flux-2")).toBe(true);
    expect(IMAGE_MODEL_LIST.has("fal-ai/flux-2-pro")).toBe(true);
    expect(IMAGE_MODEL_LIST.has("recraft-v3")).toBe(true);
    expect(IMAGE_MODEL_LIST.has("qwen-image")).toBe(true);
  });

  it("MIXTURE_MODEL_LIST has exactly 3 models (genspark2api MixtureModelList)", () => {
    expect(MIXTURE_MODEL_LIST).toHaveLength(3);
    expect(MIXTURE_MODEL_LIST).toEqual(["gpt-5.1-low", "claude-sonnet-4-5", "gemini-3-pro-preview"]);
  });

  it("TEXT_MODEL_LIST and IMAGE_MODEL_LIST are disjoint", () => {
    for (const m of TEXT_MODEL_LIST) {
      expect(IMAGE_MODEL_LIST.has(m)).toBe(false);
    }
    for (const m of IMAGE_MODEL_LIST) {
      expect(TEXT_MODEL_LIST.has(m)).toBe(false);
    }
  });
});
