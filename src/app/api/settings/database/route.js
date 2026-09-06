import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import {
  verifyDashboardPassword,
  verifyDashboardPasswordAgainstStoredHash,
} from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/dashboardGuard";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import {
  sealArchive,
  openArchive,
  ArchiveError,
  validateArchivePassphrase,
} from "@/lib/db/archive.js";

const PASSWORD_HEADER = "x-9r-password";
const ARCHIVE_PASSPHRASE_HEADER = "x-9r-archive-passphrase";

// RT46-A3: printable-ASCII-only passphrases. Browser fetch truncates chars
// U+0100–U+01FF (`codepoint & 0xFF`) — a header-sealed archive would live
// under a TRANSFORMED passphrase and be unopenable from every surface. This
// server-side gate is the backstop covering every client at once.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

// RT46-A4: constant error for wrong passphrase / tamper / non-JSON decrypted
// payload. JSON.parse SyntaxError messages embed a snippet of the DECRYPTED
// payload — never log or return those, only this constant.
const WRONG_ARCHIVE = "Wrong archive passphrase or corrupted archive";

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

    // v0.6.46 Option F: passphrase-sealed whole-archive export. The release
    // gate for the PLAIN install secrets is pwOk || viaCliToken (RT46-A1) —
    // the authOk default/initial-password branch can NEVER reach plainSecrets,
    // same as it can never reach the .45 envelope (the seal key being a fresh
    // passphrase changes nothing about the RELEASE gate).
    const archivePassphrase = request.headers.get(ARCHIVE_PASSPHRASE_HEADER);
    if (typeof archivePassphrase === "string" && archivePassphrase.length > 0) {
      if (!PRINTABLE_ASCII.test(archivePassphrase)) {
        return NextResponse.json(
          { error: "passphrase must be printable ASCII; spaces and hyphens are ignored by normalization" },
          { status: 400 }
        );
      }
      if (!validateArchivePassphrase(archivePassphrase)) {
        return NextResponse.json(
          { error: "Passphrase too short (minimum 10 characters after removing spaces and hyphens)" },
          { status: 400 }
        );
      }
      if (!pwOk && !viaCliToken) {
        return NextResponse.json({ error: "Invalid password" }, { status: 401 });
      }
      // NEVER {password} + plainSecrets together — F suppresses the .45
      // envelope; the secrets ride plain inside the passphrase-sealed payload.
      const payload = await exportDb({ plainSecrets: true });
      // N12: sealed full-secret artifact — never cacheable by intermediaries.
      return NextResponse.json(
        await sealArchive(JSON.stringify(payload), archivePassphrase),
        { headers: { "Cache-Control": "no-store" } }
      );
    }

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
    const body = await request.json();
    const { password, ...payload } = body;
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) return lockedResponse(lock);
    const pwOk = await verifyDashboardPassword(password, request);
    const viaCliToken = await hasValidCliToken(request);
    if (!viaCliToken && !pwOk) return failWithLimiter(ip).response;
    if (pwOk) recordSuccess(ip);

    let innerPayload = payload;
    if (body.archive && typeof body.archive === "object") {
      // v0.6.46 Option F: the route unwraps server-side (browsers lack
      // scrypt) BEFORE importDb — a wrong passphrase hard-fails before the
      // mutex, the shape guard, or any DELETE. No partial import possible.
      const archivePassphrase = typeof body.archivePassphrase === "string" ? body.archivePassphrase : "";
      if (archivePassphrase.length > 0 && !PRINTABLE_ASCII.test(archivePassphrase)) {
        return NextResponse.json(
          { error: "passphrase must be printable ASCII; spaces and hyphens are ignored by normalization" },
          { status: 400 }
        );
      }
      let inner;
      try {
        inner = JSON.parse(await openArchive(body.archive, archivePassphrase));
      } catch (err) {
        // RT46-A4: ArchiveError AND JSON.parse SyntaxErrors (whose messages
        // embed decrypted plaintext) collapse into one constant — log and
        // return the constant only, never the error object or its message.
        if (err instanceof ArchiveError || err instanceof SyntaxError) {
          console.log("Archive open failed:", err instanceof ArchiveError ? err.message : WRONG_ARCHIVE);
          return NextResponse.json({ error: WRONG_ARCHIVE }, { status: 400 });
        }
        throw err;
      }
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
        return NextResponse.json({ error: WRONG_ARCHIVE }, { status: 400 });
      }
      innerPayload = inner;
    } else if (payload?.format === "9router-encrypted-archive") {
      // An F wrapper file accidentally posted as the payload (format key, no
      // archive key) — give the operator the actionable message instead of a
      // generic shape-guard 400.
      return NextResponse.json(
        { error: "This backup file is encrypted — re-import it and provide its passphrase" },
        { status: 400 }
      );
    }

    // The CURRENT dashboard password authenticates; if it differs from the
    // export-time password the unwrap inside importDb simply fails and keys
    // are flagged needsRekey (warning carries the count, never plaintext).
    const restored = await importDb(innerPayload, { password: typeof password === "string" ? password : "" });

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
