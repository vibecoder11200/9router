/**
 * OpenCode v2 free-lane wire snapshot.
 *
 * The v2 free-tier gate fingerprints the CLI's TLS/HTTP stack AND the wire
 * shape: a byte-identical replay passes under Bun (BoringSSL) and is refused
 * under Node, and P0 proved the minimal accepted system composition (harness
 * + Code Mode tool guidance + fork-minted env — the bare harness alone is
 * gate-refused). This module is the single runtime source of that proven wire
 * shape: a committed, scrubbed snapshot extracted from the v2.2.7 live capture
 * (see scripts/extract-opencode-wire.mjs), rendered per request and sent
 * through the Bun stdio lane (services/opencodeBunLane.js).
 *
 * Snapshot lifecycle (detect-only sync): the embedded JSON is never written at
 * runtime. A 24h tick compares the upstream CLI feed version against
 * clientVersion and ALERTS on drift — a fork release must regenerate the
 * snapshot via scripts/extract-opencode-wire.mjs. No runtime write channel
 * exists, closing the prompt-injection supply chain (plan SEC-2).
 */
import snapshotJson from "./opencodeWire.snapshot.json";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";
import { dbg } from "../utils/debugLog.js";
// Re-export the executor's session minting (do not re-implement). Function
// declarations are hoisted, so this is cycle-safe with the executor's own
// import of this module.
import { generateSessionId } from "../executors/opencode.js";

const SYNC_URL = "https://opencode.ai/update/api/latest/cli/npm";
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_TIMEOUT_MS = 10_000;
const SHA_RE = /^[0-9a-f]{40}$/;

/** All placeholders the snapshot template may carry; render hard-fails on any leftover. */
const TEMPLATE_MARKERS = ["{{MODEL_NAME}}", "{{MODEL_ID}}", "{{DATE_UTC}}", "{{CWD}}", "{{PLATFORM}}"];

// Module state (test-resettable).
const state = {
  syncStarted: false,
  syncTimer: null,
  syncFetch: null, // injectable fetch for tests
  syncInFlight: false,
};

/**
 * CLI display name for a model id (e.g. "deepseek-v4.1-flash-free" →
 * "Deepseek V4.1 Flash"). The exact rendering is irrelevant to the gate
 * (P0 proved a derived name passes); it only needs the CLI's section shape.
 */
