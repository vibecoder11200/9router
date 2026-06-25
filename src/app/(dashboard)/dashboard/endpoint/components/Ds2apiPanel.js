"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Modal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Self-contained "DeepSeek Web" management panel (powered by the ds2api sidecar).
// Lifecycle: install → start → manage DeepSeek accounts → use DeepSeek models.
// All actions go through auth-gated /api/ds2api/* routes; the sidecar itself is invisible.

const POLL_MS = 5000;

export default function Ds2apiPanel() {
  const { copied, copy } = useCopyToClipboard();
  const [info, setInfo] = useState(null); // { install, running, version, managedKey, managedKeyPresent }
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [busy, setBusy] = useState(""); // install|start|stop|...
  const [error, setError] = useState("");
  const [showManaged, setShowManaged] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", loginType: "email", identifier: "", password: "", token: "" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/ds2api/info", { headers: { "Cache-Control": "no-store" } });
      const data = await res.json();
      setInfo(data);
      if (data.running) {
        setAccountsLoading(true);
        const accRes = await fetch("/api/ds2api/accounts", { headers: { "Cache-Control": "no-store" } });
        if (accRes.ok) setAccounts((await accRes.json()).items || []);
      } else {
        setAccounts([]);
      }
    } catch {
      /* ignore poll errors */
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
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
  const start = () => call("start", "/api/ds2api/start", { method: "POST" }).catch(() => {});
  const stop = () => call("stop", "/api/ds2api/stop", { method: "POST" }).catch(() => {});
  const testAll = () => call("testAll", "/api/ds2api/accounts/test-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});

  async function addAccount(e) {
    e.preventDefault();
    const acc = form.loginType === "token"
      ? { name: form.name, token: form.token }
      : { name: form.name, [form.loginType]: form.identifier, password: form.password };
    try {
      await call("add", "/api/ds2api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(acc) });
      setAddOpen(false);
      setForm({ name: "", loginType: "email", identifier: "", password: "", token: "" });
    } catch { /* error shown */ }
  }

  async function deleteAccount(identifier) {
    if (!confirm(`Remove account ${identifier}?`)) return;
    call("del", `/api/ds2api/accounts/${encodeURIComponent(identifier)}`, { method: "DELETE" }).catch(() => {});
  }

  async function testAccount(identifier) {
    call(`test-${identifier}`, "/api/ds2api/accounts/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier }),
    }).catch(() => {});
  }

  const install_ = info?.install || {};
  const running = !!info?.running;
  const managedKey = info?.managedKeyPresent ? info?.managedKey : null;

  return (
    <Card id="ds2api">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">cloud</span>
          DeepSeek Web
        </h2>
        <span className={`text-xs px-2 py-0.5 rounded ${running ? "bg-success/15 text-success" : install_.installed ? "bg-warning/15 text-warning" : "bg-surface-2 text-text-muted"}`}>
          {running ? "Running" : install_.installed ? "Stopped" : "Not installed"}
        </span>
      </div>

      <p className="text-sm text-text-muted mb-3">
        Use your DeepSeek account through the web interface. Add your account below and models like
        <span className="font-mono"> deepseek-v4-pro/flash/vision</span> become usable across 9Router.
      </p>

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2 py-3 border-b border-border">
        <div className="text-sm text-text-muted mr-auto">
          {install_.installed ? (
            <>Version {install_.version}{install_.upToDate ? "" : <span className="text-warning"> (update available: {install_.expectedVersion})</span>}</>
          ) : (
            <span>Binary not installed — click Install to download for this platform.</span>
          )}
        </div>
        {!install_.installed && (
          <Button size="sm" onClick={install} disabled={!!busy}>{busy === "install" ? "Installing…" : "Install"}</Button>
        )}
        {install_.installed && !running && (
          <Button size="sm" onClick={start} disabled={!!busy}>{busy === "start" ? "Starting…" : "Start"}</Button>
        )}
        {running && (
          <Button size="sm" variant="ghost" onClick={stop} disabled={!!busy}>{busy === "stop" ? "Stopping…" : "Stop"}</Button>
        )}
      </div>

      {error && <p className="text-sm text-warning mt-2">{error}</p>}

      {/* Accounts */}
      {running && (
        <div className="pt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">DeepSeek Accounts</p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={testAll} disabled={!!busy}>Test all</Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>Add account</Button>
            </div>
          </div>
          {accountsLoading && !accounts.length ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-text-muted">No accounts yet. Add a DeepSeek account (email/mobile + password, or a token) to start using DeepSeek models.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {accounts.map((a) => (
                <div key={a.identifier} className="flex items-center gap-2 py-1.5 border-b border-border/50">
                  <span className={`w-2 h-2 rounded-full ${
                    a.test_status === "ok" || a.test_status === "success" ? "bg-success"
                    : a.test_status ? "bg-warning" : "bg-text-muted/40"
                  }`} title={a.test_status || "not tested"} />
                  <span className="text-sm font-mono flex-1 min-w-0 truncate">{a.identifier}</span>
                  {a.name && <span className="text-xs text-text-muted truncate">{a.name}</span>}
                  <Button size="sm" variant="ghost" onClick={() => testAccount(a.identifier)} disabled={!!busy}>Test</Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteAccount(a.identifier)} disabled={!!busy}>Delete</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Managed access */}
      {running && managedKey && (
        <div className="pt-4 mt-2 border-t border-border">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">Managed access key</span>
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
        </div>
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
          {error && <p className="text-sm text-warning">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!!busy}>{busy === "add" ? "Adding…" : "Add"}</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
