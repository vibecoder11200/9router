import { NextResponse } from "next/server";
import {
  ensureBunInstalled,
  getInstalledBunVersion,
  isBunInstalled,
} from "@/lib/runtime/bunInstaller.js";

export const dynamic = "force-dynamic";

// POST: prewarm the bun runtime (the download-on-demand installer). Idempotent
// — if bun is already installed this is a no-op — and the installer is
// single-flight, so a double-click or a racing chat request shares one
// download instead of spawning two. Long download on slow links: the request
// stays open until it settles; the client shows an installing state.
export async function POST() {
  try {
    const already = isBunInstalled();
    await ensureBunInstalled();
    return NextResponse.json({
      ok: true,
      installed: isBunInstalled(),
      version: getInstalledBunVersion(),
      alreadyInstalled: already,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, installed: isBunInstalled(), error: error.message },
      { status: 500 },
    );
  }
}
