import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// Console (muse-spark backends) validates max_output_tokens >= 16 — anything
// lower is a 400 ("The number must be `>= 16`"). ZCode's connectivity probe
// sends maxOutputTokens: 1, so executors targeting /responses floor the mapped
// value instead of forwarding it.
export const RESPONSES_MIN_OUTPUT_TOKENS = 16;

// Console also caps tool names at 64 chars — ZCode MCP tools (mcp__server__tool)
// reach 70+ and 400 with "`name` must be at most 64 characters". Deterministic
// shortening keeps tools[] and replayed function_call history names identical
// within and across turns (same original → same wire name), so callers can map
// the wire name back to the original for response restoration.
export const RESPONSES_MAX_TOOL_NAME_LEN = 64;

export function shortenResponsesToolName(name) {
  const n = String(name ?? "");
  if (n.length <= RESPONSES_MAX_TOOL_NAME_LEN) return n;
  // FNV-1a hash of the FULL name → order-independent, collision-safe;
  // keep a recognizable prefix. 55 + 1 + 8 = 64 exactly.
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i++) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${n.slice(0, 55)}_${h.toString(36).padStart(8, "0").slice(0, 8)}`;
}

// Fallback ids share one Date.now() when a batch of items is sanitized in a tight
// loop — a per-process sequence keeps same-millisecond ids unique so
// function_call ↔ function_call_output correlation never collides.
let responsesCallIdSeq = 0;

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  return id.length > MAX_RESPONSES_CALL_ID_LEN ? id.substring(0, MAX_RESPONSES_CALL_ID_LEN) : id;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((c) => {
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
