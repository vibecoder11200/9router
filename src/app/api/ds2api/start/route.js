import { NextResponse } from "next/server";
import { startManagedDS2API } from "@/lib/ds2api/lifecycle";

export const dynamic = "force-dynamic";

// Start the managed DS2API sidecar. The full loopback-validate → spawn → inject
// logic lives in src/lib/ds2api/lifecycle.js so the boot auto-start reuses it.
export async function POST() {
  try {
    const result = await startManagedDS2API();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" || error.code === "EXTERNAL_PROXY" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
