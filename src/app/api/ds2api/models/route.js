import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";

export const dynamic = "force-dynamic";

// List models the running sidecar exposes (ds2api GET /v1/models is public).
export async function GET() {
  const { base, managedPid } = await resolveDs2api();
  if (!managedPid) {
    return NextResponse.json({ error: "DS2API sidecar is not running", models: [] }, { status: 503 });
  }
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return NextResponse.json({ error: `sidecar /v1/models failed (${res.status})`, models: [] }, { status: 502 });
    const models = Array.isArray(data?.data) ? data.data : [];
    return NextResponse.json({ models });
  } catch (error) {
    return NextResponse.json({ error: error.message, models: [] }, { status: 500 });
  }
}
