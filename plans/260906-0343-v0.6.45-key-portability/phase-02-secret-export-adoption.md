# Phase 02 — Secret Export + Adoption on Import + needsRekey Column

## Context links

- Depends on: [phase-01-crypto-envelope.md](phase-01-crypto-envelope.md)
- Research: [research/researcher-02-portability-precedent.md](research/researcher-02-portability-precedent.md) (Gitea dump precedent for shipping the pepper)
- Prior art shipped in v0.6.44: [../../reports/FixLog-260906-0245-regression-batch-v0635-v0641.md](../../reports/FixLog-260906-0245-regression-batch-v0635-v0641.md) (importDb warnings, meta.installId, budget round-trip)
- Parent: [plan.md](plan.md)

## Overview

- Date: 2026-09-06
- Description: Thread the dashboard password from the database settings route into exportDb/importDb. Export embeds a password-wrapped `api-keys-hmac` secret envelope. Import unwraps BEFORE the transaction, adopts the secret before key inserts (with rollback restore), or marks carried-keyHash rows `needsRekey=1` and warns. Profile page copy clarifies which password is expected.
- Priority: P1
- Status: pending

## Key Insights

- `db.transaction(fn)` callbacks are synchronous (src/lib/db/index.js:191-284) — async scrypt CANNOT run inside; unwrap+adopt must happen before `db.transaction` is entered. This is a hard ordering constraint, not a style choice.
- `hashApiKey` (src/lib/db/repos/apiKeysRepo.js:9-12) is the ONLY consumer of the `"api-keys-hmac"` scope — adopting that one file makes every imported `keyHash` validate; nothing else needs the secret.
- Import wipes all tables but keeps `_meta` (src/lib/db/index.js:197-204) — local `install-id` survives, so the OLD cross-install heuristic (importDb:182-188) now needs refinement: when adoption succeeded, keys DO work despite differing installIds → suppress that warning.
- Same-install import with wrong/missing password: local secret unchanged → hashes still validate → `needsRekey` must stay 0. Inert condition = `keyHash` present AND no adoption AND (installId differs OR missing). Pre-v0.6.44 archives (no `meta.installId`) with keyHash therefore flag needsRekey — acceptable: re-key is advisory-only and those archives are by definition old.
- Adoption-before-inserts has a rollback hazard: if the transaction throws AFTER `adoptInstallSecret` replaced the file, the rolled-back OLD apiKeys rows would no longer match the NEW secret. Mitigation: snapshot the current secret before adopting; on transaction throw, restore the snapshot via the same helper. (Decision order kept: adopt BEFORE inserts.)
- `getApiKeyRow` hash lookups go through the module-level Map cache in installSecret.js:13 — adoption MUST overwrite the cache (`cache.set`), not just the file, or the running process keeps signing with the old secret until restart.
- `meta.installId` is deliberately NOT derived from the HMAC secret (index.js:8-14) — exporting/adopting the secret never changes install identity.

## Requirements

- `exportDb({ password })`: when `password` is a non-empty string, embed `payload.authSecretEnvelope = await sealBackupSecret(getOrCreateInstallSecret("api-keys-hmac"), password)` and `payload.meta.authSecretWrapped = true`. Without password (CLI-token path): no envelope, `meta.authSecretWrapped = false` (the "note").
- `importDb(payload, { password })`: exact flow below; NEVER hard-fail on unwrap failure; result gains `needsRekeyCount`.
- Additive column `apiKeys.needsRekey INTEGER DEFAULT 0` via TABLES declaration (auto-sync); NO SCHEMA_VERSION bump (decision; additive-with-default skips only the pre-change backup, migrate.js:1-5).
- Export carries `needsRekey` per row (sticky: an inert row re-exported stays inert unless re-keyed).
- Route threads password into both calls; profile modal/import copy says the password is "the dashboard password used when this backup was exported" (English copy; concept: "mật khẩu dùng lúc xuất backup").
- Route response POST keeps `{ success, warnings }` shape (v0.6.44, profile page depends on it) and adds `needsRekeyCount`.

## Architecture

