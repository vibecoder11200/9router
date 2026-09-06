# Phase 04 — CLI: F Export/Import + Generated-Passphrase Display

## Context links

- Depends on: [phase-02-server-export-import.md](phase-02-server-export-import.md)
- Parent: [plan.md](plan.md)
- Research: [researcher-01-archive-crypto-ux.md](../research/researcher-01-archive-crypto-ux.md) §1 ("dual terminal + web" spec)
- .45 precedent: CLI Backup & Restore menu (RT-12/14/15/16/17) — masked prompts, 0600 writes, guarded I/O, honest SECURITY_NOTE

## Overview

- Date: 2026-09-06
- Description: The CLI Backup & Restore menu gains the F flow: an opt-in
  "encrypt the whole archive?" prompt on export (user-chosen with double
  masked entry, or generated with server-side generation + terminal show-once
  display + mandatory retype), and archive detection + passphrase prompt on
  import. api/client.js gains the archivePassphrase header, the generate
  endpoint call, and the archive POST body.
- Priority: P1
- Status: done

## Key Insights

- CLI is CommonJS and cannot import the ESM src/lib/db/archive.js — so the
  CLI never generates locally: it calls the server's archive-passphrase
  endpoint (ONE generator implementation, DRY) and never needs a local
  normalizer (server normalizes symmetrically at seal/open).
- The export file write needs no format change: the server returns the wrapper
  JSON and `handleExport` (cli/src/cli/menus/backup.js:53-66) writes `res.data`
  verbatim with 0600 — only the header and prompts are new.
- Show-once in a terminal means: print the grouped passphrase in a bordered
  block with the "cannot be shown again — write it down now" line, then never
  reprint it; the mandatory retype (masked, promptSecret) is compared to the
  exact fetched string before the export request fires.
- Import detection mirrors the server: after JSON.parse of the picked file,
  `parsed.format === "9router-encrypted-archive"` → prompt passphrase (masked)
  → POST `{archive: parsed, archivePassphrase, password}` (body only).
- CLI-token-only auth + F works (passphrase is the confidentiality gate —
  plan.md decision), so the encryption offer is NOT conditioned on having a
  dashboard password; the existing password prompt stays for the .45 wrap and
  for import auth. UX: ask "encrypt?" FIRST; if No, the current password
  prompt flow runs unchanged; if Yes, password prompt is still needed for
  auth... resolution: keep the existing dashboard-password prompt first
  (auth), THEN offer encryption — fewest flow changes, password remains
  optional-but-tried exactly as .45 (empty password = token path).
