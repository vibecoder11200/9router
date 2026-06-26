import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

async function guard() {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) return { err: NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 }) };
  return { base, adminKey };
}

export async function GET() {
  const ctx = await guard();
  if (ctx.err) return ctx.err;
  try {
    return NextResponse.json(await admin.listProxies(ctx.base, ctx.adminKey));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}

export async function POST(request) {
  const ctx = await guard();
  if (ctx.err) return ctx.err;
  try {
    const body = await request.json();
    return NextResponse.json(await admin.addProxy(ctx.base, ctx.adminKey, body));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}

export async function DELETE(request) {
  const ctx = await guard();
  if (ctx.err) return ctx.err;
  try {
    const { id } = await request.json().catch(() => ({}));
    if (!id) return NextResponse.json({ error: "Proxy id required" }, { status: 400 });
    return NextResponse.json(await admin.deleteProxy(ctx.base, ctx.adminKey, id));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
