# Phase 02 — Server F Path, Dual-Scope Secret Wrapping/Adoption, Route Tests

## Context links

- Depends on: [phase-01-archive-crypto-module.md](phase-01-archive-crypto-module.md)
- Parent: [plan.md](plan.md)
- Research: [researcher-01-archive-crypto-ux.md](../research/researcher-01-archive-crypto-ux.md) §2 (format/detection), §3 (suppressed inner envelope)
- .45 precedent: phase-02 secret export/adoption (RT-03..RT-08 amendments all carry); .45 review-gate lesson — the route layer had ZERO tests; this phase writes route tests FIRST.

## Overview

- Date: 2026-09-06
- Description: Server plumbing for all three data-flow changes. (1) F-export:
  GET with `x-9r-archive-passphrase` returns the sealed wrapper file verbatim;
  under F the payload embeds install secrets PLAIN (`payload.plainSecrets`) —
  inner .45 envelope suppressed. (2) Decision B: password exports additionally
  wrap `api-key-secret` (CRC scope) as `crcSecretEnvelope`; imports adopt both
  scopes post-commit (env-override guard for CRC). (3) F-import: POST accepts
  `{archive, archivePassphrase, password}`; the ROUTE unwraps server-side
  (browsers lack scrypt) before importDb; wrong passphrase = hard 400, never a
  partial import. Plus the passphrase generator endpoint for "Generate for me".
- Priority: P1
- Status: pending

## Key Insights

- Under F the inner .45 envelope is suppressed but the SECRETS must still ride
  inside the archive or cross-install portability dies (import would flag every
  key needsRekey). They ride PLAIN inside the encrypted payload
  (`payload.plainSecrets = {"api-keys-hmac":…, "api-key-secret":…}`): outer
  encryption provides the confidentiality the envelope used to, and import
  stays single-credential (passphrase only, no export-time dashboard password
  needed). Researcher-01 §3 endorses exactly this ("double prompt, zero gain").
- Import trust model under F: the passphrase IS the trust anchor (knowledge =
  full access, by design). `plainSecrets` adoption carries the same
  admin-deliberately-imported-this-file trust as .45 envelope adoption; import
  wipes apiKeys anyway, so no preserved-state attack exists. Documented in
  Security Considerations.
- F-import failure must NEVER partial-decrypt: the route opens the archive
  BEFORE calling importDb, so a wrong passphrase fails before the shape guard,
  the mutex, or any DELETE — hard-fail by construction.
- Detection works BOTH ways with zero ambiguity: exportDb output never has a
  top-level `format` or `archive` key (verified: keys are meta/settings/
  providerConnections/providerNodes/proxyPools/apiKeys/combos/modelAliases/
  customModels/mitmAlias/pricing + optional authSecretEnvelope/crcSecretEnvelope/
  warnings/needsRekeyCount) — so `format === "9router-encrypted-archive"` on a
  file, and `body.archive` on a POST body, are unambiguous F markers.
- CRC scope env-override (apiKey.js:9 `API_KEY_SECRET` wins by design): when
  the env var is set, (a) EXPORT must NOT embed the env secret into any file
  (env values never leak into backups — omit `api-key-secret` from both
  envelope and plainSecrets), and (b) IMPORT must SKIP adopting a file CRC
  secret and warn (env takes precedence; a silent fight would be confusing).
  `api-keys-hmac` has no env override (apiKeysRepo.js:10 goes straight to
  installSecret) — no guard needed there.
- apiKey.js:7-12 has a REDUNDANT second cache (`cachedSecret`) that
  adoptInstallSecret cannot invalidate — after CRC adoption the process would
  keep computing CRCs with the OLD secret. Fix: delete the local cache and rely
  on installSecret's own Map cache (which adopt updates). Same perf (Map hit).
- needsRekey semantics unchanged (mandated): still driven exclusively by the
  hmac envelope/plain-secret recovery + foreignOrUnknown; CRC adoption failure
  never flags keys.
- The passphrase generator endpoint returns fresh randomness only — but treat
  it as sensitive anyway (never log responses, `Cache-Control: no-store`,
  same auth as the database route).

## Requirements

