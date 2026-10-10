import { NextResponse } from "next/server";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProxyPool,
} from "@/models";
import { getSettings, updateSettings } from "@/lib/localDb";
import { normalizeProxyInput } from "@/lib/proxy/parseProxy";
import { normalizeCooldownUntil } from "@/models";
import { registerPool, unregisterPool } from "@/lib/proxy/providers/proxyxoayManager.js";

const VALID_PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks4a:"];

function normalizeGroupEntry(e, i) {
  if (e?.type === "direct") {
    return {
      id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
      name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : "Direct (server IP)",
      type: "direct",
      proxyUrl: "",
      isActive: e?.isActive !== false,
      cooldownUntil: normalizeCooldownUntil(e?.cooldownUntil),
      lastError: e?.lastError ?? null,
      lastUsedAt: e?.lastUsedAt ?? null,
    };
  }
  const entryUrl = typeof e?.proxyUrl === "string" ? e.proxyUrl.trim() : "";
  if (!entryUrl) return null;
  // Canonicalise through the multi-format parser (accepts reversed / colon
  // forms) before scheme validation — mirrors the POST route.
  const norm = normalizeProxyInput(entryUrl);
  if (!norm.ok) return null;
  const scheme = `${norm.parsed.scheme}:`;
  if (!VALID_PROXY_SCHEMES.includes(scheme)) return null;
  return {
    id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
    name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : entryUrl,
    type: norm.parsed.scheme,
    proxyUrl: norm.canonicalUrl,
    isActive: e?.isActive !== false,
    cooldownUntil: normalizeCooldownUntil(e?.cooldownUntil),
    lastError: e?.lastError ?? null,
    lastUsedAt: e?.lastUsedAt ?? null,
  };
}

function normalizeProxyPoolUpdate(body = {}, existing = null) {
  const updates = {};
  // A pool is proxyxoay-shaped when it already is one and this update doesn't
  // convert it to another type. Its entries are manager-owned (proxyUrl filled
  // by the rotation job) and must pass through verbatim — running them through
  // the group normaliser would drop empty placeholders and strip live `_px`
  // metadata.
  const validTypes = ["http", "vercel", "cloudflare", "deno", "proxyxoay", "netlify"];
  const nextType = Object.prototype.hasOwnProperty.call(body, "type")
    ? (validTypes.includes(body?.type) ? body.type : "http")
    : (existing?.type || "http");
  const isProxyXoay = nextType === "proxyxoay";

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return { error: "Name is required" };
    }
    updates.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
    const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    // proxyUrl may be empty for a group pool (entries hold the proxies).
    updates.proxyUrl = proxyUrl;
  }

  if (Object.prototype.hasOwnProperty.call(body, "noProxy")) {
    updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  }

  if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "strictProxy")) {
    updates.strictProxy = body?.strictProxy === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    // Fixed: "deno" was missing here, so editing a deno pool downgraded it to http.
    updates.type = validTypes.includes(body?.type) ? body.type : "http";
  }

  // Proxy-group fields
  if (Object.prototype.hasOwnProperty.call(body, "isGroup")) {
    updates.isGroup = body?.isGroup === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "rotationMode")) {
    updates.rotationMode = ["on-error", "round-robin", "random"].includes(body?.rotationMode)
      ? body.rotationMode
      : "on-error";
  }
  if (Object.prototype.hasOwnProperty.call(body, "entries")) {
    const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
    // proxyxoay entries are manager-owned (their proxyUrl is filled by the
    // rotation job); accept them verbatim without re-running the URL normaliser
    // so we don't clobber the live `_px` metadata / empty placeholder URLs.
    updates.entries = isProxyXoay
      ? rawEntries
      : rawEntries.map(normalizeGroupEntry).filter(Boolean);
  }

  // proxyxoay provider-config fields (pass through; keys are normalised below).
  if (Object.prototype.hasOwnProperty.call(body, "liveMinutes")) {
    const n = parseInt(body?.liveMinutes, 10);
    updates.liveMinutes = Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 5;
  }
  if (Object.prototype.hasOwnProperty.call(body, "protocol")) {
    updates.protocol = body?.protocol === "socks5" ? "socks5" : "http";
  }
  if (Object.prototype.hasOwnProperty.call(body, "autoRotate")) {
    updates.autoRotate = body?.autoRotate === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "forwardEnabled")) {
    updates.forwardEnabled = body?.forwardEnabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "keys")) {
    const result = normalizeProxyXoayKeys(body.keys);
    if (result.error) return { error: result.error };
    updates.keys = result.keys;
    // Re-seed entries 1:1 with the new keys (manager refills proxyUrl). When a
    // key keeps its id (frontend re-sends it), carry the existing entry over —
    // live proxyUrl + `_px` metadata included — so an edit doesn't wipe every
    // proxy and force a re-fetch of the whole pool against the provider
    // rate-limit. Keys sent as plain strings always get fresh ids/entries.
    const prevById = new Map(
      (isProxyXoay && Array.isArray(existing?.entries) ? existing.entries : [])
        .map((e) => [e?.id, e])
    );
    const nextProtocol = Object.prototype.hasOwnProperty.call(body, "protocol")
      ? (body?.protocol === "socks5" ? "socks5" : "http")
      : null;
    updates.entries = result.keys.map((k) => {
      const prev = prevById.get(k.id);
      if (prev) {
        // Keep the live proxy state; only the label (and protocol, when the
        // edit changed it) is refreshed — the next rotation fetches with the
        // new protocol anyway.
        return nextProtocol
          ? { ...prev, name: k.label, type: nextProtocol }
          : { ...prev, name: k.label };
      }
      return {
        id: k.id,
        name: k.label,
        type: nextProtocol || "http",
        proxyUrl: "",
        isActive: true,
        cooldownUntil: null,
        lastError: null,
        lastUsedAt: null,
        _px: null,
      };
    });
  }

  return { updates };
}

