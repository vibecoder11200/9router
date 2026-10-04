// Console caps tool names at 64 chars — ZCode MCP tools (mcp__server__tool)
// reach 70+ and 400 with "`name` must be at most 64 characters". The opencode
// executors shorten deterministically and record a wire→original map that
// chatCore threads into the response handlers for restoration. Regression tests.
import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { shortenResponsesToolName, RESPONSES_MAX_TOOL_NAME_LEN } from "../../open-sse/translator/formats/responsesApi.js";
import { takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

const MODEL = "muse-spark-1.3-contributor-free";
// 71 chars — over the Console 64-char cap (the live 400 reported "got 71").
const LONG_NAME = "mcp__github_server__get_pull_request_files_for_repository_review__audit9";
// 69 chars, chat-shaped variant.
const CHAT_LONG_NAME = "mcp__github_server__get_pull_request_files_for_repo_review_and_more_x";

const flatTool = (name) => ({
  type: "function",
  name,
  description: "test tool",
  parameters: { type: "object", properties: {} },
});

const responsesBody = (extra = {}) => ({
  model: MODEL,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  ...extra,
});

describe("shortenResponsesToolName", () => {
  it("passes through names at or under the cap", () => {
    expect(shortenResponsesToolName("bash")).toBe("bash");
    expect(shortenResponsesToolName("a".repeat(RESPONSES_MAX_TOOL_NAME_LEN))).toBe("a".repeat(RESPONSES_MAX_TOOL_NAME_LEN));
  });

  it("shortens long names to exactly the cap, deterministically", () => {
    const short = shortenResponsesToolName(LONG_NAME);
    expect(short.length).toBeLessThanOrEqual(RESPONSES_MAX_TOOL_NAME_LEN);
    expect(shortenResponsesToolName(LONG_NAME)).toBe(short);
    expect(short.startsWith(LONG_NAME.slice(0, 55))).toBe(true);
  });

  it("distinct names sharing the 55-char prefix hash differently", () => {
    const a = "x".repeat(60) + "a";
    const b = "x".repeat(60) + "b";
    expect(shortenResponsesToolName(a)).not.toBe(shortenResponsesToolName(b));
  });
});

describe.each([
  ["opencode (oc)", OpenCodeExecutor],
  ["opencode-zen (ocz)", OpenCodeZenExecutor],
  ["opencode-go", OpenCodeGoExecutor],
])("%s responses tool-name cap", (name, Executor) => {
  it("shortens a >64 char tool name and records the wire→original map", () => {
    const body = responsesBody({ tools: [flatTool(LONG_NAME)] });
    new Executor().transformRequest(MODEL, body, true, {});
    expect(body.tools[0].name.length).toBeLessThanOrEqual(RESPONSES_MAX_TOOL_NAME_LEN);
    const map = takeRenamedToolNames(body);
    expect(map?.get(body.tools[0].name)).toBe(LONG_NAME);
  });

  it("leaves short names untouched and records no map", () => {
    const body = responsesBody({ tools: [flatTool("read")] });
    new Executor().transformRequest(MODEL, body, true, {});
    expect(body.tools.some((t) => t.name === "read")).toBe(true);
    expect(takeRenamedToolNames(body)).toBeNull();
  });

  it("shortens replayed function_call history to the same wire name as tools[]", () => {
    const body = responsesBody({
      tools: [flatTool(LONG_NAME)],
      input: [
        { type: "function_call", name: LONG_NAME, call_id: "call_1", arguments: "{}" },
      ],
    });
    new Executor().transformRequest(MODEL, body, true, {});
    const historyName = body.input.find((i) => i.type === "function_call").name;
    expect(historyName).toBe(body.tools[0].name);
    expect(historyName.length).toBeLessThanOrEqual(RESPONSES_MAX_TOOL_NAME_LEN);
  });

  it("keeps the wire body free of private bookkeeping fields", () => {
    const body = responsesBody({ tools: [flatTool(LONG_NAME)] });
    new Executor().transformRequest(MODEL, body, true, {});
    expect(JSON.stringify(body)).not.toContain("_toolNameMap");
  });
});

// tool_choice retarget — zen/go only: the oc registry forces tool_choice "auto"
// for muse-spark-1.3-contributor-free (forceAutoToolChoiceModels quirk), so an
// explicit choice never survives there by design.
describe.each([
  ["opencode-zen (ocz)", OpenCodeZenExecutor],
  ["opencode-go", OpenCodeGoExecutor],
])("%s tool_choice retarget", (name, Executor) => {
  it("retargets an explicit tool_choice at the shortened wire name", () => {
    const body = responsesBody({
      tools: [flatTool(LONG_NAME)],
      tool_choice: { type: "function", name: LONG_NAME },
    });
    new Executor().transformRequest(MODEL, body, true, {});
    expect(body.tool_choice?.name).toBe(body.tools[0].name);
    expect(body.tool_choice?.name.length).toBeLessThanOrEqual(RESPONSES_MAX_TOOL_NAME_LEN);
  });
});

describe("fingerprint + length rename maps merge (opencode executor)", () => {
  it("keeps both the case-variant and the shortened entry", () => {
    const body = responsesBody({
      tools: [flatTool("Bash"), flatTool(LONG_NAME)],
    });
    new OpenCodeExecutor().transformRequest(MODEL, body, true, {});
    const map = takeRenamedToolNames(body);
    expect(map?.get("bash")).toBe("Bash");
    expect(map?.get(shortenResponsesToolName(LONG_NAME))).toBe(LONG_NAME);
  });
});

describe("streaming restore in openaiResponsesToOpenAIResponse", () => {
  it("restores the original name on the emitted tool_call chunk", () => {
    const wire = shortenResponsesToolName(LONG_NAME);
    const state = { toolNameMap: new Map([[wire, LONG_NAME]]) };
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.output_item.added",
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: wire, arguments: "" },
    }, state);
    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe(LONG_NAME);
  });

  it("passes unmapped names through unchanged", () => {
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.output_item.added",
      item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "bash", arguments: "" },
    }, {});
    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe("bash");
  });
});

// Chat-shaped bodies (function:{name}) ride the same executor normalization.
describe("chat-shaped long tool names (oc executor)", () => {
  it("shortens nested function names and records the map", () => {
    const body = {
      model: MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      tools: [{
        type: "function",
        function: { name: CHAT_LONG_NAME, description: "d", parameters: { type: "object", properties: {} } },
      }],
    };
    new OpenCodeExecutor().transformRequest(MODEL, body, true, {});
    expect(body.tools[0].name.length).toBeLessThanOrEqual(RESPONSES_MAX_TOOL_NAME_LEN);
    expect(takeRenamedToolNames(body)?.get(body.tools[0].name)).toBe(CHAT_LONG_NAME);
  });
});
