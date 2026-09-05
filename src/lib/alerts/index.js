/**
 * Alert system entry point: `emitAlert(eventType, payload)` fans a single
 * alert out to every configured channel (Telegram / Discord / generic
 * webhook), each behind its own rate-limited SendQueue.
 *
 * Import-graph safety: emitAlert is called from hot low-level paths, so this
 * module has NO static imports from db/sse/settings — only sibling alert
 * modules and node builtins. The settings layer is loaded lazily via a
 * dynamic `await import("@/lib/localDb")` inside the config refresh, cached
 * for 30s.
 *
 * emitAlert NEVER throws and returns immediately: all async work
 * (config read → dedup → fan-out) runs fire-and-forget.
 */

import os from "node:os";

import { EVENT_TYPES, SEVERITY } from "./eventTypes.js";
import { SendQueue } from "./queue.js";
import { createTelegramSender } from "./telegram.js";
import { createDiscordSender } from "./discord.js";
import { createWebhookSender } from "./webhook.js";

export { EVENT_TYPES, SEVERITY };

const CONFIG_CACHE_TTL_MS = 30_000;
const DEDUP_PRUNE_THRESHOLD = 200;
const DEDUP_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const BODY_MAX_CHARS = 1500;

// Unit tests import this module transitively through hot paths
// (connectionProxy, proxyFetch, xray manager…) — the dynamic settings import
// would then touch the REAL database from inside a test run. Alerts are
// inert under NODE_ENV=test unless the test opts in explicitly (the module's
// own test suite sets ALERTS_ENABLE_IN_TESTS=1).
const ALERTS_INERT =
  process.env.NODE_ENV === "test" && process.env.ALERTS_ENABLE_IN_TESTS !== "1";

/** Module state (singletons, caches) — reset via __resetAlertsForTests(). */
const state = {
  configCache: null, // { settings, fetchedAt }
  dedup: new Map(), // `${eventType}:${dedupKey}` → lastEmit ms
  channels: null, // lazy { telegram, discord, webhook } → { queue }
};

/** Read settings via dynamic import, cached for CONFIG_CACHE_TTL_MS. */
async function getCachedSettings() {
  const now = Date.now();
  if (!state.configCache || now - state.configCache.fetchedAt >= CONFIG_CACHE_TTL_MS) {
    const { getSettings } = await import("@/lib/localDb");
    const settings = (await getSettings()) || {};
    state.configCache = { settings, fetchedAt: now };
  }
  return state.configCache.settings;
}

/** The app's own public host (webhook self-call guard): tunnel/cloud URL if
 *  set, else the machine hostname. Returns "" when unknown. */
async function getOwnHostValue() {
  const settings = await getCachedSettings();
  const publicUrl = settings.cloudUrl || settings.externalTunnelUrl || settings.tunnelUrl || "";
  if (publicUrl) {
    try {
      return new URL(publicUrl).hostname;
    } catch {
      // fall through to machine hostname
    }
  }
  return os.hostname();
}

/** Lazy channel singletons. Senders re-read the CACHED config on every send
 *  (getters, not closed-over values), so config changes propagate per TTL. */
function getChannels() {
  if (!state.channels) {
    const telegramSender = createTelegramSender({
      getBotToken: async () => (await getCachedSettings()).alertsTelegramBotToken || "",
      getChatId: async () => (await getCachedSettings()).alertsTelegramChatId || "",
    });
    const discordSender = createDiscordSender({
      getWebhookUrl: async () => (await getCachedSettings()).alertsDiscordWebhookUrl || "",
    });
    const webhookSender = createWebhookSender({
      getUrl: async () => (await getCachedSettings()).alertsWebhookUrl || "",
      getOwnHost: getOwnHostValue,
    });
    state.channels = {
      telegram: { queue: new SendQueue(telegramSender, { minIntervalMs: 1000 }) },
      discord: { queue: new SendQueue(discordSender, { minIntervalMs: 2000 }) },
      webhook: { queue: new SendQueue(webhookSender, { minIntervalMs: 200 }) },
    };
  }
  return state.channels;
}

/** Clamp a numeric setting; NaN/absent falls back to `fallback`. */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** "all-accounts-locked" → "All accounts locked". */
function prettifyEventType(eventType) {
  const s = String(eventType)
    .replace(/[-_]+/g, " ")
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(eventType);
}

/** Drop dedup entries older than 24h once the map grows past the threshold. */
function pruneDedup(now) {
  for (const [key, entry] of state.dedup) {
    if (now - entry.ts > DEDUP_ENTRY_TTL_MS) state.dedup.delete(key);
  }
}

const SEVERITY_RANK = { [SEVERITY.INFO]: 0, [SEVERITY.WARN]: 1, [SEVERITY.CRITICAL]: 2 };

