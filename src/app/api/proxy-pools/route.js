import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];

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
  // Derive the scheme from the URL; reject unsupported schemes.
  let scheme = "";
  try { scheme = new URL(entryUrl).protocol; } catch { return null; }
  if (!VALID_PROXY_SCHEMES.includes(scheme)) return null;
  return {
    id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
    name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : entryUrl,
    type: scheme.replace(":", ""),
    proxyUrl: entryUrl,
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

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
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
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
