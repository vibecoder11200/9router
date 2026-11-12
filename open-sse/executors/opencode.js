import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools, recordRenamedToolNames } from "../utils/opencodeFingerprint.js";
import { opencodeTlsFetch } from "../services/opencodeTlsClient.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
  RESPONSES_MIN_OUTPUT_TOKENS,
  shortenResponsesToolName,
  ensureResponsesReasoningHeadroom,
} from "../translator/formats/responsesApi.js";
// Fork: live UA version + catalog-driven responses routing (providers/opencodeCatalog.js).
import { ensureOpencodeCatalog, getOpencodeCliUserAgent, isResponsesServed } from "../providers/opencodeCatalog.js";
// Fork: v2 free-lane wire snapshot + Bun stdio lane transport (plans/261112-2130).
import {
  getEmbeddedWireSnapshot,
  shapeV2FreeLaneRequestBody,
  mintV2IdentityHeaders,
} from "../providers/opencodeWire.js";
import {
  opencodeFreeLaneFetch,
  OpenCodeFreeLaneUnavailableError,
  OpenCodeFreeLaneUnmappedProxyError,
  OpenCodeFreeLaneBusyError,
} from "../services/opencodeBunLane.js";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";
import { getSettings } from "@/lib/localDb.js";
import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const OPENCODE_UA = "opencode/latest/2.0.26/cli";
const OPENCODE_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}
// Models served by /inference/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

// Upstream decodes the prefix timestamp and refuses sessions whose time is in
// the future or older than the free-tier window (live probes 2026-10-26: a
// Date.now() session passed 10/10 while digest-derived ones passed 1/10). A
// digest is uniform over 2^36 ms, so most translated ids were refused even
// though their shape matched. Mint with the current time and memoize per
// conversation so a conversation keeps one stable, valid session.
const translatedOpencodeSessions = new Map();
const MAX_TRANSLATED_SESSIONS = 5000;
const translatedSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of translatedOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      translatedOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (translatedSessionCleanup.unref) translatedSessionCleanup.unref();

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const key = `${clientTool || "generic"}\0${sessionId || ""}`;
  const existing = translatedOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }
  const translated = `ses_${descendingTimeHex(Date.now(), 1)}${unstableRandom()}`;
  if (translatedOpencodeSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedOpencodeSessions.delete(translatedOpencodeSessions.keys().next().value);
  }
  translatedOpencodeSessions.set(key, { sessionId: translated, lastUsed: Date.now() });
  return translated;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
      sessionRotatedAt.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  let base;
  if (connectionId) base = `opencode:conn:${String(connectionId).slice(0, 128)}`;
  else if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    base = `opencode:auth:${digest}`;
  } else base = "opencode:default";
  // A stable session must never hop exit IPs: the server-side free-tier
  // accounting keys on the session, and one session seen from many IPs
  // (rotating proxy pool, xray model-filter probes) reads as account
  // sharing and burns the session for every request behind this identity.
  // Key the session by the resolved exit too, so each exit keeps its own
  // long-lived session exactly like a real single-IP CLI client.
  const psd = credentials?.providerSpecificData || {};
  // connectionProxyProbeTag (xray model-filter free-chat probes, api-mode):
  // every config routes through the SAME worker SOCKS URI, so the URL alone
  // would collapse all exits into one session — exactly the hopping pattern
  // above. The per-config tag keeps each probed exit on its own session.
  const exit = String(
    psd.connectionProxyProbeTag
      || psd.connectionProxyUrl
      || psd.connectionProxyEntryId
      || psd.connectionProxyPoolId
      || "",
  ).trim();
  if (!exit || exit === base) return base;
  const exitDigest = crypto.createHash("sha256").update(exit).digest("hex").slice(0, 16);
  return `${base}:exit:${exitDigest}`;
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

