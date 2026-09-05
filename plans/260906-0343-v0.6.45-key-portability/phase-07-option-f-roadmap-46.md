# Phase 07 — Option F Roadmap: Whole-Archive Encryption (v0.6.46, DESIGN ONLY)

## Context links

- Research: [researcher-01-crypto-envelope.md](research/researcher-01-crypto-envelope.md) §3 (Bitwarden/1Password/GitHub-recovery-code UX precedent), §4 (LUKS header-backup analogy)
- Research: [researcher-02-portability-precedent.md](research/researcher-02-portability-precedent.md) (conclusion: "hardening A toward F closes the gap")
- Parent: [plan.md](plan.md)
- Builds on: phase-01 envelope module (reused verbatim with a different AAD)

## Overview

- Date: 2026-09-06
- Description: Roadmap entry for v0.6.46 "Option F": encrypt the ENTIRE backup archive with a user-chosen passphrase (Bitwarden pattern + unrecoverable warning). One envelope wraps the existing JSON payload; legacy plaintext imports keep working via shape detection. NOTHING in this phase is scheduled for v0.6.45 — no code, no schema, no UI.
- Priority: P3 (roadmap)
- Status: pending (design sketch)

## Key Insights

- Research verdict: shipping the pepper in backups is precedented (Gitea `gitea dump` ships app.ini unencrypted); 9router's .45 already improves on Gitea by envelope-encrypting the pepper. F closes the remaining gap — provider tokens (`providerConnections.data`) still ride plaintext in .45 backups.
- UX precedent splits cleanly (researcher-01 §3): 1Password reuses an existing credential (what .45 does with the dashboard password); Bitwarden asks for a user-chosen export password with an explicit "cannot be recovered" warning (what F should do). Industry failure mode: users forget the export passphrase and the backup is useless — hence forced confirmation + warning text.
- Distinct AAD is mandatory: `"9router-archive-v1"` vs .45's `"9router-backup-v1"` so a .46 archive envelope can never be replayed as a .45 secret envelope or vice versa (phase-01 module already parameterizes this — only the constant changes).
- Envelope-wrapping the WHOLE payload makes the file opaque: `isBackupEnvelope(file)` at import becomes the natural legacy detector (plaintext backups still parse as the known `{meta, settings, apiKeys, …}` shape).
- The .45 secret envelope becomes REDUNDANT under F (the archive envelope already protects the pepper) — keep it for backward compatibility, omit it when F is active.

## Requirements (v0.6.46 scope — recorded only)

- Export flow (both dashboard + CLI): optional "Encrypt archive" step → user-chosen passphrase + confirm + "cannot be recovered, we don't store it" warning → `sealBackupSecret(JSON.stringify(payload), passphrase)` with AAD `"9router-archive-v1"` → file IS the envelope (plus a thin `{ format: "9router-encrypted-archive", envelope }` wrapper or the bare envelope — see open questions).
- Import flow: if file parses as an envelope (`isBackupEnvelope`) → prompt passphrase → unwrap → `JSON.parse` → existing `importDb`. Plaintext files import unchanged (shape detection).
- When F is active: skip the .45 inner `authSecretEnvelope` (double encryption is waste); when F is off, .45 behavior exactly.
- CLI: passphrase prompts in the Backup & Restore menu; masked input desirable (see open questions).
- Docs: threat-model note that the backup file is key material (LUKS analogy).

## Architecture (sketch)

```
v0.6.46 export (F on)                      v0.6.46 import
  payload = exportDb({})                     file → JSON.parse
  passphrase = prompt twice + warning        ├─ isBackupEnvelope? ──► prompt passphrase
  file = { format:"9router-encrypted-archive",│    openBackupSecret(env, pass)  [AAD v-archive]
          v:1, envelope: seal(                 │    JSON.parse(plaintext) ──┐
            JSON.stringify(payload), pass,     └─ else: legacy plaintext ────┤
            AAD="9router-archive-v1")                                        ▼
  (no inner authSecretEnvelope — redundant)                        importDb(payload, {})
```

## Related code files (v0.6.46 — none touched now)

