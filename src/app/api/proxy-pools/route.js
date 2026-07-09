import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];

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
    const entries = rawEntries
      .map((e, i) => {
        const entryType = e?.type === "direct" ? "direct" : "http";
        const entryUrl = typeof e?.proxyUrl === "string" ? e.proxyUrl.trim() : "";
        // "direct" entries need no URL; "http" entries require one.
        if (entryType !== "direct" && !entryUrl) return null;
        return {
          id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
          name: typeof e?.name === "string" ? e.name.trim() : (entryType === "direct" ? "Direct (server IP)" : entryUrl),
          type: entryType,
          proxyUrl: entryUrl,
          isActive: e?.isActive !== false,
          cooldownUntil: null,
          lastError: null,
          lastUsedAt: null,
        };
      })
      .filter(Boolean);
    if (entries.length === 0) {
      return { error: "A proxy group needs at least one entry" };
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
