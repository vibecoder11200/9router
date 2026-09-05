"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { normalizeProxyInput } from "@/lib/proxy/parseProxy";
import ProxyXoayPoolCard from "./ProxyXoayPoolCard";

function getStatusVariant(status) {
  if (status === "active") return "success";
  if (status === "error") return "error";
  return "default";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function normalizeFormData(data = {}) {
  return {
    name: data.name || "",
    proxyUrl: data.proxyUrl || "",
    noProxy: data.noProxy || "",
    isActive: data.isActive !== false,
    strictProxy: data.strictProxy === true,
    isGroup: data.isGroup === true,
    rotationMode: data.rotationMode || "on-error",
    // proxyxoay.org provider config
    type: data.type === "proxyxoay" ? "proxyxoay" : "",
    pxKeysText: Array.isArray(data.keys)
      ? data.keys.map((k) => (typeof k === "string" ? k : k.apiKey)).filter(Boolean).join("\n")
      : "",
    // Original key objects (id/label) so an edit can re-send surviving keys
    // with their ids — the backend then keeps each entry's live proxy state.
    pxKeys: Array.isArray(data.keys) ? data.keys.filter((k) => k && typeof k === "object") : [],
    liveMinutes: data.liveMinutes || 5,
    protocol: data.protocol === "socks5" ? "socks5" : "http",
    autoRotate: data.autoRotate !== false,
    forwardEnabled: data.forwardEnabled === true,
    entries: Array.isArray(data.entries) ? data.entries.map((e) => ({
      id: e.id || "",
      name: e.name || "",
      type: e.type || "http",
      proxyUrl: e.proxyUrl || "",
      isActive: e.isActive !== false,
      cooldownUntil: e.cooldownUntil || null,
      lastError: e.lastError || null,
    })) : [],
  };
}

export default function ProxyPoolsPage() {
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBatchImportModal, setShowBatchImportModal] = useState(false);
  const [showVercelModal, setShowVercelModal] = useState(false);
  const [showCloudflareModal, setShowCloudflareModal] = useState(false);
  const [showDenoModal, setShowDenoModal] = useState(false);
  const [showRelayMenu, setShowRelayMenu] = useState(false);
  const [editingProxyPool, setEditingProxyPool] = useState(null);
  const [formData, setFormData] = useState(normalizeFormData());
  const [batchImportText, setBatchImportText] = useState("");
  const [vercelForm, setVercelForm] = useState({ vercelToken: "", projectName: "vercel-relay" });
  const [cloudflareForm, setCloudflareForm] = useState({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
  const [denoForm, setDenoForm] = useState({ denoToken: "", orgDomain: "", projectName: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthProgress, setHealthProgress] = useState({ current: 0, total: 0 });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [showGroupBatchImport, setShowGroupBatchImport] = useState(false);
  const [groupBatchText, setGroupBatchText] = useState("");
  const relayMenuRef = useRef(null);
  const notify = useNotificationStore();

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (relayMenuRef.current && !relayMenuRef.current.contains(e.target)) {
        setShowRelayMenu(false);
      }
    };
    if (showRelayMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRelayMenu]);

  const fetchProxyPools = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setProxyPools(data.proxyPools || []);
      }
    } catch (error) {
      console.log("Error fetching proxy pools:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProxyPools();
  }, [fetchProxyPools]);

  const resetForm = () => {
    setEditingProxyPool(null);
    setFormData(normalizeFormData());
  };

  const openCreateModal = () => {
    resetForm();
    setShowFormModal(true);
  };

  const openEditModal = (proxyPool) => {
    setEditingProxyPool(proxyPool);
    setFormData(normalizeFormData(proxyPool));
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    setShowFormModal(false);
    resetForm();
  };

  const handleSave = async () => {
    const payload = {
      name: formData.name.trim(),
      noProxy: formData.noProxy.trim(),
      isActive: formData.isActive === true,
      strictProxy: formData.strictProxy === true,
    };

    // Proxyxoay pools are stored as groups (isGroup:true), so this branch MUST
    // be checked before the generic group branch — otherwise an edit would send
    // group-shaped fields and silently drop every provider field (liveMinutes,
    // keys, protocol, autoRotate, forwardEnabled).
    if (formData.type === "proxyxoay") {
      const keyLines = formData.pxKeysText
        .split(/\r?\n/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (keyLines.length === 0) {
        notify.error("Enter at least one proxyxoay API key");
        return;
      }
      // Reuse the existing key's id for surviving keys so the backend keeps the
      // entry's live proxy state instead of re-fetching every key on each edit.
      const keyById = new Map(
        (formData.pxKeys || []).map((k) => [String(k.apiKey || "").trim(), k])
      );
      payload.type = "proxyxoay";
      payload.isGroup = true;
      payload.keys = keyLines.map((apiKey) => {
        const prev = keyById.get(apiKey);
        return prev?.id ? { apiKey, id: prev.id, label: prev.label } : apiKey;
      });
      payload.liveMinutes = Number(formData.liveMinutes) || 5;
      payload.protocol = formData.protocol;
      payload.autoRotate = formData.autoRotate;
      payload.forwardEnabled = formData.forwardEnabled;
      payload.rotationMode = formData.rotationMode;
    } else if (formData.isGroup) {
      // Converting a proxyxoay pool into a plain group: tell the backend
      // explicitly so it can stop the proxyxoay rotation timers.
      if (editingProxyPool?.type === "proxyxoay") payload.type = "http";
      payload.isGroup = true;
      payload.rotationMode = formData.rotationMode;
      payload.entries = formData.entries
        .filter((e) => e.type === "direct" || e.proxyUrl.trim())
        .map((e) => ({
          id: e.id || undefined,
          name: e.name.trim(),
          type: e.type,
          proxyUrl: e.type === "direct" ? "" : e.proxyUrl.trim(),
          isActive: e.isActive !== false,
        }));
      if (!payload.entries.length) {
        notify.error("A proxy group needs at least one entry");
        return;
      }
    } else {
      if (editingProxyPool?.type === "proxyxoay") payload.type = "http";
      payload.proxyUrl = formData.proxyUrl.trim();
      payload.isGroup = false;
    }

    if (!payload.name) return;
    if (!formData.isGroup && formData.type !== "proxyxoay" && !payload.proxyUrl) return;

    setSaving(true);
    try {
      const isEdit = !!editingProxyPool;
      const res = await fetch(isEdit ? `/api/proxy-pools/${editingProxyPool.id}` : "/api/proxy-pools", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchProxyPools();
        closeFormModal();
        notify.success(editingProxyPool ? "Proxy pool updated" : "Proxy pool created");
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to save proxy pool");
      }
    } catch (error) {
      console.log("Error saving proxy pool:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (proxyPool, { force = false } = {}) => {
    setConfirmState({
      title: "Delete Proxy Pool",
      message: `Delete proxy pool "${proxyPool.name}"?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/proxy-pools/${proxyPool.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(force ? { force: true } : {}),
          });
          if (res.ok) {
            setProxyPools((prev) => prev.filter((item) => item.id !== proxyPool.id));
            notify.success(force ? "Proxy pool deleted (bindings removed)" : "Proxy pool deleted");
            return;
          }

          const data = await res.json();
          if (res.status === 409) {
            // Two distinct 409s (P3): providerStrategies bind (offers force) and
            // live connections bind. Show the server's actual reason instead of
            // a made-up "0 connection(s)" message.
            const boundProviders = Array.isArray(data.boundProviders) ? data.boundProviders : [];
            if (boundProviders.length > 0) {
              const ok = window.confirm(
                `Cannot delete: proxy strategies for ${boundProviders.join(", ")} still use this pool.\n\nUnbind them and delete anyway?`
              );
              if (ok) await handleDelete(proxyPool, { force: true });
              return;
            }
            notify.warning(
              data.boundConnectionCount
                ? `${data.error || "Cannot delete"}: ${data.boundConnectionCount} connection(s) still use this pool.`
                : data.error || "Cannot delete: this pool is still in use."
            );
          } else {
            notify.error(data.error || "Failed to delete proxy pool");
          }
        } catch (error) {
          console.log("Error deleting proxy pool:", error);
          notify.error("Failed to delete proxy pool");
        }
      }
    });
  };

  const handleTest = async (proxyPoolId) => {
    setTestingId(proxyPoolId);
    try {
      const res = await fetch(`/api/proxy-pools/${proxyPoolId}/test`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        notify.error(data.error || "Failed to test proxy");
        return;
      }

      await fetchProxyPools();
      // For group pools the API returns a per-entry breakdown; surface it so
      // the user can see how many entries passed/failed instead of a binary.
      if (data.group) {
        const { passed, failed, total } = data.group;
        if (data.ok) {
          notify.success(`Proxy group: ${passed}/${total} entries reachable${failed ? `, ${failed} failed` : ""}`);
        } else {
          notify.error(`Proxy group: all ${total} entries failed`);
        }
      } else {
        notify.success(data.ok ? "Proxy test passed" : "Proxy test failed");
      }
    } catch (error) {
      console.log("Error testing proxy pool:", error);
      notify.error("Failed to test proxy");
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (pool) => {
    const next = !pool.isActive;
    setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: next } : p));
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
        notify.error("Failed to update active state");
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
    }
  };

  const allSelected = proxyPools.length > 0 && selectedIds.length === proxyPools.length;
  const toggleSelect = (id) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : proxyPools.map((p) => p.id));
  const clearSelection = () => setSelectedIds([]);

  const bulkSetActive = async (isActive) => {
    const targets = selectedIds.length > 0 ? selectedIds : proxyPools.map((p) => p.id);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0; let failed = 0;
      for (const id of targets) {
        try {
          const res = await fetch(`/api/proxy-pools/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive }),
          });
          if (res.ok) ok += 1; else failed += 1;
        } catch { failed += 1; }
      }
      await fetchProxyPools();
      notify.success(`${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, failed ${failed}` : ""}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setConfirmState({
      title: "Delete Proxy Pools",
      message: `Delete ${selectedIds.length} proxy pool(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setBulkBusy(true);
        try {
          let ok = 0; let blocked = 0; let failed = 0;
          for (const id of selectedIds) {
            try {
              const res = await fetch(`/api/proxy-pools/${id}`, { method: "DELETE" });
              if (res.ok) ok += 1;
              else if (res.status === 409) blocked += 1;
              else failed += 1;
            } catch { failed += 1; }
          }
          await fetchProxyPools();
          clearSelection();
          notify.success(`Deleted ${ok}${blocked ? `, ${blocked} bound` : ""}${failed ? `, ${failed} failed` : ""}`);
        } finally {
          setBulkBusy(false);
        }
      }
    });
  };

  const handleHealthCheck = async () => {
    const targets = selectedIds.length > 0
      ? proxyPools.filter((p) => selectedIds.includes(p.id))
      : proxyPools;
    if (targets.length === 0) return;
    setHealthChecking(true);
    setHealthProgress({ current: 0, total: targets.length });
    let alive = 0; const deadIds = [];
    let done = 0;
    const CONCURRENCY = 10;
    const queue = [...targets];

    const worker = async () => {
      while (queue.length > 0) {
        const pool = queue.shift();
        if (!pool) break;
        try {
          const res = await fetch(`/api/proxy-pools/${pool.id}/test`, { method: "POST" });
          const data = await res.json();
          if (res.ok && data.ok) alive += 1; else deadIds.push(pool.id);
        } catch {
          deadIds.push(pool.id);
        } finally {
          done += 1;
          setHealthProgress({ current: done, total: targets.length });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    await fetchProxyPools();
    setHealthChecking(false);
    setHealthProgress({ current: 0, total: 0 });

    if (deadIds.length > 0) {
      setConfirmState({
        title: "Disable Dead Proxies",
        message: `Alive: ${alive}, Dead: ${deadIds.length}.\n\nDisable ${deadIds.length} dead proxies?`,
        onConfirm: async () => {
          setConfirmState(null);
          setBulkBusy(true);
          try {
            for (const id of deadIds) {
              try {
                await fetch(`/api/proxy-pools/${id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ isActive: false }),
                });
              } catch {}
            }
            await fetchProxyPools();
            notify.success(`Disabled ${deadIds.length} dead proxies`);
          } finally {
            setBulkBusy(false);
          }
        }
      });
    } else {
      notify.success(`Health check done. Alive: ${alive}, Dead: ${deadIds.length}`);
    }
  };

  // Cleanup selectedIds when pools change
  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => proxyPools.some((p) => p.id === id)));
  }, [proxyPools]);

  const openBatchImportModal = () => {
    setBatchImportText("");
    setShowBatchImportModal(true);
  };

  const closeBatchImportModal = () => {
    if (importing) return;
    setShowBatchImportModal(false);
  };

  const openVercelModal = () => {
    setVercelForm({ vercelToken: "", projectName: "vercel-relay" });
    setShowVercelModal(true);
  };

  const closeVercelModal = () => {
    if (deploying) return;
    setShowVercelModal(false);
  };

  const openCloudflareModal = () => {
    setCloudflareForm({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
    setShowCloudflareModal(true);
  };

  const closeCloudflareModal = () => {
    if (deploying) return;
    setShowCloudflareModal(false);
  };

  const openDenoModal = () => {
    setDenoForm({ denoToken: "", orgDomain: "", projectName: "" });
    setShowDenoModal(true);
  };

  const closeDenoModal = () => {
    if (deploying) return;
    setShowDenoModal(false);
  };

  const handleVercelDeploy = async () => {
    if (!vercelForm.vercelToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/vercel-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vercelForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeVercelModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Vercel relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleCloudflareDeploy = async () => {
    if (!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/cloudflare-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cloudflareForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeCloudflareModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Cloudflare relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleDenoDeploy = async () => {
    if (!denoForm.denoToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/deno-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(denoForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeDenoModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Deno relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  // Dedup key (P6): host:port plus credentials (if any), scheme-insensitive,
  // with noProxy folded in for single-pool imports. One key for both paths.
  const proxyDedupeKey = (proxyUrl, noProxy = "") => {
    try {
      const u = new URL(proxyUrl);
      return `${u.username ? `${u.username}@` : ""}${u.hostname}:${u.port}|||${noProxy}`.toLowerCase();
    } catch {
      return `${String(proxyUrl || "").trim().toLowerCase()}|||${noProxy}`;
    }
  };

  const parseProxyLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Delegate to the shared multi-format parser so all common shapes work:
    //   scheme://user:pass@host:port   (standard)
    //   scheme://host:port@user:pass   (reversed — new)
    //   host:port:user:pass            (colon form, e.g. proxyxoay `proxyhttp`)
    //   user:pass:host:port, host:port, IPv6 …
    const result = normalizeProxyInput(trimmed);
    if (!result.ok) throw new Error(result.error || "Unsupported format");

    const { parsed, canonicalUrl } = result;
    const hostLabel = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
    return {
      proxyUrl: canonicalUrl,
      name: `Imported ${hostLabel}`,
    };
  };

  const handleBatchImport = async () => {
    const lines = batchImportText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      notify.warning("Please paste at least one proxy line.");
      return;
    }

    const parsedEntries = [];
    const invalidLines = [];

    lines.forEach((line, index) => {
      try {
        const parsed = parseProxyLine(line);
        if (parsed) {
          parsedEntries.push({
            ...parsed,
            lineNumber: index + 1,
          });
        }
      } catch (error) {
        invalidLines.push(`Line ${index + 1}: ${error.message}`);
      }
    });

    if (invalidLines.length > 0) {
      notify.error(`Invalid proxy format:\n${invalidLines.join("\n")}`);
      return;
    }

    setImporting(true);
    try {
      const existingKeys = new Set(
        proxyPools.map((pool) => proxyDedupeKey(pool.proxyUrl, pool.noProxy))
      );

      let created = 0;
      let skipped = 0;
      let failed = 0;

      for (const entry of parsedEntries) {
        const dedupeKey = proxyDedupeKey(entry.proxyUrl);
        if (existingKeys.has(dedupeKey)) {
          skipped += 1;
          continue;
        }

        const res = await fetch("/api/proxy-pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: entry.name,
            proxyUrl: entry.proxyUrl,
            noProxy: "",
            isActive: true,
          }),
        });

        if (res.ok) {
          created += 1;
          existingKeys.add(dedupeKey);
        } else {
          failed += 1;
        }
      }

      await fetchProxyPools();
      setShowBatchImportModal(false);
      notify.success(`Batch import completed: Created ${created}, Skipped ${skipped}, Failed ${failed}`);
    } catch (error) {
      console.log("Error batch importing proxies:", error);
      notify.error("Batch import failed");
    } finally {
      setImporting(false);
    }
  };

  // Batch import proxies directly into the current group form's entries list.
  // Reuses the same parseProxyLine logic but appends to formData.entries.
  const handleGroupBatchImport = () => {
    const lines = groupBatchText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      notify.warning("Paste at least one proxy line.");
      return;
    }
    const newEntries = [];
    const seenKeys = new Set(formData.entries.map((e) => proxyDedupeKey(e.proxyUrl)).filter(Boolean));
    let failed = 0;
    let duplicates = 0;
    for (const line of lines) {
      try {
        const parsed = parseProxyLine(line);
        if (!parsed?.proxyUrl) continue;
        const key = proxyDedupeKey(parsed.proxyUrl);
        if (seenKeys.has(key)) {
          duplicates += 1;
          continue;
        }
        seenKeys.add(key);
        newEntries.push({ id: "", name: parsed.name || "", proxyUrl: parsed.proxyUrl, type: "http", isActive: true });
      } catch {
        failed++;
      }
    }
    if (newEntries.length === 0) {
      notify.error(failed > 0 || duplicates > 0 ? "All lines were invalid or duplicates." : "No valid proxy lines found.");
      return;
    }
    setFormData((prev) => ({ ...prev, entries: [...prev.entries, ...newEntries] }));
    setGroupBatchText("");
    setShowGroupBatchImport(false);
    notify.success(`Added ${newEntries.length} entr${newEntries.length === 1 ? "y" : "ies"}${duplicates ? `, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : ""}${failed ? `, ${failed} skipped` : ""}`);
  };

  const activeCount = useMemo(
    () => proxyPools.filter((pool) => pool.isActive === true).length,
    [proxyPools]
  );

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Proxy Pools</h1>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <div className="relative" ref={relayMenuRef}>
            <Button
              size="sm"
              variant="secondary"
              icon="rocket_launch"
              onClick={() => setShowRelayMenu(!showRelayMenu)}
            >
              Deploy Relay
              <span className="material-symbols-outlined ml-1 text-[18px]">
                {showRelayMenu ? "expand_less" : "expand_more"}
              </span>
            </Button>

            {showRelayMenu && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-zinc-900 sm:left-auto sm:right-0">
                <button
                  onClick={() => {
                    openCloudflareModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-orange-500">cloud</span>
                  Cloudflare Relay
                </button>
                <button
                  onClick={() => {
                    openVercelModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-blue-500">cloud_upload</span>
                  Vercel Relay
                </button>
                <button
                  onClick={() => {
                    openDenoModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-green-500">terminal</span>
                  Deno Relay
                </button>
              </div>
            )}
          </div>

          <Button size="sm" variant="secondary" icon="upload" onClick={openBatchImportModal}>
            Batch Import
          </Button>
          <Button size="sm" icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
        </div>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {proxyPools.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="size-4 rounded border-black/20 dark:border-white/20"
              />
              {allSelected ? "Unselect all" : "Select all"}
            </label>
          )}
          <Badge variant="default">Total: {proxyPools.length}</Badge>
          <Badge variant="success">Active: {activeCount}</Badge>
        </div>

        {(selectedIds.length > 0 || healthChecking) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="material-symbols-outlined text-[18px] text-primary">checklist</span>
            <span className="text-xs font-medium text-primary">
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : "All pools"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={healthChecking ? "progress_activity" : "health_and_safety"}
                onClick={handleHealthCheck}
                disabled={healthChecking || bulkBusy || proxyPools.length === 0}
              >
                {healthChecking ? `Checking ${healthProgress.current}/${healthProgress.total}` : "Health Check"}
              </Button>
              {selectedIds.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" icon="toggle_on" onClick={() => bulkSetActive(true)} disabled={bulkBusy || healthChecking}>
                    Activate
                  </Button>
                  <Button size="sm" variant="secondary" icon="toggle_off" onClick={() => bulkSetActive(false)} disabled={bulkBusy || healthChecking}>
                    Deactivate
                  </Button>
                  <Button size="sm" variant="secondary" icon="delete" onClick={bulkDelete} disabled={bulkBusy || healthChecking}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy || healthChecking}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {proxyPools.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-text-main font-medium mb-1">No proxy pool entries yet</p>
            <p className="text-sm text-text-muted mb-4">
              Create a proxy pool entry, then assign it to connections.
            </p>
            <Button icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {proxyPools.map((pool) => (
              <div key={pool.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(pool.id)}
                    onChange={() => toggleSelect(pool.id)}
                    className="mt-1 size-4 shrink-0 rounded border-black/20 dark:border-white/20"
                  />
                  <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[18rem]">{pool.name}</p>
                    <Badge variant={getStatusVariant(pool.testStatus)} size="sm" dot>
                      {pool.testStatus || "unknown"}
                    </Badge>
                    <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                      {pool.isActive ? "active" : "inactive"}
                    </Badge>
                    {pool.type === "vercel" && (
                      <Badge variant="default" size="sm">vercel relay</Badge>
                    )}
                    {pool.type === "cloudflare" && (
                      <Badge variant="default" size="sm">cloudflare relay</Badge>
                    )}
                    {pool.type === "proxyxoay" && (
                      <Badge variant="primary" size="sm">proxyxoay · {pool.keys?.length || 0} key(s)</Badge>
                    )}
                    {pool.isGroup && pool.type !== "proxyxoay" && (
                      <Badge variant="primary" size="sm">group · {pool.rotationMode} · {pool.entries?.length || 0} entries</Badge>
                    )}
                    <Badge variant="default" size="sm">
                      {pool.boundConnectionCount || 0} bound
                    </Badge>
                  </div>
                  {pool.type === "proxyxoay" ? (
                    <p className="text-xs text-text-muted truncate mt-1">
                      {(pool.protocol || "http").toUpperCase()} · {(pool.liveMinutes || 5)}m rotation · {pool.keys?.length || 0} key(s)
                      {pool.forwardEnabled ? " · forwarding on" : ""}
                    </p>
                  ) : pool.isGroup ? (
                    <p className="text-xs text-text-muted truncate mt-1">
                      {pool.entries?.filter((e) => e.type === "direct").length || 0} direct + {pool.entries?.filter((e) => e.type !== "direct").length || 0} proxy
                      {pool.entries?.some((e) => e.cooldownUntil && e.cooldownUntil > Date.now()) ? ` · ${pool.entries.filter((e) => e.cooldownUntil && e.cooldownUntil > Date.now()).length} cooling down` : ""}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted truncate mt-1">{pool.proxyUrl}</p>
                  )}
                  {pool.noProxy ? (
                    <p className="text-xs text-text-muted truncate">No proxy: {pool.noProxy}</p>
                  ) : null}
                  <p className="text-[11px] text-text-muted mt-1">
                    Last tested: {formatDateTime(pool.lastTestedAt)}
                    {pool.lastError ? ` · ${pool.lastError}` : ""}
                  </p>
                  {pool.type === "proxyxoay" && <ProxyXoayPoolCard pool={pool} />}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1">
                  <Toggle
                    size="sm"
                    checked={pool.isActive === true}
                    onChange={() => handleToggleActive(pool)}
                    title={pool.isActive ? "Disable" : "Enable"}
                  />
                  <button
                    onClick={() => handleTest(pool.id)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Test proxy"
                    disabled={testingId === pool.id}
                  >
                    <span
                      className="material-symbols-outlined text-[18px]"
                      style={testingId === pool.id ? { animation: "spin 1s linear infinite" } : undefined}
                    >
                      {testingId === pool.id ? "progress_activity" : "science"}
                    </span>
                  </button>
                  <button
                    onClick={() => openEditModal(pool)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(pool)}
                    className="p-2 rounded hover:bg-red-500/10 text-red-500"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        isOpen={showBatchImportModal}
        title="Batch Import Proxies"
        onClose={closeBatchImportModal}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste Proxy List (One per line)</label>
            <textarea
              value={batchImportText}
              onChange={(e) => setBatchImportText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
              className="w-full min-h-[180px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <p className="text-xs text-text-muted mt-1">
              Supported formats: protocol://user:pass@host:port, host:port:user:pass
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth onClick={handleBatchImport} disabled={!batchImportText.trim() || importing}>
              {importing ? "Importing..." : "Import"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeBatchImportModal} disabled={importing}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showVercelModal}
        title="Deploy Vercel Relay"
        onClose={closeVercelModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Vercel Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys an edge relay function to Vercel. All AI provider requests will be forwarded through Vercel&apos;s edge network, masking your real IP from providers.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Your IP is replaced by Vercel&apos;s dynamic edge IPs (hundreds of IPs across 20+ global regions)</li>
              <li>Vercel serves millions of apps — providers can&apos;t block Vercel IPs without affecting legitimate traffic</li>
              <li>Free tier: 100GB bandwidth/month, 500K edge invocations</li>
              <li>Deploy multiple relays on different accounts for more IP diversity</li>
            </ul>
          </div>
          <Input
            label="Vercel API Token"
            value={vercelForm.vercelToken}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, vercelToken: e.target.value }))}
            placeholder="your-vercel-api-token"
            hint={<>Token is used once for deployment and not stored. <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Project Name"
            value={vercelForm.projectName}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Vercel project. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleVercelDeploy}
              disabled={!vercelForm.vercelToken.trim() || deploying}
            >
              {deploying ? "Deploying... (may take ~1 min)" : "Deploy"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeVercelModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCloudflareModal}
        title="Deploy Cloudflare Relay"
        onClose={closeCloudflareModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-orange-500/5 border border-orange-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Cloudflare Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a Cloudflare Worker as a proxy relay. All AI provider requests will be forwarded through Cloudflare&apos;s global edge network.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>High performance global routing and IP masking via Cloudflare Workers</li>
              <li>Free tier: 100,000 requests per day</li>
              <li>Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-orange-500/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate your API Token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>My Profile</b> → <b>API Tokens</b> → <b>Create Token</b></li>
                <li>Scroll down to <b>Custom Token</b> and click <b>Get started</b></li>
                <li>Under <b>Permissions</b>: Account | Workers Scripts | Edit</li>
                <li>Under <b>Account Resources</b>: Include | Account | <i>Your Account Name</i></li>
                <li>Click <b>Continue to summary</b> → <b>Create Token</b></li>
              </ol>
            </div>
          </div>
          <Input
            label="Account ID"
            value={cloudflareForm.accountId}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, accountId: e.target.value }))}
            placeholder="your-cloudflare-account-id"
            hint={<>Found on the right side of the Cloudflare dashboard overview page.</>}
          />
          <Input
            label="API Token"
            value={cloudflareForm.apiToken}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, apiToken: e.target.value }))}
            placeholder="your-cloudflare-api-token"
            hint={<>Requires "Workers Scripts: Edit" permission. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Worker Name"
            value={cloudflareForm.projectName}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Cloudflare Worker. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleCloudflareDeploy}
              disabled={!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Worker"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeCloudflareModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showDenoModal}
        title="Deploy Deno Relay"
        onClose={closeDenoModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Deno Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a relay worker to Deno Deploy&apos;s global edge network. All AI provider requests are forwarded through Deno&apos;s edge, masking your real IP.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Deno Deploy v2 runs on a high-performance global edge network</li>
              <li>Free tier: 1M requests & 100GiB outbound traffic per month</li>
              <li>No per-request CPU time limits (unlike Vercel/Cloudflare)</li>
              <li>Support up to 20 active apps & 50 custom domains</li>
              <li>Deploy multiple relays for maximum IP diversity</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-black/10 dark:border-white/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate API token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>console.deno.com</b></li>
                <li>Select your <b>Organization</b> → <b>Settings</b> → <b>Organization Tokens</b></li>
                <li>Create a <b>Organization Token</b> (prefix <b>ddo_</b>)</li>
              </ol>
            </div>
          </div>
          <Input
            label="Deno Deploy API Token"
            value={denoForm.denoToken}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, denoToken: e.target.value }))}
            placeholder="ddo_xxxxxxxxxxxxxxxx"
            hint={<>Token is used once for deployment, not stored. Found in Organization Settings.</>}
            type="password"
          />
          <Input
            label="Organization Domain"
            value={denoForm.orgDomain}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, orgDomain: e.target.value }))}
            placeholder="your-org.deno.net"
            hint="Organization's default domain. Your relay URL will be in the format: https://my-relay.your-org.deno.net"
          />
          <Input
            label="App Name"
            value={denoForm.projectName}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="deno-relay"
            hint="Unique app name. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleDenoDeploy}
              disabled={!denoForm.denoToken.trim() || !denoForm.orgDomain.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Relay"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeDenoModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showFormModal}
        title={editingProxyPool ? "Edit Proxy Pool" : "Add Proxy Pool"}
        onClose={closeFormModal}
        size="full"
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Office Proxy"
          />

          {/* Pool type: single proxy / rotating group / proxyxoay provider */}
          <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-3">
            <p className="font-medium text-sm">Pool type</p>
            <div className="flex flex-wrap gap-1">
              {[
                { id: "single", label: "Single proxy" },
                { id: "group", label: "Rotating group" },
                { id: "proxyxoay", label: "proxyxoay.org" },
              ].map((opt) => {
                const active =
                  (opt.id === "single" && !formData.isGroup && formData.type !== "proxyxoay") ||
                  // proxyxoay pools are stored with isGroup:true — exclude them
                  // so "group" and "proxyxoay" don't both highlight on edit.
                  (opt.id === "group" && formData.isGroup && formData.type !== "proxyxoay") ||
                  (opt.id === "proxyxoay" && formData.type === "proxyxoay");
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        isGroup: opt.id === "group",
                        type: opt.id === "proxyxoay" ? "proxyxoay" : "",
                      }))
                    }
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border bg-transparent hover:bg-border/30"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-text-muted">
              {formData.type === "proxyxoay"
                ? "Rotating residential/4G proxies from proxyxoay.org. Paste your API keys; each key rotates its IP automatically."
                : formData.isGroup
                ? "Hold multiple proxies + rotate on rate-limit (429). Includes a \"direct\" option to use the server IP."
                : "A single HTTP/SOCKS proxy URL."}
            </p>
          </div>

          {formData.type === "proxyxoay" ? (
            <div className="flex flex-col gap-3">
              {/* proxyxoay provider config */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">API keys (one per line) — bulk add</span>
                <textarea
                  value={formData.pxKeysText}
                  onChange={(e) => setFormData((prev) => ({ ...prev, pxKeysText: e.target.value }))}
                  placeholder={"ICWvX6xzQQTDL9xj7yXY\nanother-key-here"}
                  rows={4}
                  className="text-sm rounded border border-border bg-transparent px-2 py-1.5 font-mono"
                />
                <span className="text-[11px] text-text-muted">
                  {formData.pxKeysText.split(/\r?\n/).filter((l) => l.trim()).length} key(s). Each becomes a rotating proxy the pool rotates across.
                </span>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">Rotation interval (live, minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={formData.liveMinutes}
                    onChange={(e) => setFormData((prev) => ({ ...prev, liveMinutes: Number(e.target.value) }))}
                    onBlur={(e) => {
                      // Snap empty/out-of-range input back into 1–60 on blur.
                      const n = Math.round(Number(e.target.value));
                      const safe = Number.isFinite(n) && n > 0 ? Math.min(60, Math.max(1, n)) : 5;
                      setFormData((prev) => ({ ...prev, liveMinutes: safe }));
                    }}
                    className="text-sm rounded border border-border bg-transparent px-2 py-1.5"
                  />
                  <span className="text-[11px] text-text-muted">1–60 min. Actual IP lifetime follows the provider (time_die).</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">Protocol</span>
                  <select
                    value={formData.protocol}
                    onChange={(e) => setFormData((prev) => ({ ...prev, protocol: e.target.value }))}
                    className="text-sm rounded border border-border bg-transparent px-2 py-1.5"
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">Rotation mode (across keys)</span>
                <select
                  value={formData.rotationMode}
                  onChange={(e) => setFormData((prev) => ({ ...prev, rotationMode: e.target.value }))}
                  className="text-sm rounded border border-border bg-transparent px-2 py-1.5"
                >
                  <option value="on-error">Rotate on error (least-recently-used, default)</option>
                  <option value="round-robin">Round-robin (cycle every request)</option>
                  <option value="random">Random</option>
                </select>
              </label>

              <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">Auto-rotate</p>
                    <p className="text-xs text-text-muted">Refresh each key&apos;s IP shortly before it expires (time_die).</p>
                  </div>
                  <Toggle
                    checked={formData.autoRotate === true}
                    onChange={() => setFormData((prev) => ({ ...prev, autoRotate: !prev.autoRotate }))}
                    disabled={saving}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">Local forwarding port</p>
                    <p className="text-xs text-text-muted">Expose 127.0.0.1:&lt;port&gt; per key so external tools can ride the rotating IP.</p>
                  </div>
                  <Toggle
                    checked={formData.forwardEnabled === true}
                    onChange={() => setFormData((prev) => ({ ...prev, forwardEnabled: !prev.forwardEnabled }))}
                    disabled={saving}
                  />
                </div>
              </div>
            </div>
          ) : formData.isGroup ? (
            <div className="flex flex-col gap-3">
              {/* Rotation mode */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">Rotation mode</span>
                <select
                  value={formData.rotationMode}
                  onChange={(e) => setFormData((prev) => ({ ...prev, rotationMode: e.target.value }))}
                  className="text-sm rounded border border-border bg-transparent px-2 py-1.5"
                >
                  <option value="on-error">Rotate on error (least-recently-used, default)</option>
                  <option value="round-robin">Round-robin (cycle every request)</option>
                  <option value="random">Random</option>
                </select>
              </label>

              {/* Entries editor */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-medium">Proxy entries ({formData.entries.length})</span>
                  <div className="flex gap-1 flex-wrap">
                    <Button size="sm" variant="ghost" icon="playlist_add" onClick={() => setShowGroupBatchImport(true)} disabled={saving}>Batch import</Button>
                    <Button size="sm" variant="ghost" onClick={() => setFormData((prev) => ({
                      ...prev,
                      entries: [...prev.entries, { id: "", name: "", type: "http", proxyUrl: "", isActive: true }],
                    }))} disabled={saving}>+ Proxy</Button>
                    <Button size="sm" variant="ghost" onClick={() => setFormData((prev) => ({
                      ...prev,
                      entries: [...prev.entries, { id: "", name: "Direct (server IP)", type: "direct", proxyUrl: "", isActive: true }],
                    }))} disabled={saving}>+ Direct</Button>
                  </div>
                </div>
                <p className="text-xs text-text-muted">Supported: http, https, socks5, socks5h, socks4, socks4a, direct.</p>
                {formData.entries.map((entry, idx) => {
                  // Derive the displayed protocol from the URL for non-direct entries.
                  const displayType = entry.type === "direct" ? "direct"
                    : (() => { try { return new URL(entry.proxyUrl).protocol.replace(":", "") || entry.type; } catch { return entry.type || "?"; } })();
                  return (
                  <div key={idx} className="flex items-center gap-2 rounded border border-border/50 p-2 flex-wrap">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-2">{displayType}</span>
                    {entry.type === "direct" ? (
                      <span className="text-sm flex-1 text-text-muted italic">Uses server IP (no proxy)</span>
                    ) : (
                      <>
                        <input
                          className="text-sm bg-transparent border border-border rounded px-2 py-1 flex-1 min-w-[140px] font-mono"
                          placeholder="socks5://user:pass@host:port"
                          value={entry.proxyUrl}
                          onChange={(e) => setFormData((prev) => ({
                            ...prev,
                            entries: prev.entries.map((x, i) => i === idx ? { ...x, proxyUrl: e.target.value } : x),
                          }))}
                        />
                        <input
                          className="text-sm bg-transparent border border-border rounded px-2 py-1 w-28"
                          placeholder="label (opt)"
                          value={entry.name}
                          onChange={(e) => setFormData((prev) => ({
                            ...prev,
                            entries: prev.entries.map((x, i) => i === idx ? { ...x, name: e.target.value } : x),
                          }))}
                        />
                      </>
                    )}
                    <button
                      className="text-text-muted hover:text-warning text-sm px-1"
                      title="Remove entry"
                      onClick={() => setFormData((prev) => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }))}
                      type="button"
                    >✕</button>
                  </div>
                  );
                })}
                {formData.entries.length === 0 && (
                  <p className="text-sm text-warning">Add at least one proxy or direct entry.</p>
                )}
              </div>
            </div>
          ) : (
            <Input
              label="Proxy URL"
              value={formData.proxyUrl}
              onChange={(e) => setFormData((prev) => ({ ...prev, proxyUrl: e.target.value }))}
              placeholder="http://user:pass@host:port  ·  host:port:user:pass  ·  http://host:port@user:pass"
              hint="Many formats accepted: scheme://user:pass@host:port, host:port:user:pass, reversed order, IPv6, etc."
            />
          )}

          <Input
            label="No Proxy"
            value={formData.noProxy}
            onChange={(e) => setFormData((prev) => ({ ...prev, noProxy: e.target.value }))}
            placeholder="localhost,127.0.0.1,.internal"
            hint="Comma-separated hosts/domains to bypass proxy"
          />

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Active</p>
              <p className="text-xs text-text-muted">Inactive pools are ignored by runtime resolution.</p>
            </div>
            <Toggle
              checked={formData.isActive === true}
              onChange={() => setFormData((prev) => ({ ...prev, isActive: !prev.isActive }))}
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Strict Proxy</p>
              <p className="text-xs text-text-muted">Fail request if proxy is unreachable instead of falling back to direct.</p>
            </div>
            <Toggle
              checked={formData.strictProxy === true}
              onChange={() => setFormData((prev) => ({ ...prev, strictProxy: !prev.strictProxy }))}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleSave}
              disabled={!formData.name.trim() || (!formData.isGroup && formData.type !== "proxyxoay" && !formData.proxyUrl.trim()) || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeFormModal} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {/* Batch import into group form entries */}
      <Modal
        isOpen={showGroupBatchImport}
        title="Batch import into group"
        onClose={() => setShowGroupBatchImport(false)}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste proxy list (one per line)</label>
            <textarea
              value={groupBatchText}
              onChange={(e) => setGroupBatchText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\nsocks5://user:pass@10.0.0.5:1080\n127.0.0.1:7890:user:pass"}
              className="w-full min-h-[180px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all font-mono"
            />
            <p className="text-xs text-text-muted mt-1">
              Formats: protocol://user:pass@host:port, host:port:user:pass. Protocols: http, https, socks5, socks5h, socks4, socks4a.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth onClick={handleGroupBatchImport} disabled={!groupBatchText.trim()}>
              Add to group
            </Button>
            <Button fullWidth variant="ghost" onClick={() => setShowGroupBatchImport(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
