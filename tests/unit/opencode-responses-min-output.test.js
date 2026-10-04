// opencode Console rejects max_output_tokens < 16 on /responses ("The number
// must be `>= 16`"). ZCode's connectivity probe sends maxOutputTokens: 1, so the
// executors floor the mapped value instead of forwarding it. Regression tests.
import { describe, it, expect } from "vitest";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const MODEL = "muse-spark-1.3-contributor-free";

function baseBody(extra = {}) {
  return {
    model: MODEL,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    ...extra,
  };
}

describe.each([
  ["opencode-zen", OpenCodeZenExecutor],
  ["opencode-go", OpenCodeGoExecutor],
])("%s responses max_output_tokens floor", (name, Executor) => {
  it("floors sub-16 values to 16 (ZCode probe sends 1)", () => {
    const out = new Executor().transformRequest(MODEL, baseBody({ max_output_tokens: 1 }));
    expect(out.max_output_tokens).toBe(16);
  });

  it("maps max_tokens then floors it", () => {
    const out = new Executor().transformRequest(MODEL, baseBody({ max_tokens: 8 }));
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
  });

  it("maps max_completion_tokens then floors it", () => {
    const out = new Executor().transformRequest(MODEL, baseBody({ max_completion_tokens: 3 }));
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("leaves the chat path untouched (chat backends accept tiny caps)", () => {
    // mimo models ride /chat/completions where upstream proved max_tokens:1 is
    // a valid "length" finish — the floor is responses-only by design.
    const chat = new Executor().transformRequest("mimo-v2.5-free", {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    expect(chat.max_tokens).toBe(1);
  });

  it("leaves normal values untouched", () => {
    const out = new Executor().transformRequest(MODEL, baseBody({ max_output_tokens: 1024 }));
    expect(out.max_output_tokens).toBe(1024);
  });

  it("adds no cap when the client sent none", () => {
    const out = new Executor().transformRequest(MODEL, baseBody());
    expect(out.max_output_tokens).toBeUndefined();
  });
});
