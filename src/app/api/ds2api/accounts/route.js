import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

export async function GET() {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    return NextResponse.json(await admin.listAccounts(base, adminKey));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}

export async function POST(request) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const account = await request.json();
    return NextResponse.json(await admin.addAccount(base, adminKey, account));
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