- `exportDb` (src/lib/db/index.js:128-187):
  - New option `options.plainSecrets` (F path): when truthy, set
    `out.plainSecrets = { "api-keys-hmac": getOrCreateInstallSecret("api-keys-hmac") }`
    plus `"api-key-secret"` ONLY when `!process.env.API_KEY_SECRET`; do NOT
    create the .45 envelope; set `out.meta.secretsPlain = true`.
  - Password path (:179-184) additionally seals
    `out.crcSecretEnvelope = await sealBackupSecret(getOrCreateInstallSecret("api-key-secret"), password)`
    — only when `!process.env.API_KEY_SECRET`; same default AAD_BACKUP_V1 as
    the existing envelope (both are dashboard-password-wrapped install
    secrets; type-binding to F-archives comes from AAD_ARCHIVE_V1). Set
    `out.meta.crcSecretWrapped = Boolean(out.crcSecretEnvelope)`.
  - No-password path byte-identical to .45 apart from the new additive fields.
- `doImportDb` (src/lib/db/index.js:230-423), inside the existing mutex chain:
  - Before the envelope branch: `newSecret = payload.plainSecrets?.["api-keys-hmac"]`
    when it is a non-empty string; `newCrcSecret = payload.plainSecrets?.["api-key-secret"]`
    likewise (F path — no scrypt for either).
  - Legacy envelope branch unchanged (RT-06 skip-without-password preserved);
    add: when `password && isBackupEnvelope(payload.crcSecretEnvelope)` try
    `newCrcSecret = await openBackupSecret(payload.crcSecretEnvelope, password)`
    (catch → silent skip; CRC failure must not affect needsRekey).
  - Post-commit adoption (:371-390): after the existing hmac adopt, `if
    (newCrcSecret)`: when `process.env.API_KEY_SECRET` is set → push warning
    "API_KEY_SECRET env override is active — the backup's key-CRC secret was
    not adopted (the env value takes precedence)."; else
    `adoptInstallSecret("api-key-secret", newCrcSecret)` (failure → best-effort
    warning only, NEVER touches needsRekey).
  - `inert` rule (:335) unchanged — plainSecrets sets newSecret so F-imports
    import live keys.
- GET route (route.js:39-80):
  - Read `x-9r-archive-passphrase` header. When present AND non-empty → F-mode:
    auth flow unchanged (pwOk/authOk/CLI-token logic untouched — F's
    confidentiality is the passphrase, not auth); require
    `validateArchivePassphrase(passphrase)` else 400
    `{"error":"Passphrase too short (minimum 10 characters after removing spaces and hyphens)"}`;
    `const payload = await exportDb({ plainSecrets: true })` (NEVER
    `{password}`+plainSecrets together — F suppresses the inner envelope);
    skip the envelope-less warning block (:66-73 — under F the secrets ARE
    embedded); return `NextResponse.json(await sealArchive(JSON.stringify(payload), passphrase),
    { headers: { "Cache-Control": "no-store" } })`.
  - Without the header: EXACT .45 behavior (exportDb(pwOk?{password}:{}),
    envelope-less warning, no-store). The only delta is the new
    crcSecretEnvelope field inside pwOk payloads (decision B).
- NEW `GET /api/settings/database/archive-passphrase` (new file
  src/app/api/settings/database/archive-passphrase/route.js): auth =
  `hasValidCliToken(request) || hasPw && await verifyDashboardPassword(password, request)`
  (401 + limiter otherwise, mirroring POST:82-91); success → `{ passphrase:
  generateArchivePassphrase() }`, `Cache-Control: no-store`, never logged.
- POST route (route.js:82-117):
  - Body may now be `{ archive, archivePassphrase, password }` (F) or the
    legacy `{ ...payload, password }`. Branch on `body.archive` being a
    non-null object: `const inner = JSON.parse(await openArchive(body.archive,
    typeof body.archivePassphrase === "string" ? body.archivePassphrase : ""))`
    → shape-sanity: if `!inner || typeof inner !== "object"` → 400. ArchiveError
    → 400 `{"error":"Wrong archive passphrase or corrupted archive"}` —
    importDb NOT called (no wipe possible). Then
    `importDb(inner, { password })` with the EXISTING auth/limiter flow
    unchanged (the current dashboard password still authenticates the request).
  - Legacy branch: destructure `password` off the payload exactly as today
    (:84) — an F-wrapper accidentally posted as a payload (no `archive` key,
    has `format` key) reaches importDb's shape guard; add a pre-check: if
    `payload?.format === "9router-encrypted-archive"` → 400
    `{"error":"This backup file is encrypted — re-import it and provide its passphrase"}`.
  - Passphrase/password travel in the BODY only (never URL); nothing logged
    (existing catch logs error.message only — keep; ArchiveError message is a
    constant, safe).