- SECURITY_NOTE honesty: F-on runs a different note ("everything in this file
  is encrypted with your passphrase; losing it makes the backup
  unrecoverable"); F-off keeps the .45 note verbatim (backup.js:10-12).

## Requirements

- api/client.js:
  - `exportDatabase(password, { archivePassphrase } = {})` — merge
    `"x-9r-archive-passphrase": archivePassphrase` into extraHeaders when
    present (client.js:335-337).
  - `getArchivePassphrase(password)` — GET
    /api/settings/database/archive-passphrase with `x-9r-password` when a
    password was entered (mirrors exportDatabase's header idiom; token header
    always sent by makeRequest).
  - `importDatabase(payload, password, { archivePassphrase } = {})` — when
    archivePassphrase is provided, POST body becomes `{ archive: payload,
    archivePassphrase, password }`; otherwise the .45 spread body unchanged
    (client.js:345-347).
  - No passphrase in URLs; makeRequest already puts extras in headers/body.
- menus/backup.js handleExport:
  1. Existing masked dashboard-password prompt first (backup.js:27-34).
  2. NEW prompt: "Encrypt the whole archive with a passphrase? (y/N)" —
     default N (plain Enter).
  3. N → existing flow byte-for-byte (same file name, same notes).
  4. y → sub-choice: "1) Enter my own passphrase 2) Generate one for me".
     - Own: promptSecret twice ("passphrase (min 10 chars, input hidden)",
       "confirm passphrase (input hidden)"); local check: non-empty, length
       >= 10 after stripping spaces/hyphens (hint text mirrors the server's
       rule; the server is the enforcer), entries identical — else reprint
       error and restart the sub-choice (bounded retries: 3 → cancel).
     - Generate: `api.getArchivePassphrase(password)` → print show-once block
       (bordered, monospace grouping as returned, "cannot be shown again —
       write it down or copy it now"), promptSecret retype, exact-match gate
       (3 tries → cancel, never reprint).
  5. Export with archivePassphrase; on success write file
     `9router-backup-<stamp>-encrypted.json` 0600 (guarded write RT-15 kept),
     print the F-on security note; skip the .45 SECURITY_NOTE on this path.
- menus/backup.js handleImport:
  1. Read + JSON.parse (existing, backup.js:91-98).
  2. If `parsed?.format === "9router-encrypted-archive"` → promptSecret
     "Archive passphrase (input hidden)" (never echoed; empty → cancel) →
     `api.importDatabase(parsed, password, { archivePassphrase })`.
  3. Else existing flow unchanged. On 400 wrong-passphrase: print the server
     error verbatim (it names the cause) and offer one retry of the
     passphrase (then exit to menu) — DB is untouched server-side.
- Menu header copy (backup.js:144-147): add one line — "Backups can
  optionally be encrypted with a passphrase (recommended for off-device
  storage). Encrypted backups cannot be opened without the passphrase."
- All prompts use promptSecret (masked); the generated passphrase is printed
  ONCE via console.log inside the bordered block and never stored.

## Architecture

```
handleExport
  promptSecret(dashboard password)           [auth + .45 wrap, unchanged]
  "Encrypt the whole archive? (y/N)"
  ├─ N ──► api.exportDatabase(password) ──► write .json 0600 ──► .45 note   (unchanged)
  └─ y ──► 1) own: promptSecret x2 + local checks   ┐
           2) generate: api.getArchivePassphrase ───┤→ exportDatabase(password,{archivePassphrase})
                show-once block → retype (exact)    ┘   → write -encrypted.json 0600 → F note
handleImport
  read file → JSON.parse
  ├─ format==="9router-encrypted-archive" → promptSecret(archive passphrase)
  │      → api.importDatabase(parsed, password, {archivePassphrase})
  └─ else → api.importDatabase(parsed, password)                      (unchanged)
```

## Related code files

- EDIT cli/src/cli/api/client.js (exportDatabase :335-337, importDatabase
  :345-347, +getArchivePassphrase; exports block :563-566)
- EDIT cli/src/cli/menus/backup.js (handleExport :23-75, handleImport :80-133,
  menu header :144-147)
- Existing helpers reused: promptSecret (cli/src/cli/utils/input.js:64),
  showStatus, guarded write pattern (backup.js:53-66)

## Implementation Steps

1. Impact() upstream on exportDatabase/importDatabase/makeRequest (CLI call
   graph is local: menus/backup.js only — verify with grep, expect 2 callers).
2. client.js: extend the three methods (+module.exports).
3. backup.js: export flow per Requirements (encrypt prompt, sub-choice,
   show-once block, retype gate, -encrypted filename, F note).
4. backup.js: import detection + passphrase prompt + retry-once.
5. Menu header line.
6. Manual E2E against a running server: all four export variants (N; y-own
   short rejected; y-own valid; y-generate wrong/right retype), import
   (encrypted happy + wrong passphrase retry; legacy unchanged); confirm no
   passphrase echo in prompts (masked), file perms on write (0600, Windows:
   mode is best-effort — unchanged .45 behavior).
7. detect_changes(); one green commit
   `feat(cli): encrypted backup support — passphrase prompts, generated-passphrase show-once (v0.6.46 phase 04)`.

## Todo list

- [x] client.js: archivePassphrase plumbing + getArchivePassphrase
- [x] Export: encrypt prompt, own/generate sub-flows, show-once block, retype gate
- [x] Export: -encrypted filename + F-on security note (F-off note untouched)
- [x] Import: wrapper detection + masked passphrase prompt + retry-once
- [x] Menu header copy line
- [x] Manual E2E checklist green
- [x] detect_changes() + one green commit

## Success Criteria

- Default flow (Enter on the encrypt prompt) produces a byte-flow identical to
  .45: same requests, same file name, same notes (diff the terminal output
  against a .45 session).
- Generated path: wrong retype (3x) cancels with NO export request sent; right
  retype produces `9router-backup-*-encrypted.json` whose first bytes are
  `{"format":"9router-encrypted-archive"`.
- Own-passphrase path rejects short/mismatched entries locally; server 400 for
  short-after-normalize surfaces verbatim.
- Encrypted import: correct passphrase imports (warnings printed incl. CRC
  env note if applicable); wrong passphrase prints the server error, DB
  untouched, one retry offered.
- No passphrase ever appears in non-masked terminal output except the single
  show-once block (visual check in E2E transcript).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| User loses generated passphrase (terminal scrolled away, no .txt) | High | High | Bordered block + explicit write-it-down line + retype gate; suggest redirecting output or copying (terminal copy) | support complaints | Copy improvements only; never log/store server-side |
| getArchivePassphrase auth fails on fresh installs (no password set) | Medium | Low | makeRequest always sends the CLI token header (client.js:98); endpoint accepts token OR password (phase 02) | 401 on generate | Fall back to "enter your own passphrase" prompt with an explanatory line |
| Retry loops trap users (retype mismatch x3) | Medium | Low | 3-try cap → cancel to menu (never into a broken state); export simply not performed | user reports frustration | Cap is per-attempt-flow; regenerating a NEW passphrase requires restarting the flow (by design — old one was shown once) |
| Flow-order confusion (password prompt vs encrypt prompt) | Low | Low | Password first (auth), then encrypt offer; prompts are one-at-a-time with clear titles | E2E friction | Reorder/reword locally; server contract untouched |
| Non-latin1 passphrase breaks http header (ERR_INVALID_CHAR) | Medium | Medium | Pre-check: passphrase must match /^[\x20-\x7E]+$/ before sending (same class of issue as the .45 password note at backup.js:40-42); error message suggests ASCII passphrases | export throws ERR_INVALID_CHAR | Client-side pre-check with clear message; server-side header read stays utf8-safe (headers are latin1 on the wire — ASCII-only rule documented) |

## Security Considerations

- Passphrase prompts are ALWAYS promptSecret (masked, cli/src/cli/utils/input.js:64)
  — including confirm and retype; "(input hidden)" in prompt text per RT-14.
- The passphrase is sent in a header (export) / body (import) only — never a
  URL; never echoed; never stored; terminal history-safe (promptSecret does
  not use readline's echoed line).
- Show-once discipline: single console print inside the block; never
  reprinted; no tee/log integration.
- File perms: backup files written `{ mode: 0o600 }` (RT-15) incl. the
  -encrypted variant; guarded write (EBUSY/EPERM) does not crash the TUI.
- No sealing under default passwords: .45 wrap gate unchanged (server-side);
  F sealing uses the fresh passphrase.
- Import never partial-decrypts: server contract; CLI surfaces the hard 400
  and offers only a full retry.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT46-A5/O2 "empty password = token path" is FALSE (supersedes Key Insight #6's tail):** the .45 CLI CANCELS export on empty/null password (backup.js:30-34) — there is no token-only export path from the shipped CLI menu; it exists only at the HTTP contract level. Decision: keep the cancel (byte-identical F-off invariant, plan.md decision 4). Token-only F-export is reachable via direct API use only — say so, and note the phase-02 RT46-A1 gate makes token+wrong-password 401 anyway. The existing dashboard-password prompt stays FIRST in the flow; if the user has no password set, the server's authOk fallback authenticates and (per RT46-A1) F-export still works ONLY via the CLI token — the CLI always sends it, so fresh installs keep working; document this case in the E2E checklist.
2. **RT46-O10 (nit, premise reword):** `require(esm)` works on Node ≥ 22.12 for sync ESM graphs — archive.js COULD be required from the CLI. The server-side generator stays the design for DRY (one implementation) and show-once semantics; drop the "cannot import ESM" justification, keep the conclusion.
3. The local ASCII pre-check stays as specced; the server-side 400 (phase-02 RT46-A3) is the authoritative gate — surface its message verbatim when hit.

## Next steps

- Phase 05 (C4 rules) is independent and may already be done in parallel;
  phase 06 runs the release sweep.