```
exportDb({password})                          importDb(payload, {password})
  build payload (unchanged)                     envelope = payload.authSecretEnvelope
  if password:                                  adopted = false; inertRows = null
    envelope = sealBackupSecret(                if isBackupEnvelope(envelope):
        secret("api-keys-hmac"), password)        try:                       // BEFORE transaction
    meta.authSecretWrapped = true                  newSecret = openBackupSecret(envelope, password)
  else:                                            old = read current secret file (best-effort)
    meta.authSecretWrapped = false                 adoptInstallSecret("api-keys-hmac", newSecret)
                                                   adopted = true
  return payload                                 catch: adopted = false
                                                inert = k.keyHash && !adopted
                                                  && (installId mismatch || missing)
                                                db.transaction(() => {        // sync
                                                  ...wipe/insert (unchanged)...
                                                  apiKeys insert adds needsRekey
                                                    = (k.needsRekey===1 || inert) ? 1 : 0
                                                })
                                                on transaction throw && adopted:
                                                  adoptInstallSecret(old)  // restore, then rethrow
                                                warnings: adopt-fail → amber re-key msg + count;
                                                  cross-install warning ONLY when !adopted && inert
                                                return exportDb() + { warnings, needsRekeyCount }
```

## Related code files

- `src/lib/db/schema.js` (apiKeys columns, :78-98)
- `src/lib/auth/installSecret.js` (add `adoptInstallSecret`, :15-30)
- `src/lib/db/repos/apiKeysRepo.js` (`rowToKey` expose needsRekey, :26-48)
- `src/lib/db/index.js` (`exportDb` :119-164, `importDb` :171-300)
- `src/app/api/settings/database/route.js` (GET :18-30, POST :32-56, `authorized` :13-16)
- `src/app/(dashboard)/dashboard/profile/page.js` (dbAuth modal :1672-1699, status render :836-840)
- CREATE `tests/unit/key-portability.test.js`
- Existing harness to extend/copy: tests/unit/s7-followup-regressions.test.js:23-70

## Implementation Steps

1. `src/lib/db/schema.js` — add to `apiKeys.columns` after `hardBlock` (:92): `needsRekey: "INTEGER DEFAULT 0", // v0.6.45: imported keyHash that this install's secret cannot validate (re-key to fix)`. No SCHEMA_VERSION bump. syncSchemaFromTables (migrate.js:87-101) adds it on next boot.
2. `src/lib/auth/installSecret.js` — add:
   ```js
   export function adoptInstallSecret(fileName, secret) {
     if (typeof secret !== "string" || !secret.trim()) throw new Error("adoptInstallSecret: empty secret");
     const file = path.join(AUTH_DIR, fileName);
     fs.mkdirSync(AUTH_DIR, { recursive: true });
     fs.writeFileSync(file, secret, { mode: 0o600 });
     cache.set(fileName, secret);
     return secret;
   }
   ```
   Also export a `readInstallSecret(fileName)` (returns current file content or null, WITHOUT creating) for the snapshot/restore path — keeps installSecret.js the single owner of AUTH_DIR.
3. `src/lib/db/repos/apiKeysRepo.js` — `rowToKey` add `needsRekey: row.needsRekey === 1 || row.needsRekey === true,` (after `hardBlock`, :46).
4. `src/lib/db/index.js` — `exportDb(options = {})`:
   - Signature change; build payload exactly as today (:123-156).
   - After the kv loops (:158-161): `if (typeof options.password === "string" && options.password) { const { sealBackupSecret } = await import("@/lib/auth/backupEnvelope.js"); const { getOrCreateInstallSecret } = await import("@/lib/auth/installSecret.js"); out.authSecretEnvelope = await sealBackupSecret(getOrCreateInstallSecret("api-keys-hmac"), options.password); }`
   - `out.meta.authSecretWrapped = Boolean(out.authSecretEnvelope)` (:124 meta object).
   - apiKeys export row (:136-150): add `needsRekey: r.needsRekey === 1 || r.needsRekey === true ? 1 : 0,`.
