import { NextResponse } from "next/server";
import { rekeyApiKey } from "@/lib/localDb";
import { checkRekeyLock, recordRekeyFail, recordRekeySuccess } from "@/lib/auth/rekeyLimiter";

export const dynamic = "force-dynamic";

const LOCK_MESSAGE = "Too many re-key attempts — try again in 15 minutes";

// POST /api/keys/[id]/rekey — re-hash an inert imported key against this
// install's secret after a masked-compare ownership proof (phase-03). Guarded
// by the same deny-by-default proxy protection as PUT/DELETE on /api/keys.
// The pasted raw key NEVER appears in any response or log.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { rawKey } = body ?? {};

    const lock = checkRekeyLock(id);
    if (lock.locked) {
      return NextResponse.json(
        { error: LOCK_MESSAGE },
        { status: 429, headers: { "Retry-After": String(Math.max(1, lock.retryAfter ?? 900)) } }
      );
    }

    const result = await rekeyApiKey(id, rawKey);
    if (result.error === "not_found") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    if (result.error === "invalid") {
      return NextResponse.json({ error: "Invalid key format" }, { status: 400 });
    }
    if (result.error === "not_needed") {
      return NextResponse.json({ error: "This key does not need re-keying" }, { status: 409 });
    }
    if (result.error === "mismatch") {
      // RT-11: every mismatch on a flagged row counts toward the lockout.
      const fail = recordRekeyFail(id);
      if (fail.lockedNow) {
        return NextResponse.json(
          { error: LOCK_MESSAGE },
          { status: 429, headers: { "Retry-After": String(Math.max(1, fail.retryAfter ?? 900)) } }
        );
      }
      return NextResponse.json({ error: "That raw key does not match this key entry" }, { status: 400 });
    }

    recordRekeySuccess(id);
    return NextResponse.json({ key: result.key }); // masked display value only
  } catch (error) {
    console.log("Error re-keying key:", error.message);
    return NextResponse.json({ error: "Failed to re-key" }, { status: 500 });
  }
}