export function deriveModelDisplayName(modelId) {
  const parts = String(modelId || "")
    .replace(/-free$/, "")
    .split("-")
    .filter(Boolean);
  if (!parts.length) return "";
  return parts
    .map((w) => (w.match(/^\d/) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** UTC date rendered in the CLI's "Today's date" format ("Thu Nov 12 2026"). */
function formatDateUtc(d) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/**
 * The committed snapshot. Lazily starts the detect-only sync on the executor
 * path (idempotent, unref'd timer — no boot-path change).
 */
export function getEmbeddedWireSnapshot() {
  startWireSnapshotSync();
  return snapshotJson;
}

/**
 * Render the snapshot's system-text template. Fills every known marker and
 * HARD-FAILS on any leftover "{{" — an unknown placeholder means the
 * extraction was buggy and literal markers must never ship upstream.
 */
export function renderSystemText(snapshot, env = {}) {
  const modelId = env.modelId || "";
  const text = String(snapshot.systemTextTemplate || "")
    .replaceAll("{{MODEL_NAME}}", env.modelName || deriveModelDisplayName(modelId))
    .replaceAll("{{MODEL_ID}}", modelId)
    .replaceAll("{{DATE_UTC}}", formatDateUtc(env.date || new Date()))
    .replaceAll("{{CWD}}", env.cwd || "/workspace")
    .replaceAll("{{PLATFORM}}", env.platform || "linux");
  if (text.includes("{{")) {
    throw new Error("opencodeWire: unrendered placeholder left in system text — extraction bug");
  }
  return text;
}

/**
 * Shape a caller chat-completions body into the v2 CLI wire shape:
 * rendered harness system first (caller system dropped — the CLI sends
 * exactly one system message), snapshot tool manifest + caller tools deduped
 * by name, streaming + usage, caller token cap preserved with the CLI's
 * 32000 default.
 */
export function shapeV2FreeLaneRequestBody(body, snapshot, env = {}) {
  const toolsByName = new Map(snapshot.tools.map((t) => [t.function?.name, t]));
  for (const t of body.tools || []) {
    const name = t?.function?.name;
    if (name && !toolsByName.has(name)) toolsByName.set(name, t);
  }
  return {
    model: body.model,
    messages: [
      { role: "system", content: renderSystemText(snapshot, env) },
      ...(body.messages || []).filter((m) => m.role !== "system"),
    ],
    tools: [...toolsByName.values()],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: body.max_completion_tokens || body.max_tokens || 32000,
  };
}

/**
 * v2 CLI identity headers from the snapshot (per capture ground truth):
 * Bearer public, CLI UA, client cli, project from the snapshot, four equal
 * session headers. NO accept header — the CLI does not send one.
 */
export function mintV2IdentityHeaders(snapshot, sessionId) {
  return {
    authorization: "Bearer public",
    "content-type": "application/json",
    "user-agent": `opencode/latest/${snapshot.clientVersion}/cli`,
    "x-opencode-client": "cli",
    "x-opencode-project": snapshot.xOpencodeProject || "global",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
  };
}

/** Fresh CLI-shaped session id (re-export of the executor's minting). */
export function mintV2SessionId() {
  return generateSessionId();
}

// ---------------------------------------------------------------------------
// Detect-only snapshot sync
// ---------------------------------------------------------------------------

/** One sync tick: compare the upstream CLI feed against the snapshot version. */
async function syncTick({ fetchFn = state.syncFetch || fetch, onDrift } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetchFn(SYNC_URL, { signal: controller.signal });
    const data = await res.json();
    const latest = data?.version;
    const sha = data?.sha;
    // SEC-2: never trust a crafted value into any runtime action — the sha is
    // only surfaced in the alert payload, and only a well-formed sha at that.
    if (!latest || typeof latest !== "string") {
      dbg("[opencodeWire] sync feed missing version — skipping drift check");
      return { drifted: false };
    }
    const current = getEmbeddedWireSnapshot().clientVersion;
    if (latest !== current) {
      (onDrift || defaultDrift)({ current, latest, sha: SHA_RE.test(sha || "") ? sha : undefined });
      return { drifted: true };
    }
    return { drifted: false };
  } catch (err) {
    dbg("[opencodeWire] snapshot sync failed (logged only, no alert):", err?.message || err);
    return { drifted: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function defaultDrift(payload) {
  emitAlert(EVENT_TYPES.OPENCODE_WIRE_DRIFT, {
    severity: SEVERITY.WARN,
    title: "OpenCode wire snapshot drift",
    body: `Upstream CLI ${payload.latest} ≠ snapshot ${payload.current} — a fork release must regenerate the snapshot (scripts/extract-opencode-wire.mjs).`,
    details: { ...payload, note: "fork release required: run scripts/extract-opencode-wire.mjs" },
    dedupKey: `wire-drift:${payload.latest}`,
  });
}

/** Start the detect-only 24h sync (idempotent, unref'd — never blocks boot). */
export function startWireSnapshotSync() {
  if (state.syncStarted) return;
  state.syncStarted = true;
  const timer = setInterval(() => {
    void syncTick().catch(() => {});
  }, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  state.syncTimer = timer;
}

/** Test hooks: reset state, inject fetch, run one tick synchronously. */
export const __test__ = {
  reset() {
    if (state.syncTimer) clearInterval(state.syncTimer);
    state.syncStarted = false;
    state.syncTimer = null;
    state.syncFetch = null;
    state.syncInFlight = false;
  },
  injectFetch(fn) {
    state.syncFetch = fn;
  },
  async runTick() {
    return syncTick();
  },
};
