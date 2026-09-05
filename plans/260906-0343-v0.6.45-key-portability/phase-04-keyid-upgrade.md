# Phase 04 — generateKeyId Crypto Upgrade (12 chars, ~62 bits)

## Context links

- Depends on: none (independent — may run parallel with phases 02/03; owns `src/shared/utils/apiKey.js` exclusively)
- Parent: [plan.md](plan.md)

## Overview

- Date: 2026-09-06
- Description: Replace the 6-char `Math.random` keyId with a 12-char `crypto.randomInt` draw over the same 36-char alphabet (~62.0 bits: 36^12 = 2^62.04). Only `generateKeyId` changes; parse/mask/CRC are untouched and verified compatible.
- Priority: P1
- Status: pending

## Key Insights

- Current generator is dual-flawed: `Math.random()` (non-crypto, biased rejection-free multiply) and only 6 chars (~31 bits) — src/shared/utils/apiKey.js:17-24. `crypto` is ALREADY imported in this file (:1), so the fix is two lines.
- `crypto.randomInt(max)` (or `randomInt(0, max)`) is uniform and crypto-strong; loop 12 times over `chars.charAt(crypto.randomInt(chars.length))`.
- Compatibility TRACED, not assumed:
  - `parseApiKey` (:58-80) splits on "-": a 12-char keyId (alphabet `[a-z0-9]`, no "-") keeps the 4-part shape `sk-{machineId}-{keyId}-{crc}` — parts count unchanged.
  - `maskApiKey` (apiKeysRepo.js:16-22) uses `parts[parts.length - 2]` — index-based, length-agnostic; masked display just grows from `sk-abc123-••••wxyz` to `sk-abc123def456-••••wxyz`.
  - `generateCrc` (:29-35) hashes `machineId + keyId` — any keyId length works; CRC stays 8 hex chars.
  - Old 6-char keys continue to parse/validate forever (no migration; no stored-format assumption anywhere — DB stores only hash + masked string).
- CRC secret scope `"api-key-secret"` (:8-12, incl. `API_KEY_SECRET` env override) is SEPARATE from `"api-keys-hmac"` (apiKeysRepo.js:10) — this phase touches NEITHER secret; do not conflate.

## Requirements

- `generateKeyId()` returns exactly 12 chars from `abcdefghijklmnopqrstuvwxyz0123456789`, each drawn via `crypto.randomInt`.
- No other behavior change in `src/shared/utils/apiKey.js`; exported signatures identical.
- All existing consumers keep working: `generateApiKeyWithMachine` (:43-48), `createApiKey` (apiKeysRepo.js:86-88), CLI/cloud copies untouched.

## Architecture

```
generateApiKeyWithMachine(machineId)          [unchanged shape]
  keyId = generateKeyId()   // NOW: 12 × crypto.randomInt(36)  ≈ 62.04 bits
  crc   = generateCrc(machineId, keyId)       // HMAC over machineId+keyId, "api-key-secret" scope
  key   = `sk-${machineId}-${keyId}-${crc}`   // 4 dash-parts regardless of keyId length
maskApiKey(key) = `sk-${parts[len-2]}-••••${last4}`   // length-agnostic (verified)
```

## Related code files

- `src/shared/utils/apiKey.js` (`generateKeyId` :17-24; `crypto` import already at :1)
- CREATE `tests/unit/apikey-keyid-upgrade.test.js`
- Grep-verified consumers (no changes needed): src/lib/db/repos/apiKeysRepo.js:86, tests/unit/apikeys-hash-migration.test.js:62-64 (mocks the generator — unaffected), cli + cloud have their own copies (out of scope; verify no shared import: grep `utils/apiKey` → only apiKeysRepo.js:86 imports the shared one)

## Implementation Steps

1. `src/shared/utils/apiKey.js` — replace `generateKeyId` (:17-24):
   ```js
   /**
    * Generate 12-char random keyId (crypto-strong, ~62 bits).
    * v0.6.45: was 6 chars via Math.random (~31 bits). Longer keyIds are
    * transparent to parseApiKey/maskApiKey (split/index-based, no length
    * assumptions); existing 6-char keys keep validating.
    */
   function generateKeyId() {
     const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
     let result = "";
     for (let i = 0; i < 12; i++) {
       result += chars.charAt(crypto.randomInt(chars.length));
     }
     return result;
   }
   ```
