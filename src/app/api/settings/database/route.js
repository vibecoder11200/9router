import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import {
  verifyDashboardPassword,
  verifyDashboardPasswordAgainstStoredHash,
} from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/dashboardGuard";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

const PASSWORD_HEADER = "x-9r-password";

function lockedResponse(lock) {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
    { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
  );
}

// RT-08: this route hands back the whole DB (plus, on GET, the wrapped key
// secret) — the password path must be throttled exactly like login.
function failWithLimiter(ip) {
  const { remainingBeforeLock } = recordFail(ip);
  const postLock = checkLock(ip);
  if (postLock.locked) return { response: lockedResponse(postLock) };
  return {
    response: NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.` },
      { status: 401 }
    ),
  };
}

// RT-03 / RT-Cli: the wrap-password is derived from the header on BOTH auth
// paths, and it must verify against the STORED bcrypt hash only (no
// "123456"/INITIAL_PASSWORD fallback — a backup sealed under the default
// password would leak every keyHash). A valid CLI token with a BAD password
// is rejected: no silent envelope-less downgrade and no guessing oracle.
export async function GET(request) {
  try {
    const password = request.headers.get(PASSWORD_HEADER);
    const hasPw = typeof password === "string" && password.length > 0;
    const ip = getClientIp(request);
    if (hasPw) {
      const lock = checkLock(ip);
      if (lock.locked) return lockedResponse(lock);
    }
    const pwOk = hasPw && (await verifyDashboardPasswordAgainstStoredHash(password));
    // Auth keeps the full baseline semantics (stored bcrypt OR the local
    // default/initial password); SEALING is gated separately on pwOk (RT-03).
    // An install without a stored password still authenticates and exports
    // envelope-less + warning (RT-17) instead of being locked out of export.
    const authOk = pwOk || (hasPw && (await verifyDashboardPassword(password, request)));
    const viaCliToken = await hasValidCliToken(request);
    if (!viaCliToken && !authOk) {
      return hasPw ? failWithLimiter(ip).response
        : NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    if (hasPw && !authOk) {
      // token + wrong password = reject, don't downgrade to envelope-less.
      return failWithLimiter(ip).response;
    }
    if (hasPw) recordSuccess(ip);

    const payload = await exportDb(pwOk ? { password } : {});
    if (!pwOk) {
      // Envelope-less export (CLI-token path or no password offered): honest
      // warning so the operator knows the archive is not key-portable.
      payload.warnings = [
        ...(payload.warnings || []),
        "This backup does not include the encrypted API-key secret (no dashboard password was used). API keys restored from it on another install will need re-keying — export with your dashboard password for portable backups.",
      ];
    }
    // N12: full-credential artifact — never cacheable by intermediaries.
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) return lockedResponse(lock);
    const pwOk = await verifyDashboardPassword(password, request);
    const viaCliToken = await hasValidCliToken(request);
    if (!viaCliToken && !pwOk) return failWithLimiter(ip).response;
    if (pwOk) recordSuccess(ip);
    // The CURRENT dashboard password authenticates; if it differs from the
    // export-time password the unwrap inside importDb simply fails and keys
    // are flagged needsRekey (warning carries the count, never plaintext).
    const restored = await importDb(payload, { password: typeof password === "string" ? password : "" });

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({
      success: true,
      warnings: restored?.warnings || [],
      needsRekeyCount: restored?.needsRekeyCount || 0,
    });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
