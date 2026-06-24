import { NextResponse } from "next/server";
import { stopDS2API } from "@/lib/ds2api/process";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = stopDS2API();
    const status = result.stopped ? 200 : 409;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
