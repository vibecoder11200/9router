/**
 * Gemini Web Executor — non-streaming & streaming generation via StreamGenerate RPC.
 *
 * Architecture mirrors the Python gemini_webapi library:
 *   Endpoint: /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   Auth:     SAPISIDHASH (Authorization header) + SNlM0e (at token in body for XSRF)
 *   Payload:  102-slot inner array (f.req = [null, JSON.stringify(inner)])
 *   Response: Length-prefixed JSON frames with wrb.fr entries
 *
 * Key difference from Python library:
 *   - Python uses curl_cffi for TLS fingerprinting
 *   - We use standard fetch + SAPISIDHASH auth header + SNlM0e for XSRF
 *   - Model headers are x-goog-ext-525001261-jspb etc.
 *
 * Features:
 *   - Session bootstrap with build_label, session_id, language, SNlM0e extraction
 *   - SAPISIDHASH-based auth (per-request fresh hash)
 *   - SNlM0e (at) token extracted from bootstrap and included in request body
 *   - Model selection via model headers + inner[79]
 *   - Streaming via SSE chunks
 *   - Non-streaming JSON responses
 *   - Cookie rotation
 */

import { BaseExecutor } from "./base.js";
import { extractGeminiWebCredentials } from "../services/geminiWebCookie.js";
import { bootstrapGeminiWebSession, getGeminiWebUserStatus, buildSapisidHash, extractSapisid } from "../services/geminiWebSession.js";
import {
  parseResponseFrames,
  extractGeminiResponse,
} from "../services/geminiWebRpc.js";
import { PROVIDERS } from "../config/providers.js";
import { resolveGeminiWebModel } from "../services/geminiWebModels.js";
import crypto from "crypto";

