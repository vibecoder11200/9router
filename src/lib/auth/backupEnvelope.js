// Password-wrapped backup envelope for the install secret (v0.6.45 key
// portability). scrypt + AES-256-GCM; params travel in-band but v:1 is
// HARD-PINNED to the exact frozen tuple (RT-01) — the opener rejects any
// deviation before touching scrypt, and maxmem is always the frozen
// constant, never derived from envelope fields. Deliberately a leaf
// module — only node:crypto — so phase 02's exportDb/importDb and any
// test context can use it cheaply. Never logs password/secret/plaintext;
// all error messages are generic constants.
//
// AAD domain separation (v0.6.46): the AAD is an allowlisted parameter so
// the .46 whole-archive envelope can reuse this exact code — scrypt tuple,
// whitelist, error normalization — with a different domain tag. Exactly two
// constants exist; seal/open/is reject anything else, which prevents an
// accidental third domain. Existing callers pass nothing and get
// AAD_BACKUP_V1, byte-identical to the old private const.
import crypto from "node:crypto";

export const AAD_BACKUP_V1 = "9router-backup-v1";
export const AAD_ARCHIVE_V1 = "9router-archive-v1";
const AAD_ALLOWED = Object.freeze([AAD_BACKUP_V1, AAD_ARCHIVE_V1]);
const PARAMS = Object.freeze({
  N: 65536,
  r: 8,
  p: 1,
  keylen: 32,
  maxmem: 128 * 1024 * 1024,
});
// Test-only override (RT-02): lets the suite drop N (e.g. 4096) for speed.
// Production paths never read any env var; seal/open read `active.N` etc.
const active = { N: PARAMS.N };

const OPEN_FAILED = "backup envelope could not be opened";
const INVALID_SEAL_INPUT = "invalid seal input";

export class BackupEnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupEnvelopeError";
  }
}

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export function isBackupEnvelope(v, aad = AAD_BACKUP_V1) {
  if (!AAD_ALLOWED.includes(aad)) return false;
  return Boolean(
    v &&
    v.v === 1 &&
    v.cipher === "aes-256-gcm" &&
    v.kdf === "scrypt" &&
    typeof v.salt === "string" &&
    typeof v.nonce === "string" &&
    typeof v.ct === "string" &&
    typeof v.tag === "string" &&
    v.aad === aad
  );
}

export async function sealBackupSecret(secret, password, { aad = AAD_BACKUP_V1 } = {}) {
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof password !== "string" ||
    password.length === 0 ||
    !AAD_ALLOWED.includes(aad)
  ) {
    throw new BackupEnvelopeError(INVALID_SEAL_INPUT);
  }
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = await scryptAsync(password, salt, PARAMS.keylen, {
    N: active.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    N: active.N,
    r: PARAMS.r,
    p: PARAMS.p,
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
    aad,
  };
}

export async function openBackupSecret(envelope, password, { aad = AAD_BACKUP_V1 } = {}) {
  if (!isBackupEnvelope(envelope, aad)) {
    throw new BackupEnvelopeError(OPEN_FAILED);
  }
  // RT-01: v:1 accepts EXACTLY the frozen tuple (r/p always; N via the
  // active value, which only tests change — see _setEnvelopeParamsForTests).
  // Integer checks come FIRST — NaN slips through > / <= comparisons
  // silently. Any deviation (including non-integers) is rejected before
  // scrypt runs, so crafted params can never force an outsized allocation.
  if (
    !Number.isInteger(envelope.N) ||
    !Number.isInteger(envelope.r) ||
    !Number.isInteger(envelope.p) ||
    envelope.N !== active.N ||
    envelope.r !== PARAMS.r ||
    envelope.p !== PARAMS.p
  ) {
    throw new BackupEnvelopeError(OPEN_FAILED);
  }
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const key = await scryptAsync(password, salt, PARAMS.keylen, {
      N: active.N,
      r: PARAMS.r,
      p: PARAMS.p,
      maxmem: PARAMS.maxmem,
    });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    // Wrong password, tamper, or malformed base64 — one normalized error,
    // never echoing any input. (Open-path scrypt only ever runs with the
    // frozen params, so the whitelist above keeps raw TypeErrors out too.)
    throw new BackupEnvelopeError(OPEN_FAILED);
  }
}

// RT-02: test-only hook. Tests pass {N: <small>} to keep the suite fast;
// the default matches the frozen production tuple. Returns previous value
// so callers can restore.
export function _setEnvelopeParamsForTests({ N } = {}) {
  const prev = active.N;
  if (Number.isInteger(N) && N > 0) active.N = N;
  else active.N = PARAMS.N;
  return prev;
}
