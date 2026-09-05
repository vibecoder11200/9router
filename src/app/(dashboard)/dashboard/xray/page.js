"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function statusVariant(status) {
  if (status === "running") return "success";
  if (status === "starting") return "warning";
  if (status === "error") return "error";
  return "default";
}

function latencyText(ms) {
  if (ms == null) return "—";
  if (ms < 0) return "failed";
  return `${ms} ms`;
}

function latencyVariant(ms) {
  if (ms == null) return "default";
  if (ms < 0) return "error";
  if (ms < 300) return "success";
  if (ms < 800) return "warning";
  return "default";
}

// "2h ago" / "3d ago" / "just now" — used by the per-config model-filter badge.
function formatTimeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Sync interval presets in minutes. 0 = manual-only (scheduler stopped).
// The select also offers "custom" which reveals a number+unit input pair.
const SYNC_INTERVAL_PRESETS = [
  { value: "0", label: "Never (manual only)" },
  { value: "10", label: "Every 10 min" },
  { value: "15", label: "Every 15 min" },
  { value: "30", label: "Every 30 min" },
  { value: "60", label: "Every hour" },
  { value: "180", label: "Every 3 hours" },
  { value: "360", label: "Every 6 hours" },
  { value: "720", label: "Every 12 hours" },
  { value: "1440", label: "Every day" },
  { value: "4320", label: "Every 3 days" },
  { value: "10080", label: "Every week" },
];

const SERVER_PAGE_SIZE = 200;

// Map a raw minute value to either a preset value or "custom".
function intervalToPresetValue(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "0";
  return SYNC_INTERVAL_PRESETS.some((p) => p.value === String(m)) ? String(m) : "custom";
}

