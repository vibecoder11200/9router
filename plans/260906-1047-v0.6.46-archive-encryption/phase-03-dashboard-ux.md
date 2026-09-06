# Phase 03 — Dashboard UX: F Opt-in, Passphrase Modal, Show-Once Panel, Honest Copy

## Context links

- Depends on: [phase-02-server-export-import.md](phase-02-server-export-import.md)
- Parent: [plan.md](plan.md)
- Research: [researcher-01-archive-crypto-ux.md](../research/researcher-01-archive-crypto-ux.md) §1 (GitHub recovery-code precedent, show-once discipline, display spec)
- .45 precedent: dbAuth modal + honest-copy rule (RT-16/21); profile/page.js modal copy :1692-1696

## Overview

- Date: 2026-09-06
- Description: Dashboard export flow gains an "Encrypt this archive?" step:
  No (default, .45 behavior), Choose a passphrase (double entry + min-10
  hint), or Generate for me (server-generated show-once panel with Copy +
  Download .txt + mandatory retype-confirm). Import flow detects encrypted
  files and prompts for the archive passphrase alongside the current password.
  All copy follows the honest-copy variants mandated by plan.md.
- Priority: P1
- Status: pending

## Key Insights

- The file download path needs almost NO change: GET returns the wrapper JSON
  verbatim and `handleExportDatabase` (profile/page.js:657-688) already
  downloads whatever JSON the route returns — only the extra header and the
  passphrase steps are new.
- Show-once discipline (GitHub recovery-code precedent): the generated
  passphrase is displayed in a monospace panel with an explicit "cannot be
  shown again" line, Copy + Download affordances, and the panel is dismissed
  forever on close; the ONLY re-entry point is the mandatory retype field.
  The retype is compared client-side against the exact fetched string (no
  normalization in the browser — the server normalizes symmetrically at
  seal/open).
- Confirm-by-retyping catches clipboard loss AND validates capture BEFORE the
  export request fires (the file is never produced with a passphrase the user
  could not retype).
- Import detection is client-side on the PARSED file: `parsed.format ===
  "9router-encrypted-archive"` → the dbAuth modal (profile/page.js:1676-1705)
  gains a passphrase field (secret input) + unrecoverable-loss copy; the POST
  switches to `{archive: parsed, archivePassphrase, password}`.
- Honest copy matrix (RT-16/21 carried): F-off export = .45 text unchanged;
  F-on export confirm = "Everything in this backup — provider tokens, API keys,
  settings — is encrypted with this passphrase. If you lose it, the backup
  cannot be recovered."; F-import = "This backup is encrypted with a passphrase.
  If it is lost, the backup cannot be recovered."
- The passphrase endpoint returns the passphrase exactly once over the wire;
  keep it in React state only (never localStorage/sessionStorage), clear it on
  modal close, and never console.log it.

## Requirements

- Export flow (profile/page.js:813-822 Download Backup button → new step):
  1. Click → open an "Encrypt this archive?" modal (new component state or a
     step inside the dbAuth modal flow — implementer's choice, keep ONE modal
     open at a time): options "No, keep it unencrypted (.45 behavior)" /
     "Encrypt with my own passphrase" / "Generate a passphrase for me".
  2. No → existing dbAuth password modal → export (no new header) → .45 copy.
  3. Own → passphrase + confirm fields (secret inputs), live min-length hint
     (10 chars after spaces/hyphens removed — hint text only, server
     validates), must match → dbAuth password modal → export with
     `x-9r-archive-passphrase` header.
  4. Generate → GET /api/settings/database/archive-passphrase (with the same
     `x-9r-password` header after the password step, or CLI-token-less
     dashboard session — use the already-collected password from the dbAuth
     step: reorder so the dashboard password is collected FIRST) → show-once
     panel: monospace grouped string, "This passphrase cannot be shown again —
     save it now.", Copy button (navigator.clipboard + fallback), Download
     `9router-backup-passphrase.txt` (passphrase + one-line warning), retype
     field (secret input) → exact-match gate → export with header.
  5. On export response: if the user chose F, the status message uses the
     F-on copy ("Encrypted backup downloaded"); file name gains `-encrypted`
     (`9router-backup-<stamp>-encrypted.json`) so the two artifacts are
     visually distinct.