2. Update the file-top docstring/comment if it mentions "6-char" (only the function's own comment does; check :14-16).
3. CREATE `tests/unit/apikey-keyid-upgrade.test.js` (no DB mocks needed — pure module; but mock `@/lib/auth/installSecret.js` to pin `apiKeySecret()` since generateCrc reads it, pattern apikeys-hash-migration.test.js:50-52):
   - length: `generateApiKeyWithMachine("machine1234").keyId` has length 12; charset matches `/^[a-z0-9]{12}$/`.
   - key shape: `sk-machine1234-<12>-<8 hex>` — split("-").length === 4; `parseApiKey` round-trips `{machineId, keyId, isNewFormat:true}`.
   - `verifyApiKeyCrc` true for a generated key; false after flipping one keyId char (CRC property preserved).
   - `maskApiKey` of a generated key === `"sk-" + keyId + "-••••" + last4` (length-agnostic mask).
   - old-format compatibility: hand-built 6-char-keyId key (compute CRC with the mocked secret via the module's own `generateCrc` through a generated 12-char sibling — simpler: assert `parseApiKey` still accepts a legacy 2-part `"sk-abcdefgh"`).
   - uniqueness smoke: 200 generated keyIds are all distinct.
4. Run `npx vitest run unit/apikey-keyid-upgrade unit/apikeys-hash-migration` from tests/ (the latter pins `generateApiKeyWithMachine` via mock — must stay green unchanged).

## Todo list

- [ ] Swap `Math.random` loop → `crypto.randomInt` × 12 in generateKeyId
- [ ] Comment updated (62-bit rationale + backward compat note)
- [ ] tests/unit/apikey-keyid-upgrade.test.js green
- [ ] apikeys-hash-migration.test.js still green (no edits)
- [ ] gitnexus `impact` on `generateApiKeyWithMachine` BEFORE editing; `detect_changes()` before commit

## Success Criteria

- All new + existing tests pass with zero edits to existing test files.
- `grep -n "Math.random" src/shared/utils/apiKey.js` returns nothing.
- Generated keys validate end-to-end conceptually: `parseApiKey` accepts, `maskApiKey` masks, `hashApiKey` (separate scope) unaffected — asserted via the test set above.
- No schema/data migration involved (new format applies to newly created keys only).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| Longer keyId breaks a hidden length assumption (UI width, CLI box drawing, regex elsewhere) | Low | Medium | grep for `[a-z0-9]{6}` / keyId length checks (none found in src/ or cli/); masked display +14 chars fits existing layouts (code/font-mono, EndpointPageClient.js:1127-1129 truncation-free) | UI smoke on create-key modal | Accept minor width growth; no truncation (full keyId must stay visible — it's the re-key proof) |
| `crypto.randomInt` unavailable in some runtime | Very Low | High | Node ≥ 14.10 (repo requires Node 22 per env); apiKey.js already node-crypto based | CI test failure | None needed |
| Mixed 6/12-char keyIds confuse dedupe or UNIQUE paths | Very Low | Low | `apiKeys.key` UNIQUE column stores masked values incl. keyId (schema.js:81) — keyIds are random in a 62-bit space; collision chance negligible; old+new coexist as distinct strings | UNIQUE violation on create | Retry-on-collision is out of scope (probability ~0) |
| CRC secret env override (`API_KEY_SECRET`) makes cross-install CRC fail after adoption | Certain (by design) | None for auth (no CRC callers) | Documented in phase-03 Key Insights | rekey structural-parse test | Already handled — re-key does not enforce CRC |

## Security Considerations

- `crypto.randomInt` removes the non-crypto `Math.random` bias — keyId entropy now ~62 bits, matching the re-key masked-compare security argument (phase 03).
- No secrets, passwords, or raw-key logging introduced (pure generator change).
- CRC scope `"api-key-secret"` untouched and remains SEPARATE from the exported/wrapped `"api-keys-hmac"` scope (conflation would silently break phase-02's threat model).
- Envelope versioning N/A (no envelope interaction); file perms N/A (no files).
- No event-loop concerns (randomInt is sync-cheap, 12 iterations at key creation only).

## Red-Team Amendments (BINDING — 2026-09-06)

1. **RT-13 correct the security claim (supersedes Security Considerations bullet 1):** the 12-char keyId strengthens KEY-STRING forgery (guessing a key whose hash collides with a stored `keyHash`), NOT the phase-03 masked-compare proof — the keyId is published inside the masked display, so that proof stays 16 bits (last4) regardless of keyId length. Rewrite the bullet as: "raises brute-force cost of forging key STRINGS against hash lookups (~62 bits); the re-key proof's strength comes from its needsRekey-only gate + mismatch lockout (phase-03 RT-11), not from keyId length." Phase-03's own bullets are amended in its file.

## Next steps

- Phase 06 folds this into the release sweep; v0.6.46 review may revisit wrapping `api-key-secret` alongside `api-keys-hmac` (plan.md unresolved #4).
