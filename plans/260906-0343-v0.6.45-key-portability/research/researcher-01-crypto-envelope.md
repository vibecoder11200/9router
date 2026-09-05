# Research: Crypto Envelope for v0.6.45/v0.6.46 Backup Encryption

Date: 2026-09-06. Scope: scrypt params, AES-256-GCM envelope in node:crypto, backup-passphrase UX precedent, pepper-in-backup guidance.

## 1. scrypt parameters

### OWASP Password Storage Cheat Sheet (current revision)
Recommended configurations (all r=8; "minimum memory cost" framing, equivalent defensive strength):
- N=2^17, r=8, p=1 (128 MiB)
- N=2^16, r=8, p=2 (64 MiB)
- N=2^15, r=8, p=3 (32 MiB)
- N=2^14, r=8, p=5 (16 MiB)
- N=2^13, r=8, p=10 (8 MiB)

OWASP notes trade-off is "between parallelism and RAM usage"; scrypt itself is a fallback (Argon2id preferred when available — not in stdlib Node, and we have a no-deps constraint, so scrypt is correct here).
Source: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

### Node maxmem math (verified against Node docs)
- `crypto.scrypt` memory need ≈ **128 * N * r bytes**. Constraint enforced: `128*N*r < maxmem`, else `ERR_CRYPTO_SCRYPT_INVALID_PARAMETER`.
- Default maxmem = 32 MiB (33554432). So N=2^17, r=8 needs 128*131072*8 = **128 MiB > 32 MiB → throws** unless `maxmem: 64+N*128*r` style explicit value is passed. Confirmed.
- N=2^16, r=8 = 64 MiB → also exceeds 32 MiB default. N=2^15, r=8 = 32 MiB → borderline (needs maxmem slightly above 32MiB due to overhead; Node docs note actual usage exceeds 128*N*r slightly). Safe rule: always pass explicit `maxmem`.
Source: https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback

### Weak-hardware cost (1-2 vCPU VPS)
Rule of thumb from scrypt literature and RFC 7914: throughput ≈ N*r*2 (mix ops). At r=8:
- N=2^15 (32 MiB): ~50-150 ms on modern x86, ~200-400 ms on weak vCPU. Fine for interactive.
- N=2^16 (64 MiB, p=2): ~100-300 ms modern, ~0.5-1 s weak vCPU. Still acceptable for rare export/import; marginal for every-request login.
- N=2^17 (128 MiB): ~0.3-1 s modern, 1.5-3 s weak vCPU; risks OOM on 512 MB containers.

## 2. AES-256-GCM envelope in Node

- Nonce: **12 bytes random** (`crypto.randomBytes(12)`) — NIST SP 800-38D standard size for GCM; never derive deterministically from password/salt (classic pitfall → nonce reuse catastrophic in GCM, forbidden-attack).
- Tag: `cipher.getAuthTag()` → 16 bytes. Store as separate base64 field (cleaner JSON, versioning-friendly) or appended to ct (age/libsodium style, one fewer field — both fine; separate fields easier to debug).
- AAD: bind a context string via `cipher.setAAD(Buffer.from("9router-backup-v1"))` so a ciphertext can't be replayed as a different artifact type (e.g. envelope swapped into a future "settings-blob" field). Cheap, standard (JWT/COSE/TLS do this).
- Other pitfalls: don't reuse salt across exports of the same password (fresh 16 B salt each export); use `createDecipheriv('aes-256-gcm', key, nonce)` + `decipher.setAuthTag(tag)` **before** `final()` — missing setAuthTag or ignoring final() error = authentication bypass. Keylen 32 bytes for AES-256.

Recommended envelope JSON:
```json
{
  "v": 1,
  "cipher": "aes-256-gcm",
  "kdf": "scrypt",
  "salt": "<b64, 16B>",
  "N": 16384, "r": 8, "p": 2,
  "nonce": "<b64, 12B>",
  "ct": "<b64>",
  "tag": "<b64, 16B>",
  "aad": "9router-backup-v1"
}
```
Storing N/r/p in-band is what Bitwarden/age-style formats do; it makes future parameter upgrades non-breaking (importer reads params, passes maxmem accordingly).

