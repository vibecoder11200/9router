import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_DS2API_URL, getDS2APIStatus } from "@/lib/ds2api/detect";
import { applyDs2apiUrl } from "@/lib/ds2api/resolve";
import { getManagedPid } from "@/lib/ds2api/process";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const url = settings.ds2apiUrl || DEFAULT_DS2API_URL;
    // Keep provider routing in sync with the configured URL (applied on every dashboard load).
    applyDs2apiUrl(url);
    const status = await getDS2APIStatus(url);
    const managedPid = getManagedPid();
    return NextResponse.json({ ...status, url, managedPid });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
