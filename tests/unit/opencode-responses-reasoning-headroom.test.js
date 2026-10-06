// Console returns EMPTY completions (content "" + finish_reason "in_progress")
// when reasoning alone exceeds max_output_tokens — reasoning draws from the
// same cap (probed live: cap 8000/4000 + effort high → empty 3/3; 32000/no-cap
// → full). Agent clients binding the official 32000 default with a high effort
// hit this mid-task on big contexts, ending the turn as a clean empty response.
// All three opencode executors raise sub-65536 caps for high-tier efforts.
import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const MODEL = "muse-spark-1.3-contributor-free";

const body = (extra) => ({
  model: MODEL,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  ...extra,
});

describe.each([
  ["opencode (oc)", OpenCodeExecutor],
  ["opencode-zen (ocz)", OpenCodeZenExecutor],
  ["opencode-go", OpenCodeGoExecutor],
])("%s reasoning headroom", (name, Executor) => {
  it("raises a 32000 cap to 65536 at effort high (ZCode's combo)", () => {
    const out = new Executor().transformRequest(MODEL, body({ max_tokens: 32000, reasoning_effort: "high" }), true, {});
    expect(out.max_output_tokens).toBe(65536);
  });

  it("raises via the native reasoning object shape too", () => {
    const out = new Executor().transformRequest(MODEL, body({ max_output_tokens: 32000, reasoning: { effort: "high" } }), true, {});
    expect(out.max_output_tokens).toBe(65536);
  });

  it("floor-16 and headroom compose: cap 8 + high → 65536, not 16", () => {
    const out = new Executor().transformRequest(MODEL, body({ max_tokens: 8, reasoning_effort: "high" }), true, {});
    expect(out.max_output_tokens).toBe(65536);
  });

  it.each(["xhigh", "max"])("raises for effort %s", (effort) => {
    const out = new Executor().transformRequest(MODEL, body({ max_tokens: 32000, reasoning_effort: effort }), true, {});
    expect(out.max_output_tokens).toBe(65536);
  });

  it("leaves low/minimal efforts untouched (probe stays cheap)", () => {
    const low = new Executor().transformRequest(MODEL, body({ max_tokens: 8000, reasoning_effort: "low" }), true, {});
    expect(low.max_output_tokens).toBe(8000);
    const minimal = new Executor().transformRequest(MODEL, body({ max_tokens: 32000, reasoning_effort: "minimal" }), true, {});
    expect(minimal.max_output_tokens).toBe(32000);
  });

  it("leaves absent caps absent (Console default is generous)", () => {
    const out = new Executor().transformRequest(MODEL, body({ reasoning_effort: "high" }), true, {});
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("leaves caps at or above the threshold untouched", () => {
    const out = new Executor().transformRequest(MODEL, body({ max_tokens: 100000, reasoning_effort: "high" }), true, {});
    expect(out.max_output_tokens).toBe(100000);
  });

  it("no reasoning at all → cap untouched", () => {
    const out = new Executor().transformRequest(MODEL, body({ max_tokens: 32000 }), true, {});
    expect(out.max_output_tokens).toBe(32000);
  });
});
