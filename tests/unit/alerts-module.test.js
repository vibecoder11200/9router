import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// This suite tests the REAL alert behavior — override the NODE_ENV=test
// inertness guard (see index.js ALERTS_INERT). vi.hoisted runs BEFORE the
// module graph loads (plain assignments would be hoisted under the imports).
vi.hoisted(() => { process.env.ALERTS_ENABLE_IN_TESTS = "1"; });

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// Mutable settings stand-in — individual tests call setSettings() to change it.
const settingsState = vi.hoisted(() => ({ settings: {} }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...settingsState.settings })),
}));

import {
  emitAlert,
  sendTestAlert,
  __resetAlertsForTests,
  EVENT_TYPES,
  SEVERITY,
} from "@/lib/alerts/index.js";
import { SendQueue } from "@/lib/alerts/queue.js";
import { createTelegramSender } from "@/lib/alerts/telegram.js";
import { createDiscordSender } from "@/lib/alerts/discord.js";
import { createWebhookSender, isPrivateHostname } from "@/lib/alerts/webhook.js";

const realFetch = global.fetch;

function setSettings(overrides = {}) {
  settingsState.settings = {
    alertsEnabled: true,
    alertsDedupMin: 1, // 60s dedup window — short for tests
    alertsEvents: {},
    alertsTelegramBotToken: "",
    alertsTelegramChatId: "",
    alertsDiscordWebhookUrl: "",
    alertsWebhookUrl: "",
    ...overrides,
  };
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({}) };
}

function statusResponse(status, { json = {}, headers = {} } = {}) {
  return { ok: false, status, json: async () => json, headers: new Headers(headers) };
}