5. `src/lib/db/index.js` — `importDb(payload, options = {})`:
   - BEFORE the transaction (before :191): unwrap block per Architecture diagram. Compute per-row inert predicate: `const foreignOrUnknown = importedInstallId !== localInstallId` where missing `importedInstallId` counts as unknown (reuse/extend the existing best-effort block :182-188; note it currently skips when no apiKeys — keep that).
   - `db.transaction` body: apiKeys INSERT (:252-263) gains column `needsRekey` and value `(k.needsRekey === 1 || k.needsRekey === true || (!adopted && k.keyHash && foreignOrUnknown)) ? 1 : 0` (13 params now). Pre-S7 rows (`k.keyHash` falsy) → 0 (lazy backfill, index.js:247-251 comment).
   - Wrap transaction call: `try { db.transaction(...) } catch (err) { if (adopted) { try { adoptInstallSecret(FILE, oldSecret) } catch {} } throw err; }` where `oldSecret = readInstallSecret("api-keys-hmac")` captured before adopting (null on first-run install → restore = delete-and-recache? KISS: if oldSecret is null, restore by clearing cache `cache` is private — instead call `adoptInstallSecret` only when oldSecret non-null; when null there were no local hashed keys to break).
   - After the existing warnings block (:287-298):
     - `const needsRekeyCount = [...state].filter(inert).length` — recompute by reading rows back? The restored payload IS exportDb() output (rows include needsRekey after step 4 export change) → `const needsRekeyCount = restored.apiKeys.filter((k) => k.needsRekey).length; restored.needsRekeyCount = needsRekeyCount;`
     - If envelope present && !adopted → push warning: `"The backup embedded an encrypted key secret, but the password did not match the one used when the backup was exported. Everything else was imported. N API key(s) were restored but cannot authenticate until re-keyed (Endpoint page → Re-key, or CLI) — paste each raw key once."` (N = needsRekeyCount).
     - Cross-install warning (:289-291): only push when `crossInstallKeys && !adopted` and reword tail to point at the re-key flow instead of "create new keys".
     - If no envelope && !importedInstallId && any keyHash rows → push the missing-id informational warning (replaces silent v0.6.44 behavior for old archives): `"This backup predates v0.6.44 and carries no install id or embedded secret — if it came from another machine, its keys need re-keying."`
   - Final `exportDb()` call (:286) stays argument-less (response is not re-wrapped).
6. `src/app/api/settings/database/route.js`:
   - GET (RT-AMENDED per Red-Team Amendment RT-Cli — supersedes the mode-detection draft, which was dead-on-arrival for CLI exports because `makeRequest` ALWAYS attaches the CLI token): derive the wrap-password from `x-9r-password` REGARDLESS of which auth path passed, and reject a BAD password even when the CLI token is valid (no silent envelope-less export, no guessing oracle):
     ```js
     const password = request.headers.get("x-9r-password");
     const hasPw = typeof password === "string" && password.length > 0;
     const pwOk = hasPw && (await verifyDashboardPasswordAgainstStoredHash(password));
     const viaCliToken = await hasValidCliToken(request);
     if (!viaCliToken && !pwOk) return unauthorized;
     if (hasPw && !pwOk) return unauthorized; // token + wrong password = reject, don't downgrade
     const payload = await exportDb(pwOk ? { password } : {});
     ```
     `verifyDashboardPasswordAgainstStoredHash` is the new bcrypt-only compare from RT-03 (below) — NOT `verifyDashboardPassword`, which accepts the "123456"/INITIAL_PASSWORD fallbacks.
   - POST: `const restored = await importDb(payload, { password });` and response `{ success: true, warnings: restored?.warnings || [], needsRekeyCount: restored?.needsRekeyCount || 0 }` (:48).
7. `src/app/(dashboard)/dashboard/profile/page.js`:
   - Modal copy (:1688-1690): export mode → `"Enter your dashboard password. It encrypts your API-key secret inside the backup — the same password will be needed to restore it."`; import mode → `"Enter the password that was used when this backup was exported (the exporter's dashboard password). Without it, everything imports but API keys must be re-keyed."`
   - `runImportDatabase` (:719-725): when `data.needsRekeyCount > 0`, append to the warning message: `"N key(s) need re-keying — Endpoint page → API Keys → Re-key."`
8. CREATE `tests/unit/key-portability.test.js` (copy harness from s7-followup-regressions.test.js:16-75; extend fakeAdapter INSERT to 13 params; `vi.mock("@/lib/auth/installSecret.js")` with a shared `state.secret` + `adoptInstallSecret: (f, s) => { state.secret = s; state.adopted = f; }` + `getOrCreateInstallSecret: () => state.secret`):
   - password export embeds envelope + `meta.authSecretWrapped === true`; no-password export omits both.
   - round-trip: export with password on "install A" state → import with same password on "install B" (different `state.secret`, different meta installId) → adopted flag set, imported rows `needsRekey === 0`, NO cross-install warning.
   - wrong password import → rows with keyHash get `needsRekey === 1`, `needsRekeyCount` correct, amber warning matches /re-key/i, NO throw.
   - same-install import without password (matching installId) → needsRekey 0, no warnings (regression guard).
   - pre-S7 archive row (key=raw, keyHash null) → needsRekey 0 regardless.
   - envelope absent + installId missing + keyHash rows → informational warning + needsRekey 1.
   - transaction-throw restore: force fakeAdapter run() to throw on one INSERT after adoption → assert adopt was called with OLD secret afterwards (restore) and importDb rethrows.

