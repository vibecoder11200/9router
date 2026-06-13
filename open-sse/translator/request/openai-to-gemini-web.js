import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/**
 * OpenAI → Gemini Web request translator.
 *
 * Converts OpenAI chat completion messages to Gemini Web RPC format.
 * The Gemini Web executor handles the actual RPC payload construction,
 * so this translator focuses on message conversion and model resolution.
 */

/**
 * Convert OpenAI messages array to Gemini Web prompt format.
 *
 * @param {string} model - Requested model name (e.g. "gemini-3-flash")
 * @param {object} body - OpenAI request body
 * @param {boolean} stream - Whether streaming is requested
 * @returns {object} Translated request body for Gemini Web executor
 */
export function openaiToGeminiWebRequest(model, body, stream) {
  const messages = body?.messages || [];
  const systemPrompt = extractSystemPrompt(messages);
  const { prompt, conversationHistory } = convertMessages(messages);

  return {
    model: model || "gemini-3-flash",
    messages,
    stream,
    // Pre-processed fields for executor
    _geminiWeb: {
      prompt,
      systemPrompt,
      conversationHistory,
    },
  };
}

/**
 * Extract system prompt from messages.
 */
function extractSystemPrompt(messages) {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return null;
  return systemMsgs
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("\n");
      }
      return "";
    })
    .join("\n\n");
}

/**
 * Convert OpenAI messages to Gemini Web format.
 *
 * Gemini Web uses a single prompt approach where we take the last user message
 * as the main prompt and include conversation history for context.
 */
function convertMessages(messages) {
  const userMessages = [];
  const conversationHistory = [];

  for (const msg of messages || []) {
    const role = String(msg.role || "user");
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((p) => p.type === "text")
        .map((p) => String(p.text || ""))
        .join("\n");
    }

    if (!content.trim()) continue;

    if (role === "user") {
      userMessages.push(content);
      conversationHistory.push({ role: "user", content });
    } else if (role === "assistant") {
      conversationHistory.push({ role: "assistant", content });
    }
  }

  const prompt = userMessages[userMessages.length - 1] || "";
  return { prompt, conversationHistory };
}

// Register translator: OpenAI → Gemini Web
register(FORMATS.OPENAI, FORMATS.GEMINI_WEB, openaiToGeminiWebRequest, null);
