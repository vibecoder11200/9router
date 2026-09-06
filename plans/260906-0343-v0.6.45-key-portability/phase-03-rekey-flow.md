# Phase 03 — Re-key Flow (Endpoint + Route + Dashboard UI + CLI)

## Context links

- Depends on: [phase-02-secret-export-adoption.md](phase-02-secret-export-adoption.md) (needsRekey column + rowToKey flag)
- Parent: [plan.md](plan.md)

## Overview

- Date: 2026-09-06
- Description: `POST /api/keys/[id]/rekey {rawKey}` re-hashes an inert imported key against THIS install's secret after an ownership proof that needs no old secret: full masked-string compare. Dashboard Endpoint page gets a per-row Re-key button + modal; CLI key actions get a "Re-key" item. `GET /api/keys` derives a global needsRekey flag.
- Priority: P1
- Status: done

## Key Insights

- Ownership proof WITHOUT old secret: `maskApiKey(rawKey) === row.key` (full string compare). `maskApiKey` (src/lib/db/repos/apiKeysRepo.js:16-22) keeps keyId (`parts[length-2]`) + last4 — with phase-04's 62-bit keyId a forged match is negligible; the proof also works for legacy rows because `rowToKey` masks them at read (:33).
- TRACED SUBTLETY — `parseApiKey` CRC is install-bound: it verifies `generateCrc(machineId, keyId)` (src/shared/utils/apiKey.js:66-69) against the SEPARATE `"api-key-secret"` scope (:8-12), which is per-install and NOT adopted by phase 02. A raw key pasted from the exporting install FAILS CRC here. Therefore the re-key route must do STRUCTURAL validation only (startsWith "sk-", split length 2 or 4 — a longer keyId never changes the part count since the alphabet has no "-"); the masked compare is the real proof. `verifyApiKeyCrc`/`parseApiKey` have no other callers (verified by grep — auth is hash-based), so nothing else depends on CRC passing cross-install.
- Route protection is inherited: `/api/keys` is deny-by-default protected in the proxy layer (src/dashboardGuard.js:64, :255-261 — `hasValidCliToken || isAuthenticated`), exactly like PUT/DELETE in src/app/api/keys/[id]/route.js:20/:62 which carry no per-route guard. The rekey route needs NO extra auth code — same guard class as PUT, per decision.
- `updateApiKey` deliberately refuses to rotate the secret through PUT (apiKeysRepo.js:136-138 comment) — re-key is a NEW route, do not widen PUT.
- After phase-02 adoption, `hashApiKey` uses the adopted secret — re-key writes `hashApiKey(rawKey)` which then matches; `needsRekey=0` clears badge/banners.
- Do NOT echo the raw key back in any response; show-once feedback = the masked display value (the user already has the raw key — they pasted it).

## Requirements

- New repo fn `rekeyApiKey(id, rawKey)` in apiKeysRepo.js: structural validation, masked-compare vs current row, single UPDATE (keyHash, key, needsRekey=0), returns `rowToKey` result; distinct error kinds: not-found / invalid-key / mismatch.
- New route `src/app/api/keys/[id]/rekey/route.js` POST — 404 unknown id, 400 invalid or mismatched key, 200 `{ key }` (masked), never the raw key.
- `GET /api/keys` (src/app/api/keys/route.js:8-16) adds `needsRekey: keys.some((k) => k.needsRekey)` to the JSON response.
- Endpoint page: global amber banner when any key needs re-key; per-row "Needs re-key" badge + Re-key button; RekeyModal (paste field, submit, success feedback showing the masked key + "working" hint).
- CLI: `rekeyApiKey(id, rawKey)` client method + "Re-key (paste raw key)" item in `showKeyActions` (RT-AMENDED: shown ONLY for rows with `needsRekey === true`; the server gate enforces the same — see Red-Team Amendments RT-11).

## Architecture