## Todo list

- [ ] schema.js needsRekey column (no SCHEMA_VERSION bump)
- [ ] installSecret.js: adoptInstallSecret + readInstallSecret
- [ ] rowToKey exposes needsRekey
- [ ] exportDb({password}) embeds envelope + meta note + carries needsRekey
- [ ] importDb(payload, {password}): unwrap before transaction, adopt before inserts, rollback restore, inert flagging, warnings, needsRekeyCount
- [ ] Route: mode-aware GET (CLI token → no envelope), POST threads password, response + needsRekeyCount
- [ ] Profile page modal copy (export-password vs import-password clarification) + needsRekeyCount in warning message
- [ ] tests/unit/key-portability.test.js all cases green (`npx vitest run unit/key-portability` from tests/)
- [ ] Run gitnexus `impact` on exportDb/importDb BEFORE editing (AGENTS.md rule) and record blast radius in the PR body; `detect_changes()` before commit

## Success Criteria

- All phase-02 unit tests pass; existing s7-followup-regressions.test.js still passes UNCHANGED except the cross-install warning text assertion (:146 matches /different/i — keep the word "different" in the reworded warning).
- Export with password contains `authSecretEnvelope` whose plaintext secret is NOT recoverable from the JSON without the password (test asserts `JSON.stringify(out)` does not contain the raw secret).
- Import with wrong password: returns 200-equivalent result (no throw), `needsRekeyCount ≥ 1`, warning present.
- Import with right password cross-install: adopted secret equals exporter's secret; `validateApiKey(rawKey)` (apiKeysRepo.js:205) returns true for a key from the archive (integration-style assertion in test).
- Boot on an existing v0.6.44 DB auto-adds the column (log line `[DB][sync] +column apiKeys.needsRekey` from migrate.js:97).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Transaction throw after adoption strands old rows with a foreign secret | Low | High | Snapshot+restore of old secret (step 5); unit test covers | restore assertion in key-portability test | If restore itself fails, log loudly + needsRekey path remains the user-visible recovery |
| Cache desync: file adopted but Map cache stale | Low | High | adoptInstallSecret writes cache AND file (step 2) | validateApiKey works in-process after import (no restart) | None needed if test asserts in-process validation |
| False-positive needsRekey on same-install old-archive imports (missing installId) | Medium | Low (advisory flag; keys still work) | Warning copy says "if it came from another machine"; re-key optional | user reports unnecessary amber badge | Accept in .45; refine with a stored secret fingerprint in _meta in .46 if reported |
| Envelope makes GET export noticeably slower (scrypt ~0.5-1 s) | Certain | Low (rare admin op) | async scrypt off event loop | request duration | Accept |
| exportDb signature change breaks other callers | Low | Medium | Grep callers: only route.js:23 and importDb:286 internal call — both updated; default `{}` keeps old behavior | grep `exportDb(` → 3 sites | None |
| Mocked installSecret in OLD tests lacks adoptInstallSecret | Medium | Medium (test-only) | s7-followup test mocks the module (:73-75) — default param path never calls adopt, so unchanged tests keep passing; verify in phase-06 sweep | old suite green after change | Add missing mock export only if a test actually hits adopt |

## Security Considerations

