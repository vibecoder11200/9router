# Phase 05 — CLI Backup & Restore Menu

## Context links

- Depends on: [phase-02-secret-export-adoption.md](phase-02-secret-export-adoption.md) (routes accept/require password), [phase-03-rekey-flow.md](phase-03-rekey-flow.md) (`rekeyApiKey` client method)
- Parent: [plan.md](plan.md)

## Overview

- Date: 2026-09-06
- Description: New CLI menu `Backup & Restore`: Export prompts the dashboard password, GETs `/api/settings/database` with `x-9r-password`, writes `9router-backup-<stamp>.json` to cwd; Import prompts file path + password, POSTs, prints warnings incl. needsRekey count. Client gains `exportDatabase(password)` / `importDatabase(payload, password)`; `makeRequest` gains an optional headers param.
- Priority: P1
- Status: done

## Key Insights

- `makeRequest` (cli/src/cli/api/client.js:86-166) hardcodes headers to Content-Type + CLI token (:95-98) — the password header needs a 4th optional param `extraHeaders = {}` merged in; every existing call site (3-arg or fewer) is untouched (verified: all current calls pass ≤3 args).
- CLI export chooses the PASSWORD path on purpose (not the CLI-token path): the CLI token alone yields an envelope-less backup (phase 02 GET mode detection) — prompting the dashboard password is what makes the backup portable.
- Local no-password installs: `verifyDashboardPassword` (src/lib/auth/dashboardSession.js:79-91) accepts `INITIAL_PASSWORD || DEFAULT_PASSWORD` only for local requests — CLI runs local, so the prompt still works on fresh installs (user enters the default/initial password).
- Import response carries `{ success, warnings, needsRekeyCount }` (phase 02 step 6) — print warnings verbatim plus a targeted "N key(s) need re-keying — API Keys → Re-key" line, reusing the phase-03 CLI action.
- Menu conventions to copy exactly: `showMenuWithBack` items array (cli/src/cli/terminalUI.js:76-110), `prompt`/`pause`/`showStatus` (cli/src/cli/menus/apiKeys.js:1-6), breadcrumb threading.
- Write file with plain `fs.writeFileSync(path, JSON.stringify(payload, null, 2))` mirroring the dashboard blob (profile/page.js:670-676). Save to cwd (unresolved question #2 in plan.md — default cwd, revisit later).

## Requirements

- `makeRequest(method, path, body, extraHeaders)` — additive param; no behavior change for existing callers.
- `api.exportDatabase(password)` → GET `/api/settings/database` with `x-9r-password: password`.
- `api.importDatabase(payload, password)` → POST `/api/settings/database` body `{ ...payload, password }`.
- New `cli/src/cli/menus/backup.js` `showBackupMenu(port, breadcrumb)` with Export / Import items; wired into the main menu (terminalUI.js) as "Backup & Restore".
- Export prints the written path + a note that the file contains the password-wrapped key secret ("store it securely").
- Import prints warnings; on `needsRekeyCount > 0` prints the re-key guidance; on missing file / bad JSON prints a clean error.
- Never echo the password back; never print the envelope contents.

## Architecture

```
Main menu (terminalUI.js)
  └─ "Backup & Restore" → showBackupMenu(port, breadcrumb)
       ├─ "Export Backup"
       │    password = prompt("Dashboard password (wraps the key secret): ")
       │    res = api.exportDatabase(password)          GET + x-9r-password
       │    file = `9router-backup-<YYYYMMDD-HHmmss>.json`  (cwd)
       │    fs.writeFileSync(file, JSON.stringify(res.data, null, 2))
       │    print path + "contains an encrypted copy of your API-key
       │           secret — protected by this password; store securely"
       └─ "Import Backup"
            path     = prompt("Path to backup .json: ")
            password = prompt("Password used when this backup was exported: ")
            payload  = JSON.parse(fs.readFileSync(path, "utf8"))
            res      = api.importDatabase(payload, password)   POST {…, password}
            print warnings[]; if needsRekeyCount: "→ API Keys → Re-key (paste raw key)"
```

## Related code files

- `cli/src/cli/api/client.js` (`makeRequest` :86-166; keys section :283-310; exports :517-525)
- CREATE `cli/src/cli/menus/backup.js`
- `cli/src/cli/terminalUI.js` (requires :3-7, items :76-110)
- `cli/src/cli/utils/input.js` (`prompt` :49), `cli/src/cli/utils/display.js` (`showStatus`)
- No server changes (routes already done in phase 02/03)

## Implementation Steps

1. `cli/src/cli/api/client.js` — `makeRequest(method, path, body = null, extraHeaders = {})` (:86): change `headers: { "Content-Type": "application/json", [CLI_TOKEN_HEADER]: getCliToken() }` (:94-98) to spread `...extraHeaders` after the token header (extraHeaders wins, allowing future overrides).
2. Same file — add after `deleteApiKey` (:307):
   ```js
   // Database backup (v0.6.45). Password path on purpose: only a
   // password-authenticated export embeds the wrapped key secret.
   async function exportDatabase(password) {
     return makeRequest("GET", "/api/settings/database", null, { "x-9r-password": password });
   }
   async function importDatabase(payload, password) {
     return makeRequest("POST", "/api/settings/database", { ...payload, password });
   }
   ```
   Add `exportDatabase, importDatabase` to the API Keys/backup export block (:520-522).
3. CREATE `cli/src/cli/menus/backup.js`:
   - Requires: `api`, `{ prompt, pause }` from `../utils/input`, `{ showStatus }` from `../utils/display`, `{ showMenuWithBack }` from `../utils/menuHelper`, `fs`/`path` node builtins.
   - `async function handleExport(port)` per Architecture; stamp `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)`; on `!res.success` `showStatus("Export failed: " + res.error, "error")`; on success print file path (resolved absolute) + the security note; `pause()`.
   - `async function handleImport()` per Architecture; wrap read/parse in try/catch → `showStatus("Could not read backup file: " + err.message, "error")`; on success print each warning (amber-ish plain text is fine — CLI has no colors here beyond COLORS in terminalUI; KISS) + needsRekey guidance line; `pause()`.
   - `async function showBackupMenu(port, breadcrumb = [])` → `showMenuWithBack({ title: "💾 Backup & Restore", breadcrumb, headerContent: "Export embeds an encrypted copy of your API-key secret (needs the dashboard password). Import restores everything; wrong password = keys need re-keying.", items: [Export, Import] })`.
   - `module.exports = { showBackupMenu };`
4. `cli/src/cli/terminalUI.js` — `const { showBackupMenu } = require("./menus/backup");` (:3-7) and add item after "Settings" (:102-108):
   ```js
   {
     label: "Backup & Restore",
     action: async () => { await showBackupMenu(port, [...basePath, "Backup & Restore"]); return true; }
   }
   ```
5. Manual smoke (documented, not automated — CLI has no test harness): run CLI against a dev server, export with password, confirm file exists in cwd and `authSecretEnvelope` present in JSON; import it back with right and wrong password; confirm warning + needsRekey line; re-key via API Keys menu.

## Todo list

- [x] `makeRequest` 4th param `extraHeaders` (merged after token header)
- [x] `exportDatabase` / `importDatabase` client methods + exports
- [x] `cli/src/cli/menus/backup.js` (Export / Import handlers + menu)
- [x] terminalUI.js wiring ("Backup & Restore" item after Settings)
- [x] Manual smoke: export→file, import right/wrong password, re-key path
- [x] gitnexus `impact` on `makeRequest` BEFORE editing; `detect_changes()` before commit

## Success Criteria

- `grep -n "makeRequest(" cli/src/cli/api/client.js` shows all pre-existing call sites unchanged (3 args or fewer); new methods compile (`node -e "require('./cli/src/cli/api/client.js')"` from repo root exits 0).
- Exported file exists in cwd, is valid JSON, contains `authSecretEnvelope` and `meta.authSecretWrapped === true` when exported with a password.
- Import with wrong password prints an amber-style warning mentioning re-key and the count; import never exits non-zero on unwrap failure (server returns 200 with warnings).
- Import of a v0.6.44-era plaintext backup (no envelope) still succeeds with the informational warning (legacy shape detection — payload lacks `authSecretEnvelope`, import proceeds normally).
- CLI main menu shows six items incl. "Backup & Restore"; back navigation returns to main menu (menuHelper contract).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Password echoed in terminal during prompt | Medium | Medium (shoulder-surfing) | `prompt` util is plain readline (input.js:49) — no masking today; note in menu copy ("input is visible"); a masked prompt helper is a nice-to-have | password visible on screen | Ship with visible input + note in .45; masked prompt candidate for .46 |
| Backup file written to an unexpected cwd (user launched CLI from elsewhere) | Medium | Low | Print the ABSOLUTE resolved path after write | user can't find file | Print path; .46 may add save-location prompt (plan.md unresolved #2) |
| Huge payload import ties up CLI 30 s timeout (makeRequest :157) | Low | Low | Import of realistic DBs ≪ 30 s; scrypt adds ~1 s | timeout error message | Raise timeout for importDatabase only if reported |
| Envelope-bearing backup imported by OLD CLI/server (downgrade) | Low | Low | Old importer ignores unknown top-level field (importDb iterates known tables only) — degrades to needsRekey path | warnings shown | Accept; documented |
| makeRequest signature change breaks a caller passing 4th arg | Very Low | Low | grep verified: no 4-arg callers exist today | CI/test failure | None needed |

## Security Considerations

- NEVER log/echo the password (beyond the unavoidable visible prompt input) or the envelope contents; the CLI prints only the file path and warning text.
- The backup FILE is key material once exported (contains the wrapped pepper — LUKS-header-backup analogy, researcher-01 §4): the export success message says so explicitly; no chmod attempt beyond default umask on Windows-focused CLI (documented, not enforced).
- Requests go to localhost by default (`api.configure({ port })`, terminalUI.js:82); the password header travels only over the local loopback / user-configured host — same trust boundary as the existing CLI token header (client.js:97).
- `x-9r-password` header is sent only on the two backup endpoints — never added globally to `makeRequest`.
- Envelope versioning respected: CLI treats `authSecretEnvelope` opaquely (no parsing) — forward compatible with v2 envelopes.
- No async-crypto on the CLI side (server does scrypt); no event-loop concerns.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT-14 masked prompts THIS release (supersedes risk row 1's "ship with visible input + note" and Security Considerations bullet 1's parenthetical):** add `promptSecret(promptText)` to cli/src/cli/utils/input.js (~10 lines: `rl.question` with a proxied stdout.write emitting `*`; Enter submits; Ctrl+C cancels to menu). Use it for the dashboard password AND (phase-03 RT-12) the pasted raw key. Both prompts print "(input hidden)". Architecture diagram's two `prompt(…)` calls for passwords become `promptSecret(…)`.
2. **RT-15 file-write hardening (supersedes step 3's handleExport write):** `fs.writeFileSync(file, JSON.stringify(res.data, null, 2), { mode: 0o600 })` (POSIX advisory on Windows — same convention as install secrets). Wrap in try/catch → `showStatus("Could not write backup file: " + err.message + " (target: " + path.resolve(file) + ")", "error")` + `pause()` — an unguarded EBUSY/EPERM (file open in an editor, OneDrive-synced cwd, Program Files) currently crashes the whole TUI because menuHelper runs actions without try/catch.
3. **RT-16 honest copy everywhere (supersedes step 3's headerContent + success note):** every mention of the wrapped secret must continue "…but the rest of the backup — including provider access tokens — stays unencrypted." Header: "Export embeds your API-key secret encrypted with the dashboard password (the rest of the backup — including provider access tokens — stays unencrypted). Wrong password on import = keys need re-keying." Success note: "Backup written. It contains an encrypted copy of your API-key secret — but provider access tokens inside are NOT encrypted; store the file securely."
4. **RT-17 Key Insights bullet 3 is WRONG (supersedes it):** `INITIAL_PASSWORD` bypasses the locality gate entirely (dashboardSession.js), so "default/initial password only for local requests" is false — and after phase-02 RT-03 it's moot anyway: sealing requires a stored bcrypt password, so fresh default-password installs export envelope-LESS with a warning telling the user to set a dashboard password for portable backups. CLI export on such installs still succeeds (auth passes); the file just carries `meta.authSecretWrapped === false` + the warning string from the response.
5. **RT-18 import prompt text stays as drafted:** CLI auth is token-based, so the body password is ONLY the unwrap password — "Password used when this backup was exported:" is accurate for CLI. The dashboard modal is the only one-password-two-roles surface (phase-02 RT-09). Import response handling also prints `meta.authSecretWrapped === false` warnings verbatim when present.

## Next steps

- Phase 06 runs the full sweep + release; phase 07 sketches the .46 whole-archive option that may subsume "which password" UX.