function testMessage(overrides = {}) {
  return {
    eventType: "quota-near-limit",
    severity: "warn",
    title: "Quota near limit",
    body: "provider X at 91%",
    host: "test-host",
    timestamp: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

/** Flush microtask chains (dynamic settings import → enqueue → send). */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

let errSpy;

beforeEach(() => {
  vi.useFakeTimers();
  setSettings();
  __resetAlertsForTests();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = realFetch;
  errSpy.mockRestore();
  vi.useRealTimers();
});

describe("alerts module", () => {
  it("re-exports EVENT_TYPES and SEVERITY", () => {
    expect(EVENT_TYPES.ALL_ACCOUNTS_LOCKED).toBe("all-accounts-locked");
    expect(SEVERITY.INFO).toBe("info");
    expect(SEVERITY.WARN).toBe("warn");
    expect(SEVERITY.CRITICAL).toBe("critical");
  });

  // 1. Master gate: alertsEnabled=false → zero fetch calls, no other work.
  it("makes ZERO fetch calls when alertsEnabled is false", async () => {
    setSettings({
      alertsEnabled: false,
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsDiscordWebhookUrl: "https://discord.example/hook",
      alertsWebhookUrl: "https://example.com/hook",
    });
    global.fetch.mockResolvedValue(okResponse());

    expect(() => emitAlert(EVENT_TYPES.BREAKER_OPEN, {})).not.toThrow();
    await vi.runAllTimersAsync();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 2. Per-type toggle: disabled event type is silent, enabled one sends.
  it("suppresses event types disabled in alertsEvents but sends enabled ones", async () => {
    setSettings({
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsEvents: { [EVENT_TYPES.BREAKER_OPEN]: false },
    });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.BREAKER_OPEN, {});
    await flush();
    emitAlert(EVENT_TYPES.ALL_ACCOUNTS_LOCKED, {});
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain("all-accounts-locked");
    expect(body.text).not.toContain("breaker-open");
  });

  // 3. Dedup: same event inside the window → 1 send per channel; outside → sends again.
  it("deduplicates repeated emits within the window and re-sends after it passes", async () => {
    setSettings({
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsDiscordWebhookUrl: "https://discord.example/hook",
      alertsWebhookUrl: "https://example.com/hook",
      alertsDedupMin: 1,
    });
    global.fetch.mockResolvedValue(okResponse());
    const countFor = (substr) =>
      global.fetch.mock.calls.filter(([u]) => String(u).includes(substr)).length;

    emitAlert(EVENT_TYPES.XRAY_NODE_DOWN, {});
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(3);

    emitAlert(EVENT_TYPES.XRAY_NODE_DOWN, {});
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(3); // deduped: exactly 1 send per channel

    await vi.advanceTimersByTimeAsync(61_000); // past the 1-minute window
    emitAlert(EVENT_TYPES.XRAY_NODE_DOWN, {});
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(6);
    expect(countFor("api.telegram.org")).toBe(2);
    expect(countFor("discord.example")).toBe(2);
    expect(countFor("example.com/hook")).toBe(2);
  });

  // 3b. Distinct dedupKeys do not suppress each other.
  it("keys dedup by payload.dedupKey", async () => {
    setSettings({ alertsTelegramBotToken: "T", alertsTelegramChatId: "C" });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.QUOTA_NEAR_LIMIT, { dedupKey: "provider-a" });
    await flush();
    emitAlert(EVENT_TYPES.QUOTA_NEAR_LIMIT, { dedupKey: "provider-b" });
    await flush();
    // Second telegram send waits out the queue's 1000ms pacing interval.
    await vi.advanceTimersByTimeAsync(1000);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // 4. emitAlert never rejects even when every channel's fetch rejects.
  it("never throws when all senders fail", async () => {
    setSettings({
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsDiscordWebhookUrl: "https://discord.example/hook",
      alertsWebhookUrl: "https://example.com/hook",
    });
    global.fetch.mockRejectedValue(new Error("network down"));

    expect(emitAlert(EVENT_TYPES.PROXY_POOL_EXHAUSTED, {})).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(emitAlert(EVENT_TYPES.TOTU_FETCH_FAILED, {})).toBeUndefined();
    await vi.runAllTimersAsync();

    // Each channel retried and eventually dropped — but nothing propagated.
    expect(
      errSpy.mock.calls.some((c) => c[0] === "[alerts] dropped message after 3 tries")
    ).toBe(true);
  });

  // 5. TG 429 with retry_after=2s → retry happens after ≥2000ms.
  it("honors telegram 429 retry_after", async () => {
    const sender = createTelegramSender({
      getBotToken: async () => "T",
      getChatId: async () => "C",
    });
    const q = new SendQueue(sender, { minIntervalMs: 1000 });
    global.fetch
      .mockResolvedValueOnce(statusResponse(429, { json: { parameters: { retry_after: 2 } } }))
      .mockResolvedValue(okResponse());

    q.enqueue(testMessage());
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(global.fetch).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[1][0])).toContain("api.telegram.org");
    expect(q.pending()).toBe(0);
  });

  // 6. Discord 429 with retry-after: 3 header → retry after ≥3000ms
  // (beyond the 1s backoff, so the header is what dominates).
  it("honors discord 429 retry-after header", async () => {
    const sender = createDiscordSender({
      getWebhookUrl: async () => "https://discord.example/hook",
    });
    const q = new SendQueue(sender, { minIntervalMs: 2000 });
    global.fetch
      .mockResolvedValueOnce(statusResponse(429, { headers: { "retry-after": "3" } }))
      .mockResolvedValue(okResponse());

    q.enqueue(testMessage());
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(global.fetch).toHaveBeenCalledTimes(1); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const embedBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(embedBody.embeds).toHaveLength(1);
    expect(embedBody.embeds[0].title).toBe("[9router] quota-near-limit");
    expect(embedBody.content).toBeUndefined(); // no ping-able content field
  });

  // 7. Queue drops after 3 failed tries with console.error.
  it("drops a message after 3 tries and logs via console.error", async () => {
    let calls = 0;
    const sender = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const q = new SendQueue(sender, { minIntervalMs: 0 });

    q.enqueue(testMessage());
    await vi.runAllTimersAsync();

    expect(calls).toBe(3);
    expect(
      errSpy.mock.calls.some((c) => c[0] === "[alerts] dropped message after 3 tries")
    ).toBe(true);
    expect(q.pending()).toBe(0);
  });

  // 7b. Rate limit: minIntervalMs between send STARTS.
  it("paces send starts at least minIntervalMs apart", async () => {
    const sender = vi.fn(async () => {});
    const q = new SendQueue(sender, { minIntervalMs: 1000 });

    q.enqueue(testMessage());
    q.enqueue(testMessage());
    q.enqueue(testMessage());
    await flush();
    expect(sender).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(sender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sender).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(sender).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(q.pending()).toBe(0);
  });

  // 8. Webhook JSON schema (stable, versioned).
  it("sends the versioned webhook payload schema", async () => {
    setSettings({ alertsWebhookUrl: "https://example.com/hook" });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.QUOTA_NEAR_LIMIT, { details: { provider: "x", used: 12 } });
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toBe("https://example.com/hook");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      version: 1,
      eventType: "quota-near-limit",
      severity: "warn",
      host: expect.any(String),
      payload: {
        title: "Quota near limit",
        body: JSON.stringify({ provider: "x", used: 12 }),
      },
    });
    expect(new Date(sent.timestamp).toISOString()).toBe(sent.timestamp); // ISO
  });

  // 9. SSRF posture: loopback/private/own-host URLs blocked without fetch.
  it("blocks localhost, private, and own-host webhook URLs without fetching", async () => {
    const blocked = [
      "http://localhost:9000/hook",
      "http://127.0.0.1:9000/hook",
      "http://[::1]:9000/hook",
      "http://10.1.2.3/hook",
      "http://172.16.5.4/hook",
      "http://172.31.9.9/hook",
      "http://192.168.0.9/hook",
      "http://169.254.169.254/latest/meta-data",
    ];
    for (const url of blocked) {
      const sender = createWebhookSender({ getUrl: async () => url, getOwnHost: async () => null });
      global.fetch.mockClear();
      await expect(sender(testMessage())).rejects.toThrow("webhook URL not allowed");
      expect(global.fetch).not.toHaveBeenCalled();
    }

    // Own public host is blocked too, and the error is marked noRetry.
    const own = createWebhookSender({
      getUrl: async () => "https://myrouter.example/hook",
      getOwnHost: async () => "myrouter.example",
    });
    const err = await own(testMessage()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("webhook URL not allowed");
    expect(err.noRetry).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();

    // A public third-party host still goes through.
    const allowed = createWebhookSender({
      getUrl: async () => "https://hooks.example.com/hook",
      getOwnHost: async () => "myrouter.example",
    });
    global.fetch.mockResolvedValue(okResponse());
    await allowed(testMessage());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("isPrivateHostname classifies ranges correctly", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.8.8.8", "::1", "[::1]", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1"]) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "193.168.1.1", "999.1.1.1", "", null, undefined]) {
      expect(isPrivateHostname(h), String(h)).toBe(false);
    }
  });

  // 10. Redirects: fetched with redirect:"manual", any 3xx is an error.
  it("treats 3xx responses as errors and never follows redirects", async () => {
    const sender = createWebhookSender({
      getUrl: async () => "https://example.com/hook",
      getOwnHost: async () => null,
    });
    global.fetch.mockResolvedValue(statusResponse(302));

    await expect(sender(testMessage())).rejects.toThrow("webhook redirect blocked");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("throws on non-2xx webhook responses", async () => {
    const sender = createWebhookSender({
      getUrl: async () => "https://example.com/hook",
      getOwnHost: async () => null,
    });
    global.fetch.mockResolvedValue(statusResponse(500));
    await expect(sender(testMessage())).rejects.toThrow("500");
  });

  it("throws 'webhook not configured' on empty URL without fetching", async () => {
    const sender = createWebhookSender({ getUrl: async () => "", getOwnHost: async () => null });
    await expect(sender(testMessage())).rejects.toThrow("webhook not configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 11. TG HTML escaping: payload markup is inert.
  it("HTML-escapes payload content in the telegram text", async () => {
    setSettings({ alertsTelegramBotToken: "T", alertsTelegramChatId: "C" });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.STRICTPROXY_VIOLATION, {
      title: "<script>alert(1)</script>",
      body: "a < b & c > d",
    });
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.parse_mode).toBe("HTML");
    expect(sent.disable_web_page_preview).toBe(true);
    expect(sent.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(sent.text).not.toContain("<script>");
    expect(sent.text).toContain("a &lt; b &amp; c &gt; d");
    // Structure: only our own <b>/<code> tags survive unescaped.
    expect(sent.text).toMatch(/^<b>&lt;script&gt;/);
    expect(sent.text).toMatch(/<\/b>\n<code>strictproxy-violation<\/code>\n/);
  });

  // 12. noRetry errors drop immediately without retrying.
  it("drops messages whose error is marked noRetry without retrying", async () => {
    const sender = createWebhookSender({
      getUrl: async () => "http://localhost:9000/hook",
      getOwnHost: async () => null,
    });
    const q = new SendQueue(sender, { minIntervalMs: 200 });

    q.enqueue(testMessage());
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("(noRetry)"))
    ).toBe(true);
    expect(q.pending()).toBe(0);
  });

  // 13. sendTestAlert result shape.
  it("sendTestAlert returns ok:true on 2xx and ok:false with error otherwise", async () => {
    setSettings({
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsWebhookUrl: "https://example.com/hook",
    });

    global.fetch.mockResolvedValueOnce(okResponse());
    const okResult = await sendTestAlert("webhook");
    expect(okResult.ok).toBe(true);
    expect(okResult.error).toBeUndefined();

    global.fetch.mockResolvedValueOnce(statusResponse(500));
    const badResult = await sendTestAlert("webhook");
    expect(badResult.ok).toBe(false);
    expect(badResult.error).toContain("500");

    // Unconfigured channel errors surface instead of throwing.
    setSettings({ alertsWebhookUrl: "" });
    __resetAlertsForTests(); // drop the cached settings
    const unconfigured = await sendTestAlert("discord");
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.error).toBe("discord not configured");

    // Unknown channel name.
    const unknown = await sendTestAlert("pigeon");
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown channel");

    // Telegram happy path uses the Bot API URL and bypasses the queue.
    setSettings({ alertsTelegramBotToken: "T", alertsTelegramChatId: "C" });
    __resetAlertsForTests();
    global.fetch.mockResolvedValueOnce(okResponse());
    const tg = await sendTestAlert("telegram");
    expect(tg.ok).toBe(true);
    expect(String(global.fetch.mock.calls.at(-1)[0])).toContain("api.telegram.org/botT/sendMessage");
  });
});