- Fix apiKey.js:7-12: delete `cachedSecret`; `apiKeySecret()` = env override
  OR `getOrCreateInstallSecret("api-key-secret")` (installSecret Map cache is
  the single cache; adoption-safe).
- ROUTE TESTS FIRST (tests/unit/database-route.test.js extension + new cases):
  write/extend the route test file BEFORE touching route.js (TDD against the
  pinned contracts below).

## Architecture

```
EXPORT (GET /api/settings/database)
  auth: .45 flow unchanged (pwOk / authOk / cli token / limiter)
  ├─ no x-9r-archive-passphrase ──► exportDb(pwOk?{password}:{})
  │     pwOk ⇒ payload{authSecretEnvelope, crcSecretEnvelope(NEW), …}   (F-off)
  │     else ⇒ envelope-less + warning (.45 exact)
  └─ x-9r-archive-passphrase present ──► F-on
        validateArchivePassphrase → 400 if short
        exportDb({plainSecrets:true}) → payload{plainSecrets{hmac[,crc]}, no envelope}
        sealArchive(JSON.stringify(payload), pass) → {format,v:1,envelope} = THE FILE

IMPORT (POST /api/settings/database)
  body.archive present?
  ├─ yes: openArchive(archive, archivePassphrase)   [route-side; scrypt not in browsers]
  │      ArchiveError → 400 (importDb NEVER called — no partial import)
  │      JSON.parse(inner) → importDb(inner, {password}) → adopt plain secrets post-commit
  └─ no: legacy {…payload,password} → importDb(payload,{password})
         (envelope hmac + NEW crcSecretEnvelope both unwrapped/adopted inside)
  + guard: wrapper-as-payload (format key, no archive key) → clear 400
```

## Related code files

- EDIT src/lib/db/index.js (exportDb :128-187; doImportDb :230-423)
- EDIT src/app/api/settings/database/route.js (GET :39-80; POST :82-117)
- CREATE src/app/api/settings/database/archive-passphrase/route.js
- EDIT src/shared/utils/apiKey.js (:7-12 cache removal — impact-check first;
  callers of generateCrc/parseApiKey: generateApiKeyWithMachine, verifyApiKeyCrc
  (no production callers), tests)
- EDIT tests/unit/database-route.test.js (extend; harness already mocks
  exportDb/importDb/auth/limiter — database-route.test.js:10-33)
- EDIT/EXTEND tests/unit/key-portability-lifecycle.test.js (F lifecycle) or new
  tests/unit/archive-import.test.js (fake-adapter harness:
  key-portability-lifecycle.test.js / s7-followup-regressions.test.js)

## Implementation Steps

1. Impact() upstream on exportDb, importDb, apiKeySecret (expect: route.js, apiKeysRepo.js, apiKey.js internal, client tests). Record blast radius.
2. Write FAILING route tests pinning the contracts: F-on wrapper response (200,
   body.format === "9router-encrypted-archive", exportDb called with
   {plainSecrets:true}, sealArchive output shape — mock archive.js), F-on short
   passphrase → 400 + exportDb NOT called, F-off unchanged (exportDb called
   with {password:"x"} when pwOk — existing test already pins this), POST
   archive happy path (importDb called with INNER payload + password), POST
   wrong passphrase → 400 + importDb NOT called, POST wrapper-as-payload →
   clear 400, archive-passphrase endpoint 200 shape + 401 unauth.
3. db/index.js exportDb changes (plainSecrets + crcSecretEnvelope).
4. db/index.js doImportDb changes (plain + crcSecretEnvelope adoption, env
   guard, warnings).
5. apiKey.js cache fix.
6. route.js GET/POST + new archive-passphrase route.
7. Make route tests green; add db-level F lifecycle test (cross-install A→B
   with passphrase: exportDb({plainSecrets:true}) → sealArchive → openArchive →
   JSON.parse → importDb → validateApiKey true AND parseApiKey(rawKey) non-null
   (CRC adopted); env-override variant: set API_KEY_SECRET → adoption skipped +
   warning + parseApiKey null).
8. Full new-file runs green; `detect_changes()`; one green commit
   `feat(backup): whole-archive encryption server path + dual-scope secret wrapping/adoption (v0.6.46 phase 02)`.

## Todo list

