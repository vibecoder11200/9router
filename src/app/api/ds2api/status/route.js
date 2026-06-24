import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_DS2API_URL, getDS2APIStatus } from "@/lib/ds2api/detect";
import { getManagedPid } from "@/lib/ds2api/process";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const url = settings.ds2apiUrl || DEFAULT_DS2API_URL;
    const status = await getDS2APIStatus(url);
    const managedPid = getManagedPid();
    return NextResponse.json({ ...status, url, managedPid });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