// Split a raw minute value into { value, unit } for the custom inputs.
function intervalToCustomParts(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return { value: 30, unit: "minutes" };
  if (m >= 10080 && m % 10080 === 0) return { value: m / 10080, unit: "days" };
  if (m >= 1440 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m >= 60 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

// Convert { value, unit } back into minutes.
function customPartsToMinutes(value, unit) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const factor = unit === "hours" ? 60 : unit === "days" ? 1440 : 1;
  return n * factor;
}

// Human-readable label for the interval badge.
function formatInterval(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "manual only";
  if (m < 60) return `every ${m} min`;
  if (m % 10080 === 0 && m >= 10080) {
    const w = m / 10080;
    return `every ${w} week${w > 1 ? "s" : ""}`;
  }
  if (m % 1440 === 0 && m >= 1440) {
    const d = m / 1440;
    return `every ${d} day${d > 1 ? "s" : ""}`;
  }
  if (m % 60 === 0) {
    const h = m / 60;
    return `every ${h} h`;
  }
  return `every ${m} min`;
}

export default function XrayProxyPage() {
  const [status, setStatus] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [facets, setFacets] = useState({ countries: [], protocols: [] });
  const [configCounts, setConfigCounts] = useState({ active: 0, inactive: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [filter, setFilter] = useState({ protocol: "", country: "", status: "active", healthyOnly: false });
  const [serverPage, setServerPage] = useState(1);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState({ runtime: "", install: "" });
  const [settings, setSettings] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const [modelFilter, setModelFilter] = useState({
    model: "",
    limit: 50,
    all: false,
    prune: false,
    concurrency: 2,
    pauseOnTraffic: true,
    quietMs: 15000,
  });
  const [modelFilterBusy, setModelFilterBusy] = useState(false);
  const [modelFilterResult, setModelFilterResult] = useState(null);
  // True after the user clicks "Stop Filter" until the running job actually
  // winds down (status leaves "running"). Drives the "Stopping..." banner and
  // keeps the button disabled to prevent duplicate stop requests.
  const [stopRequested, setStopRequested] = useState(false);
  const [customInterval, setCustomInterval] = useState({ value: 30, unit: "minutes" });
  // True when the user has picked "Custom…" in the dropdown, regardless of the
  // persisted value. We keep this separate from settings.xraySyncIntervalMin so
  // the custom inputs stay visible while the user is editing them, even before
  // (or without) saving.
  const [customMode, setCustomMode] = useState(false);
  const notify = useNotificationStore();
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/xray/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        // Only use sync.sourceUrl as a fallback if the user hasn't set one.
        setSettings((prev) => ({
          ...prev,
          xraySubscriptionUrl: prev.xraySubscriptionUrl || data.sync?.sourceUrl || "",
        }));
      }
    } catch (e) {
      console.log("status fetch error:", e.message);
    }
  }, []);

  // Load the xray-related settings from /api/settings so toggles reflect
  // persisted state (not just in-memory defaults). Without this, a page
  // refresh would always show toggles as off even though the value was saved.
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({
          ...prev,
          xrayAutoStart: data.xrayAutoStart === true,
          xrayAutoRotate: data.xrayAutoRotate === true,
          xraySyncIntervalMin: data.xraySyncIntervalMin ?? prev.xraySyncIntervalMin ?? 60,
          xrayStaleRetentionDays: data.xrayStaleRetentionDays ?? 7,
          xraySocksPort: data.xraySocksPort ?? prev.xraySocksPort,
          xrayHttpPort: data.xrayHttpPort ?? prev.xrayHttpPort,
          xraySubscriptionUrl: data.xraySubscriptionUrl || prev.xraySubscriptionUrl,
          xrayModelFilterEnabled: data.xrayModelFilterEnabled === true,
          xrayModelFilterModel: data.xrayModelFilterModel || "",
          xrayModelFilterLimit: data.xrayModelFilterLimit ?? 50,
          xrayModelFilterAll: data.xrayModelFilterAll === true,
          xrayModelFilterPrune: data.xrayModelFilterPrune === true,
          xrayModelFilterConcurrency: data.xrayModelFilterConcurrency ?? 2,
          xrayModelFilterPauseOnTraffic: data.xrayModelFilterPauseOnTraffic !== false,
          xrayModelFilterQuietMs: data.xrayModelFilterQuietMs ?? 15000,
        }));
        setModelFilter((prev) => ({
          ...prev,
          model: data.xrayModelFilterModel || prev.model || "",
          limit: data.xrayModelFilterLimit ?? prev.limit ?? 50,
          all: data.xrayModelFilterAll === true,
          prune: data.xrayModelFilterPrune === true,
          concurrency: data.xrayModelFilterConcurrency ?? prev.concurrency ?? 2,
          pauseOnTraffic: data.xrayModelFilterPauseOnTraffic !== false,
          quietMs: data.xrayModelFilterQuietMs ?? prev.quietMs ?? 15000,
        }));
        // Seed the custom interval inputs whenever the persisted value isn't a
        // known preset, so the "Custom…" option shows the right value/unit.
        const intervalMin = data.xraySyncIntervalMin ?? 60;
        if (intervalToPresetValue(intervalMin) === "custom") {
          setCustomInterval(intervalToCustomParts(intervalMin));
        }
      }
    } catch (e) {
      console.log("settings fetch error:", e.message);
    }
  }, []);

  const fetchConfigs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter.protocol) params.set("protocol", filter.protocol);
      if (filter.country) params.set("country", filter.country);
      if (filter.status === "active") params.set("active", "1");
      if (filter.status === "inactive") params.set("active", "0");
      if (filter.healthyOnly) params.set("healthy", "1");
      const res = await fetch(`/api/xray/configs?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setConfigs(data.configs || []);
        setFacets(data.facets || { countries: [], protocols: [] });
        setConfigCounts(data.counts || { active: 0, inactive: 0, total: 0 });
      }
    } catch (e) {
      console.log("configs fetch error:", e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const fetchInitialData = async () => {
      await Promise.all([fetchStatus(), fetchConfigs(), fetchSettings()]);
    };
    fetchInitialData();
  }, [fetchStatus, fetchConfigs, fetchSettings]);

  // Poll status while running so health/latency/filter progress stay fresh.
  useEffect(() => {
    if (status?.status === "running" || status?.modelFilter?.status === "running") {
      pollRef.current = setInterval(fetchStatus, 15000);
      return () => clearInterval(pollRef.current);
    }
  }, [status?.status, status?.modelFilter?.status, fetchStatus]);

  // Clear the "stopping" indicator once the job is no longer running (it has
  // wound down — either fully stopped, errored, or completed).
  useEffect(() => {
    if (status?.modelFilter?.status !== "running") {
      setStopRequested(false);
    }
  }, [status?.modelFilter?.status]);

  const api = async (path, method = "POST", body) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    try {
      notify.info("Downloading Xray binary (~20MB)...");
      await api("/api/xray/install", "POST", {});
      notify.success("Xray binary installed");
      await fetchStatus();
    } catch (e) {
      notify.error(`Install failed: ${e.message}`);
    }
  };

  const handleStart = async (configId) => {
    try {
      await api("/api/xray/start", "POST", configId ? { configId } : {});
      notify.success("Proxy started");
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Start failed: ${e.message}`);
    }
  };

  const handleStop = () => {
    setConfirmState({
      message: "Stop the V2Ray proxy? Provider connections using it will fall back to direct.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api("/api/xray/stop", "POST");
          notify.success("Proxy stopped");
          await fetchStatus();
        } catch (e) {
          notify.error(`Stop failed: ${e.message}`);
        }
      },
    });
  };

  const handleSwitch = async (configId, name) => {
    try {
      notify.info(`Switching to ${name}...`);
      await api("/api/xray/switch", "POST", { configId });
      notify.success(`Switched to ${name}`);
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Switch failed: ${e.message}`);
    }
  };

  const handleTest = async (configId) => {
    setTestingId(configId);
    try {
      const result = await api(`/api/xray/configs/${configId}/test`, "POST");
      if (result.latencyMs >= 0) {
        notify.success(`Latency: ${result.latencyMs} ms${result.exitIp ? ` · exit ${result.exitIp}` : ""}`);
      } else {
        notify.error("Server did not respond (dead or blocked)");
      }
      await fetchConfigs();
    } catch (e) {
      notify.error(`Test failed: ${e.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async () => {
    try {
      notify.info("Syncing subscription from v2go...");
      const result = await api("/api/xray/sync", "POST", {});
      notify.success(`Synced ${result.count} configs${result.stalePruned ? ` · removed ${result.stalePruned} inactive` : ""}${result.autoFilter?.queued ? " · model filter queued" : ""}`);
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Sync failed: ${e.message}`);
    }
  };

  const handleHealthCheck = async () => {
    try {
      const result = await api("/api/xray/health-check", "POST");
      if (result.skipped) {
        notify.info("Proxy not running — nothing to check");
      } else if (result.latencyMs >= 0) {
        notify.success(`Active proxy healthy: ${result.latencyMs} ms`);
      } else {
        notify.error("Active proxy is unreachable");
      }
      await fetchStatus();
    } catch (e) {
      notify.error(`Health check failed: ${e.message}`);
    }
  };

  const runModelFilter = async (opts = {}) => {
    const forceRetest = opts.forceRetest === true;
    const model = modelFilter.model.trim();
    if (!model) {
      notify.error("Model is required");
      return;
    }

    const execute = async () => {
      setModelFilterBusy(true);
      setModelFilterResult(null);
      try {
        notify.info(forceRetest ? `Re-testing all Xray servers with ${model}...` : `Testing Xray servers with ${model}...`);
        const res = await fetch("/api/xray/configs/model-filter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            limit: modelFilter.all ? "all" : (Number(modelFilter.limit) || 50),
            all: modelFilter.all === true,
            prune: modelFilter.prune === true,
            concurrency: Number(modelFilter.concurrency) || 2,
            pauseOnTraffic: modelFilter.pauseOnTraffic === true,
            quietMs: Number(modelFilter.quietMs) || 15000,
            forceRetest,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setModelFilterResult(data);
        const cachedNote = data.cached ? ` · ${data.cached} cached` : "";
        if (data.cancelled) {
          notify.info(`Filter stopped: ${data.passed}/${data.tested} tested before stop. Re-run to resume from where it stopped.`);
        } else if (data.skipped) {
          notify.info("A filter run is already in progress.");
        } else {
          notify.success(`Model filter done: ${data.passed}/${data.tested} usable${data.pruned ? ` · removed ${data.pruned}` : ""}${cachedNote}`);
        }
        await fetchConfigs();
        await fetchStatus();
      } catch (e) {
        notify.error(`Model filter failed: ${e.message}`);
      } finally {
        setModelFilterBusy(false);
      }
    };

    if (modelFilter.prune) {
      setConfirmState({
        message: `Test ${modelFilter.all ? "all active" : `up to ${modelFilter.limit || 50}`} V2Ray servers with "${model}" and permanently delete every failing config?`,
        onConfirm: async () => {
          setConfirmState(null);
          await execute();
        },
      });
      return;
    }

    await execute();
  };

  // Request a cooperative stop of the running model filter. The job winds
  // down after current probes finish; already-tested servers are kept in the
  // DB, so re-running resumes from where it stopped. No separate "Resume"
  // button is needed — "Run Filter Now" after a stop IS the resume.
  const handleStopModelFilter = async () => {
    if (stopRequested) return;
    setStopRequested(true);
    try {
      const res = await fetch("/api/xray/configs/model-filter/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify.info(data.message || "Stop requested. The filter will wind down shortly.");
      // Refresh now for immediate feedback; the in-flight runModelFilter POST
      // resolves (and refreshes again) once the job actually stops.
      await fetchStatus();
    } catch (e) {
      setStopRequested(false);
      notify.error(`Stop failed: ${e.message}`);
    }
  };

  // Clear cached model-filter results (all models). Next filter run re-probes
  // everything fresh.
  const handleClearCache = () => {
    setConfirmState({
      message: "Clear all cached filter results? Servers will be re-tested on the next filter run.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch("/api/xray/configs/model-filter/clear-cache", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          notify.success(`Cleared ${data.cleared} cached result${data.cleared === 1 ? "" : "s"}`);
          await fetchStatus();
          await fetchConfigs();
        } catch (e) {
          notify.error(`Clear cache failed: ${e.message}`);
        }
      },
    });
  };

  const handleSaveSetting = async (key, value) => {
    // Optimistic update: toggle reflects immediately.
    const previousValue = settings[key];
    setSettings((s) => ({ ...s, [key]: value }));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify.success("Setting saved");
      // Re-read from server to confirm persistence.
      await fetchSettings();
    } catch (e) {
      // Revert on failure.
      setSettings((s) => ({ ...s, [key]: previousValue }));
      notify.error(`Save failed: ${e.message}`);
    }
  };

  // Persist the sync interval. Accepts either a preset value ("0", "60", ...)
  // or the literal string "custom" — in which case the customInterval state is
  // converted to minutes. The backend clamps to [0] ∪ [5, ∞).
  const handleSaveSyncInterval = (presetValue) => {
    let minutes;
    if (presetValue === "custom") {
      minutes = customPartsToMinutes(customInterval.value, customInterval.unit);
    } else {
      minutes = Number(presetValue) || 0;
    }
    handleSaveSetting("xraySyncIntervalMin", minutes);
  };

  const saveModelFilterSettings = async (extra = {}) => {
    const { xrayModelFilterEnabled, ...filterExtra } = extra;
    const next = { ...modelFilter, ...filterExtra };
    const payload = {
      xrayModelFilterEnabled: xrayModelFilterEnabled ?? settings.xrayModelFilterEnabled === true,
      xrayModelFilterModel: next.model.trim(),
      xrayModelFilterLimit: Math.max(1, Math.min(Number(next.limit) || 50, 500)),
      xrayModelFilterAll: next.all === true,
      xrayModelFilterPrune: next.prune === true,
      xrayModelFilterConcurrency: Math.max(1, Math.min(Number(next.concurrency) || 2, 16)),
      xrayModelFilterPauseOnTraffic: next.pauseOnTraffic === true,
      xrayModelFilterQuietMs: Math.max(3000, Math.min(Number(next.quietMs) || 15000, 120000)),
    };
    setSettings((s) => ({ ...s, ...payload }));
    setModelFilter(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify.success("Model filter settings saved");
      await fetchSettings();
    } catch (e) {
      notify.error(`Save failed: ${e.message}`);
      await fetchSettings();
    }
  };

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/xray/logs?lines=200", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setLogs(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (showLogs) {
      const fetchInitialLogs = async () => {
        await fetchLogs();
      };
      fetchInitialLogs();
      const t = setInterval(fetchLogs, 3000);
      return () => clearInterval(t);
    }
  }, [showLogs, fetchLogs]);

  if (loading || !status) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">V2Ray Proxy</h1>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const activeConfig = configs.find((c) => c.id === status.activeConfigId);
  const runningModelFilter = status.modelFilter?.status === "running";
  const modelFilterTrafficWaiters = status.modelFilter?.trafficWaiters || 0;
  const modelFilterLiveTraffic = status.modelFilter?.liveTraffic?.active || 0;
  const serverTotalPages = Math.max(1, Math.ceil(configs.length / SERVER_PAGE_SIZE));
  const safeServerPage = Math.min(serverPage, serverTotalPages);
  const serverPageStart = (safeServerPage - 1) * SERVER_PAGE_SIZE;
  const serverPageEnd = Math.min(serverPageStart + SERVER_PAGE_SIZE, configs.length);
  const pagedConfigs = configs.slice(serverPageStart, serverPageEnd);
  const jumpToServerPage = (value) => {
    const page = Math.floor(Number(value));
    if (!Number.isFinite(page)) return;
    setServerPage(Math.max(1, Math.min(serverTotalPages, page)));
  };
  const visibleModelFilterResult = modelFilterResult || (
    status.modelFilter?.status && status.modelFilter.status !== "idle"
      ? status.modelFilter
      : null
  );

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">V2Ray Proxy</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Managed local proxy powered by v2go configs + Xray-core
          </p>
        </div>
        <Badge variant={statusVariant(status.status)}>{status.status}</Badge>
      </div>

      {/* Quick-start guide */}
      {!status.binaryInstalled || status.status !== "running" ? (
        <Card className="p-4 border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20">
          <div className="text-sm space-y-1.5">
            <div className="font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">lightbulb</span>
              How to use this proxy
            </div>
            <ol className="list-decimal list-inside space-y-1 text-zinc-600 dark:text-zinc-300 ml-1">
              {!status.binaryInstalled && (
                <li><strong>Install</strong> the Xray binary (one-time, ~20MB download)</li>
              )}
              <li><strong>Sync</strong> configs from v2go (auto-runs {formatInterval(settings.xraySyncIntervalMin ?? 60)} after first sync — configure below)</li>
              <li><strong>Start</strong> the proxy — a SOCKS5 proxy opens on <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">127.0.0.1:10808</code></li>
              <li>Go to <Link href="/dashboard/providers" className="text-blue-600 hover:underline font-medium">Providers</Link>, pick a connection, and assign the <strong>“V2Ray Proxy (v2go)”</strong> pool — requests to that provider now route through the proxy</li>
            </ol>
            <div className="text-xs text-zinc-500 mt-2">
              The proxy auto-creates a pool in <Link href="/dashboard/proxy-pools" className="text-blue-600 hover:underline">Proxy Pools</Link> when running. Switch servers any time; auto-rotate if enabled.
            </div>
          </div>
        </Card>
      ) : null}

      {/* Status card */}
      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Binary</div>
            {status.binaryInstalled ? (
              <Badge variant="success">Installed v{status.installedVersion}</Badge>
            ) : (
              <Badge variant="error">Not installed</Badge>
            )}
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">SOCKS Port</div>
            <div className="font-mono">{status.socksPort ? `127.0.0.1:${status.socksPort}` : "—"}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">PID</div>
            <div className="font-mono">{status.pid || "—"}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Latency</div>
            {status.lastHealth ? (
              <Badge variant={latencyVariant(status.lastHealth.latencyMs)}>
                {latencyText(status.lastHealth.latencyMs)}
              </Badge>
            ) : (
              <span className="text-zinc-400">—</span>
            )}
          </div>
        </div>

        {activeConfig && (
          <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3">
            <span className="text-zinc-500 dark:text-zinc-400">Active server: </span>
            <span className="font-medium">{activeConfig.name}</span>
            {status.lastHealth?.exitIp && (
              <span className="text-zinc-500 ml-2">· exit {status.lastHealth.exitIp}</span>
            )}
          </div>
        )}

        {status.lastError && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg p-3">
            {status.lastError}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!status.binaryInstalled ? (
            <Button onClick={handleInstall} disabled={busy}>Install Xray Binary</Button>
          ) : status.status === "running" ? (
            <>
              <Button variant="secondary" onClick={() => handleStart()} disabled={busy}>Restart</Button>
              <Button variant="danger" onClick={handleStop} disabled={busy}>Stop</Button>
              <Button variant="ghost" onClick={handleHealthCheck} disabled={busy}>Health Check</Button>
            </>
          ) : (
            <Button onClick={() => handleStart()} disabled={busy}>Start Proxy</Button>
          )}
          <Button variant="ghost" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? "Hide Logs" : "View Logs"}
          </Button>
          <a href="/dashboard/proxy-pools" className="text-sm text-blue-600 hover:underline self-center ml-auto">
            Manage in Proxy Pools →
          </a>
        </div>
      </Card>

      {/* Log viewer */}
      {showLogs && (
        <Card className="p-4">
          <pre className="text-xs font-mono whitespace-pre-wrap max-h-64 overflow-auto text-zinc-600 dark:text-zinc-300">
            {logs.runtime || "(no logs yet)"}
          </pre>
        </Card>
      )}

      {/* Sync card */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Subscription Sync</h2>
          <Badge>auto-update {formatInterval(settings.xraySyncIntervalMin ?? 60)}</Badge>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Last sync</div>
            <div>{formatDateTime(status.sync?.lastSyncAt)}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Configs</div>
            <div>{status.sync?.lastSyncCount ?? 0}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Total syncs</div>
            <div>{status.sync?.totalSyncRuns ?? 0}</div>
          </div>
        </div>
        {status.sync?.lastSyncError && (
          <div className="text-sm text-amber-600 dark:text-amber-400">
            Last error: {status.sync.lastSyncError}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-zinc-500 block mb-1">Subscription URL</label>
            <Input
              value={settings.xraySubscriptionUrl || ""}
              onChange={(e) => setSettings((s) => ({ ...s, xraySubscriptionUrl: e.target.value }))}
              placeholder="https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt"
            />
          </div>
          <Button variant="ghost" onClick={() => handleSaveSetting("xraySubscriptionUrl", settings.xraySubscriptionUrl)} disabled={busy}>
            Save
          </Button>
          <Button onClick={handleSync} disabled={busy}>Sync Now</Button>
        </div>
        <div className="grid sm:grid-cols-[220px_1fr] gap-3 items-end text-sm">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Keep inactive servers</label>
            <select
              className="w-full text-sm border rounded px-2 py-2 bg-transparent"
              value={String(settings.xrayStaleRetentionDays ?? 7)}
              onChange={(e) => {
                const value = Number(e.target.value);
                setSettings((s) => ({ ...s, xrayStaleRetentionDays: value }));
                handleSaveSetting("xrayStaleRetentionDays", value);
              }}
            >
              <option value="7">7 days</option>
              <option value="1">24 hours</option>
              <option value="0">Delete after sync</option>
              <option value="-1">Forever</option>
            </select>
          </div>
          <div className="text-xs text-zinc-500 pb-2">
            Sync marks missing servers inactive first, then this setting decides when inactive rows are deleted.
          </div>
        </div>
        <div className="grid sm:grid-cols-[220px_1fr] gap-3 items-end text-sm">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Auto-sync interval</label>
            <select
              className="w-full text-sm border rounded px-2 py-2 bg-transparent"
              value={(() => {
                if (customMode) return "custom";
                const preset = intervalToPresetValue(settings.xraySyncIntervalMin ?? 60);
                return preset; // either a known preset or "custom" (value not in list)
              })()}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  // Seed the custom inputs from the current value, then reveal them.
                  setCustomInterval(intervalToCustomParts(settings.xraySyncIntervalMin ?? 60));
                  setCustomMode(true);
                  return;
                }
                setCustomMode(false);
                handleSaveSyncInterval(e.target.value);
              }}
            >
              {SYNC_INTERVAL_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
              <option value="custom">
                Custom…{!customMode && intervalToPresetValue(settings.xraySyncIntervalMin ?? 60) === "custom"
                  ? ` (${formatInterval(settings.xraySyncIntervalMin)})`
                  : ""}
              </option>
            </select>
          </div>
          <div className="text-xs text-zinc-500 pb-2">
            How often the subscription is re-fetched automatically. Choose “Never” for manual-only syncs.
          </div>
        </div>
        {(customMode || intervalToPresetValue(settings.xraySyncIntervalMin ?? 60) === "custom") && (
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Custom interval</label>
              <Input
                type="number"
                min={1}
                className="w-28"
                value={customInterval.value}
                onChange={(e) => setCustomInterval((c) => ({ ...c, value: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Unit</label>
              <select
                className="text-sm border rounded px-2 py-2 bg-transparent"
                value={customInterval.unit}
                onChange={(e) => setCustomInterval((c) => ({ ...c, unit: e.target.value }))}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
            <Button
              variant="ghost"
              onClick={() => handleSaveSyncInterval("custom")}
              disabled={busy}
            >
              Save
            </Button>
            <div className="text-xs text-zinc-500 pb-2">
              Minimum 5 minutes. Equivalent to {formatInterval(customPartsToMinutes(customInterval.value, customInterval.unit))}.
            </div>
          </div>
        )}
      </Card>

      {/* Settings card */}
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Settings</h2>
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between">
            <span>Auto-start on boot</span>
            <Toggle
              checked={settings.xrayAutoStart === true}
              onChange={(v) => { setSettings((s) => ({ ...s, xrayAutoStart: v })); handleSaveSetting("xrayAutoStart", v); }}
            />
          </label>
          <label className="flex items-center justify-between">
            <span>Auto-rotate when active server dies</span>
            <Toggle
              checked={settings.xrayAutoRotate === true}
              onChange={(v) => { setSettings((s) => ({ ...s, xrayAutoRotate: v })); handleSaveSetting("xrayAutoRotate", v); }}
            />
          </label>
        </div>
      </Card>

      {/* Model-aware filtering */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold">Model Proxy Filter</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Test Xray IPs against a real routed model request, then optionally delete failing configs.
            </p>
          </div>
          {visibleModelFilterResult && (
            <Badge variant={visibleModelFilterResult.status === "running" ? "warning" : visibleModelFilterResult.cancelled || visibleModelFilterResult.failed > 0 ? "warning" : "success"}>
              {visibleModelFilterResult.status === "running"
                ? `${visibleModelFilterResult.tested || 0} tested${visibleModelFilterResult.cached ? ` · ${visibleModelFilterResult.cached} cached` : ""}...`
                : `${visibleModelFilterResult.cancelled ? "Stopped · " : ""}${visibleModelFilterResult.passed}/${visibleModelFilterResult.tested} usable${visibleModelFilterResult.cached ? ` · ${visibleModelFilterResult.cached} cached` : ""}`}
            </Badge>
          )}
        </div>

        {(() => {
          const cache = status?.modelFilter?.cache;
          const total = cache?.total || 0;
          if (!total) return null;
          const modelKey = modelFilter.model.trim();
          const modelCount = modelKey ? (cache.byModel?.[modelKey] || 0) : 0;
          return (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 -mt-1">
              Cache: {total} result{total === 1 ? "" : "s"}
              {modelCount ? ` · ${modelCount} for current model (skipped until sync)` : ""}
            </div>
          );
        })()}

        <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm">
          <div>
            <div className="font-medium">Auto-filter after subscription sync</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Off by default. When enabled, each successful v2go sync runs this filter with the saved settings.
            </div>
          </div>
          <Toggle
            checked={settings.xrayModelFilterEnabled === true}
            onChange={(v) => saveModelFilterSettings({ xrayModelFilterEnabled: v })}
          />
        </div>

        <div className="grid md:grid-cols-[1fr_120px_120px_auto] gap-2 items-end">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Model</label>
            <Input
              value={modelFilter.model}
              onChange={(e) => setModelFilter((s) => ({ ...s, model: e.target.value }))}
              placeholder="oc/deepseek-v4-flash-free"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Limit</label>
            <Input
              type="number"
              min="1"
              max="500"
              value={modelFilter.limit}
              disabled={modelFilter.all}
              onChange={(e) => setModelFilter((s) => ({ ...s, limit: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Threads</label>
            <Input
              type="number"
              min="1"
              max="16"
              value={modelFilter.concurrency}
              onChange={(e) => setModelFilter((s) => ({ ...s, concurrency: e.target.value }))}
            />
          </div>
          <Button variant="ghost" onClick={() => saveModelFilterSettings()} disabled={busy}>
            Save
          </Button>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={modelFilter.all}
              onChange={(e) => setModelFilter((s) => ({ ...s, all: e.target.checked }))}
            />
            Check all active configs
          </label>
          <label className="text-sm flex items-center gap-2 h-10">
            <input
              type="checkbox"
              checked={modelFilter.prune}
              onChange={(e) => setModelFilter((s) => ({ ...s, prune: e.target.checked }))}
            />
            Delete failures
          </label>
          <label className="text-sm flex items-center gap-2 h-10">
            <input
              type="checkbox"
              checked={modelFilter.pauseOnTraffic}
              onChange={(e) => saveModelFilterSettings({ pauseOnTraffic: e.target.checked })}
            />
            Pause while live traffic is active
          </label>
          <span className="text-xs text-zinc-500 self-center">
            Recommended threads: 2. Turn pause off only when you want filtering to run continuously.
          </span>
        </div>

        {modelFilter.pauseOnTraffic && (
          <div className="grid md:grid-cols-[160px_1fr] gap-2 items-end text-sm">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Quiet window (ms)</label>
              <Input
                type="number"
                min="3000"
                max="120000"
                value={modelFilter.quietMs}
                onChange={(e) => setModelFilter((s) => ({ ...s, quietMs: e.target.value }))}
              />
            </div>
            <div className="text-xs text-zinc-500 pb-2">
              Filtering resumes after live model traffic has been quiet for this long.
            </div>
          </div>
        )}

        {runningModelFilter && (
          <div className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 p-3">
            {stopRequested
              ? <>Stopping — finishing current probes, then the filter will wind down. </>
              : <>Filtering {status.modelFilter.all ? "all active configs" : `up to ${status.modelFilter.limit}`} with {status.modelFilter.concurrency || 2} threads:{" "}</>
            }
            {!stopRequested && <>{status.modelFilter.tested || 0} tested, {status.modelFilter.passed || 0} usable, {status.modelFilter.failed || 0} failed{status.modelFilter.cached ? `, ${status.modelFilter.cached} cached` : ""}.</>}
            {!stopRequested && status.modelFilter.pauseOnTraffic ? " Pauses when live traffic is active." : ""}
            {!stopRequested && modelFilterTrafficWaiters > 0
              ? ` Waiting for live traffic to go quiet (${modelFilterLiveTraffic} active request${modelFilterLiveTraffic === 1 ? "" : "s"}).`
              : ""}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {runningModelFilter && (
            <Button
              variant="danger"
              onClick={handleStopModelFilter}
              disabled={stopRequested}
              title="Stop after the current probes finish. Already-tested servers are kept; re-running resumes from where it stopped."
            >
              {stopRequested ? "Stopping..." : "Stop Filter"}
            </Button>
          )}
          <Button onClick={() => runModelFilter()} disabled={modelFilterBusy || runningModelFilter || busy || !status.binaryInstalled}>
            {modelFilterBusy || runningModelFilter ? "Testing..." : "Run Filter Now"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => runModelFilter({ forceRetest: true })}
            disabled={modelFilterBusy || runningModelFilter || busy || !status.binaryInstalled}
            title="Wipe cached results for this model and re-probe every selected server"
          >
            {modelFilterBusy || runningModelFilter ? "Testing..." : "Force Re-test All"}
          </Button>
          <Button
            variant="ghost"
            onClick={handleClearCache}
            disabled={modelFilterBusy || runningModelFilter || busy}
            title="Clear cached results for all models (next run re-tests everything)"
          >
            Clear Cache
          </Button>
        </div>

        {modelFilterResult?.results?.length > 0 && (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-xs">
              <thead className="text-left text-zinc-500 dark:text-zinc-400 border-b">
                <tr>
                  <th className="py-2 px-3">Server</th>
                  <th className="py-2 px-3">Country</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Latency</th>
                  <th className="py-2 px-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {modelFilterResult.results.slice(0, 25).map((r) => (
                  <tr key={r.configId} className="border-b last:border-0">
                    <td className="py-2 px-3 max-w-xs truncate">{r.name || r.host || r.configId}</td>
                    <td className="py-2 px-3">{r.country || "—"}</td>
                    <td className="py-2 px-3">
                      <Badge variant={r.ok ? "success" : "error"}>{r.ok ? "usable" : "failed"}</Badge>
                    </td>
                    <td className="py-2 px-3">{latencyText(r.latencyMs)}</td>
                    <td className="py-2 px-3 max-w-sm truncate">{r.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {modelFilterResult.results.length > 25 && (
              <div className="text-center py-2 text-xs text-zinc-500">
                Showing first 25 of {modelFilterResult.results.length} results.
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Server list */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-semibold">Servers ({configs.length})</h2>
            <div className="text-xs text-zinc-500 mt-1">
              Active {configCounts.active || 0} · Inactive {configCounts.inactive || 0} · Total {configCounts.total || 0}
              {configs.length > 0 ? ` · Showing ${serverPageStart + 1}-${serverPageEnd}` : ""}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.status}
              onChange={(e) => {
                setServerPage(1);
                setFilter((f) => ({ ...f, status: e.target.value, country: "", protocol: "" }));
              }}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.protocol}
              onChange={(e) => {
                setServerPage(1);
                setFilter((f) => ({ ...f, protocol: e.target.value }));
              }}
            >
              <option value="">All protocols</option>
              {facets.protocols.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.country}
              onChange={(e) => {
                setServerPage(1);
                setFilter((f) => ({ ...f, country: e.target.value }));
              }}
            >
              <option value="">All countries</option>
              {facets.countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="text-sm flex items-center gap-1">
              <input
                type="checkbox"
                checked={filter.healthyOnly}
                onChange={(e) => {
                  setServerPage(1);
                  setFilter((f) => ({ ...f, healthyOnly: e.target.checked }));
                }}
              />
              Healthy only
            </label>
          </div>
        </div>

        {configs.length > SERVER_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="text-xs text-zinc-500">
              Page {safeServerPage} of {serverTotalPages} · {SERVER_PAGE_SIZE} servers per page
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setServerPage((page) => Math.max(1, page - 1))}
                disabled={safeServerPage <= 1}
              >
                Previous
              </Button>
              <div className="flex items-center gap-1">
                <Input
                  key={`server-page-top-${safeServerPage}-${serverTotalPages}`}
                  type="number"
                  min="1"
                  max={serverTotalPages}
                  defaultValue={safeServerPage}
                  className="w-20 h-8 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") jumpToServerPage(e.currentTarget.value);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    const input = e.currentTarget.parentElement?.querySelector("input");
                    jumpToServerPage(input?.value);
                  }}
                >
                  Go
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setServerPage((page) => Math.min(serverTotalPages, page + 1))}
                disabled={safeServerPage >= serverTotalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500 dark:text-zinc-400 border-b">
              <tr>
                <th className="py-2 pr-3">Server</th>
                <th className="py-2 px-3">Protocol</th>
                <th className="py-2 px-3">Country</th>
                <th className="py-2 px-3">Endpoint</th>
                <th className="py-2 px-3">Latency</th>
                <th className="py-2 pl-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedConfigs.map((c) => (
                <tr key={c.id} className={`border-b last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${c.isActive === false ? "opacity-60" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      {c.isSelected && <span className="w-2 h-2 rounded-full bg-green-500" title="active" />}
                      <span className="truncate max-w-xs">{c.name || c.host}</span>
                      {c.isActive === false && <Badge>inactive</Badge>}
                      {c.modelFilterResult ? (
                        <Badge variant={c.modelFilterResult.ok ? "success" : "error"} title={`Last model probe: ${c.modelFilterResult.ok ? "usable" : "failed"}${c.modelFilterResult.latencyMs != null && c.modelFilterResult.latencyMs >= 0 ? ` · ${c.modelFilterResult.latencyMs}ms` : ""}`}>
                          {c.modelFilterResult.ok ? "✓" : "✗"} {formatTimeAgo(c.modelFilterResult.testedAt)}
                        </Badge>
                      ) : (
                        <Badge title="Not yet probed against the current filter model">untested</Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-3"><Badge>{c.protocol?.toUpperCase()}</Badge></td>
                  <td className="py-2 px-3">{c.country || "—"}</td>
                  <td className="py-2 px-3 font-mono text-xs">{c.host}:{c.port}</td>
                  <td className="py-2 px-3">
                    <Badge variant={latencyVariant(c.lastLatencyMs)}>{latencyText(c.lastLatencyMs)}</Badge>
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <div className="flex gap-1 justify-end">
                      {!c.isSelected && c.isActive !== false && (
                        <Button size="sm" variant="ghost" onClick={() => handleSwitch(c.id, c.name)} disabled={busy}>
                          Select
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleTest(c.id)}
                        disabled={testingId === c.id || busy || c.isActive === false}
                      >
                        {testingId === c.id ? "..." : "Test"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {configs.length === 0 && (
            <div className="text-center py-8 text-zinc-500">
              No {filter.status === "all" ? "" : `${filter.status} `}configs found. Click <strong>Sync Now</strong> to fetch from v2go.
            </div>
          )}
          {configs.length > 200 && (
            <div className="flex items-center justify-center gap-3 py-3 text-xs text-zinc-500">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setServerPage((page) => Math.max(1, page - 1))}
                disabled={safeServerPage <= 1}
              >
                Previous
              </Button>
              <span>Showing {serverPageStart + 1}-{serverPageEnd} of {configs.length}</span>
              <div className="flex items-center gap-1">
                <Input
                  key={`server-page-bottom-${safeServerPage}-${serverTotalPages}`}
                  type="number"
                  min="1"
                  max={serverTotalPages}
                  defaultValue={safeServerPage}
                  className="w-20 h-8 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") jumpToServerPage(e.currentTarget.value);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    const input = e.currentTarget.parentElement?.querySelector("input");
                    jumpToServerPage(input?.value);
                  }}
                >
                  Go
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setServerPage((page) => Math.min(serverTotalPages, page + 1))}
                disabled={safeServerPage >= serverTotalPages}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </Card>

      <ConfirmModal
        isOpen={!!confirmState}
        message={confirmState?.message}
        onConfirm={confirmState?.onConfirm}
        onClose={() => setConfirmState(null)}
      />
    </div>
  );
}