describe("telegram topic targeting (message_thread_id)", () => {
  // 14. Configured topic → message_thread_id rides the sendMessage body.
  it("sends message_thread_id when a valid topic is configured", async () => {
    setSettings({
      alertsTelegramBotToken: "T",
      alertsTelegramChatId: "C",
      alertsTelegramTopicId: "42",
    });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.QUOTA_NEAR_LIMIT, { remainingPct: 5 });
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.chat_id).toBe("C");
    expect(sent.message_thread_id).toBe(42);
  });

  // 15. No topic (absent/blank) → key omitted entirely, main chat.
  it("omits message_thread_id when no topic is set", async () => {
    setSettings({ alertsTelegramBotToken: "T", alertsTelegramChatId: "C", alertsTelegramTopicId: "" });
    global.fetch.mockResolvedValue(okResponse());

    emitAlert(EVENT_TYPES.QUOTA_NEAR_LIMIT, { remainingPct: 5 });
    await flush();

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(Object.prototype.hasOwnProperty.call(sent, "message_thread_id")).toBe(false);
  });

  // 16. Garbage topic values are dropped, not sent (Bot API would 400).
  it("omits message_thread_id for non-numeric topic values", async () => {
    const sender = createTelegramSender({
      getBotToken: async () => "T",
      getChatId: async () => "C",
      getTopicId: async () => "not-a-number",
    });
    global.fetch.mockResolvedValue(okResponse());
    await sender(testMessage());
    let sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(Object.prototype.hasOwnProperty.call(sent, "message_thread_id")).toBe(false);

    // Legacy callers constructing the sender without getTopicId still work.
    const legacy = createTelegramSender({ getBotToken: async () => "T", getChatId: async () => "C" });
    await legacy(testMessage());
    sent = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(Object.prototype.hasOwnProperty.call(sent, "message_thread_id")).toBe(false);
  });

  // 17. The channel gate ignores topic — token+chatId alone enable Telegram.
  it("still sends without a topic and the test path honors the topic too", async () => {
    setSettings({ alertsTelegramBotToken: "T", alertsTelegramChatId: "C", alertsTelegramTopicId: "7" });
    __resetAlertsForTests();
    global.fetch.mockResolvedValueOnce(okResponse());
    const result = await sendTestAlert("telegram");
    expect(result.ok).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(sent.message_thread_id).toBe(7);
  });
});