- Import flow (profile/page.js:690-736):
  1. After file.text()/JSON.parse: if `parsed?.format === "9router-encrypted-archive"`
     → dbAuth modal variant: current-password field (auth) + NEW passphrase
     field (secret input) + F-import copy + "cannot be recovered" line.
  2. POST body switches to `{ archive: parsed, archivePassphrase, password }`.
  3. 400 "Wrong archive passphrase or corrupted archive" → surface verbatim in
     dbStatus (error styling), allow retry (modal stays available).
- Copy matrix exactly as Key Insights above; no other text changes.
- No passphrase persistence (state only, cleared on modal close/unmount); no
  console logging of passphrase; clipboard write is user-initiated only.
- Client never normalizes the passphrase (server does, symmetrically).

## Architecture

```
Download Backup
  └─ Encrypt-archive? modal ── No ──► dbAuth password ──► GET (no hdr) ──► .45 file+copy
       ├─ Own passphrase ──(2 secret fields, match+hint)──► dbAuth ──► GET(+x-9r-archive-passphrase)
       └─ Generate ──► dbAuth (password first) ──► GET archive-passphrase
              └─ show-once panel (copy/download .txt) ── retype (exact) ──► GET(+hdr)
  GET response (wrapper JSON) downloaded verbatim by existing blob path

Import Backup
  file → JSON.parse → format==="9router-encrypted-archive"?
       ├─ yes → dbAuth modal (+passphrase field, F copy) → POST {archive, archivePassphrase, password}
       └─ no  → dbAuth modal (.45) → POST {...payload, password}   (unchanged)
```

## Related code files

- EDIT src/app/(dashboard)/dashboard/profile/page.js (state :35, export
  handler :657-688, import handlers :690-736, confirm flow :739-744, buttons
  card :806-846, modal :1676-1705)
- No new routes/libs (phase 02 owns the API surface); small local components
  inline in page.js per existing idiom (no component library additions)

## Implementation Steps

1. Add modal-step state machine (encryptChoice: none|no|own|generated;
   archivePassphrase state; generatedPassphrase state) to the page component.
2. Implement the three export paths per Requirements; reuse the existing
   password modal for the auth step (dbAuth.mode gains the encrypt context).
3. Implement the show-once panel (monospace pre + Copy + Download .txt +
   retype secret input + exact-match gate).
4. Import-side: file-shape detection, modal variant with passphrase field,
   POST body switch, error surfacing.
5. Copy matrix pass (grep the diff for "unencrypted"/"cannot be recovered" —
   every mention must match the matrix).
6. Manual E2E: F-off export (byte-flow unchanged), F-on own, F-on generate
   (wrong retype blocks export; right retype downloads wrapper; .txt
   downloads), F import happy + wrong passphrase (error, retry), legacy
   import unchanged.
7. detect_changes(); one green commit
   `feat(dashboard): encrypted-backup UX — opt-in passphrase, show-once generator panel (v0.6.46 phase 03)`.

## Todo list

- [ ] Encrypt-archive? step (3 options) wired into export flow
- [ ] Own-passphrase path: double secret entry + match + min-length hint
- [ ] Generate path: endpoint call, show-once panel (copy/download/retype)
- [ ] F-on status copy + `-encrypted` filename suffix
- [ ] Import detection + passphrase field + F copy + 400 surfacing
- [ ] Copy-matrix grep pass + manual E2E checklist
- [ ] detect_changes() + one green commit

## Success Criteria

- F-off export is indistinguishable from .45 for a user who never opens the
  encrypt step (default choice = No on explicit dismiss).