- [ ] impact() run on exportDb/importDb/apiKeySecret
- [ ] Route tests written FIRST (red), pinning all 8 contracts above
- [ ] exportDb: plainSecrets + crcSecretEnvelope + meta flags
- [ ] doImportDb: plain-secret + crcSecretEnvelope adoption, env guard, warnings
- [ ] apiKey.js redundant cache removed
- [ ] GET F path + POST archive branch + wrapper-as-payload guard
- [ ] archive-passphrase endpoint (auth + no-store + never logged)
- [ ] db-level F lifecycle test (incl. env-override case)
- [ ] detect_changes() + one green commit

## Success Criteria

- All route tests green, including: F-off GET with pwOk calls
  `exportDb({password})` (existing pin) AND the returned payload carries
  crcSecretEnvelope (via exportDb mock asserting options); F-on GET response
  body IS the wrapper (format key present, no `meta` at top level).
- POST with `{archive, archivePassphrase:"…"}` and a WRONG passphrase → 400,
  `importDb` mock NOT called (hard-fail proof); with the RIGHT passphrase →
  importDb called once with the decrypted inner object.
- Lifecycle test: F-archive cross-install import adopts BOTH secrets —
  `validateApiKey(raw)===true`, `parseApiKey(raw)` non-null on install B; with
  `API_KEY_SECRET` set on B → hmac still adopted, CRC skipped + warning,
  `parseApiKey(raw)===null`.
- .45 regression: full existing key-portability + backup-envelope +
  database-route + s7-followup files green unedited (except additive route-test
  cases).
- No passphrase/password value appears in any console output (grep the diff for
  the test passphrases — none should appear in log assertions).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| F path leaks the .45 envelope by passing both password+plainSecrets | Medium | Medium | Route spec forbids combining; route test asserts exportDb called with EXACTLY `{plainSecrets:true}` in F mode | route test red / envelope inside sealed archive (inspect in lifecycle test) | Fix route call; add explicit lifecycle assertion `!inner.authSecretEnvelope` |
| Plain-secret adoption becomes a poisoning vector via crafted PLAINTEXT body | Medium | Medium | Poisoning-by-plaintext-file equals .45's existing admin-trust on import (file already replaces settings/keys); env guard prevents CRC fights; documented threat model | security review note | Accept with documentation (plan.md decision log); revisit only if a no-import adoption path ever appears |
| POST contract change breaks .45 CLI/dashboard clients | Low | High | Legacy branch byte-compatible (same `{...payload,password}` spread); new keys only ADD a branch | phase 04/03 integration failures; old-CLI manual test | Legacy branch is the default — any regression is a route bug, fix in place |
| crcSecretEnvelope adoption changes needsRekey behavior | Low | Medium | CRC adoption is warning-only by spec; lifecycle test pins needsRekeyCount===0 for F import and unchanged counts for .45 wrong-password case | key-portability-lifecycle red | Remove any needsRekey coupling from CRC path |
| Large payload memory blowup during seal (string + base64 copies) | Low | Medium | Documented ~100MB ceiling (researcher-01 §2); one-shot GCM; single JSON.stringify; no extra copies | OOM on huge DBs (not realistic here: sqlite JSON exports are MBs) | Document ceiling in CHANGELOG; defer chunking |
| archive-passphrase endpoint abused for noise | Low | Low | Behind the same auth+limiter as POST; output is fresh randomness; no-store | endpoint log noise | Rate-limit shares loginLimiter — nothing further |

## Security Considerations

- Passphrase: header (export) / body (import) only — never URL, never logged
  (route catches log only `error.message`; ArchiveError/BackupEnvelopeError
  messages are constants); normalized server-side so clients never send it
  twice in different forms.
- Never seal under default passwords: RT-03 gate untouched for the .45
  envelope path (pwOk only). Under F the seal key is the fresh user passphrase
  — no default-password surface exists. plainSecrets are embedded ONLY inside
  the sealed archive (route never returns them unwrapped; exportDb({plainSecrets})
  is only callable server-side and only the F route passes it — assert in route
  tests that a plain GET (no archive passphrase) can never get plainSecrets:
  pwOk GET must NOT include them... NOTE: implement by having the F branch be
  the ONLY caller passing plainSecrets AND adding a db-level test that
  exportDb({}) / exportDb({password}) never emit plainSecrets).
- Import never partial-decrypts: openArchive failure precedes importDb entirely;
  success yields the full plaintext payload or a hard 400.
- Env-override discipline: `API_KEY_SECRET` value never enters any export;
  adoption skipped + warned when active.
