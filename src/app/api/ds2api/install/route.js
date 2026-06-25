import { NextResponse } from "next/server";
import { installDS2API } from "@/lib/ds2api/install";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request) {
  try {
    const { force } = await request.json().catch(() => ({}));
    const result = await installDS2API({ force: !!force });
    return NextResponse.json(result);
  } catch (error) {
    const status = error.code === "UNSUPPORTED_PLATFORM" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
