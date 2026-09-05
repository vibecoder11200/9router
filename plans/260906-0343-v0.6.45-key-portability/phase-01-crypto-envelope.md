# Phase 01 — Crypto Envelope Module (pure)

## Context links

- Research: [researcher-01-crypto-envelope.md](research/researcher-01-crypto-envelope.md) (scrypt params, GCM pitfalls, maxmem math)
- Precedent: [researcher-02-portability-precedent.md](research/researcher-02-portability-precedent.md) (Gitea dump = pepper-in-backup)
- Parent: [plan.md](plan.md)

## Overview

- Date: 2026-09-06
- Description: New leaf module `src/lib/auth/backupEnvelope.js` — seal/open a secret with a password using scrypt + AES-256-GCM. Pure: no DB, no fs, no imports beyond `node:crypto`. Fully unit-testable.
- Priority: P1
- Status: pending

## Key Insights

- Node's `crypto.scrypt` default `maxmem` is 32 MiB; `128*N*r < maxmem` is enforced, so N=2^16, r=8 (64 MiB) THROWS with `ERR_CRYPTO_SCRYPT_INVALID_PARAMETER` unless explicit `maxmem` is passed (verified against Node docs in researcher-01 §1). This is the #1 pitfall; pin maxmem = 134217728 (128 MiB, = 2× working set).
- `db.transaction(fn)` callbacks are synchronous (src/lib/db/index.js:191-284) — one more reason scrypt must stay a standalone async primitive consumed OUTSIDE transactions (phase 02).
- GCM nonce: 12 bytes fresh `crypto.randomBytes(12)` per seal — NEVER derived from salt/password (nonce reuse is catastrophic in GCM). Fresh 16 B salt per seal too.
- `decipher.setAuthTag(tag)` MUST be called before `decipher.final()`; any error from `final()` (or `update`) = wrong password or tamper = unwrap failure. No partial plaintext is ever returned.
- Params (N/r/p) travel in-band so future upgrades are non-breaking — the opener reads them and derives maxmem from `N*r`, capped at a sane ceiling to avoid DoS via crafted N.
- AAD `"9router-backup-v1"` binds the artifact type; v0.6.46 archive encryption will use the distinct string `"9router-archive-v1"` so the two artifact types are not interchangeable.

## Requirements

- `sealBackupSecret(secret, password)` → `Promise<object>` envelope; throws on non-string/empty inputs.
- `openBackupSecret(envelope, password)` → `Promise<string>` secret; throws a single normalized error (`BackupEnvelopeError`, name only — never includes password/secret/plaintext) on: bad shape, unsupported v/cipher/kdf, param ceiling exceeded, wrong password, tampered ct/tag/aad/salt.
- `isBackupEnvelope(value)` → boolean shape check (fast, no crypto) for import-side detection.
- Envelope JSON exactly: `{v:1, cipher:"aes-256-gcm", kdf:"scrypt", salt, N, r, p, nonce, ct, tag, aad:"9router-backup-v1"}` — salt/nonce/ct/tag base64.
- No logging of password, secret, or derived key anywhere in the module.

## Architecture

```
sealBackupSecret(secret, password)
  salt   = randomBytes(16)
  nonce  = randomBytes(12)
  key    = scrypt(password, salt, 32, {N:65536, r:8, p:1, maxmem:134217728})   [async]
  cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from("9router-backup-v1"))
  ct  = cipher.update(secret, "utf8") + cipher.final()
  tag = cipher.getAuthTag()                      // 16 B, separate field
  → {v:1, cipher, kdf:"scrypt", salt, N, r, p, nonce, ct, tag, aad}

openBackupSecret(envelope, password)             // inverse; setAuthTag BEFORE final()
  validate shape + v + cipher + kdf + N,r,p ceilings (N ≤ 2^20, r ≤ 32, p ≤ 8)
  key  = scrypt(password, salt, 32, {N: envelope.N, r, p, maxmem: max(134217728, 128*N*r*2)})
  → secret string, or throw BackupEnvelopeError (generic message)
```

## Related code files

