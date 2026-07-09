import { NextResponse } from "next/server";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProxyPool,
} from "@/models";

const VALID_PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks4a:"];

function normalizeGroupEntry(e, i) {
  if (e?.type === "direct") {
    return {
      id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
      name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : "Direct (server IP)",
      type: "direct",
      proxyUrl: "",
      isActive: e?.isActive !== false,
      cooldownUntil: e?.cooldownUntil ?? null,
      lastError: e?.lastError ?? null,
      lastUsedAt: e?.lastUsedAt ?? null,
    };
  }
  const entryUrl = typeof e?.proxyUrl === "string" ? e.proxyUrl.trim() : "";
  if (!entryUrl) return null;
  let scheme = "";
  try { scheme = new URL(entryUrl).protocol; } catch { return null; }
  if (!VALID_PROXY_SCHEMES.includes(scheme)) return null;
  return {
    id: typeof e?.id === "string" && e.id ? e.id : `entry_${Date.now()}_${i}`,
    name: typeof e?.name === "string" && e.name.trim() ? e.name.trim() : entryUrl,
    type: scheme.replace(":", ""),
    proxyUrl: entryUrl,
    isActive: e?.isActive !== false,
    cooldownUntil: e?.cooldownUntil ?? null,
    lastError: e?.lastError ?? null,
    lastUsedAt: e?.lastUsedAt ?? null,
  };
}

function normalizeProxyPoolUpdate(body = {}) {
  const updates = {};

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
    const validTypes = ["http", "vercel", "cloudflare", "deno"];
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
    updates.entries = rawEntries.map(normalizeGroupEntry).filter(Boolean);
  }

  return { updates };
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
    const normalized = normalizeProxyPoolUpdate(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const updated = await updateProxyPool(id, normalized.updates);
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

    await deleteProxyPool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}
