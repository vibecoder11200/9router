import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

async function guard() {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) return { err: NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 }) };
  return { base, adminKey };
}

// Tests connectivity of an existing proxy (proxy_id) or an ad-hoc proxy object.
export async function POST(request) {
  const ctx = await guard();
  if (ctx.err) return ctx.err;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await admin.testProxy(ctx.base, ctx.adminKey, body));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