- CREATE `src/lib/auth/backupEnvelope.js` (new leaf module; keep beside `src/lib/auth/installSecret.js` which is the model for leaf-style modules — installSecret.js:1-6 header comment documents the convention)
- CREATE `tests/unit/backup-envelope.test.js`

## Implementation Steps

1. Create `src/lib/auth/backupEnvelope.js`:
   - `import crypto from "node:crypto";` only import.
   - `const AAD = "9router-backup-v1";` `const PARAMS = Object.freeze({ N: 65536, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 });`
   - `const scryptAsync = crypto.scrypt` wrapped in a small `promisify`-style helper (no `util` import needed; inline `new Promise` wrapper). NEVER `scryptSync`.
   - `export class BackupEnvelopeError extends Error { constructor(msg) { super(msg); this.name = "BackupEnvelopeError"; } }` — messages are generic ("backup envelope could not be opened"), never echo inputs.
   - `export function isBackupEnvelope(v)` — `v && v.v === 1 && v.cipher === "aes-256-gcm" && v.kdf === "scrypt" && typeof v.salt === "string" && typeof v.nonce === "string" && typeof v.ct === "string" && typeof v.tag === "string" && v.aad === AAD`.
   - `export async function sealBackupSecret(secret, password)` — per diagram above; validate `typeof secret === "string" && secret.length > 0 && typeof password === "string" && password.length > 0` else throw `BackupEnvelopeError("invalid seal input")`.
   - `export async function openBackupSecret(envelope, password)` — shape check via `isBackupEnvelope`; v1 params HARD-WHITELISTED to the exact frozen tuple `N===65536 && r===8 && p===1` (all three also `Number.isInteger` — see Red-Team Amendments RT-01); maxmem = the frozen `PARAMS.maxmem` constant, NEVER derived from envelope fields; `decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))` BEFORE `final()`; the ENTIRE open body (scrypt + decipher ops) wrapped in try/catch → throw `BackupEnvelopeError("backup envelope could not be opened")`.
2. Create `tests/unit/backup-envelope.test.js` (pattern: tests/unit/apikeys-hash-migration.test.js header — `vi.mock("undici", …, { virtual: true })` not needed here; pure module, no mocks):
   - round-trip: seal then open returns the exact secret.
   - wrong password → `BackupEnvelopeError`, message does NOT contain the password.
   - tamper ct (flip one base64 char), tamper tag, tamper salt → all throw.
   - AAD binding: hand-build envelope via internal logic with different AAD → open throws. (Achieve by sealing with a copied module instance? KISS: assert `envelope.aad === "9router-backup-v1"` and that mutating `envelope.aad` before open throws — GCM covers the AAD field because the AAD used at open must equal the one used at seal; since open always uses the constant, a mutated in-band `aad` value changes nothing cryptographically — so instead assert `isBackupEnvelope` rejects a mutated `aad`.)
   - params in-band: seal output has `N===65536, r===8, p===1`; `isBackupEnvelope` true for seal output, false for `{}`, `null`, `{v:2,…}`.
   - fresh randomness: two seals of the same (secret, password) produce different salt and nonce.
   - maxmem regression guard: open succeeds on Node with default env (implicitly proves explicit maxmem is passed — without it N=2^16 throws).

## Todo list

- [ ] Create `src/lib/auth/backupEnvelope.js` (seal/open/isBackupEnvelope/BackupEnvelopeError)
- [ ] Async scrypt with explicit maxmem=128MiB, N=2^16/r=8/p=1/keylen=32
- [ ] Param ceilings on open (DoS guard)
- [ ] Create `tests/unit/backup-envelope.test.js` (round-trip, wrong password, tamper ×3, shape, randomness, maxmem guard)
- [ ] Run `npx vitest run unit/backup-envelope` from `tests/` — all green
- [ ] `node .gitnexus/run.cjs analyze` not needed (new file); skip impact (no existing symbol edited)

## Success Criteria

