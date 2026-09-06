/**
 * Telegram sender factory. Builds a Telegram HTML message from the common
 * alert message shape and POSTs it to the Bot API. Throws on failure so the
 * SendQueue can retry/drop; 429 responses surface `.retryAfterMs`.
 */

/** Escape Telegram-HTML special chars (& first so entities can't nest). */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * @param {{ getBotToken: () => Promise<string>, getChatId: () => Promise<string>, getTopicId?: () => Promise<string> }} deps
 *   Async getters — settings may not be loaded yet at construction time.
 *   getTopicId is optional; a positive-integer value targets a forum topic
 *   inside the group chat (message_thread_id), anything else posts to the
 *   group's main chat as before.
 * @returns {(message: { eventType: string, severity: string, title: string, body: string, host: string, timestamp: string }) => Promise<void>}
 */
export function createTelegramSender({ getBotToken, getChatId, getTopicId }) {
  return async function telegramSend(message) {
    const botToken = await getBotToken();
    const chatId = await getChatId();
    if (!botToken || !chatId) {
      throw new Error("telegram not configured");
    }

    // Only <b>/<code> tags we construct ourselves are allowed in the text;
    // everything operator/payload-sourced is HTML-escaped.
    const text =
      `<b>${escapeHtml(message.title)}</b>\n` +
      `<code>${escapeHtml(message.eventType)}</code>\n` +
      escapeHtml(message.body);

    const rawTopic = getTopicId ? String((await getTopicId()) || "").trim() : "";
    const topicId = /^\d+$/.test(rawTopic) ? Number(rawTopic) : 0;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(topicId > 0 ? { message_thread_id: topicId } : {}),
      }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => null);
      const retryAfterSec = Number(data && data.parameters && data.parameters.retry_after) || 0;
      const err = new Error(`telegram 429 rate limited (retry_after=${retryAfterSec}s)`);
      err.retryAfterMs = retryAfterSec * 1000;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`telegram send failed: HTTP ${res.status}`);
    }
  };
}