- Generator endpoint: response is sensitive-adjacent (may become someone's
  archive key) — no-store, never logged, auth-gated.
- Masked prompts are client-side (phases 03/04); server never echoes the
  passphrase back except the one-time generate endpoint.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT46-A1 plainSecrets release gate (supersedes the GET F-mode bullet "auth flow unchanged … F's confidentiality is the passphrase, not auth", Key Insight #2's "no preserved-state attack exists", the risk row "equals .45's existing admin-trust", and Security Considerations "no default-password surface exists" — all four are FALSE as written):** .45's shipped invariant is that install secrets never leave the box under anything weaker than the bcrypt-verified STORED password (pwOk). The `authOk` fallback accepts local "123456"/INITIAL_PASSWORD — the F branch as drafted would hand BOTH secrets (plain, inside the envelope) to that weaker gate. GATE the F-mode exportDb({plainSecrets:true}) call on `pwOk || viaCliToken` explicitly (the authOk default-password branch answers 401 in F mode, same as a wrong password). Route test: default-password-authOk + archive header → 401, exportDb NOT called with plainSecrets. The seal KEY being a fresh passphrase changes nothing about the RELEASE gate.
2. **RT46-A2 adoption trust re-binding (corrected threat model):** under .45, a phished import file could never adopt secrets (unwrap needs the victim's password); under F, an attacker-crafted file + attacker-known passphrase makes the victim install ADOPT attacker-chosen `api-keys-hmac` AND `api-key-secret` — state that survives the DB wipe. With the CRC pepper known, rekeyApiKey's masked-compare proof collapses from 16 online-guessable bits to ~0 (grind machineId offline: HMAC(pepper, machineId+knownKeyId) until last4 matches the published mask). Mitigations (both required): (a) NON-SUPPRESSIBLE import warning whenever plainSecrets/crc adoption REPLACES an existing DIFFERENT secret — "This archive replaced this install's key-derivation secrets"; (b) Security Considerations state the real trust model: archive-passphrase knowledge = full file-author trust including secret replacement.
3. **RT46-A3 charset gate, SERVER-side (covers every client at once):** the GET F branch validates the passphrase header against `/^[\x20-\x7E]+$/` → else 400 naming the rule ("passphrase must be printable ASCII; spaces and hyphens are ignored by normalization"). Reason: browser fetch TRUNCATES chars U+0100–U+01FF (`codepoint & 0xFF`) — a dashboard-sealed archive would silently live under a TRANSFORMED passphrase, unopenable from every surface (the plan's own headline loss-path). Client pre-checks ride along in phases 03/04; the server rule is the backstop. Import body passphrases get the same check.
4. **RT46-A4 logging correction + constant errors:** the claim "existing catch logs error.message only" is false — route.js:77/:111 log the WHOLE error object, and POST returns `error?.message` to the client (:113). In the POST F branch, `JSON.parse` SyntaxErrors embed a snippet of the DECRYPTED payload — catch ArchiveError AND parse errors and return/log the CONSTANT "Wrong archive passphrase or corrupted archive"; never rely on the accident that the snippet is the poster's own plaintext.
5. **RT46-O1 lifecycle harness rework (supersedes any "copy the .45 lifecycle mock verbatim" instruction here and in phase 06):** the .45 mock aliases BOTH scopes to one `state.secret` and ignores fileName — dual-scope adoption would be untestable/vacuous on it (a scope-swap bug passes). Spec a per-fileName Map mock mirroring installSecret.js: `getOrCreate(fileName)` reads map, `adopt(fileName, secret)` writes map, `readInstallSecret(fileName)` peeks; drive installs via `becomeInstall(id, {hmac, crc})`.
6. **RT46-O4 route-test harness reality:** database-route.test.js today covers GET auth contracts only — no `.json()` request helper, `importDb` mock not retained/assertable, no archive.js mock. Phase 02 step 2 includes: hoist importDb into the mock set, add a POST body-helper, add archive.js mocks. Replace "harness already mocks exportDb/importDb/auth/limiter" with this.
7. **RT46-O9 (nit):** delete the incoherent sentence "type-binding to F-archives comes from AAD_ARCHIVE_V1" from the crcSecretEnvelope bullet — F-archives carry no envelopes at all.
8. Baseline ref is 1ff29d9b (docs commits follow a916ec20); test-identical, cited correctly.

## Next steps

- Phase 03 (dashboard UX) and phase 04 (CLI) consume the new endpoints; can run
  in parallel after this phase lands.
