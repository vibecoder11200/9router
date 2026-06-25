import { NextResponse } from "next/server";
import { getInstallStatus } from "@/lib/ds2api/install";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getInstallStatus());
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