- `npx vitest run tests/unit/backup-envelope.test.js` from tests/ dir: 100% pass.
- Round-trip property holds for: ASCII secret, 64-char hex secret (the real install-secret format, installSecret.js:25), Unicode password.
- Wrong-password and all tamper cases throw `BackupEnvelopeError` with a generic message; no test can make the module emit password/secret/plaintext.
- Module imports nothing but `node:crypto` (grep `from "` in the file → single import line).
- No `scryptSync` anywhere in the file (grep).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Forgotten maxmem → scrypt throws at N=2^16 on every export/import | Medium | High (feature dead on arrival) | maxmem pinned as frozen constant used by BOTH seal and open; maxmem test | `ERR_CRYPTO_SCRYPT_INVALID_PARAMETER` in phase-02 tests | Fix constant; never lower N to dodge it |
| Event-loop stall from scrypt (async still burns CPU ~0.5-1 s on weak vCPU) | Medium | Low (rare ops) | async scrypt (thread-pool offload); export/import are rare admin ops | request latency ~1 s during import | Accept for .45 (researcher-01 §1); revisit if per-login use ever adopts this KDF |
| Crafted envelope with huge N bricks import (CPU/RAM DoS via import POST) | Low | Medium | Param ceilings (N≤2^20, r≤32, p≤8) reject before scrypt | `BackupEnvelopeError` on crafted input | Ship ceilings in .45 |
| Tag/ct order bug (setAuthTag after final) silently skips auth | Low | Critical | Step order in code + tamper tests force failure | tamper tests fail if order wrong | Tests are the guard; any tamper-test failure blocks phase-02 |

## Security Considerations

- NEVER log password, secret, plaintext, or derived key; `BackupEnvelopeError` messages are generic constants.
- 0600 file perms are installSecret.js's concern (phase 02); this module holds no fs state — keep it that way.
- AAD `"9router-backup-v1"` binds artifact type; envelope `v:1` + in-band cipher/kdf fields give forward compatibility (v2 openers can read v1; v1 openers reject v2 loudly via shape check).
- Wrap-only-post-authorization is enforced by the CALLER (phase 02 route); this module must never be reachable with an unauthenticated password guess source. Rate of password guesses is bounded by the route's auth (verified password before unwrap) — note in phase 02.
- Async scrypt keeps the request path off `scryptSync`; ~64 MiB transient per call is acceptable for a single concurrent admin op.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT-01 param handling (supersedes every "ceilings"/"derived maxmem" line in this file, incl. Key Insights bullet 5, Architecture open step, Requirements, risk row 3):** ceilings (N≤2^20, r≤32, p≤8) are NOT sufficient — `N=2^20, r=32` sits inside them and makes Node allocate ~4 GiB per scrypt call (memory ≈ 128·N·r), and the `maxmem = max(PARAMS.maxmem, 2·128·N·r)` formula makes it WORSE by blessing the allocation. For `v:1` the opener accepts EXACTLY `{N:65536, r:8, p:1}` — the only tuple `sealBackupSecret` ever emits — and rejects any deviation with `BackupEnvelopeError`. Params stay in-band for forward compat (a future v2 may widen under a version gate), but v1 hard-pins. maxmem = frozen 128 MiB constant, never derived from attacker input. Validate `Number.isInteger(N/r/p)` BEFORE any comparison (NaN passes `>` and `<=` silently). Wrap the WHOLE open body in the try/catch, not just update/final — `crypto.scrypt` throws raw `TypeError` on bad params otherwise, violating the single-normalized-error contract phase-02 relies on.
2. **RT-02 test runtime:** scrypt at N=2^16 costs ~0.5-1 s per op; phases 01+02+06 together run ~20+ ops and can brush vitest's 5 s default timeout on slow CI/Windows (a timeout flake = a "new failure" under the zero-new-failures release gate). Honor `process.env.N9R_TEST_ENVELOPE_N` (default 65536) ONLY in the test files via a test-only `_setEnvelopeParamsForTests({N})` hook on the module; production paths never read it — tests drop N to 2^12. Add per-test timeouts (20000 ms) on the 3 slowest cases as belt. Record the suite-runtime delta in phase-06 (RT-20).
3. Add tests: envelope with `{N:1048576, r:32, p:1}` and with `{N:NaN}` → both throw `BackupEnvelopeError` (no scrypt call, no allocation — assert via the fake-timer-free fast failure).

## Next steps

- Phase 02 consumes `sealBackupSecret`/`openBackupSecret`/`isBackupEnvelope` from exportDb/importDb.