// 429 FreeUsageLimitError can stick to a specific session id (the gate counts
// per session and a flagged one keeps answering 429 long after its quota
// window, e.g. after a session accidentally hopped exit IPs). Rotate the
// identity's session once a 429 is seen so the next request mints a fresh
// one. Cooldown: while the whole exit IP is quota-capped every new session
// 429s too, and re-minting on every request would itself look abusive — one
// rotation per identity per 10 minutes.
const SESSION_ROTATE_COOLDOWN_MS = 10 * 60 * 1000;
const sessionRotatedAt = new Map();

export function evictStableSessionForRotation(credentials) {
  const key = identityKey(credentials);
  sessionRotatedAt.set(key, Date.now());
  return stableOpencodeSessions.delete(key);
}

function shouldRotateStableSession(credentials) {
  const key = identityKey(credentials);
  const last = sessionRotatedAt.get(key) || 0;
  return Date.now() - last >= SESSION_ROTATE_COOLDOWN_MS;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  if (RESPONSES_MODELS.has(base) || isMuseSparkModel(base)) return true;
  // Fork: registry-declared targetFormat is authoritative for declared models;
  // undeclared ones fall back to the live api.json catalog (same metadata the
  // official CLI reads), which picks up newly released responses-only models
  // without a code change.
  ensureOpencodeCatalog();
  const declared = getModelTargetFormat(PROVIDER_ID_TO_ALIAS.opencode, base);
  if (declared) return declared === "openai-responses";
  return isResponsesServed(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  // wire name -> original name for names shortened past the Console 64-char cap.
  const renamed = new Map();
  const origToWire = new Map();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = shortenResponsesToolName(name);
    if (tool.name !== name) {
      renamed.set(tool.name, name);
      origToWire.set(name, tool.name);
    }
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      // Retarget an explicit choice at the shortened wire name before the
      // validNames membership check would otherwise drop it.
      const wire = origToWire.get(n);
      if (wire) body.tool_choice = { ...body.tool_choice, name: wire };
      const eff = wire || n;
      if (!eff || !validNames.has(eff)) delete body.tool_choice;
    }
  }
  recordRenamedToolNames(body, renamed);
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      // Same deterministic shortening as tools[] so replayed history matches.
      item.name = shortenResponsesToolName(item.name.trim());
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Chat Completions lane: the free backend validates reasoning_effort against the
// plain OpenAI enum (none|minimal|low|medium|high|xhigh|max) and answers 400
// "Invalid option" for anything else — including "auto", which adaptive thinking
// (Claude Code's thinking:{type:"adaptive"}) arrives as. Omitting the field lets
// the upstream pick its own default, which is what adaptive means; same rationale
// as the Responses path above, which rejects "unknown variant `auto`".
function dropAdaptiveReasoningEffort(body) {
  if (body?.reasoning_effort === "auto") delete body.reasoning_effort;
}

// Fail-fast alert dedupe (plan acceptance #3): exactly ONE alert per kind per
// hour regardless of request volume — keyed PER KIND so an unmapped-proxy info
// can never mask a genuine lane-down critical in the same window (review P1-3).
const LANE_ALERT_DEDUPE_MS = 60 * 60 * 1000;
const laneAlertState = { down: 0, unmapped: 0, busy: 0 };

/**
 * The free gate keys on the TLS ClientHello (Bun's BoringSSL passes, Node's
 * is refused) — the v2 gate ALSO refuses the legacy wreq-js Chrome-TLS lane
 * (plan P0 evidence), so the primary engine is the Bun stdio lane with the
 * CLI-identical wire snapshot. Fail-fast: on lane unavailability the typed
 * error surfaces (503) — serving a v2-gated request on the legacy lane would
 * be a guaranteed 429 wearing a degradation alert, never a fallback. The
 * legacy path stays reachable ONLY via opencodeFreeLaneEngine: "legacy"
 * (today's exact behavior) or for responses/messages-format free models
 * (known-refused by the v2 chat-completions lane — documented R8).
 */
