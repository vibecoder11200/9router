import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import { getInstallStatus } from "@/lib/ds2api/install";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

export async function GET() {
  const install = getInstallStatus();
  const { base, adminKey, managedPid, apiKey } = await resolveDs2api();
  const info = { install, running: !!managedPid, managedKeyPresent: !!apiKey, managedKey: apiKey || null };

  if (managedPid && adminKey) {
    try {
      info.version = await admin.getVersion(base, adminKey);
    } catch (error) {
      info.versionError = error.message;
    }
  }
  return NextResponse.json(info);
}