// Normalise a bulk key list (strings or {apiKey,label}) into deduped key objects
// with stable ids. Mirrors the POST route's logic so edits validate identically.
function normalizeProxyXoayKeys(rawKeys) {
  const seen = new Set();
  const keys = [];
  for (const k of Array.isArray(rawKeys) ? rawKeys : []) {
    let apiKey = "";
    let label = "";
    let id;
    if (typeof k === "string") {
      apiKey = k.trim();
    } else if (k && typeof k === "object") {
      apiKey = String(k.apiKey || "").trim();
      label = typeof k.label === "string" ? k.label.trim() : "";
      if (typeof k.id === "string" && k.id) id = k.id;
    }
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    keys.push({
      id: id || `px_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      apiKey,
      label: label || `key …${apiKey.slice(-5)}`,
    });
  }
  if (keys.length === 0) return { error: "At least one proxyxoay API key is required" };
  return { keys };
}

function countBoundConnections(connections = [], proxyPoolId) {
  return connections.filter((connection) => connection?.providerSpecificData?.proxyPoolId === proxyPoolId).length;
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    return NextResponse.json({ proxyPool });
  } catch (error) {
    console.log("Error fetching proxy pool:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 });
  }
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const normalized = normalizeProxyPoolUpdate(body, existing);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const updated = await updateProxyPool(id, normalized.updates);
    if (existing.type === "proxyxoay") {
      if (updated?.type === "proxyxoay") {
        // Re-register so the manager picks up key/config changes (timers +
        // forwarding servers are rebuilt). Fire-and-forget.
        registerPool(updated).catch((e) =>
          console.warn("[proxyxoay] registerPool after update failed:", e?.message || e)
        );
      } else {
        // Converted to another pool type — stop the rotation timers and
        // forwarding servers. Fire-and-forget (see DELETE).
        unregisterPool(id).catch(() => {});
      }
    }
    return NextResponse.json({ proxyPool: updated });
  } catch (error) {
    console.log("Error updating proxy pool:", error);
    return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 });
  }
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    // Protect the auto-managed v2go/xray pool — it is recreated by the xray
    // manager on every start, so deleting it just causes confusion. Stop the
    // xray proxy from the V2Ray Proxy page instead.
    if (id === "v2go-xray-managed" || existing._v2goManaged === true) {
      return NextResponse.json(
        { error: "This pool is auto-managed by the V2Ray Proxy feature and cannot be deleted. Stop the proxy from the V2Ray Proxy page instead." },
        { status: 403 }
      );
    }

    // Provider strategies bound to this pool (P3): deleting under them would
    // leave a dangling proxyPoolId whose provider silently goes direct. Names
    // only — never leak connection credentials in the 409 body.
    const settings = await getSettings();
    const providerStrategies = settings?.providerStrategies || {};
    const boundProviders = Object.entries(providerStrategies)
      .filter(([, strategy]) => strategy?.proxyPoolId === id)
      .map(([providerId]) => providerId);

    let force = false;
    try {
      const body = await request.json();
      force = body?.force === true;
    } catch {
      // No/invalid body — plain delete.
    }

    if (boundProviders.length > 0) {
      if (!force) {
        return NextResponse.json(
          {
            error: "Proxy pool is bound to provider strategies",
            boundProviders,
            hint: "Re-send with { force: true } to unbind these strategies and delete the pool.",
          },
          { status: 409 }
        );
      }
      // Force: unbind each referencing strategy (explicit "__none__" so the
      // provider never silently falls back to an unknown pool), then delete.
      const next = { ...providerStrategies };
      for (const providerId of boundProviders) {
        next[providerId] = { ...next[providerId], proxyPoolId: "__none__" };
      }
      await updateSettings({ providerStrategies: next });
    }

    const connections = await getProviderConnections();
    const boundConnectionCount = countBoundConnections(connections, id);

    if (boundConnectionCount > 0) {
      return NextResponse.json(
        {
          error: "Proxy pool is currently in use",
          boundConnectionCount,
        },
        { status: 409 }
      );
    }

    // Stop rotation timers + forwarding servers before removing a proxyxoay pool.
    // Fire-and-forget: teardown (proxy-chain close) must not block or hang the
    // delete response; the manager re-reads the pool from DB on any in-flight
    // tick and bails out once the row is gone.
    if (existing.type === "proxyxoay") {
      unregisterPool(id).catch(() => {});
    }

    await deleteProxyPool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}
