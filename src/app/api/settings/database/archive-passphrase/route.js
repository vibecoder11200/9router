// GET /api/settings/database/archive-passphrase — "Generate for me" backend
// for v0.6.46 Option F. Returns fresh randomness only, but treat it as
// sensitive anyway: it may become someone's archive key, so the response is
// never logged and is marked no-store. Auth mirrors the database route's
// POST path (CLI token OR bcrypt-verified dashboard password) behind the
// same login limiter.
import { NextResponse } from "next/server";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/dashboardGuard";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { generateArchivePassphrase } from "@/lib/db/archive.js";

const PASSWORD_HEADER = "x-9r-password";

function lockedResponse(lock) {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
    { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
  );
}

function failWithLimiter(ip) {
  const { remainingBeforeLock } = recordFail(ip);
  const postLock = checkLock(ip);
  if (postLock.locked) return lockedResponse(postLock);
  return {
    response: NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.` },
      { status: 401 }
    ),
  };
}

export async function GET(request) {
  try {
    const password = request.headers.get(PASSWORD_HEADER);
    const hasPw = typeof password === "string" && password.length > 0;
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) return lockedResponse(lock);
    const pwOk = hasPw && (await verifyDashboardPassword(password, request));
    const viaCliToken = await hasValidCliToken(request);
    if (!viaCliToken && !pwOk) return failWithLimiter(ip).response;
    if (pwOk) recordSuccess(ip);

    // N12: sensitive-adjacent value — never cacheable by intermediaries. The
    // passphrase value itself is never logged anywhere in this handler.
    return NextResponse.json(
      { passphrase: generateArchivePassphrase() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    // Log only the message; this path cannot contain passphrase material
    // (generation happens after auth), but stay conservative regardless.
    console.log("Error generating archive passphrase:", error?.message);
    return NextResponse.json({ error: "Failed to generate passphrase" }, { status: 500 });
  }
}
