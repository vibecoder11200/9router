import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/dashboardGuard";

const PASSWORD_HEADER = "x-9r-password";

// S1: the CLI-token path must present the REAL per-install token (constant-time
// compared in the guard) — not just any value in the header. Previously any
// dashboard session could add the header and skip password re-auth if the
// middleware layer were ever bypassed.
async function authorized(request, password) {
  if (await hasValidCliToken(request)) return true;
  return verifyDashboardPassword(password, request);
}

export async function GET(request) {
  try {
    if (!(await authorized(request, request.headers.get("x-9r-password")))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = await exportDb();
    // N12: full-credential artifact — never cacheable by intermediaries.
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    if (!(await authorized(request, password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const restored = await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true, warnings: restored?.warnings || [] });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