async function runBunFreeLane(options, ctx, credentials, model) {
  // The snapshot endpoint is authoritative — the executor's chat-completions
  // URL is deliberately not used on this lane.
  const snapshot = getEmbeddedWireSnapshot();
  // The harness system text carries `- Name:` / `- Model ID:` lines — render
  // them with the real model so the wire matches the CLI/fixture composition
  // (P0-proven), not empty fields (review P2-1).
  const shaped = shapeV2FreeLaneRequestBody(JSON.parse(options.body), snapshot, { modelId: model });
  const headers = mintV2IdentityHeaders(snapshot, credentials?.[SESSION_FIELD]);
  return opencodeFreeLaneFetch(snapshot.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(shaped),
  }, { signal: options.signal, proxyUrl: ctx?.proxyUrl || null });
}

function surfaceLaneUnavailable(laneError) {
  const unmapped = laneError instanceof OpenCodeFreeLaneUnmappedProxyError;
  const busy = laneError instanceof OpenCodeFreeLaneBusyError;
  // info for a healthy-but-saturated lane and an unmapped proxy — neither is
  // a lane outage; critical only for a genuine bun runtime/lane failure.
  const kind = busy ? "busy" : unmapped ? "unmapped" : "down";
  const now = Date.now();
  if (now - laneAlertState[kind] > LANE_ALERT_DEDUPE_MS) {
    laneAlertState[kind] = now;
    emitAlert(EVENT_TYPES.OPENCODE_BUN_LANE_UNAVAILABLE, {
      severity: kind === "down" ? SEVERITY.CRITICAL : SEVERITY.INFO,
      title: kind === "down"
        ? "OpenCode free lane unavailable"
        : kind === "busy"
          ? "OpenCode free lane saturated"
          : "OpenCode free lane proxy unmapped",
      body: kind === "down"
        ? "The Bun lane failed its bounded retry; requests fail fast with 503 until it recovers."
        : kind === "busy"
          ? "All 3 lane children are busy and the waiter queue timed out — healthy lane under load; requests fail fast with 503."
          : "The pool binding's socks proxy has no verifiable xray HTTP inbound — bind a fork xray pool or remove the pool binding.",
      details: { reason: laneError?.code, kind },
      dedupKey: "opencode-bun-lane",
    });
  }
  const err = new Error(
    kind === "down"
      ? "OpenCode free lane unavailable (bun runtime/lane failure)"
      : kind === "busy"
        ? "OpenCode free lane saturated (max 3 concurrent children; queue timeout)"
        : "OpenCode free lane: proxy pool not mappable to the Bun lane (bind a fork xray pool or remove the pool binding)",
  );
  err.code = "OPENCODE_FREE_LANE_UNAVAILABLE";
  err.statusCode = 503;
  // Non-retriable by construction: the lane already spent its bounded retry.
  // Without this the base loop maps the throw to the 502 retry config and
  // multiplies both the latency and the child spawns (review P1-2).
  err.noRetry = true;
  return err;
}

// Test-only: reset the lane-alert dedupe windows (module-level state).
export const __test__ = {
  resetLaneAlertDedupe() {
    laneAlertState.down = 0;
    laneAlertState.unmapped = 0;
    laneAlertState.busy = 0;
  },
};

// Read-only observability hook for GET /api/opencode-free-lane — when the
// lane last raised ANY unavailable-class alert (null = never).
export function getLaneUnavailableAlertAt() {
  const latest = Math.max(laneAlertState.down, laneAlertState.unmapped, laneAlertState.busy);
  return latest ? new Date(latest).toISOString() : null;
}

/** Engine setting per request ("bun" default | "legacy" kill-switch). */
async function getFreeLaneEngine() {
  try {
    const settings = await getSettings();
    return settings?.opencodeFreeLaneEngine === "legacy" ? "legacy" : "bun";
  } catch {
    return "bun"; // settings read failure must not degrade the lane decision
  }
}

