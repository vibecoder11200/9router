import { NextResponse } from "next/server";
import { rollbackXrayOrchestrated } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

/**
 * One-click rollback to the `.prev` binary retained by the last install
 * (RT-5). Restores the exact pre-update files (no download, no checksum
 * re-verification needed — they were verified when first installed) and
 * restarts the proxy if it was running.
 */
export async function POST() {
  try {
    const result = await rollbackXrayOrchestrated();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const statusByCode = {
      NO_PREV: 400,
      ROLLBACK_FAILED: 500,
      INSTALL_IN_PROGRESS: 409,
    };
    const status = statusByCode[error.code] || 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
