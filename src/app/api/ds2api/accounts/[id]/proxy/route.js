import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

// Assign (body.proxy_id) or clear (empty proxy_id) the outbound proxy for an account.
export async function PUT(request, { params }) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const { id } = await params;
    const decoded = decodeURIComponent(Array.isArray(id) ? id.join("/") : id);
    const { proxy_id: proxyId } = await request.json().catch(() => ({}));
    return NextResponse.json(await admin.setAccountProxy(base, adminKey, decoded, proxyId || ""));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
