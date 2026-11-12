"use client";

// OpenCode free-lane card: engine kill-switch (bun / legacy), concurrency
// cap, and live lane status. Extracted from page.js (VersionPanel precedent)
// when the bun lane (v0.6.81/82) grew its own settings surface.
//
// Notes for operators (rendered inline — the knobs are easy to misread):
//  - bun children cost ~22MB RAM steady (up to ~70MB at spawn peak) EACH;
//    keep the cap <=5 on a ~1GB VPS.
//  - the cap changes apply to NEW requests immediately (no restart).
//  - upstream meters free-tier quota PER EXIT IP: raising the cap buys
//    shorter queues, not more upstream throughput. Scale by adding xray
//    exits, not just concurrency.

import { useEffect, useState, useCallback } from "react";
import { Badge, Button, Card } from "@/shared/components";

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];

export default function FreeLaneCard({ settings, onSaveSetting }) {
  const [lane, setLane] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);

  const fetchLane = useCallback(async () => {
    try {
      const res = await fetch("/api/opencode-free-lane", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setLane(data);
    } catch { /* status is best-effort; settings stays authoritative */ }
  }, []);

  useEffect(() => {
    fetchLane();
    const t = setInterval(fetchLane, 15000);
    return () => clearInterval(t);
  }, [fetchLane]);

  // Prewarm the bun runtime via the idempotent POST route (the installer is
  // single-flight — a double-click or a racing first chat request shares one
  // download). Long on slow links: the button stays disabled until it settles.
  const prewarmBun = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch("/api/opencode-free-lane/prewarm", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (e) {
      setInstallError(e.message);
    } finally {
      setInstalling(false);
      fetchLane();
    }
  }, [fetchLane]);

  const engine = settings?.opencodeFreeLaneEngine || "bun";
  const cap = settings?.opencodeFreeLaneMaxConcurrency ?? 3;
  // include a persisted-but-unlisted value so the select never lies
  const capOptions = CONCURRENCY_OPTIONS.includes(Number(cap))
    ? CONCURRENCY_OPTIONS
    : [...CONCURRENCY_OPTIONS, Number(cap)].sort((a, b) => a - b);

  const bunInstalled = lane ? lane.bun?.installed : null;
  const lastErr = lane?.lane?.lastError;
  const busy = lane?.lane?.busy;
  const maxCap = lane?.lane?.maxConcurrency ?? cap;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">OpenCode free lane</h3>
        <div className="flex items-center gap-2">
          {lane?.snapshot?.clientVersion && (
            <Badge variant="default">wire {lane.snapshot.clientVersion}</Badge>
          )}
          <Badge variant={engine === "legacy" ? "warning" : "success"}>
            {engine === "legacy" ? "legacy engine" : "bun engine"}
          </Badge>
        </div>
      </div>

      <div className="text-sm space-y-3">
        <div className="grid sm:grid-cols-[220px_1fr] gap-3 items-end">
          <div>
            <label className="text-xs text-text-muted block mb-1">Transport engine</label>
            <select
              className="w-full text-sm border border-border rounded px-2 py-2 bg-transparent"
              value={engine}
              onChange={(e) => onSaveSetting("opencodeFreeLaneEngine", e.target.value)}
            >
              <option value="bun">bun (default)</option>
              <option value="legacy">legacy (kill-switch)</option>
            </select>
          </div>
          <div className="text-xs text-text-muted pb-2">
            bun spawns one short-lived Bun child per request with CLI-identical traffic — the only engine the v2 free gate accepts. legacy restores the pre-bun-lane path (wreq-js); the v2 gate refuses it with 429, so use it only to bisect a suspected bun-lane regression.
          </div>
        </div>

        <div className="grid sm:grid-cols-[220px_1fr] gap-3 items-end">
          <div>
            <label className="text-xs text-text-muted block mb-1">Max concurrent children</label>
            <select
              className="w-full text-sm border border-border rounded px-2 py-2 bg-transparent"
              value={String(cap)}
              onChange={(e) => onSaveSetting("opencodeFreeLaneMaxConcurrency", Number(e.target.value))}
            >
              {capOptions.map((n) => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </div>
          <div className="text-xs text-text-muted pb-2">
            Each child costs ~22MB RAM steady (up to ~70MB at spawn peak). Keep 5 or lower on a ~1GB VPS. Applies to new requests immediately — no restart. Extra concurrency shortens queues only: the upstream meters free quota per exit IP, so scale real throughput by adding xray exits, not this number.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          {bunInstalled === null ? (
            <Badge variant="default">lane status…</Badge>
          ) : bunInstalled ? (
            <Badge variant="success">bun {lane?.bun?.version || "installed"}</Badge>
          ) : (
            <Badge variant="warning">bun not installed (downloads on first use)</Badge>
          )}
          {typeof busy === "number" && (
            <Badge variant={busy >= maxCap ? "warning" : "default"}>children {busy}/{maxCap}</Badge>
          )}
          {typeof lane?.lane?.queued === "number" && lane.lane.queued > 0 && (
            <Badge variant="warning">queued {lane.lane.queued}</Badge>
          )}
          {lane?.lastUnavailableAlertAt && (
            <Badge variant="error">unavailable alert {new Date(lane.lastUnavailableAlertAt).toLocaleTimeString()}</Badge>
          )}
          {bunInstalled === false && (
            <Button
              className="text-xs"
              disabled={installing}
              onClick={prewarmBun}
              title="Download and install the pinned Bun runtime now (the lane also self-installs on the first free-model request)"
            >
              {installing ? "Installing bun…" : "Install bun now"}
            </Button>
          )}
        </div>

        {installError && (
          <div className="text-xs text-red-600 dark:text-red-400 break-words">
            Install failed: {installError}
          </div>
        )}

        {lastErr && (
          <div className="text-xs text-text-muted rounded bg-black/5 dark:bg-white/5 p-2 break-words">
            Last lane error: {lastErr}
          </div>
        )}

        {Array.isArray(lane?.lane?.modelsKnownRefused) && lane.lane.modelsKnownRefused.length > 0 && (
          <div className="text-xs text-text-muted">
            Served legacy regardless of engine (v2 gate refuses their wire shape): {lane.lane.modelsKnownRefused.join(", ")}.
          </div>
        )}
      </div>
    </Card>
  );
}