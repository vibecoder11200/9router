# Phase 01 — Passphrase Generator + Archive Seal/Open Module (pure)

## Context links

- Research: [researcher-01-archive-crypto-ux.md](../research/researcher-01-archive-crypto-ux.md) §1 (Crockford spec), §2 (format precedent), §3 (nesting/buffer), §4 (scrypt tuple reuse)
- Parent: [plan.md](plan.md)
- .45 precedent: phase-01 crypto envelope module (same leaf-module discipline); phase-07 sketch (separate helper preferred over touching db/index.js)
- Depends on: nothing. Phases 02–04 depend on this.

## Overview

- Date: 2026-09-06
- Description: Pure crypto/UX primitives for Option F: (1) generalize the AAD
  in backupEnvelope.js from a private const to an exported, allowlisted
  parameter (two constants: backup v1 / archive v1) with zero behavior change
  for existing callers; (2) new leaf module `src/lib/db/archive.js` with the
  Crockford Base32 passphrase generator, symmetric passphrase normalizer,
  length-floor validator, and whole-archive seal/open/detect helpers built on
  the parameterized envelope.
- Priority: P1
- Status: pending

## Key Insights

- The frozen scrypt tuple is reused verbatim — domain separation between the
  .45 secret envelope and the .46 archive envelope lives in the AAD string,
  not in new KDF params (researcher-01 §4). One validation path, one test
  hook, one attack-economics story.
- Generalizing the AAD is a smaller blast radius than duplicating 150 lines of
  envelope code: `sealBackupSecret/openBackupSecret/isBackupEnvelope` gain an
  optional `{ aad }` argument that MUST be one of two exported constants
  (allowlist prevents accidental third domains); every existing caller passes
  nothing and gets `9router-backup-v1` (default). The 3 existing callers are
  db/index.js:182 (seal), db/index.js:259-261 (open), db/index.js:5/:259
  (isBackupEnvelope import/use) plus tests/unit/backup-envelope.test.js,
  key-portability.test.js, key-portability-lifecycle.test.js — all unchanged.
- Crockford Base32 generation is bias-free WITHOUT rejection sampling: the
  alphabet has exactly 32 chars and 256 % 32 === 0, so
  `crypto.randomBytes(20)` → `byte % 32` per char is uniform. 20 chars = 100
  bits, displayed `xxxxx-xxxxx-xxxxx-xxxxx`.
- Normalization must be SYMMETRIC (applied identically at seal and open) so
  exact-retype always works and case/hyphen retyping of the generated form is
  rescued. Folding I/L→1 and O→0 is Crockford-standard; all other chars pass
  through. No checksum generation or stripping (we never emit checksums —
  YAGNI, researcher open-question 4 resolved as "skip").
- Length floor (10, on the NORMALIZED string) is an EXPORT-time UX/validation
  gate only — open() must accept any non-empty passphrase so a future-tighter
  floor never bricks old archives.
- Buffer discipline (researcher-01 §3): one-shot GCM; the seal input is the
  JSON string passed straight to `cipher.update` (no extra Buffer copies);
  decrypt does a single `pt.toString("utf8")` immediately before JSON.parse by
  the CALLER. Documented ceiling ~100MB payload (~3-4x transient memory);
  no STREAM chunking (YAGNI).

## Requirements

- backupEnvelope.js: export `AAD_BACKUP_V1 = "9router-backup-v1"` (replaces the
  private `AAD` const, same value) and `AAD_ARCHIVE_V1 = "9router-archive-v1"`.
- `sealBackupSecret(secret, password, { aad } = {})`,
  `openBackupSecret(envelope, password, { aad } = {})`,
  `isBackupEnvelope(v, aad = AAD_BACKUP_V1)`: `aad` must `===` one of the two
  constants or throw `BackupEnvelopeError("invalid seal input")` (seal) /
  `OPEN_FAILED` (open/is-check just returns false). Param whitelist (RT-01),
  scrypt options, maxmem constant, error normalization: all unchanged.