function safeParseModel(bodyStr) {
  try {
    return JSON.parse(bodyStr)?.model || null;
  } catch {
    return null;
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      // Console rejects max_output_tokens < 16 ("The number must be `>= 16`") —
      // ZCode's connectivity probe sends maxOutputTokens: 1. Floor instead of
      // forwarding, same as opencode-zen/opencode-go.
      if (body.max_output_tokens !== undefined && body.max_output_tokens < RESPONSES_MIN_OUTPUT_TOKENS) {
        body.max_output_tokens = RESPONSES_MIN_OUTPUT_TOKENS;
      }
      normalizeOpencodeReasoning(model, body);
      ensureResponsesReasoningHeadroom(body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      dropAdaptiveReasoningEffort(body);
      applyFingerprintTools(body, false, { claude: isMessagesModel(model || body?.model) });
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  // The free gate keys on the TLS ClientHello, so a native Node fetch is refused
  // no matter how faithful the body is. Route through the impersonating client
  // on BOTH paths: direct (proxyAwareFetch delegates to `directFetch` when no
  // proxy is configured) and proxied — the bridge flag carries the connection
  // proxy into a proxy-pinned wreq session, because a proxied free-lane request
  // on native fetch hits the TLS gate (upstream #5275). Fail-open only for the
  // direct path: without wreq-js the request still goes out on native fetch
  // instead of erroring here.
  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    const freeLaneFetch = async (url, options, ctx) => {
      const legacy = () => opencodeTlsFetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      }, { signal: options.signal, proxyUrl: ctx?.proxyUrl || null });
      const model = args?.model || (typeof options?.body === "string" ? safeParseModel(options.body) : null);
      const engine = await getFreeLaneEngine();
      if (engine !== "legacy" && model && !isResponsesModel(model) && !isMessagesModel(model)) {
        try {
          const res = await runBunFreeLane(options, ctx, credentials, model);
          // 429 rotation hook (see legacy branch): a real bun-lane 429 means
          // THIS exit identity's quota is spent — rotate exactly as before.
          if (res && res.status === 429 && shouldRotateStableSession(credentials)) {
            evictStableSessionForRotation(credentials);
          }
          return res;
        } catch (e) {
          if (e instanceof OpenCodeFreeLaneUnavailableError || e instanceof OpenCodeFreeLaneUnmappedProxyError || e instanceof OpenCodeFreeLaneBusyError) {
            throw surfaceLaneUnavailable(e); // fail-fast — NO legacy serving
          }
          throw e;
        }
      }
      const res = await legacy();
      // 429 FreeUsageLimitError can be pinned to THIS session id (per-session
      // accounting, see stableSessionId). Rotate it (cooldown-limited) so the
      // identity recovers instead of 429ing until the 2h idle TTL — the flag
      // outlives any single quota window once a session hopped exit IPs.
      if (res && res.status === 429 && shouldRotateStableSession(credentials)) {
        evictStableSessionForRotation(credentials);
      }
      return res;
    };
    freeLaneFetch.proxyBridge = true;
    return super.execute({
      ...args,
      credentials,
      directFetch: freeLaneFetch,
    });
  }

  // Free tier moved from /zen/v1 to /inference/v1 (OpenCode v2); /zen/v1 now
  // answers every free request with 403 FreeTierError.
  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/v1/messages`;
    return `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2 CLI. Upstream needs x-opencode-session-id next to
    // x-opencode-session, and rejects any x-opencode-request (v1 only) with 403.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      // Fork: cloak non-opencode downstream clients with the live CLI UA
      // (v2 shape opencode/latest/<version>/cli, version resolved from the npm
      // registry in opencodeCatalog — no stale hardcode; a pinned v2 fallback
      // lives inside the catalog for the pre-resolve window).
      "User-Agent": isOpencodeDownstream ? downstreamUa : getOpencodeCliUserAgent(),
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
