import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;
    result.response = await inspectAndWrapCommandCodeResponse(result.response, opts.model);
    return result;
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

// Event types that mark the transition from preamble to streamed content.
// Seeing one ends the peek — everything buffered so far replays in order.
const PEEK_SENTINEL_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-call",
  "finish",
  "finish-step",
]);

// N8: hard cap on pre-sentinel buffering. A response that never produces a
// recognizable sentinel (renamed/unknown event schema) must not be buffered in
// RAM in full — past the cap the peek degrades to streaming passthrough.
const PEEK_BUFFER_MAX_BYTES =
  Number(process.env.NINEROUTER_CC_PEEK_MAX_BYTES) > 0
    ? Number(process.env.NINEROUTER_CC_PEEK_MAX_BYTES)
    : 1024 * 1024;

// N9: only these upstream headers survive onto the re-encoded SSE response.
// content-length/content-encoding/transfer-encoding describe the ORIGINAL
// NDJSON bytes and would mis-frame the new SSE stream.
const WRAP_HEADER_WHITELIST = [
  "x-request-id",
  "request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "retry-after",
];

function whitelistedHeaders(originalResponse, extra = {}) {
  const out = { ...extra };
  if (originalResponse?.headers) {
    for (const name of WRAP_HEADER_WHITELIST) {
      const v = originalResponse.headers.get(name);
      if (v != null) out[name] = v;
    }
  }
  return out;
}

export async function inspectAndWrapCommandCodeResponse(originalResponse, model) {
  // Escape hatch (C1 rollout risk): bypass the peek entirely and stream
  // straight through the NDJSON→SSE wrapper (no error pre-scan, no buffering).
  if (process.env["9R_CC_PEEK_LEGACY"] === "1" || process.env.NINEROUTER_CC_PEEK_LEGACY === "1") {
    return wrapNdjsonAsOpenAISse(originalResponse.body, model, originalResponse);
  }

  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const bufferedLines = [];
  let bufferedBytes = 0;
  let detectedError = null;
  let overflowed = false;
  // C1: complete lines that arrived in the SAME chunk after the sentinel.
  // Providers routinely flush sentinel + first deltas in one TCP read; these
  // lines must replay in order ahead of the live stream — never be dropped.
  let afterSentinelLines = [];

  const recordLine = (line) => {
    bufferedLines.push(line);
    // Count UTF-8 bytes, not JS chars — a char-only cap can undercount up to
    // 4x on multi-byte content and let the buffer exceed the real limit.
    bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
  };

  try {
    scan: while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            } else {
              recordLine(trimmed);
            }
          } catch {
            recordLine(trimmed);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          recordLine(trimmed);
          afterSentinelLines = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean);
          break scan;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          recordLine(trimmed);
          continue;
        }

        if (event?.type === "error") {
          detectedError = event;
          break scan;
        }

        recordLine(trimmed);

        if (PEEK_SENTINEL_TYPES.has(event?.type)) {
          afterSentinelLines = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean);
          break scan;
        }
      }

      if (bufferedBytes > PEEK_BUFFER_MAX_BYTES) {
        // N8: no sentinel within the cap — stop scanning and degrade to
        // passthrough. Everything buffered replays; the remainder streams
        // through the wrapper without further peek-side accumulation.
        overflowed = true;
        break;
      }
    }
  } catch {
    // C8: the original body is half-consumed at this point. Hand back a
    // stream that REPLAYS every buffered line first, then continues reading
    // the original body — instead of the old behavior of returning the
    // original (prefix-lost) response.
    try { reader.releaseLock(); } catch { /* ignore */ }
    let continuation = null;
    try { continuation = originalResponse.body.getReader(); } catch { /* body unusable */ }
    const replayBody = createReplayedStream(bufferedLines, buffer, continuation, true);
    return new Response(replayBody, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: whitelistedHeaders(originalResponse, {
        "Content-Type": originalResponse.headers?.get("content-type") || "application/x-ndjson",
      }),
    });
  }

  if (overflowed) {
    console.warn(
      `[CommandCode] peek buffered >${PEEK_BUFFER_MAX_BYTES}B without a sentinel; degrading to streaming passthrough (no error pre-scan)`
    );
  }

  if (detectedError) {
    try { await reader.cancel(); } catch { /* ignore */ }
    const { statusCode, message, type } = parseCommandCodeError(detectedError);
    return new Response(
      JSON.stringify({
        error: {
          message: `[CommandCode error: ${message}]`,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        statusText: statusCode === 503 ? "Service Unavailable" : (statusCode === 429 ? "Too Many Requests" : "Bad Gateway"),
        headers: whitelistedHeaders(originalResponse, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }),
      }
    );
  }

  const combinedStream = createReplayedStream(
    [...bufferedLines, ...afterSentinelLines],
    buffer,
    reader
  );
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createReplayedStream(bufferedLines, remainingBuffer, reader, closeWhenReaderMissing = false) {
  const encoder = new TextEncoder();
  let replayed = false;

  return new ReadableStream({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        let prefix = bufferedLines.join("\n");
        if (prefix && remainingBuffer) {
          prefix += "\n" + remainingBuffer;
        } else if (remainingBuffer) {
          prefix = remainingBuffer;
        } else if (prefix) {
          prefix += "\n";
        }
        if (prefix) {
          controller.enqueue(encoder.encode(prefix));
          // Return here: the prefix must be delivered as its own pull. Reading
          // the continuation in the same pull would discard the enqueued
          // prefix when the original body errors (controller.error clears the
          // queue) — exactly the C8 case this replay exists for.
          return;
        }
      }

      if (!reader) {
        if (closeWhenReaderMissing) controller.close();
        else controller.error(new Error("CommandCode replay: reader unavailable"));
        return;
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  // N9: the SSE body is a re-encoding — carry over only safe, framing-neutral
  // upstream headers. The old spread copied stale content-length/
  // content-encoding from the NDJSON response onto the SSE stream.
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: whitelistedHeaders(originalResponse, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    }),
  });
}

export default CommandCodeExecutor;
