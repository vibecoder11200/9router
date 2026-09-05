import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  SSE_HEADERS: { "Content-Type": "text/event-stream" },
  createPassthroughStreamWithLogger: () => new TransformStream(),
  createSSETransformStreamWithLogger: () => new TransformStream(),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

const encoder = new TextEncoder();
const SSE_CHUNK_1 = 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
const SSE_CHUNK_2 = 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n';

function sseResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function baseArgs(overrides = {}) {
  return {
    providerResponse: sseResponse([SSE_CHUNK_1, SSE_CHUNK_2]),
    provider: "openai",
    model: "gpt-4o",
    sourceFormat: "openai",
    targetFormat: "openai",
    userAgent: "",
    body: { model: "gpt-4o", messages: [] },
    stream: true,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "key",
    reqTag: "[TEST]",
    streamController: {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleError: vi.fn(),
      // Full createStreamController contract — the response body IS the
      // disconnect-aware stream now, so cancel() reaches the controller.
      handleComplete: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorLine: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// N7: onRequestSuccess used to fire the moment handleStreamingResponse was
// entered (200 headers in hand) — an upstream that accepted the request then
// died before the first byte still "healed" the account lock. The signal must
// be the first chunk actually FORWARDED to the client.
describe("first-byte success signal (N7)", () => {
  it("does not fire onRequestSuccess before any byte is forwarded", async () => {
    const onRequestSuccess = vi.fn();
    const { success } = await handleStreamingResponse(baseArgs({ onRequestSuccess }));
    expect(success).toBe(true);
    // Give any (wrongly) fire-and-forget promise a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("fires onRequestSuccess exactly once on the first forwarded chunk", async () => {
    const onRequestSuccess = vi.fn();
    const { response } = await handleStreamingResponse(baseArgs({ onRequestSuccess }));
    const reader = response.body.getReader();
    await reader.read();  // first forwarded byte
    await Promise.resolve();
    await Promise.resolve();
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    await reader.read();  // more bytes — no re-fire
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it("never fires when the upstream body errors before producing a byte", async () => {
    const onRequestSuccess = vi.fn();
    const errBody = new ReadableStream({
      pull(controller) {
        controller.error(new Error("upstream died at accept"));
      },
    });
    const providerResponse = new Response(errBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const { response } = await handleStreamingResponse(baseArgs({ providerResponse, onRequestSuccess }));
    const reader = response.body.getReader();
    await expect(reader.read()).rejects.toThrow("upstream died at accept");
    await Promise.resolve();
    await Promise.resolve();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});