/**
 * Emit an alert to every configured channel. Fire-and-forget: returns
 * immediately, NEVER throws. Deduplicated per `eventType` + `payload.dedupKey`.
 *
 * @param {string} eventType - one of EVENT_TYPES
 * @param {{ title?: string, body?: string, details?: object, severity?: string, dedupKey?: string }} [payload]
 * @returns {void}
 */
export function emitAlert(eventType, payload = {}) {
  try {
    void _dispatch(eventType, payload).catch(() => {
      // Swallow everything — an alert must never take down the request path.
    });
  } catch {
    // Defensive: even a synchronous bug inside the kick-off must not throw.
  }
}

async function _dispatch(eventType, payload = {}) {
  if (ALERTS_INERT) return;
  const settings = await getCachedSettings();

  // Master gate — before any other work.
  if (settings.alertsEnabled === false) return;

  // Per-type toggle: missing key = enabled (settings layer writes the full map).
  const eventsMap = settings.alertsEvents || {};
  if (eventsMap[eventType] === false) return;

  // quota-near-limit carries its own threshold: the caller passes the raw
  // remainingPct and THIS module owns the settings read (import-graph rule) —
  // only readings at/below alertsQuotaThresholdPct (default 20) alert.
  if (eventType === EVENT_TYPES.QUOTA_NEAR_LIMIT) {
    const threshold = clampNumber(settings.alertsQuotaThresholdPct, 1, 90, 20);
    if (typeof payload.remainingPct === "number" && payload.remainingPct > threshold) return;
  }

  // Dedup window: clamp 1..1440 minutes, default 10. Severity-aware: a
  // higher-severity event pierces the window (a WARN "pool exhausted" must
  // not swallow the CRITICAL "pool errored" for the same pool minutes later).
  const dedupMin = clampNumber(settings.alertsDedupMin, 1, 1440, 10);
  const windowMs = dedupMin * 60_000;
  const dedupKey = `${eventType}:${payload.dedupKey ?? "default"}`;
  const severity = payload.severity ?? SEVERITY.WARN;
  const rank = SEVERITY_RANK[severity] ?? SEVERITY_RANK[SEVERITY.WARN];
  const now = Date.now();
  const lastEmit = state.dedup.get(dedupKey);
  if (lastEmit !== undefined && now - lastEmit.ts < windowMs && rank <= lastEmit.rank) return;
  state.dedup.set(dedupKey, { ts: now, rank });
  if (state.dedup.size > DEDUP_PRUNE_THRESHOLD) pruneDedup(now);

  const message = {
    eventType,
    severity,
    title: payload.title ?? prettifyEventType(eventType),
    body: String(payload.body ?? JSON.stringify(payload.details ?? {})).slice(0, BODY_MAX_CHARS),
    host: os.hostname(),
    timestamp: new Date().toISOString(),
  };

  const channels = getChannels();
  if (settings.alertsTelegramBotToken && settings.alertsTelegramChatId) {
    channels.telegram.queue.enqueue(message);
  }
  if (settings.alertsDiscordWebhookUrl) {
    channels.discord.queue.enqueue(message);
  }
  if (settings.alertsWebhookUrl) {
    channels.webhook.queue.enqueue(message);
  }
}

/**
 * Send a test alert on one channel ("telegram" | "discord" | "webhook").
 * Bypasses dedup and the queue — awaits the actual send.
 *
 * @param {"telegram"|"discord"|"webhook"} channel
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendTestAlert(channel) {
  if (ALERTS_INERT) return { ok: false, error: "alerts inert under NODE_ENV=test" };
  const settings = await getCachedSettings();
  const message = {
    eventType: "test-alert",
    severity: SEVERITY.INFO,
    title: "Test alert",
    body: `This is a test alert from 9router on ${os.hostname()}.`,
    host: os.hostname(),
    timestamp: new Date().toISOString(),
  };
  try {
    let sender;
    if (channel === "telegram") {
      sender = createTelegramSender({
        getBotToken: async () => settings.alertsTelegramBotToken || "",
        getChatId: async () => settings.alertsTelegramChatId || "",
      });
    } else if (channel === "discord") {
      sender = createDiscordSender({
        getWebhookUrl: async () => settings.alertsDiscordWebhookUrl || "",
      });
    } else if (channel === "webhook") {
      sender = createWebhookSender({
        getUrl: async () => settings.alertsWebhookUrl || "",
        getOwnHost: getOwnHostValue,
      });
    } else {
      return { ok: false, error: `unknown channel: ${channel}` };
    }
    await sender(message);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * Reset module state for tests: clears the dedup map, the settings cache,
 * and drops the channel queues (cancelling any in-flight drain timers).
 */
export function __resetAlertsForTests() {
  state.dedup.clear();
  state.configCache = null;
  if (state.channels) {
    for (const channel of Object.values(state.channels)) channel.queue.clear();
  }
  state.channels = null;
}
