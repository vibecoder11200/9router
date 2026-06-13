/**
 * Unit tests for Gemini Web RPC — BatchExecute protocol
 *
 * Run: npx vitest run tests/unit/gemini-web-rpc.test.js
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchExecutePayload,
  buildRpcBody,
  parseBatchExecuteResponse,
  parseResponseFrames,
  extractGeneratedText,
  extractModelList,
  buildGeneratePayload,
  buildGenerateRequestBody,
} from "../../open-sse/services/geminiWebRpc.js";

describe("buildBatchExecutePayload", () => {
  it("builds URL-encoded form body", () => {
    const body = buildBatchExecutePayload("boq_assistant-bard-web-ui", [null, "test"], "snl123");
    expect(body).toContain("f.req=");
    expect(body).toContain("&at=snl123");
    expect(typeof body).toBe("string");
  });

  it("encodes special characters", () => {
    const body = buildBatchExecutePayload("rpc-id", ['{"key":"value"}'], "tok!@#");
    expect(body).not.toContain(" ");
    expect(body).toContain(encodeURIComponent("tok!@#"));
  });
});

describe("buildRpcBody", () => {
  it("defaults to boq_assistant-bard-web-ui", () => {
    const body = buildRpcBody([null, "[]"], "snl123");
    expect(body).toContain("f.req=");
    // The f.req should contain the rpcId
    const decodedFreq = decodeURIComponent(body.match(/f\.req=([^&]+)/)[1]);
    expect(decodedFreq).toContain("boq_assistant-bard-web-ui");
  });
});

describe("parseBatchExecuteResponse", () => {
  it("returns empty array for null/empty input", () => {
    expect(parseBatchExecuteResponse(null)).toEqual([]);
    expect(parseBatchExecuteResponse("")).toEqual([]);
    expect(parseBatchExecuteResponse("   ")).toEqual([]);
  });

  it("parses a single frame", () => {
    const inner = JSON.stringify([["wrb.fr", "test", null, null, null, "generic"]]);
    const response = `)]}'\n${inner.length}\n${inner}\n`;
    const items = parseBatchExecuteResponse(response);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("parses multiple frames", () => {
    const frame1 = [1, 2, 3];
    const frame2 = [4, 5, 6];
    const f1 = JSON.stringify(frame1);
    const f2 = JSON.stringify(frame2);
    const response = `)]}'\n${f1.length}\n${f1}\n${f2.length}\n${f2}\n`;
    const items = parseBatchExecuteResponse(response);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it("handles missing prefix gracefully", () => {
    const data = JSON.stringify({ some: "data" });
    const response = `${data.length}\n${data}\n`;
    const items = parseBatchExecuteResponse(response);
    expect(items.length).toBe(1);
  });

  it("skips malformed frames", () => {
    const inner = "not-valid-json";
    const response = `)]}'\n${inner.length}\n${inner}\n`;
    // Should not throw
    const items = parseBatchExecuteResponse(response);
    expect(Array.isArray(items)).toBe(true);
  });
});

describe("parseResponseFrames", () => {
  it("yields frames from generator", () => {
    const frame1 = [42];
    const f1 = JSON.stringify(frame1);
    const response = `)]}'\n${f1.length}\n${f1}\n`;
    const results = [...parseResponseFrames(response)];
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractGeneratedText", () => {
  it("extracts the longest string from nested arrays", () => {
    const data = [
      [
        ["short", "this is a much longer piece of generated text", "tiny"],
        ["other text here"]
      ]
    ];
    const text = extractGeneratedText(data);
    expect(text).toBe("this is a much longer piece of generated text");
  });

  it("skips URLs and token-like strings", () => {
    const data = [
      ["https://example.com/long/url/path/that/keeps/going",
       "Hello! This is the actual response from Gemini."]
    ];
    const text = extractGeneratedText(data);
    expect(text).toBe("Hello! This is the actual response from Gemini.");
  });

  it("returns null for empty data", () => {
    expect(extractGeneratedText(null)).toBeNull();
    expect(extractGeneratedText(undefined)).toBeNull();
    expect(extractGeneratedText([])).toBeNull();
    expect(extractGeneratedText(["a"])).toBeNull();  // "a" is under min-length 5
  });

  it("doesn't exceed max depth", () => {
    const deep = [];
    let current = deep;
    for (let i = 0; i < 30; i++) {
      current.push([]);
      current = current[0];
    }
    current.push("deep text");
    expect(extractGeneratedText(deep)).toBeNull(); // Too deep
  });
});

describe("extractModelList", () => {
  it("finds model identifiers in nested data", () => {
    const data = [["gemini-3-flash", "gemini-3-pro", "gemini-2.5-flash"]];
    const models = extractModelList(data);
    expect(models).toContain("gemini-3-flash");
    expect(models).toContain("gemini-3-pro");
  });

  it("returns empty for data with no models", () => {
    expect(extractModelList(42)).toEqual([]);
    expect(extractModelList(null)).toEqual([]);
  });
});

describe("buildGeneratePayload", () => {
  it("converts OpenAI messages to Gemini Web format", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const payload = buildGeneratePayload(messages, "gemini-3-flash");
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(2);
    expect(payload[0]).toBeNull();
    expect(typeof payload[1]).toBe("string");
    // Inner string should contain model id
    expect(payload[1]).toContain("gemini-3-flash");
    // Should contain the messages
    expect(payload[1]).toContain("Hello");
  });

  it("handles empty messages gracefully", () => {
    const payload = buildGeneratePayload([], "gemini-3-flash");
    expect(Array.isArray(payload)).toBe(true);
  });

  it("extracts text from content arrays", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hi there" }] }
    ];
    const payload = buildGeneratePayload(messages, "gemini-3-flash");
    expect(payload[1]).toContain("Hi there");
  });
});

describe("buildGenerateRequestBody", () => {
  it("builds complete URL-encoded request body", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const body = buildGenerateRequestBody(messages, "gemini-3-flash", "snl123");
    expect(body).toContain("f.req=");
    expect(body).toContain("at=snl123");
    expect(typeof body).toBe("string");
  });
});
