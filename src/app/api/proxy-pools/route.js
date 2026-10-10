import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";
import { normalizeProxyInput } from "@/lib/proxy/parseProxy";
import { registerPool } from "@/lib/proxy/providers/proxyxoayManager.js";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "proxyxoay", "netlify"];

// Proxy schemes accepted at the network layer (undici ProxyAgent / env proxy).
// Group entries can use any of these; "direct" means no proxy (server IP).
const VALID_PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks4a:"];

function normalizeGroupEntry(e, i) {
  if (e?.type === "direct") {
    return {
      id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
      name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : "Direct (server IP)",
      type: "direct",
      proxyUrl: "",
      isActive: e?.isActive !== false,
      cooldownUntil: null,
      lastError: null,
      lastUsedAt: null,
    };
  }
  const entryUrl = typeof e?.proxyUrl === "string" ? e.proxyUrl.trim() : "";
  if (!entryUrl) return null;
  // Canonicalise through the multi-format parser first: this accepts reversed
  // `scheme://host:port@user:pass`, bare `host:port:user:pass`, etc., and emits
  // a standard URL that undici understands. Reject if it can't be parsed or the
  // scheme isn't a supported proxy scheme.
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
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
  };
}

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  // proxyxoay.org rotating-provider pool: a group whose entries are 1:1 with
  // the user's API keys. The manager fills each entry's proxyUrl by polling the
  // provider; the resolver rotates across keys like any group.
  if (type === "proxyxoay") {
    return normalizeProxyXoayInput(body, { name, noProxy, isActive, strictProxy });
  }

  // Proxy group: holds multiple entries instead of a single proxyUrl.
  const isGroup = body?.isGroup === true;
  if (isGroup) {
    const rotationMode = ["on-error", "round-robin", "random"].includes(body?.rotationMode)
      ? body.rotationMode
      : "on-error";
    const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
    const entries = rawEntries.map(normalizeGroupEntry).filter(Boolean);
    if (entries.length === 0) {
      return { error: "A proxy group needs at least one valid entry" };
    }
    return { name, proxyUrl: "", noProxy, isActive, strictProxy, type: "http", isGroup: true, rotationMode, entries, rrCounter: 0 };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  // Relay pools (vercel/cloudflare/deno) store a relay *base URL* (with a path)
  // in `proxyUrl`, not a proxy URL — leave it untouched. Standard pools store a
  // real proxy URL: canonicalise it through the multi-format parser so reversed
  // / colon forms become a standard URL undici can consume.
  const isRelay = type === "vercel" || type === "cloudflare" || type === "deno";
  if (isRelay) {
    return { name, proxyUrl, noProxy, isActive, strictProxy, type };
  }
  const norm = normalizeProxyInput(proxyUrl);
  if (!norm.ok) {
    return { error: `Invalid proxy URL: ${norm.error}` };
  }
  return { name, proxyUrl: norm.canonicalUrl, noProxy, isActive, strictProxy, type };
}

function normalizeProxyXoayInput(body = {}, base = {}) {
  const { name, noProxy, isActive, strictProxy } = base;
  // Keys may arrive as strings (bulk-add textarea, one per line is split
  // client-side) or as { apiKey, label } objects.
  const rawKeys = Array.isArray(body?.keys) ? body.keys : [];
  const seen = new Set();
  const keys = [];
  for (const k of rawKeys) {
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
  if (keys.length === 0) {
    return { error: "At least one proxyxoay API key is required" };
  }

  const liveMinutes = (() => {
    const n = parseInt(body?.liveMinutes, 10);
    return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 5;
  })();
  const protocol = body?.protocol === "socks5" ? "socks5" : "http";
  const rotationMode = ["on-error", "round-robin", "random"].includes(body?.rotationMode)
    ? body.rotationMode
    : "on-error";
  const autoRotate = body?.autoRotate !== false;
  const forwardEnabled = body?.forwardEnabled === true;

  // Seed one (empty) entry per key — the manager fills proxyUrl on first fetch.
  const entries = keys.map((k) => ({
    id: k.id,
    name: k.label,
    type: protocol,
    proxyUrl: "",
    isActive: true,
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
    _px: null,
  }));

  return {
    name,
    proxyUrl: "",
    noProxy,
    isActive,
    strictProxy,
    type: "proxyxoay",
    isGroup: true,
    rotationMode,
    keys,
    liveMinutes,
    protocol,
    autoRotate,
    forwardEnabled,
    entries,
    rrCounter: 0,
    forwardPorts: {},
  };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return NextResponse.json({ proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));

    return NextResponse.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    // For proxyxoay pools, kick off the manager (initial fetch + timers) in the
    // background so the create response returns immediately.
    if (proxyPool?.type === "proxyxoay") {
      registerPool(proxyPool).catch((e) =>
        console.warn("[proxyxoay] registerPool after create failed:", e?.message || e)
      );
    }
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