- Generate path: retype mismatch blocks the export request (no network call);
  match fires GET with the header; the panel never re-displays the passphrase
  after dismissal (state cleared).
- Downloaded F file starts with `{"format":"9router-encrypted-archive"` (opens
  in editor = opaque); F-off file starts with `{"meta"`.
- F import: wrong passphrase shows the route's error message and leaves the DB
  untouched (server-side guarantee; UI just surfaces it); correct passphrase
  shows success/notices incl. any CRC-env warning.
- No passphrase in localStorage/sessionStorage/console (devtools check during
  E2E); Copy works on localhost (fallback path exercised).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Users lose the generated passphrase → backup useless | High (industry-documented) | High | Show-once + Copy + .txt download + mandatory retype + "cannot be shown again" + F-on confirm copy states unrecoverability | support complaints | Copy only; no server-side storage EVER (design invariant) |
| Passphrase lingers in React state / storage | Medium | Medium | State cleared on modal close/unmount; never persisted; grep diff for storage APIs | devtools shows stale passphrase after modal close | Add explicit cleanup in onClose + useEffect unmount |
| Clipboard API unavailable (non-secure origin beyond localhost) | Medium | Low | Fallback: select-the-text instruction + Download .txt always available | Copy button no-op on http LAN origins | Fallback UI branch; document "use Download" |
| Modal flow gets tangled (encrypt step vs password step ordering) | Medium | Low | Password is collected FIRST in every path (single mental model: auth → passphrase); one modal open at a time | manual E2E friction | Simplify by folding encrypt choice into the dbAuth modal as a first step |
| Honest-copy regressions (F-off text accidentally changed) | Low | Medium | Copy-matrix grep step; F-off strings pinned by comparison against .45 text | grep shows edited .45 strings | Revert copy; only additive strings allowed |

## Security Considerations

- Passphrase: secret inputs (type=password), state-only lifetime, cleared on
  close; never logged; never persisted; clipboard write user-initiated.
- Show-once discipline: generated passphrase displayed exactly once; no
  "view again"; download and copy are the persistence, by user choice.
- No sealing under default passwords: F sealing is passphrase-based (RT-03
  unaffected); the dashboard password modal flow is unchanged.
- Import never partial-decrypts: server contract; UI surfaces the hard 400 and
  never implies partial success.
- Masked inputs: passphrase/confirm/retype are secret inputs (browser masking
  = the dashboard equivalent of promptSecret).
- The .txt download carries the passphrase in plaintext — filename and content
  both carry an explicit "store securely" warning line.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT46-A3/O3 charset gate on the dashboard surface (critical — silent-loss path):** browser `fetch` TRUNCATES header chars U+0100–U+01FF (`codepoint & 0xFF`); without a gate, a passphrase with any such char gets sealed under a TRANSFORMED value after the user already passed the retype gate — the archive becomes unopenable from EVERY surface while the user believes they know the passphrase (import sends the passphrase in the BODY, so no symmetric mangling ever rescues it). Add `/^[\x20-\x7E]+$/` validation + explanatory copy ("passphrase must be printable ASCII — spaces and hyphens are ignored") to the OWN, CONFIRM, and RETYPE fields, enforced client-side BEFORE any request fires; the server 400 (phase-02 RT46-A3) is the backstop.
2. **RT46-A7 hint copy:** the min-length hint discloses the normalization discount: "minimum 10 characters (I and L count as 1, O as 0; spaces and hyphens are ignored)".
3. **RT46-O7 import detection needs a flow restructure:** today `handleImportDatabase` (profile/page.js:690-697) opens the dbAuth modal BEFORE any read; parsing happens inside `runImportDatabase` (:704-705) after confirm. To choose the passphrase-bearing modal variant BEFORE confirm, move `file.text()`+`JSON.parse` into the selection handler (or cache the parsed result in a ref and reuse at confirm). One sentence in Requirements — do not present detection as slotting into the existing handler order.

## Next steps

- Phase 04 mirrors the same flows in the CLI (shared server contracts).