```
POST /api/keys/[id]/rekey  {rawKey}          [proxy.js deny-by-default guard]
  │
  ├─ rekeyApiKey(id, rawKey)                 apiKeysRepo.js
  │    row = SELECT * WHERE id               (404 if none)
  │    structural check: string, "sk-"-prefixed, split("-").length ∈ {2,4}
  │    proof: maskApiKey(rawKey) === rowToKey(row).key   (full compare)
  │    UPDATE apiKeys SET keyHash=hashApiKey(rawKey),
  │            key=maskApiKey(rawKey), needsRekey=0 WHERE id=?
  │    → rowToKey(fresh row)
  ├─ 400 {error:"Invalid key format"}        (structural fail)
  ├─ 400 {error:"That raw key does not match this key entry"} (mask mismatch)
  └─ 200 {key}                               (masked only)

Dashboard: GET /api/keys → keys[].needsRekey + global flag
  → banner + row badge → RekeyModal → POST → refresh list (badge clears)
CLI: showKeyActions → prompt raw key → api.rekeyApiKey → show masked result
```

## Related code files

- `src/lib/db/repos/apiKeysRepo.js` (add `rekeyApiKey` after `updateApiKey` :162; export it)
- `src/lib/db/index.js` (re-export `rekeyApiKey` alongside :59-63) and `src/lib/localDb.js` (barrel :18)
- CREATE `src/app/api/keys/[id]/rekey/route.js`
- `src/app/api/keys/route.js` (GET :8-16)
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (banner zone :833, key rows :1119-1201, modal mount :1240-1246)
- CREATE `src/app/(dashboard)/dashboard/endpoint/components/RekeyModal.js` (model: `components/BudgetModal.js`)
- `cli/src/cli/api/client.js` (add `rekeyApiKey`, export block :520-522)
- `cli/src/cli/menus/apiKeys.js` (`showKeyActions` :170-193)
- CREATE `tests/unit/rekey-flow.test.js`

## Implementation Steps

1. `src/lib/db/repos/apiKeysRepo.js` — add after `updateApiKey` (:162):
   ```js
   export async function rekeyApiKey(id, rawKey) {
     const db = await getAdapter();
     const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
     if (!row) return { error: "not_found" };
     const k = String(rawKey ?? "");
     const parts = k.split("-");
     if (!k.startsWith("sk-") || (parts.length !== 2 && parts.length !== 4)) return { error: "invalid" };
     if (maskApiKey(k) !== rowToKey(row).key) return { error: "mismatch" };
     db.run(`UPDATE apiKeys SET keyHash = ?, key = ?, needsRekey = 0 WHERE id = ?`,
       [hashApiKey(k), maskApiKey(k), id]);
     return { key: rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id])) };
   }
   ```
   (Structural parse only — see Key Insights; CRC deliberately NOT enforced.)
2. Re-export from `src/lib/db/index.js` (:59-63 block) and `src/lib/localDb.js` (:18 line).
3. CREATE `src/app/api/keys/[id]/rekey/route.js` — POST handler mirroring PUT's shape (route.js of [id] :20-27): `const { id } = await params; const { rawKey } = await request.json();` map result: `not_found`→404 `{"error":"Key not found"}`, `invalid`→400 `{"error":"Invalid key format"}`, `mismatch`→400 `{"error":"That raw key does not match this key entry"}`, else 200 `{ key: result.key }`. catch → 500 generic. Never include rawKey in any response or log.
4. `src/app/api/keys/route.js` — GET (:8-16): `const keys = await getApiKeys(); return NextResponse.json({ keys, needsRekey: keys.some((k) => k.needsRekey === true) });`
5. CREATE `src/app/(dashboard)/dashboard/endpoint/components/RekeyModal.js` modeled on BudgetModal: props `{ isOpen, keyData, onClose, onSaved }`; Input (type=password) for the pasted raw key; submit disabled when empty; POST `/api/keys/${keyData.id}/rekey`; on success call `onSaved(keyData.id)` and render show-once feedback `"Re-keyed — key now validates on this install"` + the masked `key.key`; on 400 show the server error inline; clear the field on close.
6. `EndpointPageClient.js`:
   - State: `const [rekeyKey, setRekeyKey] = useState(null);` beside `budgetKey` (:28); extend the keys fetch to read `needsRekey` global for the banner (or derive locally from rows — simpler: `const anyNeedsRekey = keys.some((k) => k.needsRekey);`).
   - Global banner above the key list (pattern of the amber warning box at :833): `"N API key(s) were imported from a backup and can't authenticate yet. Re-key them with their raw keys."`
   - Per-row badge after the "Paused" text (:1162-1164): `{key.needsRekey && (<p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Needs re-key</p>)}`.
   - Per-row action button beside the Budget button (:1186-1192): key icon `key_vertical`, `title="Re-key"`, `onClick={() => { setKeyStatus(null); setRekeyKey(key); }}`, rendered ONLY when `key.needsRekey` (RT-AMENDED — see RT-11; the needsRekey-only gate is the forgery compensation).
   - Mount `<RekeyModal isOpen={!!rekeyKey} keyData={rekeyKey} onClose={() => setRekeyKey(null)} onSaved={handleRekeySaved} />` beside BudgetModal (:1241-1246); `handleRekeySaved` mirrors `handleBudgetSaved` (:726-730): clear modal, refresh list, show success status.
