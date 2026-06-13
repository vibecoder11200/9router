import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/**
 * Gemini Web → OpenAI response translator.
 *
 * Converts Gemini Web RPC response frames to OpenAI-compatible format.
 * The actual frame parsing is handled by geminiWebRpc.js,
 * so this translator focuses on response shaping.
 */

/**
 * Convert Gemini Web parsed response to OpenAI non-stream format.
 *
 * @param {object} parsed - Parsed Gemini Web response { text, thoughts, cid, rid, rcid }
 * @param {string} modelId - Model identifier
 * @param {string} responseId - Response ID
 * @param {number} created - Created timestamp
 * @returns {object} OpenAI-compatible response
 */
export function geminiWebToOpenaiResponse(parsed, modelId, responseId, created) {
  const text = parsed?.text || "";
  const thoughts = parsed?.thoughts || "";

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(thoughts ? { thoughts } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Build a single SSE chunk for streaming.
 *
 * @param {string} responseId - Response ID
 * @param {number} created - Created timestamp
 * @param {string} modelId - Model identifier
 * @param {object} delta - Delta content { role?, content? }
 * @param {string|null} finishReason - Finish reason or null
 * @returns {string} SSE formatted chunk
 */
export function buildGeminiWebSseChunk(responseId, created, modelId, delta, finishReason) {
  const data = {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason || null,
      },
    ],
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Register translator: Gemini Web → OpenAI
register(
  FORMATS.GEMINI_WEB,
  FORMATS.OPENAI,
  null,
  geminiWebToOpenaiResponse
);
