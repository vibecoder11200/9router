"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input, Toggle } from "@/shared/components";

// Alert settings page (phase 05). Credential values are masked server-side:
// the API returns *Configured booleans; leaving a credential field blank on
// save keeps the stored value (oidcClientSecret convention).
const EVENT_LABELS = {
  "all-accounts-locked": "All accounts locked",
  "breaker-open": "Circuit breaker opened",
  "breaker-recovered": "Circuit breaker recovered",
  "proxy-pool-exhausted": "Proxy pool exhausted",
  "strictproxy-violation": "Strict proxy violation",
  "quota-near-limit": "Quota near limit",
  "budget-threshold": "API-key budget threshold",
  "xray-node-down": "Xray node down",
  "xray-rotation-failed": "Xray rotation failed",
  "totu-fetch-failed": "TOTU auto-fetch failed",
};

export default function AlertsClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { type: "ok"|"err", text }
  const [enabled, setEnabled] = useState(false);
  const [dedupMin, setDedupMin] = useState(10);
  const [quotaThresholdPct, setQuotaThresholdPct] = useState(20);
  const [events, setEvents] = useState({});
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgTopicId, setTgTopicId] = useState("");
  const [discordUrl, setDiscordUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [configured, setConfigured] = useState({ telegram: false, discord: false, webhook: false });
  const [testing, setTesting] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        if (cancelled) return;
        setEnabled(data.alertsEnabled === true);
        setDedupMin(data.alertsDedupMin ?? 10);
        setQuotaThresholdPct(data.alertsQuotaThresholdPct ?? 20);
        setEvents({ ...(data.alertsEvents || {}) });
        setTgChatId(data.alertsTelegramChatId || "");
        setTgTopicId(data.alertsTelegramTopicId || "");
        setConfigured({
          telegram: Boolean(data.alertsTelegramConfigured),
          discord: Boolean(data.alertsDiscordConfigured),
          webhook: Boolean(data.alertsWebhookConfigured),
        });
      } catch {
        if (!cancelled) setMessage({ type: "err", text: "Failed to load settings" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const body = {
        alertsEnabled: enabled,
        alertsDedupMin: Number(dedupMin) || 10,
        alertsQuotaThresholdPct: Number(quotaThresholdPct) || 20,
        alertsEvents: Object.fromEntries(
          Object.entries(EVENT_LABELS).map(([key]) => [key, events[key] !== false])
        ),
      };
      // Blank credential inputs keep the stored values (server convention).
      if (tgToken.trim()) body.alertsTelegramBotToken = tgToken.trim();
      if (tgChatId.trim()) body.alertsTelegramChatId = tgChatId.trim();
      // Topic is NOT a credential: always sent so blank CLEARS it (back to the
      // group's main chat).
      body.alertsTelegramTopicId = tgTopicId.trim();
      if (discordUrl.trim()) body.alertsDiscordWebhookUrl = discordUrl.trim();
      if (webhookUrl.trim()) body.alertsWebhookUrl = webhookUrl.trim();

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json())?.error || `HTTP ${res.status}`);
      const data = await res.json();
      setConfigured({
        telegram: Boolean(data.alertsTelegramConfigured),
        discord: Boolean(data.alertsDiscordConfigured),
        webhook: Boolean(data.alertsWebhookConfigured),
      });
      setTgToken("");
      setDiscordUrl("");
      setWebhookUrl("");
      setMessage({ type: "ok", text: "Alert settings saved" });
    } catch (e) {
      setMessage({ type: "err", text: e.message || "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(channel) {
    setTesting(channel);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/alerts/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMessage({ type: "ok", text: `Test alert sent to ${channel}` });
    } catch (e) {
      setMessage({ type: "err", text: `${channel}: ${e.message || "send failed"}` });
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Alerts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Get notified on Telegram, Discord, or a generic webhook when things break.
        </p>
      </div>

      <Card className="p-5 space-y-5">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={setEnabled} />
          <div>
            <p className="font-medium text-sm">Enable alerts</p>
            <p className="text-xs text-muted-foreground">Master switch — no alerts are sent while off.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">Dedup window (minutes)</label>
            <Input type="number" min={1} max={1440} value={dedupMin} onChange={(e) => setDedupMin(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">Repeated identical events within this window send once (1-1440).</p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Quota alert threshold (%)</label>
            <Input type="number" min={1} max={90} value={quotaThresholdPct} onChange={(e) => setQuotaThresholdPct(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">Fire “quota near limit” when remaining % is at or below this.</p>
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-5">
        <h2 className="font-semibold">Channels</h2>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">Telegram</p>
            <Button variant="ghost" size="sm" disabled={!enabled || testing === "telegram"} onClick={() => handleTest("telegram")}>
              {testing === "telegram" ? "Sending…" : configured.telegram ? "Send test" : "Configure first"}
            </Button>
          </div>
          <Input type="password" placeholder={configured.telegram ? "Bot token (saved — leave blank to keep)" : "Bot token"} value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
          <Input type="text" placeholder="Chat ID" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} />
          <div>
            <Input type="text" inputMode="numeric" placeholder="Topic ID (optional)" value={tgTopicId} onChange={(e) => setTgTopicId(e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">
              For forum groups only — alerts post into that topic. Copy a message link inside the topic (looks like …/TOPIC/123) to find the number. Blank posts to the group&apos;s main chat.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">Discord</p>
            <Button variant="ghost" size="sm" disabled={!enabled || testing === "discord"} onClick={() => handleTest("discord")}>
              {testing === "discord" ? "Sending…" : configured.discord ? "Send test" : "Configure first"}
            </Button>
          </div>
          <Input type="password" placeholder={configured.discord ? "Webhook URL (saved — leave blank to keep)" : "https://discord.com/api/webhooks/…"} value={discordUrl} onChange={(e) => setDiscordUrl(e.target.value)} />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">Generic webhook</p>
            <Button variant="ghost" size="sm" disabled={!enabled || testing === "webhook"} onClick={() => handleTest("webhook")}>
              {testing === "webhook" ? "Sending…" : configured.webhook ? "Send test" : "Configure first"}
            </Button>
          </div>
          <Input type="password" placeholder={configured.webhook ? "Webhook URL (saved — leave blank to keep)" : "https://example.com/hook"} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
          <p className="text-xs text-muted-foreground">Receives JSON <code>{"{version:1, eventType, timestamp, host, payload}"}</code>. Private/loopback/own-host URLs are blocked.</p>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Events</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(EVENT_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center gap-3">
              <Toggle
                checked={events[key] !== false}
                onChange={(v) => setEvents((prev) => ({ ...prev, [key]: v }))}
              />
              <p className="text-sm">{label}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Breaker, budget, and rotation events become active as those features land.
        </p>
      </Card>

      {message && (
        <p className={`text-sm ${message.type === "ok" ? "text-green-500" : "text-red-500"}`}>{message.text}</p>
      )}

      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save alert settings"}
      </Button>
    </div>
  );
}