- New `src/lib/db/archive.js` (leaf: only node:crypto + backupEnvelope.js):
  - `ARCHIVE_FORMAT = "9router-encrypted-archive"`, `ARCHIVE_V = 1`,
    `MIN_ARCHIVE_PASSPHRASE_LENGTH = 10` (exported).
  - `generateArchivePassphrase()` → string `XXXXX-XXXXX-XXXXX-XXXXX` (Crockford
    alphabet `0-9 A-Z` minus I,L,O,U; 20 chars from `crypto.randomBytes(20)`,
    `byte % 32`, hyphen-joined in 5-char groups).
  - `normalizeArchivePassphrase(s)` → `String(s).toUpperCase()` then strip
    `[\s-]`, fold `I`/`L`→`1`, `O`→`0`; returns "" for non-string/empty input.
  - `validateArchivePassphrase(raw)` → true iff normalized length >= 10.
  - `sealArchive(jsonString, rawPassphrase)` → `{ format: ARCHIVE_FORMAT,
    v: ARCHIVE_V, envelope: await sealBackupSecret(jsonString,
    normalizeArchivePassphrase(rawPassphrase), { aad: AAD_ARCHIVE_V1 }) }`.
    Throws on empty/short-after-normalize... NO: seal validates non-empty only
    (length floor is the route/UX layer's duty — keep the module policy-free);
    document this split.
  - `isEncryptedArchive(v)` → `!!v && typeof v === "object" && !Array.isArray(v)
    && v.format === ARCHIVE_FORMAT` (detection key only; envelope validity is
    open()'s job).
  - `openArchive(file, rawPassphrase)` → inner JSON string via
    `openBackupSecret(file?.envelope, normalizeArchivePassphrase(rawPassphrase),
    { aad: AAD_ARCHIVE_V1 })`; ANY failure throws `ArchiveError("wrong archive
    passphrase or corrupted archive")` — one normalized message, no input echo.
  - `class ArchiveError extends Error` (name "ArchiveError").
  - Never logs passphrase/plaintext; no env reads on production paths.
- Tests `tests/unit/archive-encryption.test.js` (see Success Criteria).
- Existing envelope tests stay green with zero edits (default-AAD compat proof).

## Architecture

```
backupEnvelope.js (parameterized AAD, frozen tuple reused)
  └─ archive.js (new leaf)
       generateArchivePassphrase ──► show-once UI (phases 03/04)
       sealArchive(JSON.stringify(exportDbOutput), pass)
         ──► { format:"9router-encrypted-archive", v:1, envelope }   (= the file)
       isEncryptedArchive(parsedFile) ──► import branching (phase 02)
       openArchive(file, pass) ──► inner JSON string ──► JSON.parse (caller)
```

## Related code files

- EDIT `src/lib/auth/backupEnvelope.js` (AAD const :11 → exported constants; 3
  signatures gain optional `{ aad }`)
- CREATE `src/lib/db/archive.js`
- CREATE `tests/unit/archive-encryption.test.js`
- No route/db/UI changes in this phase.

## Implementation Steps

1. Impact-check `sealBackupSecret`/`openBackupSecret`/`isBackupEnvelope`
   (GitNexus `impact`, upstream) — expect callers: db/index.js (3), test files
   (3). Report blast radius before editing.
2. backupEnvelope.js: replace const AAD with the two exported constants;
   thread `{ aad }` through seal/open/is with the allowlist check; default
   `AAD_BACKUP_V1`. Update the module header comment (AAD list + why).
3. Run `npx vitest run unit/backup-envelope unit/key-portability` from tests/ —
   must be green with zero edits (proves default compatibility).
4. Create archive.js per Requirements.
5. Create archive-encryption.test.js per Success Criteria matrix.
6. `npx vitest run unit/archive-encryption` green; `detect_changes()`; one
   green commit: `feat(backup): archive crypto module — passphrase generator + whole-archive seal/open (v0.6.46 phase 01)`.

## Todo list

- [ ] impact() on the 3 envelope symbols run + blast radius recorded
- [ ] backupEnvelope.js AAD-parameterized; existing tests green unedited
- [ ] archive.js: generator / normalizer / validator / seal / open / detect / ArchiveError
- [ ] archive-encryption.test.js green (matrix below)
- [ ] detect_changes() + one green commit

## Success Criteria

- Generator: 200 samples → all match
  `/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/`; chars drawn from the
  32-char alphabet (statistical: no I/L/O/U in 4000 chars); distinct across
  samples.
- normalize: `"abcde fghij"`→`ABCDEFGHIJ`; `"abcde-fghij"`→same; `I`,`L`→`1`,
  `O`→`0`; hyphens+spaces stripped; empty/non-string → "".
- Round-trip: sealArchive→openArchive with the ORIGINAL mixed-case/hyphenated
  passphrase reproduces the input string exactly.
- Cross-AAD rejection: an envelope sealed with AAD_BACKUP_V1 fails
  openArchive (wrong-aad → isBackupEnvelope false → ArchiveError), and an
  archive envelope fails openBackupSecret default — type-binding proven.
- Tamper: flip one base64 char in `envelope.ct`/`tag` → openArchive throws the
  single normalized ArchiveError (no partial output, no echo).
- validateArchivePassphrase: "short" → false; 10 normalized chars → true;
  "abcde-fghij" (10 after strip) → true.
- sealArchive rejects empty/whitespace-only passphrase (BackupEnvelopeError
  path) but does NOT enforce the length floor (floor is route/UX-only).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| AAD parameterization subtly breaks .45 envelope compat | Low | High | Default argument keeps byte-identical behavior; step 3 runs .45 envelope tests unedited BEFORE writing archive.js | backup-envelope/key-portability tests red | Revert the edit; investigate before proceeding (phase gate) |
| Envelope test hook (_setEnvelopeParamsForTests N-override) interacts with new AAD paths | Low | Low | Override only touches `active.N`; AAD is orthogonal — covered by fast-N round-trip test in the new file | flaky/slow archive tests | Use the same hook in archive tests; keep N small there |
| Normalizer folds too aggressively for exotic user passphrases | Medium | Low | Symmetric application at seal AND open guarantees exact-retype always opens; folds limited to I/L/O + case + hyphens/space | user reports "passphrase rejected" despite correct entry | Confirm they are retyping EXACTLY what they entered at export (symmetry); no code change needed |
| randomBytes %-mapping bias sneaks in if alphabet changes later | Low | Low | 256%32===0 today; add a test asserting alphabet length === 32 to freeze the invariant | alphabet-length test red on future edit | Restore 32-char alphabet or switch to rejection sampling |

## Security Considerations

- Passphrase never logged, never persisted, never in an env var; module has no
  I/O at all (pure).
- Generated passphrase exists only in the generator's return value — 100 bits
  from `crypto.randomBytes`; show-once discipline is enforced by phases 03/04
  UX, this module just never stores anything.
- No sealing under default passwords can occur here — the module receives
  whatever passphrase the caller validated; the dashboard-password gate
  (RT-03) is unchanged in phase 02.
- Domain separation: AAD_ARCHIVE_V1 means a .46 archive envelope can never be
  replayed as a .45 secret envelope or vice versa (cross-AAD test above).
- scrypt cost: frozen tuple (N=2^16) shared with .45 — crafted low-N envelopes
  are rejected before scrypt (RT-01 whitelist reused unchanged).

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT46-A7 normalization entropy disclosure:** symmetric folding is safe for openability but silently discounts user-chosen passphrase entropy (each I/L/O loses ~1.58 bits; spaces/hyphens count for nothing) — and the F payload now carries BOTH install secrets + provider tokens, a strictly larger prize than .45's single-secret envelope. (a) `validateArchivePassphrase` ALSO requires RAW length ≥ 10 (not just normalized); (b) phases 03/04 hint copy and the phase-06 CHANGELOG must state: "I and L are treated as 1, O as 0; spaces and hyphens are ignored"; (c) module doc notes passphrases are effectively printable-ASCII-bounded (see phase-02 charset gate).

## Next steps

- Phase 02 wires archive.js into exportDb/importDb + the database route with
  route-level tests from the start.
