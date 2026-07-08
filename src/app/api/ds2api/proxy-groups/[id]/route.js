import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

export async function PUT(request, { params }) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const { id } = await params;
    const decoded = decodeURIComponent(Array.isArray(id) ? id.join("/") : id);
    const body = await request.json();
    return NextResponse.json(await admin.updateProxyGroup(base, adminKey, decoded, body));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}

export async function DELETE(_request, { params }) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const { id } = await params;
    const decoded = decodeURIComponent(Array.isArray(id) ? id.join("/") : id);
    return NextResponse.json(await admin.deleteProxyGroup(base, adminKey, decoded));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
