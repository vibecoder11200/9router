"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Modal, Badge, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// DeepSeek Web management, rendered on the provider detail page.
// Owns: sidecar install/start/stop, DeepSeek-account pool, available models,
// and the auto-managed caller key. Powered by the ds2api sidecar (invisible).

// Poll cadence for the live concurrency/queue display. Each tick fires up to 6
// admin requests against the sidecar, so keep this modest and pause entirely
// while the tab is hidden (see useEffect below) to avoid needlessly hammering
// the engine.
const POLL_MS = 15000;

export default function Ds2apiManager() {
  const { copied, copy } = useCopyToClipboard();
  const [info, setInfo] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [showManaged, setShowManaged] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", loginType: "email", identifier: "", password: "", token: "", proxyId: "" });
  const [queue, setQueue] = useState(null);
  const [runtime, setRuntime] = useState(null); // {account_max_inflight, account_max_queue, global_max_inflight, token_refresh_interval_hours}
  const [rtDraft, setRtDraft] = useState(null);
  const [savingRt, setSavingRt] = useState(false);
  const [rtError, setRtError] = useState("");
  const [cif, setCif] = useState(null); // current_input_file {enabled, min_chars}
  const [cifDraft, setCifDraft] = useState(null);
  const [savingCif, setSavingCif] = useState(false);
  const [cifError, setCifError] = useState("");
  const [proxies, setProxies] = useState([]);
  const [proxyForm, setProxyForm] = useState({ name: "", type: "socks5", host: "", port: "", username: "", password: "" });
  const [proxyError, setProxyError] = useState("");
  const [proxyTests, setProxyTests] = useState({}); // { [id]: { ok, msg, time } }
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchDefaultType, setBatchDefaultType] = useState("socks5");
  const [batchBusy, setBatchBusy] = useState(false);
  const [proxyGroups, setProxyGroups] = useState([]);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupForm, setGroupForm] = useState({ id: "", name: "", strategy: "round-robin", sticky: "1", proxy_ids: [] });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/ds2api/info", { headers: { "Cache-Control": "no-store" } });
      const data = await res.json();
      setInfo(data);
      if (data.running) {
        setAccountsLoading(true);
        const accRes = await fetch("/api/ds2api/accounts", { headers: { "Cache-Control": "no-store" } });
        if (accRes.ok) setAccounts((await accRes.json()).items || []);
        setModelsLoading(true);
        const modRes = await fetch("/api/ds2api/models", { headers: { "Cache-Control": "no-store" } });
        if (modRes.ok) setModels((await modRes.json()).models || []);
        // live concurrency + runtime config
        const [qRes, sRes] = await Promise.all([
          fetch("/api/ds2api/queue", { headers: { "Cache-Control": "no-store" } }),
          fetch("/api/ds2api/settings", { headers: { "Cache-Control": "no-store" } }),
        ]);
        if (qRes.ok) setQueue(await qRes.json());
        const pxRes = await fetch("/api/ds2api/proxies", { headers: { "Cache-Control": "no-store" } });
        if (pxRes.ok) setProxies((await pxRes.json()).items || []);
        const pgRes = await fetch("/api/ds2api/proxy-groups", { headers: { "Cache-Control": "no-store" } });
        if (pgRes.ok) setProxyGroups((await pgRes.json()).items || []);
        if (sRes.ok) {
          const s = await sRes.json();
          const rt = s.runtime || {};
          setRuntime(rt);
          setRtDraft((prev) => prev && Object.keys(prev).length ? prev : {
            account_max_inflight: String(rt.account_max_inflight ?? ""),
            account_max_queue: String(rt.account_max_queue ?? ""),
            global_max_inflight: String(rt.global_max_inflight ?? ""),
            token_refresh_interval_hours: String(rt.token_refresh_interval_hours ?? ""),
          });
          const cifVal = { enabled: s.current_input_file?.enabled !== false, min_chars: Number(s.current_input_file?.min_chars ?? 0) || 0 };
          setCif(cifVal);
          setCifDraft((prev) => prev && Object.keys(prev).length ? prev : { enabled: cifVal.enabled, min_chars: String(cifVal.min_chars) });
        }
      } else {
        setAccounts([]);
        setModels([]);
        setQueue(null);
        setRuntime(null);
        setCif(null);
        setCifDraft(null);
        setProxies([]);
        setProxyGroups([]);
      }
    } catch {
      /* ignore poll errors */
    } finally {
      setAccountsLoading(false);
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Skip the periodic refresh while the tab is hidden so an open-but-unwatched
    // panel doesn't generate steady background traffic against the sidecar.
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    };
    const id = setInterval(tick, POLL_MS);
    const onVisibility = () => { if (typeof document === "undefined" || !document.hidden) refresh(); };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function call(action, path, opts = {}) {
    setBusy(action);
    setError("");
    try {
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.detail || `Failed (${res.status})`);
      await refresh();
      return data;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy("");
    }
  }

  const install = () => call("install", "/api/ds2api/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  // Update re-downloads the engine (force) and safely cycles a running engine
  // through stop → reinstall → restart. The orchestration lives in the backend
  // route so the frontend doesn't have to sequence multiple calls itself.
  const update = () => call("update", "/api/ds2api/update", { method: "POST" }).catch(() => {});
  const start = () => call("start", "/api/ds2api/start", { method: "POST" }).catch(() => {});
  const stop = () => call("stop", "/api/ds2api/stop", { method: "POST" }).catch(() => {});
  const testAll = () => call("testAll", "/api/ds2api/accounts/test-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  const clearSessions = () => call("clearSessions", "/api/ds2api/sessions", { method: "DELETE" }).catch(() => {});

  async function addProxy(e) {
    e?.preventDefault?.();
    setProxyError("");
    try {
      const p = {
        name: form_proxyName() || `${proxyForm.type}://${proxyForm.host}:${proxyForm.port}`,
        type: proxyForm.type,
        host: proxyForm.host.trim(),
        port: Number(proxyForm.port) || 0,
        username: proxyForm.username.trim(),
        password: proxyForm.password,
      };
      if (!p.host || !p.port) throw new Error("Host and port are required");
      await call("addProxy", "/api/ds2api/proxies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
      setProxyForm({ name: "", type: "socks5", host: "", port: "", username: "", password: "" });
    } catch (e2) {
      setProxyError(e2.message);
    }
  }
  // small alias so the inline addProxy builds a default name from host/port
  function form_proxyName() { return proxyForm.name.trim(); }

  async function deleteProxy(id) {
    call(`delProxy-${id}`, "/api/ds2api/proxies", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  }

  async function testProxy(id) {
    setProxyTests((t) => ({ ...t, [id]: { loading: true } }));
    try {
      const res = await fetch("/api/ds2api/proxies/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxy_id: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.detail || `Failed (${res.status})`);
      setProxyTests((t) => ({
        ...t,
        [id]: { ok: data.success, msg: data.message, time: data.response_time },
      }));
    } catch (e) {
      setProxyTests((t) => ({ ...t, [id]: { ok: false, msg: e.message } }));
    }
  }

  // Parse a single proxy line into ds2api field shape {type,host,port,username,password}.
  // Accepts: protocol://user:pass@host:port | host:port:user:pass | host:port
  function parseProxyLine(line, fallbackType) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      if (!parsed.hostname || !parsed.port) throw new Error("Invalid URL: missing host/port");
      const scheme = parsed.protocol.replace(":", "").toLowerCase();
      const type = ["http", "https", "socks5", "socks5h"].includes(scheme) ? scheme : fallbackType;
      return { type, host: parsed.hostname, port: Number(parsed.port) || 0, username: decodeURIComponent(parsed.username || ""), password: decodeURIComponent(parsed.password || "") };
    }
    const parts = trimmed.split(":");
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      if (!host || !port) throw new Error("Invalid host:port:user:pass");
      return { type: fallbackType, host, port: Number(port) || 0, username, password };
    }
    if (parts.length === 2) {
      const [host, port] = parts;
      if (!host || !port) throw new Error("Invalid host:port");
      return { type: fallbackType, host, port: Number(port) || 0, username: "", password: "" };
    }
    throw new Error("Unsupported format");
  }

  async function handleBatchImport() {
    const lines = batchText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { setProxyError("Paste at least one proxy line."); return; }

    const parsed = [];
    const invalid = [];
    lines.forEach((line, i) => {
      try { const p = parseProxyLine(line, batchDefaultType); if (p) parsed.push({ ...p, line: i + 1 }); }
      catch (e) { invalid.push(`Line ${i + 1}: ${e.message}`); }
    });
    if (invalid.length) { setProxyError(invalid.join("\n")); return; }

    setProxyError("");
    setBatchBusy(true);
    const existingKeys = new Set(proxies.map((p) => `${p.type}|${p.host}|${p.port}|${p.username}`));
    let created = 0, skipped = 0, failed = 0;
    for (const p of parsed) {
      const key = `${p.type}|${p.host}|${p.port}|${p.username}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      try {
        const res = await fetch("/api/ds2api/proxies", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${p.type}://${p.host}:${p.port}`, ...p }),
        });
        if (res.ok) { created++; existingKeys.add(key); } else { failed++; }
      } catch { failed++; }
    }
    await refresh();
    setBatchBusy(false);
    setShowBatchImport(false);
    setBatchText("");
    setError("");
    setProxyError(created || skipped ? `Imported: ${created} added, ${skipped} skipped${failed ? `, ${failed} failed` : ""}` : `Import failed: ${failed} lines`);
  }

  async function addAccount(e) {
    e.preventDefault();
    const base = form.loginType === "token"
      ? { name: form.name, token: form.token }
      : { name: form.name, [form.loginType]: form.identifier, password: form.password };
    const acc = form.proxyId ? { ...base, proxy_id: form.proxyId } : base;
    try {
      await call("add", "/api/ds2api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(acc) });
      setAddOpen(false);
      setForm({ name: "", loginType: "email", identifier: "", password: "", token: "", proxyId: "" });
    } catch { /* error shown */ }
  }

  async function deleteAccount(identifier) {
    if (!confirm(`Remove account ${identifier}?`)) return;
    call("del", `/api/ds2api/accounts/${encodeURIComponent(identifier)}`, { method: "DELETE" }).catch(() => {});
  }

  // Apply a full proxy config to an account: mode (none|fixed|group) plus the
  // bound proxy_id (fixed) or proxy_group_id (group). The route accepts the
  // legacy { proxy_id } shape too, but sending { mode, ... } lets the engine
  // switch strategies without ambiguity.
  async function setAccountProxyConfig(identifier, { mode, proxyId, groupId }) {
    call(`px-${identifier}`, `/api/ds2api/accounts/${encodeURIComponent(identifier)}/proxy`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, proxy_id: proxyId || "", proxy_group_id: groupId || "" }),
    }).catch(() => {});
  }

  async function saveGroup(e) {
    e?.preventDefault?.();
    setProxyError("");
    const g = {
      ...(groupForm.id ? { id: groupForm.id } : {}),
      name: groupForm.name.trim(),
      strategy: groupForm.strategy,
      sticky: groupForm.strategy === "round-robin" ? (Number(groupForm.sticky) || 1) : 0,
      proxy_ids: groupForm.proxy_ids,
    };
    if (!g.name) { setProxyError("Group name is required"); return; }
    if (!g.proxy_ids.length) { setProxyError("Select at least one proxy"); return; }
    try {
      const path = "/api/ds2api/proxy-groups";
      const method = g.id ? "PUT" : "POST";
      const url = g.id ? `${path}/${encodeURIComponent(g.id)}` : path;
      await call(g.id ? "upGroup" : "addGroup", url, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(g),
      });
      setShowGroupModal(false);
      setGroupForm({ id: "", name: "", strategy: "round-robin", sticky: "1", proxy_ids: [] });
    } catch (e2) {
      setProxyError(e2.message);
    }
  }

  async function deleteGroup(id) {
    if (!confirm("Delete this proxy group? Accounts using it will fall back to direct/no proxy.")) return;
    call(`delGroup-${id}`, `/api/ds2api/proxy-groups/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  async function testAccount(identifier) {
    call(`test-${identifier}`, "/api/ds2api/accounts/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier }),
    }).catch(() => {});
  }

  async function saveRuntime(e) {
    e?.preventDefault?.();
    setSavingRt(true);
    setRtError("");
    try {
      const num = (v) => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
      const payload = {
        account_max_inflight: num(rtDraft.account_max_inflight),
        account_max_queue: num(rtDraft.account_max_queue),
        global_max_inflight: num(rtDraft.global_max_inflight),
        token_refresh_interval_hours: num(rtDraft.token_refresh_interval_hours),
      };
      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
      const res = await fetch("/api/ds2api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.success) throw new Error(data.detail || data.error || `Failed (${res.status})`);
      const rt = data.runtime || payload;
      setRuntime(rt);
      setRtDraft({
        account_max_inflight: String(rt.account_max_inflight ?? ""),
        account_max_queue: String(rt.account_max_queue ?? ""),
        global_max_inflight: String(rt.global_max_inflight ?? ""),
        token_refresh_interval_hours: String(rt.token_refresh_interval_hours ?? ""),
      });
    } catch (e2) {
      setRtError(e2.message);
    } finally {
      setSavingRt(false);
    }
  }

  // current_input_file: when enabled, ds2api uploads the full context as a file to
  // DeepSeek (helps long contexts) but the upload can fail on some accounts → 500.
  // Expose a toggle so users can disable it for reliability.
  async function saveCif(next) {
    const enabled = next?.enabled ?? cifDraft?.enabled;
    const minChars = next?.min_chars ?? cifDraft?.min_chars;
    setCifDraft({ enabled, min_chars: String(minChars) });
    setSavingCif(true);
    setCifError("");
    try {
      const payload = { enabled: !!enabled, min_chars: parseInt(String(minChars), 10) || 0 };
      const res = await fetch("/api/ds2api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_input_file: payload }),
      });
      const data = await res.json().catch(() => ({}));
      // ds2api echoes current_input_file in the response on some versions; else trust payload.
      const out = data.current_input_file || payload;
      const val = { enabled: out.enabled !== false, min_chars: Number(out.min_chars ?? 0) || 0 };
      setCif(val);
      setCifDraft({ enabled: val.enabled, min_chars: String(val.min_chars) });
      if (!res.ok && data.success === false) throw new Error(data.detail || data.error || `Failed (${res.status})`);
    } catch (e) {
      setCifError(e.message);
    } finally {
      setSavingCif(false);
    }
  }

  const install_ = info?.install || {};
  const running = !!info?.running;
  const managedKey = info?.managedKeyPresent ? info?.managedKey : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Sidecar status & control */}
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">cloud</span>
            <h2 className="text-lg font-semibold">DeepSeek Web engine</h2>
            <Badge variant={running ? "success" : install_.installed ? "warning" : "default"}>
              {running ? "Running" : install_.installed ? "Stopped" : "Not installed"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {!install_.installed && (
              <Button size="sm" onClick={install} disabled={!!busy}>{busy === "install" ? "Installing…" : "Install"}</Button>
            )}
            {install_.installed && !install_.upToDate && (
              <Button size="sm" onClick={update} disabled={!!busy}>{busy === "update" ? "Updating…" : "Update"}</Button>
            )}
            {install_.installed && !running && (
              <Button size="sm" onClick={start} disabled={!!busy}>{busy === "start" ? "Starting…" : "Start"}</Button>
            )}
            {running && (
              <Button size="sm" variant="ghost" onClick={stop} disabled={!!busy}>{busy === "stop" ? "Stopping…" : "Stop"}</Button>
            )}
          </div>
        </div>
        <p className="text-sm text-text-muted mt-2">
          {install_.installed
            ? <>Engine version {install_.version}{install_.upToDate ? "" : <span className="text-warning"> — update available ({install_.expectedVersion})</span>}</>
            : "Click Install to download the engine for this platform (no Go toolchain needed)."}
        </p>
        <p className="text-xs text-text-muted mt-1">
          Add at least one DeepSeek account below — the engine routes your requests through it to DeepSeek&apos;s web interface.
        </p>
        {error && <p className="text-sm text-warning mt-2">{error}</p>}
      </Card>

      {/* DeepSeek accounts */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined">group</span>
            DeepSeek accounts
          </h2>
          {running && (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={clearSessions} disabled={!!busy} title="Drop remote DeepSeek sessions so ds2api opens fresh ones">Clear sessions</Button>
              <Button size="sm" variant="ghost" onClick={testAll} disabled={!!busy}>Test all</Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>Add account</Button>
            </div>
          )}
        </div>
        {!running ? (
          <p className="text-sm text-text-muted">Start the engine to manage accounts.</p>
        ) : accountsLoading && !accounts.length ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-text-muted">No accounts yet. Add a DeepSeek account (email/mobile + password, or a token) to start using DeepSeek models.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {accounts.map((a) => (
              <div key={a.identifier} className="flex items-center gap-2 py-1.5 border-b border-border/50 flex-wrap">
                <span className={`w-2 h-2 rounded-full ${
                  a.test_status === "ok" || a.test_status === "success" ? "bg-success"
                  : a.test_status ? "bg-warning" : "bg-text-muted/40"
                }`} title={a.test_status || "not tested"} />
                <span className="text-sm font-mono flex-1 min-w-[120px] truncate">{a.identifier}</span>
                {a.name && <span className="text-xs text-text-muted truncate">{a.name}</span>}
                {(proxies.length > 0 || proxyGroups.length > 0) && (() => {
                  // Resolve the account's effective proxy mode. Legacy accounts
                  // with a ProxyID but no mode read back as "fixed".
                  const mode = a.proxy_mode || (a.proxy_id ? "fixed" : "none");
                  return (
                    <>
                      <select
                        value={mode}
                        onChange={(e) => {
                          const m = e.target.value;
                          if (m === "none") setAccountProxyConfig(a.identifier, { mode: "none" });
                          else if (m === "fixed") {
                            const first = proxies[0]?.id || "";
                            setAccountProxyConfig(a.identifier, { mode: "fixed", proxyId: first });
                          } else if (m === "group") {
                            const first = proxyGroups[0]?.id || "";
                            setAccountProxyConfig(a.identifier, { mode: "group", groupId: first });
                          }
                        }}
                        disabled={!!busy}
                        title="Proxy mode for this account"
                        className="text-xs rounded border border-border bg-transparent px-1.5 py-1"
                      >
                        <option value="none">direct</option>
                        <option value="fixed">fixed</option>
                        <option value="group">group</option>
                      </select>
                      {mode === "fixed" && (
                        <select
                          value={a.proxy_id || ""}
                          onChange={(e) => setAccountProxyConfig(a.identifier, { mode: "fixed", proxyId: e.target.value })}
                          disabled={!!busy}
                          title="Fixed proxy for this account"
                          className="text-xs rounded border border-border bg-transparent px-1.5 py-1 max-w-[180px]"
                        >
                          <option value="">no proxy</option>
                          {proxies.map((p) => (
                            <option key={p.id} value={p.id}>{p.type}://{p.host}:{p.port}</option>
                          ))}
                        </select>
                      )}
                      {mode === "group" && (
                        <select
                          value={a.proxy_group_id || ""}
                          onChange={(e) => setAccountProxyConfig(a.identifier, { mode: "group", groupId: e.target.value })}
                          disabled={!!busy}
                          title="Proxy group for this account"
                          className="text-xs rounded border border-border bg-transparent px-1.5 py-1 max-w-[180px]"
                        >
                          <option value="">no group</option>
                          {proxyGroups.map((g) => (
                            <option key={g.id} value={g.id}>{g.name} ({g.strategy})</option>
                          ))}
                        </select>
                      )}
                    </>
                  );
                })()}
                <Button size="sm" variant="ghost" onClick={() => testAccount(a.identifier)} disabled={!!busy}>Test</Button>
                <Button size="sm" variant="ghost" onClick={() => deleteAccount(a.identifier)} disabled={!!busy}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Proxies (per-account) */}
      {running && (
        <Card>
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined">vpn_lock</span>
              Proxies
            </h2>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowBatchImport(true)} icon="playlist_add">Batch import</Button>
              <Button size="sm" variant="ghost" onClick={() => { setGroupForm({ id: "", name: "", strategy: "round-robin", sticky: "1", proxy_ids: [] }); setShowGroupModal(true); }} icon="shuffle">New group</Button>
            </div>
          </div>
          <p className="text-sm text-text-muted mb-3">Assign a proxy per DeepSeek account to dodge &quot;user is muted&quot; from datacenter/shared IPs. Supports socks5, socks5h, http, https. Pick one when adding an account.</p>
          {proxies.length > 0 && (
            <div className="flex flex-col gap-1 mb-3">
              {proxies.map((p) => {
                const t = proxyTests[p.id];
                return (
                  <div key={p.id} className="flex items-center gap-2 py-1.5 border-b border-border/50 flex-wrap">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-2">{p.type}</span>
                    <span className="text-sm font-mono flex-1 min-w-0 truncate">{p.host}:{p.port}</span>
                    {p.username && <span className="text-xs text-text-muted truncate">{p.username}</span>}
                    {p.name && <span className="text-xs text-text-muted truncate">{p.name}</span>}
                    {t && !t.loading && (
                      <span className={`text-xs ${t.ok ? "text-success" : "text-warning"} truncate max-w-[220px]`} title={t.msg}>
                        {t.ok ? "✓" : "✗"}{t.time != null ? ` ${t.time}ms` : ""}
                      </span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => testProxy(p.id)} disabled={t?.loading || !!busy}>{t?.loading ? "…" : "Test"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteProxy(p.id)} disabled={!!busy}>Delete</Button>
                  </div>
                );
              })}
            </div>
          )}
          {proxyGroups.length > 0 && (
            <div className="flex flex-col gap-1 mb-3 mt-2 pt-3 border-t border-border/50">
              <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Proxy groups (rotating)</p>
              {proxyGroups.map((g) => (
                <div key={g.id} className="flex items-center gap-2 py-1.5 border-b border-border/50 flex-wrap">
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-primary/15 text-primary">{g.strategy}</span>
                  <span className="text-sm flex-1 min-w-0 truncate">{g.name}</span>
                  <span className="text-xs text-text-muted truncate">{g.proxy_ids?.length || 0} proxy{(g.proxy_ids?.length || 0) !== 1 ? "ies" : ""}{g.strategy === "round-robin" && g.sticky ? ` · sticky ${g.sticky}` : ""}</span>
                  <Button size="sm" variant="ghost" onClick={() => { setGroupForm({ id: g.id, name: g.name, strategy: g.strategy, sticky: String(g.sticky || 1), proxy_ids: [...(g.proxy_ids || [])] }); setShowGroupModal(true); }} disabled={!!busy}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteGroup(g.id)} disabled={!!busy}>Delete</Button>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addProxy} className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Input placeholder="Name (opt)" value={proxyForm.name} onChange={(e) => setProxyForm({ ...proxyForm, name: e.target.value })} className="text-sm" />
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Type</span>
              <select value={proxyForm.type} onChange={(e) => setProxyForm({ ...proxyForm, type: e.target.value })}
                className="text-sm rounded border border-border bg-transparent px-2 py-1.5">
                <option value="socks5">socks5</option>
                <option value="socks5h">socks5h</option>
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </label>
            <Input placeholder="host" value={proxyForm.host} onChange={(e) => setProxyForm({ ...proxyForm, host: e.target.value })} className="font-mono text-sm" />
            <Input placeholder="port" type="number" value={proxyForm.port} onChange={(e) => setProxyForm({ ...proxyForm, port: e.target.value })} className="font-mono text-sm" />
            <Input placeholder="username (opt)" value={proxyForm.username} onChange={(e) => setProxyForm({ ...proxyForm, username: e.target.value })} className="text-sm" />
            <Input placeholder="password (opt)" type="password" value={proxyForm.password} onChange={(e) => setProxyForm({ ...proxyForm, password: e.target.value })} className="text-sm" />
            <div className="col-span-2 sm:col-span-3 flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!!busy}>Add proxy</Button>
              {proxyError && <span className="text-sm text-warning whitespace-pre-line">{proxyError}</span>}
            </div>
          </form>
        </Card>
      )}

      {/* Concurrency & queue */}
      {running && (
        <Card>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined">sync_alt</span>
            Concurrency &amp; queue
          </h2>
          {queue ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Stat label="In use" value={queue.in_use} hint={`${queue.total || 0} account(s)`} />
              <Stat label="Available" value={queue.available} hint={queue.waiting ? `${queue.waiting} waiting` : "no queue"} />
              <Stat label="Recommended" value={queue.recommended_concurrency} hint="concurrency" />
              <Stat label="Per-account cap" value={queue.max_inflight_per_account} hint="inflight" />
            </div>
          ) : (
            <p className="text-sm text-text-muted mb-4">Loading queue status…</p>
          )}
          {rtDraft && (
            <form onSubmit={saveRuntime} className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Tune how ds2api load-balances across your accounts (hot-reload, no restart).</p>
              <div className="grid grid-cols-2 gap-3">
                <NumField label="Per-account inflight (1–256)" value={rtDraft.account_max_inflight} onChange={(v) => setRtDraft({ ...rtDraft, account_max_inflight: v })} />
                <NumField label="Global inflight (≥ per-account)" value={rtDraft.global_max_inflight} onChange={(v) => setRtDraft({ ...rtDraft, global_max_inflight: v })} />
                <NumField label="Queue limit" value={rtDraft.account_max_queue} onChange={(v) => setRtDraft({ ...rtDraft, account_max_queue: v })} />
                <NumField label="Token refresh (hours)" value={rtDraft.token_refresh_interval_hours} onChange={(v) => setRtDraft({ ...rtDraft, token_refresh_interval_hours: v })} />
              </div>
              {rtError && <p className="text-sm text-warning">{rtError}</p>}
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={savingRt}>{savingRt ? "Saving…" : "Apply"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => runtime && setRtDraft({
                  account_max_inflight: String(runtime.account_max_inflight ?? ""),
                  account_max_queue: String(runtime.account_max_queue ?? ""),
                  global_max_inflight: String(runtime.global_max_inflight ?? ""),
                  token_refresh_interval_hours: String(runtime.token_refresh_interval_hours ?? ""),
                })}>Reset</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {/* Context file upload (current_input_file) */}
      {running && cifDraft && (
        <Card>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined">upload_file</span>
                Context file upload
              </h2>
              <p className="text-sm text-text-muted mt-1">
                When on, ds2api uploads the full conversation as a context file to DeepSeek (helps long contexts). If your account fails with &quot;upload current user input file&quot;, turn this off for reliability.
              </p>
            </div>
            <Toggle
              checked={!!cifDraft.enabled}
              onChange={(v) => saveCif({ enabled: v, min_chars: cifDraft.min_chars })}
              disabled={savingCif}
              title="Toggle context file upload"
            />
          </div>
          {cifDraft.enabled && (
            <div className="flex items-end gap-3 mt-3">
              <label className="flex flex-col gap-1 max-w-[220px]">
                <span className="text-xs text-text-muted">Min chars (0 = always upload)</span>
                <Input type="number" min="0" value={cifDraft.min_chars}
                  onChange={(e) => setCifDraft({ ...cifDraft, min_chars: e.target.value })}
                  className="font-mono text-sm" />
              </label>
              <Button size="sm" onClick={() => saveCif({})} disabled={savingCif}>{savingCif ? "Saving…" : "Apply"}</Button>
            </div>
          )}
          {cifError && <p className="text-sm text-warning mt-2">{cifError}</p>}
        </Card>
      )}

      {/* Available models */}
      <Card>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <span className="material-symbols-outlined">lists</span>
          Available models
        </h2>
        {!running ? (
          <p className="text-sm text-text-muted">Start the engine to list models.</p>
        ) : modelsLoading && !models.length ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : models.length === 0 ? (
          <p className="text-sm text-text-muted">No models reported. Ensure at least one account is configured.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {models.map((m) => (
              <Badge key={m.id} variant="default" className="font-mono">{m.id}</Badge>
            ))}
          </div>
        )}
      </Card>

      {/* Managed access key */}
      {running && managedKey && (
        <Card>
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">Internal access key</span>
            <button className="text-xs text-primary underline hover:opacity-80" onClick={() => setShowManaged((s) => !s)}>
              {showManaged ? "Hide" : "Reveal"}
            </button>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <code className="flex-1 text-xs font-mono break-all bg-black/5 dark:bg-white/5 rounded p-2">
              {showManaged ? managedKey : "••••••••••••••••"}
            </code>
            <Button size="sm" variant="ghost" onClick={() => copy(managedKey)}>{copied === managedKey ? "Copied" : "Copy"}</Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Auto-generated. 9Router uses it internally to route your requests; copy it only if you want to connect an external client directly.
          </p>
        </Card>
      )}

      {/* Add account modal */}
      <Modal isOpen={addOpen} title="Add DeepSeek account" onClose={() => setAddOpen(false)}>
        <form onSubmit={addAccount} className="flex flex-col gap-3">
          <Input placeholder="Label (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="flex gap-2">
            {["email", "mobile", "token"].map((t) => (
              <button type="button" key={t} onClick={() => setForm({ ...form, loginType: t })}
                className={`text-xs px-2 py-1 rounded ${form.loginType === t ? "bg-primary text-white" : "bg-surface-2 text-text-muted"}`}>
                {t}
              </button>
            ))}
          </div>
          {form.loginType === "token" ? (
            <Input placeholder="DeepSeek token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="font-mono text-sm" />
          ) : (
            <>
              <Input placeholder={form.loginType === "email" ? "email" : "mobile (CN)"} value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} />
              <Input type="password" placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </>
          )}
          {proxies.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Proxy (optional — residential recommended)</span>
              <select value={form.proxyId} onChange={(e) => setForm({ ...form, proxyId: e.target.value })}
                className="text-sm rounded border border-border bg-transparent px-2 py-1.5">
                <option value="">None (direct)</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || `${p.type}://${p.host}:${p.port}`}</option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="text-sm text-warning">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!!busy}>{busy === "add" ? "Adding…" : "Add"}</Button>
          </div>
        </form>
      </Modal>

      {/* Batch import proxies modal */}
      <Modal isOpen={showBatchImport} title="Batch import proxies" onClose={() => !batchBusy && setShowBatchImport(false)} size="full">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Default type (used when the line has no protocol)</span>
            <select value={batchDefaultType} onChange={(e) => setBatchDefaultType(e.target.value)}
              className="text-sm rounded border border-border bg-transparent px-2 py-1.5 w-fit">
              <option value="socks5">socks5</option>
              <option value="socks5h">socks5h</option>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </label>
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste proxy list (one per line)</label>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\nsocks5h://user:pass@10.0.0.5:1080\n127.0.0.1:7890\nhost:port:user:pass"}
              className="w-full min-h-[200px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all font-mono"
            />
            <p className="text-xs text-text-muted mt-1">
              Formats: <code>protocol://user:pass@host:port</code>, <code>host:port:user:pass</code>, <code>host:port</code>.
              Protocols: http, https, socks5, socks5h.
            </p>
          </div>
          {proxyError && <p className="text-sm text-warning whitespace-pre-line">{proxyError}</p>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button onClick={handleBatchImport} disabled={!batchText.trim() || batchBusy}>
              {batchBusy ? "Importing…" : "Import"}
            </Button>
            <Button variant="ghost" onClick={() => setShowBatchImport(false)} disabled={batchBusy}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Proxy group (rotation) create/edit modal */}
      <Modal isOpen={showGroupModal} title={groupForm.id ? "Edit proxy group" : "New proxy group"} onClose={() => setShowGroupModal(false)} size="full">
        <form onSubmit={saveGroup} className="flex flex-col gap-4">
          <Input placeholder="Group name" value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Strategy</span>
              <select value={groupForm.strategy} onChange={(e) => setGroupForm({ ...groupForm, strategy: e.target.value })}
                className="text-sm rounded border border-border bg-transparent px-2 py-1.5">
                <option value="round-robin">round-robin (cycle)</option>
                <option value="random">random</option>
                <option value="failover">failover (retry on error)</option>
              </select>
            </label>
            {groupForm.strategy === "round-robin" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">Sticky (requests before rotating)</span>
                <Input type="number" min="1" value={groupForm.sticky} onChange={(e) => setGroupForm({ ...groupForm, sticky: e.target.value })} className="font-mono text-sm" />
              </label>
            )}
          </div>
          <div>
            <span className="text-xs text-text-muted">Proxies in group ({groupForm.proxy_ids.length} selected)</span>
            {proxies.length === 0 ? (
              <p className="text-sm text-warning mt-1">Add proxies first (above) before creating a group.</p>
            ) : (
              <div className="flex flex-col gap-1 mt-1 max-h-48 overflow-y-auto">
                {proxies.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={groupForm.proxy_ids.includes(p.id)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...groupForm.proxy_ids, p.id]
                          : groupForm.proxy_ids.filter((x) => x !== p.id);
                        setGroupForm({ ...groupForm, proxy_ids: next });
                      }}
                      className="accent-primary"
                    />
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-2">{p.type}</span>
                    <span className="text-sm font-mono">{p.host}:{p.port}</span>
                    {p.username && <span className="text-xs text-text-muted">{p.username}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
          {proxyError && <p className="text-sm text-warning whitespace-pre-line">{proxyError}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setShowGroupModal(false)}>Cancel</Button>
            <Button type="submit" disabled={!!busy}>{groupForm.id ? "Save" : "Create"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-lg bg-black/[0.02] dark:bg-white/[0.03] p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-xl font-semibold mt-0.5">{value}</p>
      {hint && <p className="text-[11px] text-text-muted mt-0.5">{hint}</p>}
    </div>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <Input type="number" min="1" value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-sm" />
    </label>
  );
}