7. CLI `cli/src/cli/api/client.js` — add after `deleteApiKey` (:307):
   ```js
   async function rekeyApiKey(id, rawKey) {
     return makeRequest("POST", `/api/keys/${id}/rekey`, { rawKey });
   }
   ```
   Export it (:520-522 block).
8. CLI `cli/src/cli/menus/apiKeys.js` — in `showKeyActions` items (:176-191) insert before "Delete Key":
   ```js
   {
     label: "Re-key (paste raw key)",
     action: async () => {
       const raw = await prompt("Paste the RAW key for this entry: ");
       const result = await api.rekeyApiKey(key.id, raw);
       showStatus(result.success ? `Re-keyed: ${result.data.key.key} — now valid on this install` : `Re-key failed: ${result.error}`, result.success ? "success" : "error");
       await pause();
       return true;
     }
   }
   ```
9. CREATE `tests/unit/rekey-flow.test.js` (harness from apikeys-hash-migration.test.js:7-64; extend fakeAdapter `run` to handle `UPDATE apiKeys SET keyHash = ?, key = ?, needsRekey = 0` — note param order keyHash, key, id; and make the WHERE id getter tolerate the new SELECT):
   - happy path: seeded row with foreign `keyHash` + `needsRekey: 1`; rekey with matching raw key → keyHash === hmacOf(rawKey) under the (mocked) CURRENT secret, `key === maskApiKey(rawKey)`, needsRekey cleared in returned rowToKey output.
   - mismatch: raw key of a DIFFERENT keyId → `{ error: "mismatch" }`, row unchanged.
   - invalid: `"banana"`, `"sk-only"`, empty → `{ error: "invalid" }`.
   - not found id → `{ error: "not_found" }`.
   - masked-compare proof: rekey succeeds even though `parseApiKey(rawKey)` returns null for a foreign-CRC key (pin the cross-install reality — mock or construct a raw key whose CRC fails under the test secret; assert structural path still accepts).
   - raw key never appears in `JSON.stringify(result)`.

## Todo list

- [x] `rekeyApiKey` in apiKeysRepo.js + re-exports (db/index.js, localDb.js)
- [x] `src/app/api/keys/[id]/rekey/route.js` (POST, same guard class as PUT, masked-only response)
- [x] `GET /api/keys` global needsRekey flag
- [x] `RekeyModal.js` component
- [x] EndpointPageClient: banner + row badge + action button + modal wiring
- [x] CLI `rekeyApiKey` client method + showKeyActions menu item
- [x] tests/unit/rekey-flow.test.js green (`npx vitest run unit/rekey-flow` from tests/)
- [x] gitnexus `impact` on `rowToKey`/`getApiKeys` BEFORE editing; `detect_changes()` before commit

## Success Criteria

