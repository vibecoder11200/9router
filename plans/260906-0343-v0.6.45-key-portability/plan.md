---
title: "v0.6.45 — Key Portability: wrapped HMAC-secret export, re-key fallback, keyId upgrade, CLI backup menu"
description: "Ship portable API keys in backups: password-wrapped install-secret envelope + adoption on import, per-key re-key fallback, 62-bit keyId, CLI Backup & Restore menu; v0.6.46 Option F roadmap entry."
status: pending
priority: P1
effort: 14.5h
branch: master
tags: [security, backup, api-keys, cli]
created: 2026-09-06
---

# Goal

Backups taken on one 9Router install become fully portable: when the export was
authorized by the dashboard password, the apiKeys HMAC pepper travels inside the
backup inside a password-wrapped AES-256-GCM envelope; importing with that
password adopts the secret so every restored key validates immediately. Wrong or
missing password never hard-fails — keys import as inert (`needsRekey=1`) with an
amber warning and a per-key re-key flow (dashboard + CLI). New keys get a 62-bit
keyId. CLI gains a Backup & Restore menu. v0.6.45 ships A + B-lite + C + D; F is
a v0.6.46 roadmap sketch only.

# Decision log (user-approved — do not relitigate)

- A: export embeds wrapped `api-keys-hmac` secret when auth = dashboard password; CLI-token exports omit it (+ meta note).
- B-lite: import with wrong/missing password imports everything; keys with `keyHash` become inert (`needsRekey`), amber warning, never hard-fail; re-key UI = Endpoint page + CLI.
- C: `generateKeyId` → 12 chars over 36-char alphabet via `crypto.randomInt` (~62 bits); parse/mask/CRC unchanged.
- D: CLI "Backup & Restore" menu (export → file in cwd; import → file+password, print warnings incl. needsRekey count).
- scrypt N=65536 (2^16), r=8, p=1, keylen=32, salt 16B random, explicit maxmem ≥128MiB (Node 32MiB default THROWS at N≥2^16); async `crypto.scrypt` only.
- Envelope `{v:1, cipher:"aes-256-gcm", kdf:"scrypt", salt, N, r, p, nonce(12B random), ct, tag(16B separate), aad:"9router-backup-v1"}`; params in-band; `setAuthTag` before `final()`; any GCM error = unwrap fail.
- `needsRekey` = additive column `apiKeys.needsRekey INTEGER DEFAULT 0` via `syncSchemaFromTables` (phase-08 precedent, NO SCHEMA_VERSION bump); set at import, cleared by re-key endpoint; `GET /api/keys` derives global flag via `rows.some()`.
- Re-key ownership proof WITHOUT old secret: full masked-string compare `maskApiKey(pastedRawKey) === row.key`. Pre-S7 archives (key=raw, keyHash null) are NOT marked needsRekey (lazy backfill already handles them).
- v0.6.46 Option F = roadmap entry only (whole-archive encryption, user passphrase, AAD `9router-archive-v1`, legacy plaintext detect-by-shape).
- RED TEAM 2026-09-06 (binding — full detail in each phase's "Red-Team Amendments"; these override conflicting earlier text):
  - v1 envelope params HARD-WHITELISTED to the exact frozen tuple `{N:65536, r:8, p:1}` + `Number.isInteger` checks; maxmem = frozen 128 MiB constant, never derived from envelope input (RT-01).
  - Sealing happens ONLY when the password matches a STORED bcrypt hash (`verifyDashboardPasswordAgainstStoredHash`) — never under "123456"/INITIAL_PASSWORD fallbacks; fresh installs export envelope-less with a warning (RT-03).
  - Route derives the wrap-password from `x-9r-password` regardless of auth path (CLI token + wrong password = 401, not silent downgrade) — the original `viaCliToken ? {} : {password}` draft was dead-on-arrival for CLI export (RT-Cli).
  - Adoption happens AFTER the import transaction commits; no snapshot/restore; post-commit adopt failure → best-effort `needsRekey=1` UPDATE (RT-04).
  - importDb minimum-shape guard BEFORE any DELETE (kills the pre-existing empty-JSON destructive wipe + auth downgrade) (RT-05); imports serialized by in-process mutex (RT-07); loginLimiter wired into the database route (RT-08).
  - Re-key gated to `needsRekey === 1` rows + 5-mismatch/15-min lockout — masked-compare proof is 16 bits (last4), NOT 62 (keyId is public in the mask); UI/CLI show Re-key only for flagged keys (RT-11).
  - Masked CLI prompts (`promptSecret`) + `0o600` + guarded file write ship IN .45 (RT-12/14/15).
  - Copy rule: every "encrypted" mention must say the rest of the backup (incl. provider tokens) stays unencrypted (RT-16/21).

# Phases

| Phase | File | Status | Deps | Effort |
|---|---|---|---|---|
| 01 crypto envelope module (pure) | [phase-01-crypto-envelope.md](phase-01-crypto-envelope.md) | pending | — | 2h |
| 02 secret export + adoption + needsRekey column | [phase-02-secret-export-adoption.md](phase-02-secret-export-adoption.md) | pending | 01 | 4h |
| 03 re-key flow (endpoint + dashboard UI + CLI) | [phase-03-rekey-flow.md](phase-03-rekey-flow.md) | pending | 02 | 3h |
| 04 keyId upgrade (12 chars, 62 bits) | [phase-04-keyid-upgrade.md](phase-04-keyid-upgrade.md) | pending | — | 1h |
| 05 CLI Backup & Restore menu | [phase-05-cli-backup-menu.md](phase-05-cli-backup-menu.md) | pending | 02, 03 | 2.5h |
| 06 end-to-end test sweep + CHANGELOG + release | [phase-06-tests-release.md](phase-06-tests-release.md) | pending | 01–05 | 1.5h |
| 07 Option F roadmap (v0.6.46, design only) | [phase-07-option-f-roadmap-46.md](phase-07-option-f-roadmap-46.md) | pending | — | 0.5h |

Phase 04 is independent and may run parallel with 02. Phases 02→03→05 are
strictly sequential (03 needs the needsRekey column; 05 needs routes + rekey
client method). Files shared ACROSS sequential phases (fine sequentially,
never in parallel worktrees): 02/03 both touch `apiKeysRepo.js` + `db/index.js`;
03/05 both touch `cli/src/cli/api/client.js`. Exclusive owners otherwise: 01
owns new `src/lib/auth/backupEnvelope.js`; 02 owns schema/installSecret/db-index/
route + profile page + dashboardSession compare helper; 03 owns rekey route +
keys route + EndpointPageClient + CLI rekey; 04 owns `src/shared/utils/apiKey.js`;
05 owns CLI backup menu + client export/import methods + `promptSecret` helper;
06 owns CHANGELOG + version bumps. Process rule (RT-22): one green commit per
phase — its own tests green + `detect_changes()` before each commit. Red team
2026-09-06 verdicts: attacker team "4 must-fix before implementation" and ops
team "not implementable as-is, 4 fixes first" — ALL incorporated as binding
amendments above; effort estimate rises ~14.5h → ~16h.

# Key verified anchors

- `getOrCreateInstallSecret` src/lib/auth/installSecret.js:15-30 (0600 file, Map cache; `adoptInstallSecret` helper to be added here).
- `hashApiKey` (sole consumer of "api-keys-hmac") src/lib/db/repos/apiKeysRepo.js:9-12; `maskApiKey` :16-22; `rowToKey` :26-48.
- `exportDb` src/lib/db/index.js:119-164; `importDb` :171-300 (sync `db.transaction` callback :191 → scrypt unwrap MUST precede it).
- Route GET/POST + `authorized()` src/app/api/settings/database/route.js:13-56.
- Profile page dbAuth modal src/app/(dashboard)/dashboard/profile/page.js:1672-1699; warnings amber :836-840.
- `generateKeyId` (Math.random, 6 chars) src/shared/utils/apiKey.js:17-24; CRC scope "api-key-secret" :8-12 (separate from "api-keys-hmac"); `parseApiKey` CRC-verified :66-69 (install-bound — re-key must use structural parse + masked compare).
- Schema apiKeys src/lib/db/schema.js:78-98; additive sync src/lib/db/migrate.js:79-109.
- `syncSchemaFromTables` precedent: budget columns (phase-08, schema.js:87-92).
- CLI: `makeRequest` cli/src/cli/api/client.js:86-166; `showKeyActions` cli/src/cli/menus/apiKeys.js:170-193; main menu cli/src/cli/terminalUI.js:76-110.
- Test harnesses: tests/unit/apikeys-hash-migration.test.js (fake adapter + installSecret mock), tests/unit/s7-followup-regressions.test.js (export/import fake adapter).

# Unresolved questions (none block v0.6.45)

- Should v0.6.46 Option F also offer an auto-generated passphrase (GitHub-recovery-code show-once presentation) alongside user-chosen? → decide in .46.
- CLI backup file default save location: cwd vs `~/.9router/backups/`? (cwd chosen for .45; revisit if users complain).
- Should re-key also verify CRC when the key WAS generated on this install (nice-to-have strictness)? Deferred — masked compare is sufficient proof.
- Should exportDb envelope also wrap `api-key-secret` (CRC scope) so pasted foreign keys pass `parseApiKey` CRC? Deferred to .46 review; auth does not depend on CRC (verified: no callers of verifyApiKeyCrc outside apiKey.js).

# Validation Summary (2026-09-06)

Interview contract: red team (2 adversarial agents, 22 combined findings) → binding amendments applied to all 7 phase files → 4 open decision points put to the owner. All 4 owner answers confirmed the recommended option, and every answer matches the amendment text already written into the phase files — **no phase file needs further changes from validation**.

Confirmed decisions:

1. **Seal gate (RT-03):** seal ONLY under a stored bcrypt hash. Fresh installs without a set dashboard password export envelope-less with a "set a dashboard password for portable backups" warning. INITIAL_PASSWORD sealing rejected.
2. **Re-key gate (RT-11):** needsRekey=1-only gate (409 not_needed otherwise) + 5-mismatch/15-min per-key lockout + 20/hour global; Re-key button/menu item render only for flagged keys. Rationale accepted: masked-compare proof is 16 bits (last4), keyId is public in the mask.
3. **Import modal UX (RT-09):** single CURRENT-password field with honest copy ("if it differs from the export-time password, keys will need re-keying"). Optional second "archive password" field rejected for .45 (KISS; re-import path covers the rare changed-password case).
4. **Hardening ride-alongs:** all three ship in .45 — importDb shape-guard (pre-existing empty-JSON wipe hole), in-process import mutex, loginLimiter on the database route.

Action items for implementation (all already encoded in phase files; listed here as the checklist of record):

- [ ] Phase 01: exact-tuple param whitelist + Number.isInteger + whole-body try + `N9R_TEST_ENVELOPE_N` test override (RT-01/02).
- [ ] Phase 02: `verifyDashboardPasswordAgainstStoredHash` (bcrypt-only) in dashboardSession.js; route wrap-password derivation from `x-9r-password` on BOTH auth paths; adopt-AFTER-commit + best-effort needsRekey UPDATE; shape-guard before DELETEs; no-password unwrap skip; import mutex; loginLimiter; mock exports `readInstallSecret`; honest single-field modal copy (RT-03..RT-10).
- [ ] Phase 03: needsRekey-only gate + mismatch lockout (loginLimiter pattern); honest 16-bit risk row; `promptSecret` for raw key; flag-gated button/menu visibility (RT-11/12).
- [ ] Phase 04: corrected security claim (62-bit = key-string forgery defense, not the re-key proof) (RT-13).
- [ ] Phase 05: `promptSecret` helper; writeFileSync `{mode: 0o600}` + try/catch + absolute path; honest "rest stays unencrypted" copy; corrected fresh-install insight (RT-14..RT-18).
- [ ] Phase 06: negative empty-JSON tests; suite-runtime delta; honest CHANGELOG bullet incl. "re-key offered only for flagged keys"; one-green-commit-per-phase rule (RT-19..RT-22).

Status: plan validated — awaiting owner go-ahead to implement (e.g. via the cook flow). frontmatter `status` stays `pending` until implementation starts.