- NEVER log password/secret/envelope plaintext: warnings and errors carry counts only; `console.log` calls in route.js:27/50 stay on error.message (generic).
- Envelope sealing happens ONLY after `authorized()` succeeded (route step 6) — the password used to wrap is itself proof-of-knowledge gated; wrong-guess rate on unwrap is additionally bounded by scrypt cost (64 MiB per attempt).
- Adopted secret file written 0600 (`mode: 0o600`, installSecret.js convention; Windows note: POSIX mode is advisory there — ACL inheritance applies, same as existing install secrets).
- AAD `"9router-backup-v1"` prevents envelope replay into any future non-backup field; envelope `v:1` + in-band params keep forward compat (v0.6.46 openers read v1).
- Import is authenticated by password OR CLI token; only the PASSWORD path yields an envelope — a CLI-token-holder cannot exfiltrate the wrapped secret without the dashboard password (envelope absent on that path entirely).
- Scrypt runs before the transaction, never inside it; single concurrent admin request, ~64 MiB transient.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT-03 seal ONLY under a stored bcrypt hash (supersedes step 4's unconditional wrap and Security Considerations bullet 2's assumption):** `verifyDashboardPassword` accepts bootstrap `DEFAULT_PASSWORD` ("123456", dashboardSession.js:10) for local requests and `INITIAL_PASSWORD` via env (which bypasses the locality gate entirely). A backup sealed under a publicly-known/default password = pepper + every keyHash to whoever leaks the file; legacy pre-S7 2-part keys (~41 bits, bare HMAC) then fall to offline brute in minutes. Add `verifyDashboardPasswordAgainstStoredHash(password)` in dashboardSession.js (bcrypt compare against `settings.password` ONLY; false when no stored hash exists — no fallback branches). exportDb seals only via that function. Fresh installs without a set password export envelope-less with a warning telling the user to set a dashboard password for portable backups. This also voids phase-05 Key Insights bullet 3 ("prompt still works on fresh installs" → it authenticates, but never seals).
2. **RT-04 adopt AFTER commit (supersedes Key Insights bullet 5, the Architecture "adopt before transaction / restore on throw" tail, step 5's unwrap-ordering + try/restore wrapper, risk row 1, and test case 7):** nothing inside the sync transaction needs the adopted secret (INSERT values come verbatim from the payload — verified). New flow: unwrap BEFORE the transaction (async constraint stays), hold `newSecret` in a local → run the transaction to completion → `adoptInstallSecret(FILE, newSecret)` AFTER commit. This deletes the snapshot/restore path and `readInstallSecret`'s restore role entirely (keep `readInstallSecret` export — phase-06 lifecycle test still uses it to assert adoption). Residual crash window (commit→adopt, milliseconds) strands imported rows inert-but-unflagged: mitigate with a best-effort `UPDATE apiKeys SET needsRekey=1 WHERE keyHash IS NOT NULL` + loud generic log if `adoptInstallSecret` throws post-commit. Replace test case 7 with: force `adoptInstallSecret` to throw post-commit → assert the best-effort UPDATE ran (needsRekeyCount = all keyHash rows) and importDb still returns success with the re-key warning.
3. **RT-05 importDb minimum-shape guard (new, FIRST thing in importDb, before any DELETE):** today `importDb({})` wipes every table, inserts nothing, skips settings restore, returns success — and leaves `verifyDashboardPassword` back on the "123456"/INITIAL_PASSWORD fallback (auth downgrade + total data loss from one wrong file pick). Reject (throw → route 400) unless `payload` is an object with `meta` AND ≥1 known table key (`settings|providerConnections|providerNodes|proxyPools|apiKeys|combos|modelAliases|customModels|mitmAlias|pricing`). Also protects phase-07's shape-detection import. Add negative tests: `importDb({})` and `importDb({unexpected:1})` throw with ZERO `DELETE` statements executed (fake adapter records SQL runs — assert none start with "DELETE").
4. **RT-06 skip unwrap when no password:** `if (password && isBackupEnvelope(envelope))` — an envelope-bearing archive imported with empty/absent password goes straight to inert instead of burning a full scrypt (~1 s) to inevitably fail (CLI 30 s timeout budget).
5. **RT-07 serialize imports:** wrap unwrap→transaction→adopt behind an in-process async mutex (promise-chain, pattern of `src/lib/serialize.js`) — two overlapping POSTs must not interleave adopt/adopt/tx/tx and pair rows with the wrong pepper.
6. **RT-08 wire loginLimiter into the database route:** `authorized()` has no throttling today (loginLimiter is wired only on login/saml/setup-password routes — grep-verified); a successful password guess returns the whole DB + wrapped pepper. Reuse `checkLock`/`recordFail` on the password path of BOTH GET and POST.
7. **RT-09 copy fixes (supersede step 7's modal text):** export modal: "Enter your dashboard password. It encrypts your API-key secret inside the backup — but the rest of the backup, including provider access tokens, stays unencrypted; store the file securely." Import modal: "Enter your CURRENT dashboard password. If it differs from the password used when this backup was exported, the keys will need re-keying after import." The CURRENT password authenticates the POST; the exporter's password only unwraps — never write copy implying otherwise.
8. **RT-10 test mock completeness:** step 8's installSecret mock must ALSO export `readInstallSecret: () => state.secret` (importDb's unwrap/adopt path calls it; without it the flagship round-trip test fails as specced). Same for phase-06's stateful mock.
9. `inert` predicate confirmed correct by red-team close-out (pre-S7 raw rows → 0; same-install wrong-password → 0): unchanged.

## Next steps

- Phase 03 builds the re-key endpoint/UI that clears `needsRekey` set here.