- `src/lib/auth/backupEnvelope.js` (phase-01; AAD constant generalized or a second constant)
- `src/lib/db/index.js` (exportDb/importDb wrappers or a new `src/lib/db/archive.js` helper — prefer the latter to keep index.js stable)
- `src/app/api/settings/database/route.js`, profile page, `cli/src/cli/menus/backup.js` (passphrase UX)
- `tests/unit/*` (envelope archive round-trip + legacy detection)

## Implementation Steps

- None scheduled. (If/when .46 is planned, promote this file to a real phase set: crypto reuse → routes → UI/CLI → tests → release, mirroring phases 01–06 of this plan.)

## Todo list

- [ ] (v0.6.46 planning only) Resolve open questions below
- [ ] (v0.6.46) Decide wrapper shape: bare envelope vs `{format, envelope}` envelope-with-header
- [ ] (v0.6.46) Decide inner-secret suppression rule (F on ⇒ omit `authSecretEnvelope`)

## Success Criteria

- Roadmap only: this phase ships NOTHING in v0.6.45. Success = the sketch above is complete enough that a .46 planner can start phase-01-style without re-research. No test, no code, no schema change in .45.

## Risk Assessment

| Risk (if F ships in .46) | Likelihood | Impact | Mitigation (sketched) | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Users forget passphrase → backup useless | High (documented industry pattern) | High | Forced double-entry + explicit unrecoverable warning at export; suggest password manager | support complaints | Optionally offer auto-generated passphrase mode with show-once GitHub-recovery-code presentation (open question #1) |
| Weak user passphrases undermine scrypt | Medium | Medium | scrypt N=2^16 already costs ~64 MiB/attempt; optional strength hint, no hard minimum (KISS) | n/a | Keep KDF cost high; revisit N=2^17 if archive ops stay rare |
| Legacy plaintext detection misfires (a plaintext backup that happens to look like an envelope) | Very Low | Medium | `isBackupEnvelope` requires exact fields incl. `aad` constant + `v:1` — plaintext payloads always have `meta`/`settings` keys | import failure on old file | Fall back: if envelope-open throws AND payload has `meta`, treat as plaintext + warn |
| Double encryption (F + inner secret envelope) confuses importers | Low | Low | Suppress inner envelope when F active | round-trip test | .46 test matrix covers F-on/F-off × right/wrong pass |

## Security Considerations

- Same invariants as phase 01 (never log passphrase/plaintext; async scrypt; setAuthTag before final; fresh salt+nonce per seal; explicit maxmem).
- Distinct AAD `"9router-archive-v1"` — envelope type-binding across versions is the forward-compat story: v-field + AAD make .45/.46 artifacts non-interchangeable.
- File perms: archive file written by the browser (dashboard) inherits download semantics — docs must state "this file is key material". CLI writes should attempt restrictive perms where the platform supports it.
- Passphrase never persisted server-side; wrap/unwrap happen post-`authorized()` exactly like .45's password path.
- Whole-archive encryption hides provider tokens too — strictly stronger than .45's secret-only envelope; threat-model doc should say so explicitly.

## Red-Team Notes (2026-09-06 — for the .46 planner)

1. **Threat-model documentation duty:** record in the .46 threat model that (a) .45 backups expose legacy pre-S7 2-part keys (~41 bits, bare HMAC) to offline brute once the pepper is unwrapped — F's whole-archive encryption is the real fix, another reason to schedule it; (b) sealing never happens under default/initial passwords (phase-02 RT-03) — keep that invariant under F.
2. Masked CLI prompts moved UP into .45 (RT-12/RT-14): strike "masked input desirable (see open questions)" from Requirements and open question (3) from Next steps — it already ships.
3. The ".45 inner envelope is redundant under F" rule survived red team unchanged. Also decide in .46 whether to adopt the `api-key-secret` (CRC) scope alongside `api-keys-hmac` (plan.md unresolved #4) — it raises re-key forgery cost from 16 bits to pepper-knowledge and lets cross-install pasted keys pass `parseApiKey` CRC again.

## Next steps

- Park until v0.6.46 planning. Owner decision needed on open questions: (1) auto-generated passphrase option with show-once presentation? (2) bare envelope vs format-header wrapper? (3) masked CLI passphrase input — RESOLVED, ships in .45 (RT-14). None block v0.6.45.