- Unit tests above 100% pass; response payloads of the route (asserted via repo result shapes) never contain the raw key.
- End-to-end mental trace covered by tests: import-without-password (phase 02) → row needsRekey=1 → rekey with raw key → `validateApiKey(rawKey)` returns true and flag cleared.
- `GET /api/keys` on a DB with one inert key returns `needsRekey: true`; after re-key returns `false`.
- CLI menu shows Copy / Re-key / Delete; re-key failure prints server error; success prints masked key.
- No response or log line anywhere contains a pasted raw key (grep test: `expect(JSON.stringify(result)).not.toContain(RAW_KEY)`).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Full parseApiKey (with CRC) used for validation → foreign keys always rejected | Medium | High (feature dead cross-install) | Structural check specified in step 1 + dedicated test pinning the foreign-CRC case | rekey-flow "masked-compare proof" test | Ship structural check; CRC strictness deferred (plan.md unresolved #3) |
| Masked-compare forgery (attacker with dashboard access writes a raw key matching keyId+last4 but not the true key) | Low | Low (attacker already owns the dashboard; they could create keys anyway) | 62-bit keyId space (phase 04) makes a targeted mask collision infeasible; endpoint is auth-gated like PUT | mismatch test | Accept; documented trade-off of no-old-secret proof |
| UI shows Re-key for healthy keys, confusing users | Medium | Low | Button tooltip + modal copy: "Only needed for keys imported from another install" | UX feedback | Keep (belt-and-suspenders per step 6) |
| EndpointPageClient edit breaks BudgetModal row layout | Low | Medium | BudgetModal untouched; new button cloned from existing pattern :1186-1192; phase-06 full-suite run | unit/E2E smoke | Revert button placement only |
| needsRekey flag stale after re-key elsewhere (multi-tab) | Low | Low | List refresh after onSaved; flag derived from GET /api/keys each load | badge clears after refresh | Accept |

## Security Considerations

- NEVER log password/secret/raw key: route catch logs generic `error.message` only; repo returns masked display values; modal/CLI show masked output; test asserts absence.
- Re-key is auth-gated by the same proxy-layer protection as PUT (`hasValidCliToken || isAuthenticated`, dashboardGuard.js:255-261) — wrap the behavior behind already-authorized routes; no new public surface.
- Structural parse + masked compare avoids trusting install-bound CRC state; the proof binds to the row's own masked value (keyId + last4), not to any guessable global.
- UPDATE writes happen as one statement (atomic in SQLite); file-perm concerns N/A (no new files); envelope/AAD concerns N/A this phase (no crypto here) — needsRekey column inherits table-level integrity.
- The pasted raw key exists only in request memory and the derived HMAC — never persisted raw, never returned, never logged (mirrors createApiKey's show-once discipline, apiKeysRepo.js:91-101).

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT-11 the 62-bit proof claim is FALSE — correct the math, then compensate:** `maskApiKey` publishes the FULL keyId in every listing (GET /api/keys serves the masked display, keyId included), so the masked-compare proof's unknown material is ONLY the last 4 chars — and for 4-part keys those are CRC hex digits = **16 bits**. Phase-04's 12-char keyId adds ZERO bits to this proof (it hardens key-string forgery against hash lookups — a different threat); Key Insights bullet 1's "forged match is negligible" and risk row 2 are superseded. Uncompensated, ~65 k online guesses silently substitute an attacker key. BOTH compensations required:
   - **Gate:** `rekeyApiKey` returns `{ error: "not_needed" }` (route maps → 409) unless `row.needsRekey === 1`. Dashboard button and CLI item render only for flagged rows (supersedes risk row 3's keep-belt-and-suspenders response). Stale/stranded-flag edge cases recover via phase-02 RT-04's best-effort `needsRekey=1` UPDATE, not via an any-row rekey surface.
   - **Lockout:** per-key-id mismatch counter + global counter (loginLimiter pattern, src/lib/auth/loginLimiter.js): 5 mismatches per key → 429 "Too many re-key attempts — try again in 15 minutes"; 20 global/hour. At 5 guesses/15 min the 16-bit space needs ~136 days — uneconomical.
2. **RT-12 masked prompt for the raw key (CLI):** plain `prompt` echoes the pasted RAW key into terminal scrollback — a stronger secret than the backup password. Use the new `promptSecret` helper (phase-05 RT-14) for the raw-key prompt; step 8's `prompt("Paste the RAW key…")` becomes `promptSecret(…)` with "(input hidden)".
3. Add tests: rekey on a row with `needsRekey === 0` → `{ error: "not_needed" }`, row unchanged; 6th mismatch → lockout engaged (unit-test the counter helper, not timers).
4. Risk row 2 replacement: "Masked-compare forgery | Medium | High (silent attacker-key substitution) | needsRekey-only gate + 5-mismatch/15-min lockout makes the 16-bit space uneconomical (~136 days) | lockout counter increments | Tune limits; .46 may adopt `api-key-secret` to raise forgery cost to pepper knowledge (plan.md unresolved #4)".

## Next steps

- Phase 05 consumes `rekeyApiKey` client method in the CLI API keys menu narrative and adds Backup & Restore menu.
