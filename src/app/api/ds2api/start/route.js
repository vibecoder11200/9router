import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { startDS2API } from "@/lib/ds2api/process";
import { DEFAULT_DS2API_URL, isLoopbackDS2APIUrl } from "@/lib/ds2api/detect";

export const dynamic = "force-dynamic";

function parsePortFromUrl(url) {
  try {
    const u = new URL(url);
    const p = parseInt(u.port, 10);
    if (p > 0 && p < 65536) return p;
  } catch { /* ignore */ }
  return null;
}

export async function POST() {
  try {
    const settings = await getSettings();
    const url = settings.ds2apiUrl || DEFAULT_DS2API_URL;
    if (!isLoopbackDS2APIUrl(url)) {
      return NextResponse.json({ error: "External DS2API must be started outside 9Router", code: "EXTERNAL_PROXY" }, { status: 400 });
    }
    const port = parsePortFromUrl(url) || 5001;
    const result = await startDS2API({ port });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