## 3. UX precedent: passphrase shown once at export

- **Bitwarden "password protected" export**: user-chosen password at export; Bitwarden docs explicitly suggest generating it via the built-in generator (i.e. random, not human-memorable) and "save that password in a safe place." No recovery possible. Also offers "account restricted" export bound to account key — analogous to our "wrap with dashboard password" Option.
  Source: https://bitwarden.com/help/export-your-data/
- **1Password**: export (.1pux, since deprecated) reused credentials the user already knows (account password + Secret Key) rather than introducing a novel one-time secret — best-in-class UX, since the failure mode "forgot export passphrase" disappears.
- **GitHub recovery codes / 1Password Emergency Kit**: generated high-entropy artifact shown ONCE with an unavoidable "we cannot recover this" warning and a download/print affordance. This is the pattern for generated secrets.
- **age (filippo.io/age)**: no passphrase UX at all in tool proper; passphrase mode prompts interactively each time; key files are the portable artifact. Lesson: high-entropy keyfile > human passphrase when the tool can present a file.
- Failure stories: widely reported pattern in Bitwarden/keepass forums — users export, lose the password, backup useless. Net industry lean: **prefer an existing credential (dashboard password) over a novel one; if generating a secret, GitHub-recovery-code presentation (show once, force acknowledgment, offer download) is mandatory, plus strong warning.**

## 4. Guidance on encrypting HMAC pepper inside backups

No published standard found for "pepper portability" specifically (pepper is usually assumed non-exportable by design — OWASP cheat sheet defines pepper as stored separately from the hashes, which our design violates on export; the mitigation is exactly envelope-encrypting it with an external secret). Closest analogs:
- **LUKS header backup** (`cryptsetup luksHeaderBackup`): docs warn the header backup contains the master key → must be stored securely; same threat shape as our pepper-in-backup.
- **age key files**: the secret IS the portable artifact; users instructed to `chmod 600` and back it up.
- Practical conclusion: wrapping the pepper with a user-held secret (dashboard password / export passphrase) is the standard mitigations pattern; treat the backup file as key material in docs and threat model.

## Recommendations

1. **scrypt params**: `N=16384 (2^14), r=8, p=2, keylen=32, salt=16B random` — wait: for rare export/import with ~1 s budget, go stronger: **N=2^16 (65536), r=8, p=1, keylen=32, maxmem: 128*65536*8*2 (=128 MiB explicit)**. Rationale: OWASP-approved (64 MiB tier), ~0.5-1 s on weak vCPU fits our rare-operation budget, and import is offline-ish so a 1 s block is tolerable (use async `scrypt` to avoid blocking the event loop per Node docs). If we later use the same KDF for per-login, drop to N=2^15.
   - Importer MUST pass explicit `maxmem` (default 32 MiB throws at N≥2^16).
2. **Envelope**: versioned JSON as above (`v,cipher,kdf,salt,N,r,p,nonce,ct,tag,aad`), tag as separate field, params stored in-band.
3. **AAD**: yes — bind `"9router-backup-v1"`; for v0.6.46 full-archive encryption use a distinct string (e.g. `9router-archive-v1`) so the two artifact types are not interchangeable.
4. **UX**: v0.6.45 reuses dashboard password (1Password pattern — preferred). If v0.6.46 asks for a passphrase, prefer user-chosen with confirmation + "cannot be recovered" warning (Bitwarden pattern); do not generate a one-time secret unless we also ship GitHub-recovery-code-style presentation with forced acknowledgment.

## Unresolved questions
- Do we accept ~1 s event-loop impact on weak VPS at import, or must import be backgrounded (async scrypt already mitigates; use `crypto.scrypt` not `scryptSync`)?
- v0.6.46: single passphrase for whole archive vs per-artifact? (Research suggests whole-archive, one envelope around the tar/zip.)
