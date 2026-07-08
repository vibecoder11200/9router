import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

// Set the outbound proxy config for an account. Two modes:
//  - Legacy fixed proxy: body { proxy_id } → sets a single fixed proxy.
//  - Full config: body { mode, proxy_id, proxy_group_id } → none/fixed/group.
// If `mode` is present we use the full PUT /admin/accounts/{id}; otherwise we
// fall back to the dedicated proxy endpoint for backward compatibility.
export async function PUT(request, { params }) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const { id } = await params;
    const decoded = decodeURIComponent(Array.isArray(id) ? id.join("/") : id);
    const body = await request.json().catch(() => ({}));
    if (body.mode !== undefined) {
      return NextResponse.json(await admin.setAccountProxyConfig(base, adminKey, decoded, {
        mode: body.mode,
        proxyId: body.proxy_id,
        groupId: body.proxy_group_id,
      }));
    }
    return NextResponse.json(await admin.setAccountProxy(base, adminKey, decoded, body.proxy_id || ""));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