const GEMINI_BASE = "https://gemini.google.com";
const STREAMGENERATE_URL = `${GEMINI_BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const BATCHEXECUTE_URL = `${GEMINI_BASE}/_/BardChatUi/data/batchexecute`;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------
const SESSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const sessionCache = new Map();

function getCachedSession(cookieHash) {
  const entry = sessionCache.get(cookieHash);
  if (!entry) return null;
  if (Date.now() - entry.ts > SESSION_CACHE_TTL) {
    sessionCache.delete(cookieHash);
    return null;
  }
  return entry;
}

function setCachedSession(cookieHash, session) {
  sessionCache.set(cookieHash, { ...session, ts: Date.now() });
  if (sessionCache.size > 50) {
    let oldest = null;
    let oldestTs = Infinity;
    for (const [k, v] of sessionCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldest = k; }
    }
    if (oldest) sessionCache.delete(oldest);
  }
}

function cookieHashKey(cookies) {
  if (!cookies) return "";
  return Object.keys(cookies)
    .filter(k => k && cookies[k])
    .sort()
    .map(k => `${k}=${(cookies[k] || "").slice(0, 12)}`)
    .join("|");
}

// ---------------------------------------------------------------------------
// Session bootstrap (cached)
// ---------------------------------------------------------------------------
async function getOrBootstrapSession(cookies, log, proxy) {
  const hash = cookieHashKey(cookies);
  const cached = getCachedSession(hash);
  if (cached) {
    log?.debug?.("GEMINI-WEB", "using cached session");
    return cached;
  }

  log?.debug?.("GEMINI-WEB", "bootstrapping new session…");
  const session = await bootstrapGeminiWebSession(cookies, { proxy });
  log?.debug?.("GEMINI-WEB", `session bootstrapped: auth=${session.authHeader?.slice(0, 30)}…, language=${session.language}`);

  // Send bard_settings as init RPC
  try {
    const { sendBardSettings } = await import("../services/geminiWebSession.js");
    await sendBardSettings(cookies, session.authHeader, {
      buildLabel: session.buildLabel,
      sessionId: session.sessionId,
      language: session.language,
    }, { proxy });
  } catch (e) {
    log?.debug?.("GEMINI-WEB", `init RPC (bard_settings) failed: ${e.message}`);
  }

  setCachedSession(hash, session);

  // Start session keep-alive (non-blocking, only once)
  try {
    const { startSessionKeepAlive } = require("../services/geminiWebKeepAlive.js");
    startSessionKeepAlive({ cookies }, proxy);
  } catch {}
  return session;
}

// ---------------------------------------------------------------------------
// Cookie header helper
// ---------------------------------------------------------------------------
function buildCookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// StreamGenerate request
// ---------------------------------------------------------------------------

async function callStreamGenerate(cookies, session, messages, modelName, streaming, signal, log, proxy, body) {
  const model = resolveGeminiWebModel(modelName);
  const { prompt } = convertMessages(messages, body);
  const uuid = crypto.randomUUID().toUpperCase();

  // Build 102-slot payload (Google expanded from 69 → 102)
  const inner = new Array(102).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = [session.language || "en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [1];
  inner[7] = streaming ? 1 : 0;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = uuid;
  inner[61] = [];
  inner[68] = 2;
  // Model mode selection (added — required for newer Gemini Web versions)
  inner[79] = null;

  const fReq = JSON.stringify([null, JSON.stringify(inner)]);

  // Build query params
  const searchParams = new URLSearchParams();
  if (session.buildLabel) searchParams.set("bl", session.buildLabel);
  searchParams.set("hl", session.language || "en");
  searchParams.set("_reqid", String(Math.floor(Math.random() * 90000) + 10000));
  searchParams.set("rt", "c");
  if (session.sessionId) searchParams.set("f.sid", session.sessionId);

  const url = `${STREAMGENERATE_URL}?${searchParams.toString()}`;

  // Build form body — include SNlM0e (at token) for XSRF protection
  const formBody = new URLSearchParams();
  formBody.set("f.req", fReq);
  if (session.snlm0e) {
    formBody.set("at", session.snlm0e);
  }

  // Build fresh SAPISIDHASH per request (real browsers do this every time)
  const sapisid = extractSapisid(cookies);
  const { headerValue: freshAuth } = sapisid
    ? buildSapisidHash(sapisid)
    : { headerValue: session.authHeader };

  // Build headers
  const requestHeaders = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "Cookie": buildCookieHeader(cookies),
    "Authorization": freshAuth,
    "Origin": GEMINI_BASE,
    "Referer": `${GEMINI_BASE}/app`,
    "X-Same-Domain": "1",
    ...model.header,
    "x-goog-ext-525005358-jspb": `["${uuid}",1]`,
  };

  log?.debug?.("GEMINI-WEB", `calling StreamGenerate: model=${model.modelName}, streaming=${streaming}, prompt_len=${prompt.length}`);

  const res = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: formBody.toString(),
    signal,
  });

  return res;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function convertMessages(messages, body) {
  // Check if translator already pre-processed the messages
  const preProcessed = body?._geminiWeb;
  if (preProcessed) {
    let prompt = preProcessed.prompt || "";

    // Build full prompt with system prompt and conversation history
    if (preProcessed.systemPrompt) {
      prompt = preProcessed.systemPrompt + "\n\n" + prompt;
    }

    // Include conversation history as context
    const history = preProcessed.conversationHistory || [];
    if (history.length > 1) {
      // Build context from all but the last message (which is the current prompt)
      const historyText = history.slice(0, -1)
        .map(msg => {
          const role = msg.role === "assistant" ? "Assistant" : "User";
          return `${role}: ${msg.content}`;
        })
        .join("\n");
      if (historyText.trim()) {
        prompt = historyText + "\n\n" + prompt;
      }
    }

    return { prompt, metadata: null, fileData: null };
  }

  // Fallback: extract from messages array directly (includes system + history)
  const userMessages = [];
  const systemParts = [];
  const historyParts = [];

  for (const msg of (messages || [])) {
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

    if (role === "system") {
      systemParts.push(content);
    } else {
      if (role === "user") userMessages.push(content);
      historyParts.push(`${role === "assistant" ? "Assistant" : "User"}: ${content}`);
    }
  }

  // Build final prompt: system + history + last user message
  let prompt = "";
  if (systemParts.length > 0) prompt += systemParts.join("\n\n") + "\n\n";
  if (historyParts.length > 1) {
    // Include all but last as history context
    prompt += historyParts.slice(0, -1).join("\n") + "\n\n";
  }
  prompt += userMessages[userMessages.length - 1] || "";

  return { prompt, metadata: null, fileData: null };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseGenerateResponse(responseText) {
  const frames = parseResponseFrames(responseText);
  const result = extractGeminiResponse(frames);
  return result || { text: "", thoughts: "", cid: "", rid: "", rcid: "" };
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeResponseId() {
  return `chatcmpl-gweb-${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Streaming response builder
// ---------------------------------------------------------------------------

function buildStreamingResponse(responseText, modelId, cid, created, signal) {
  const encoder = new TextEncoder();
  const { text } = parseGenerateResponse(responseText);
  const words = text ? text.split(/(?<=\s)/) : [];

  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })));

        if (words.length > 0) {
          const groupSize = Math.max(1, Math.floor(words.length / 20));
          for (let i = 0; i < words.length; i += groupSize) {
            if (signal?.aborted) break;
            const group = words.slice(i, i + groupSize).join("");
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { content: group }, finish_reason: null }],
            })));
            if (i + groupSize < words.length) {
              await new Promise((r) => setTimeout(r, 15));
            }
          }
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message}]` }, finish_reason: "stop" }],
        })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Executor class
// ---------------------------------------------------------------------------

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // Validate credentials and extract cookies
    const extracted = extractGeminiWebCredentials(credentials || {});
    if (!extracted.valid) {
      const errResp = new Response(JSON.stringify({
        error: { message: extracted.error || "Invalid Gemini Web cookies", type: "auth_error", code: "invalid_cookie" },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
    }

    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
    }

    const modelName = model || "gemini-3-flash";
    const cid = makeResponseId();
    const created = Math.floor(Date.now() / 1000);

    try {
      // Bootstrap or get cached session
      const session = await getOrBootstrapSession(extracted.cookies, log, proxyOptions);

      log?.debug?.("GEMINI-WEB", `generating with model=${modelName}, stream=${stream}, messages=${messages.length}`);

      // Call StreamGenerate
      const res = await callStreamGenerate(
        extracted.cookies, session, messages, modelName, stream, signal, log, proxyOptions, body
      );

      if (!res.ok) {
        let errMsg = `Gemini Web returned HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          errMsg = "Cookie expired or invalid — re-paste your Gemini cookies";
          const hash = cookieHashKey(extracted.cookies);
          sessionCache.delete(hash);
        } else if (res.status === 429) {
          errMsg = "Gemini Web rate limited — wait and retry";
        }
        log?.warn?.("GEMINI-WEB", errMsg);
        const errResp = new Response(JSON.stringify({
          error: { message: errMsg, type: "upstream_error", code: `HTTP_${res.status}` },
        }), { status: res.status >= 500 ? 502 : res.status, headers: { "Content-Type": "application/json" } });
        return { response: errResp, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
      }

      const responseText = await res.text();

      if (stream) {
        const sseStream = buildStreamingResponse(responseText, modelName, cid, created, signal);
        const finalResponse = new Response(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        });
        return { response: finalResponse, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
      } else {
        const { text: extractedText, thoughts } = parseGenerateResponse(responseText);

        const responseBody = JSON.stringify({
          id: cid,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: extractedText || "",
              ...(thoughts ? { thoughts } : {}),
            },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: Math.ceil((responseText.length || 0) / 4),
            completion_tokens: Math.ceil((extractedText?.length || 0) / 4),
            total_tokens: Math.ceil(((responseText.length || 0) + (extractedText?.length || 0)) / 4),
          },
        });

        const finalResponse = new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        return { response: finalResponse, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
      }
    } catch (err) {
      if (err.name === "AbortError") {
        log?.warn?.("GEMINI-WEB", `Request aborted: ${err.message || "timeout"}`);
        const errResp = new Response(JSON.stringify({
          error: { message: "Request timed out", type: "timeout" },
        }), { status: 408, headers: { "Content-Type": "application/json" } });
        return { response: errResp, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
      }

      log?.error?.("GEMINI-WEB", `Execution failed: ${err.message}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `Gemini Web error: ${err.message}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: STREAMGENERATE_URL, headers: {}, transformedBody: body };
    }
  }
}

export default GeminiWebExecutor;
