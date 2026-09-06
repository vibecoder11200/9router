// Whole-archive encryption primitives for encrypted database export files
// (v0.6.46 Option F). Leaf module — only node:crypto and the parameterized
// backup envelope. The archive is the envelope's outer container:
//
//   { format: "9router-encrypted-archive", v: 1, envelope: <backupEnvelope v1> }
//
// Domain separation from the .45 install-secret envelope lives in the AAD
// (AAD_ARCHIVE_V1), not in new KDF params — the frozen scrypt tuple and the
// RT-01 param whitelist are reused verbatim, so a .46 archive envelope can
// never be replayed as a .45 secret envelope or vice versa.
//
// Passphrase policy split (deliberate): this module is policy-free about
// length — sealArchive only requires a non-empty passphrase after
// normalization so a future-tighter floor never bricks old archives. The
// length floor (MIN_ARCHIVE_PASSPHRASE_LENGTH, enforced on BOTH the raw and
// normalized strings per RT46-A7) is the route/UX layer's duty at export
// time; validateArchivePassphrase exists for that layer to call.
//
// Passphrases are effectively printable-ASCII-bounded — the phase-02 charset
// gate at the route layer enforces it; this module never stores or logs the
// passphrase. Normalization is SYMMETRIC (applied identically at seal and
// open) so exact retyping always works, but note the entropy disclosure
// (RT46-A7): I and L are treated as 1, O as 0; spaces and hyphens are
// ignored — each I/L/O costs ~1.58 bits and separators count for nothing.
import crypto from "node:crypto";
import {
  sealBackupSecret,
  openBackupSecret,
  AAD_ARCHIVE_V1,
} from "@/lib/auth/backupEnvelope.js";

export const ARCHIVE_FORMAT = "9router-encrypted-archive";
export const ARCHIVE_V = 1;
export const MIN_ARCHIVE_PASSPHRASE_LENGTH = 10;

// Crockford Base32: 0-9 A-Z minus I, L, O, U — exactly 32 symbols, so
// `byte % 32` over crypto.randomBytes is bias-free (256 % 32 === 0; the
// length-32 invariant is frozen by a unit test).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const OPEN_ARCHIVE_FAILED = "wrong archive passphrase or corrupted archive";

export class ArchiveError extends Error {
  constructor(message = OPEN_ARCHIVE_FAILED) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Generate a random passphrase: 20 Crockford chars (100 bits) displayed as
 * four hyphen-joined 5-char groups, e.g. "XXXXX-XXXXX-XXXXX-XXXXX".
 */
export function generateArchivePassphrase() {
  const bytes = crypto.randomBytes(20);
  const chars = Array.from(bytes, (b) => CROCKFORD_ALPHABET[b % 32]);
  return [
    chars.slice(0, 5).join(""),
    chars.slice(5, 10).join(""),
    chars.slice(10, 15).join(""),
    chars.slice(15, 20).join(""),
  ].join("-");
}

/**
 * Symmetric passphrase normalization: uppercase, strip spaces/hyphens, fold
 * I/L→1 and O→0 (Crockford-standard). Applied identically at seal and open.
 * Returns "" for non-string or empty input.
 */
export function normalizeArchivePassphrase(s) {
  if (typeof s !== "string" || s.length === 0) return "";
  return s
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/**
 * Length floor gate for the route/UX layer (export time only).
 * RT46-A7: BOTH the raw AND the normalized string must be >= 10 chars —
 * normalization only shrinks (strips separators), so raw < 10 implies
 * normalized < 10; requiring both closes the "raw padded to length" hole.
 */
export function validateArchivePassphrase(raw) {
  if (typeof raw !== "string") return false;
  if (raw.length < MIN_ARCHIVE_PASSPHRASE_LENGTH) return false;
  return normalizeArchivePassphrase(raw).length >= MIN_ARCHIVE_PASSPHRASE_LENGTH;
}

/**
 * Seal a JSON string into an encrypted-archive file object. Passphrase must
 * be non-empty after normalization; the length floor is NOT enforced here
 * (see the policy split in the module doc).
 */
export async function sealArchive(jsonString, rawPassphrase) {
  const passphrase = normalizeArchivePassphrase(rawPassphrase);
  const envelope = await sealBackupSecret(jsonString, passphrase, {
    aad: AAD_ARCHIVE_V1,
  });
  return { format: ARCHIVE_FORMAT, v: ARCHIVE_V, envelope };
}

/**
 * Detection key only — a truthy result says "this is an encrypted archive
 * file", not that the inner envelope is well-formed (that is open()'s job).
 */
export function isEncryptedArchive(v) {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    v.format === ARCHIVE_FORMAT
  );
}

/**
 * Open an encrypted-archive file back into the inner JSON string (the caller
 * does JSON.parse). ANY failure — wrong passphrase, tamper, wrong domain,
 * malformed file — throws a single normalized ArchiveError with no input
 * echo and no partial output.
 */
export async function openArchive(file, rawPassphrase) {
  const passphrase = normalizeArchivePassphrase(rawPassphrase);
  try {
    return await openBackupSecret(file?.envelope, passphrase, {
      aad: AAD_ARCHIVE_V1,
    });
  } catch {
    throw new ArchiveError(OPEN_ARCHIVE_FAILED);
  }
}
