# Phase 05 — C4: Provider-Scoped "Payment Required" Fallback Rules (independent)

## Context links

- Research: [researcher-02-provider-scoped-rules.md](../research/researcher-02-provider-scoped-rules.md) (option (a) chosen by owner; anchors re-verified below)
- Parent: [plan.md](plan.md)
- Depends on: NOTHING (fully independent of phases 01-04 — different files; may run in parallel with the whole F chain)

## Overview

- Date: 2026-09-06
- Description: Add an optional `providers: []` allowlist to ERROR_RULES
  entries; a scoped rule matches only when the caller-supplied provider is in
  the list. Use it for one new rule — `{ text: "payment required", providers:
  ["commandcode"], cooldownMs: COOLDOWN.long }` — so commandcode billing-402
  errors (wrapped as `[CommandCode error: payment required]`, commandcode.js:288)
  rotate accounts while github's bare "Payment required" 402 keeps failing
  fast (C4 contract pinned by github-monthly-usage-lock.test.js:66-72,
  untouched).
- Priority: P1
- Status: done

## Key Insights

- Provider context beats text disambiguation: commandcode's billing text
  contains the literal "payment required" (commandcode.js:106) — the same
  string github emits bare. No text tweak can separate them; the provider
  dimension does, cleanly (researcher-02 §1).
- Option (a) is perfect-compat: rules without `providers` behave identically
  (flat top-to-bottom invariant at errorConfig.js:52 preserved); only the one
  new scoped rule changes outcomes, and only for commandcode.
- Fail-closed guardrail: when `provider` is undefined (unplumbed caller,
  third-party caller, or existing test), scoped rules are SKIPPED — behavior
  is exactly today's. This makes threading optional at every call site and
  keeps `checkFallbackError(402,"Payment required")` (undefined provider)
  === false, as pinned at account-fallback-no-fallback.test.js:72.
- Call-site plumbing is nearly free: auth.js's `markAccountUnavailable`
  (src/sse/services/auth.js:285) already has `provider` in scope (used at
  :303); combo.js members are "provider/model" strings (combo.js:70 precedent)
  so the prefix IS the provider; `commandcode` has id === alias
  (open-sse/providers/registry/commandcode.js:2,4) so both forms match the
  rule value. `applyErrorState` (accountFallback.js:223) has NO external
  callers (verified by grep) — leave it un-plumbed (YAGNI).
- The github pin test (github-monthly-usage-lock.test.js) mocks
  resolveProviderId as identity (:24-27) and passes provider "github" — with
  the scoped rule skipped on provider mismatch, the pin stays green with ZERO
  edits, proving the compat claim inside CI.

## Requirements

- errorConfig.js:
  - Doc comment (:50-58): add `providers` to the rule-shape documentation —
    "providers: optional array; when present the rule matches only if the
    caller-supplied provider equals one of the entries".
  - Replace the NOTE comment (:87-90) with the scoped rule, placed directly
    after the "billing" rule (:86):
    `{ text: "payment required", providers: ["commandcode"], cooldownMs: COOLDOWN.long },`
- accountFallback.js `checkFallbackError` (:32-71):
  - Signature: `(status, errorText, backoffLevel = 0, provider = undefined)`.
  - In the text-rule loop (:41-47), before matching: `if (rule.providers &&
    (!provider || !rule.providers.includes(provider))) continue;`
  - Status rules and NO_FALLBACK_STATUSES logic unchanged; JSDoc updated
    (provider param + fail-closed semantics).
- src/sse/services/auth.js:309: pass the provider as the 4th argument —
  `checkFallbackError(status, errorText, backoffLevel, provider)` (already in
  scope; pass the raw value — the github test's identity resolveProviderId
  mock and auth.js:303's own use are unaffected).
- open-sse/services/combo.js:335: derive and pass the model prefix —
  `const memberProvider = modelStr.includes("/") ? modelStr.split("/")[0] :
  undefined;` then `checkFallbackError(result.status, errorText, 0,
  memberProvider)`... NOTE: combo.js:335 currently passes NO backoffLevel
  (defaults 0) — keep that arity, just append provider.
- Tests (extend tests/unit/account-fallback-no-fallback.test.js, new
  describe "provider-scoped rules"):
  - `checkFallbackError(402, "Payment required", 0, "commandcode")` →
    `{ shouldFallback: true, cooldownMs: 2*60*1000 }`.
  - `checkFallbackError(402, "[CommandCode error: payment required]", 0,
    "commandcode")` → true (the wrapped real-world shape, commandcode.js:288).
  - `checkFallbackError(402, "Payment required", 0, "github")` → false.
  - `checkFallbackError(402, "Payment required")` (undefined provider) → false
    (fail-closed pin).
  - Unscoped rules ignore provider entirely:
    `checkFallbackError(402, "quota exceeded", 0, "github")` → true (existing
    assertion class, add explicit provider arg).
- github-monthly-usage-lock.test.js: NO edits (its two cases keep passing —
  that is the compat proof).
- Optional (cheap, in-phase): a capture-based confirmation note in the PR body
  that a real commandcode billing-402 arrives as the wrapped text (researcher
  unresolved #1); not a code change.

## Architecture

```
ERROR_RULES (flat, order = priority)
  … { text:"billing", cooldownMs:long }                      (unscoped, unchanged)
  + { text:"payment required", providers:["commandcode"], cooldownMs:long }
  … { status:402, cooldownMs:long }                           (unchanged)

checkFallbackError(status, errorText, backoffLevel=0, provider=undefined)
  for rule of ERROR_RULES (text):
      if rule.providers && (!provider || !rule.providers.includes(provider)) continue   ← NEW
      … match as today …
  NO_FALLBACK_STATUSES  ← unchanged (bare 402 without scoped match still fail-fast)
  status rules → transient                                ← unchanged

call sites: auth.js:309 (provider param, in scope) · combo.js:335 (modelStr prefix)
            accountFallback.js:227 applyErrorState — NOT plumbed (no callers)
```

## Related code files

- EDIT open-sse/config/errorConfig.js (doc :50-58; NOTE :87-90 → scoped rule)
- EDIT open-sse/services/accountFallback.js (checkFallbackError :32-71 + JSDoc)
- EDIT src/sse/services/auth.js (:309 call site)
- EDIT open-sse/services/combo.js (:335 call site)
- EDIT tests/unit/account-fallback-no-fallback.test.js (new describe)
- UNTOUCHED proof: tests/unit/github-monthly-usage-lock.test.js

## Implementation Steps

1. Impact() upstream on checkFallbackError — expect callers: auth.js:3,
   combo.js:5, accountFallback.js:227 (internal), open-sse/index.js:39
   (re-export), tests (3 files). All safe: the 4th param is optional.
2. errorConfig.js: doc + scoped rule (remove the NOTE).
3. accountFallback.js: signature + skip-check + JSDoc.
4. auth.js:309 + combo.js:335 plumbing.
5. Extend account-fallback-no-fallback.test.js; run
   `npx vitest run unit/account-fallback-no-fallback unit/github-monthly-usage-lock`
   → green including untouched github pin.
6. detect_changes() (expect: errorConfig/accountFallback/auth/combo + the one
   test file); one green commit
   `feat(fallback): provider-scoped error rules — commandcode payment-required rotation, github bare-402 fail-fast preserved (v0.6.46 phase 05)`.

## Todo list

- [x] impact() on checkFallbackError recorded
- [x] Scoped rule + doc; NOTE removed
- [x] checkFallbackError provider param + fail-closed skip
- [x] auth.js:309 + combo.js:335 plumbed
- [x] New test describe green; github pin green UNEDITED
- [x] detect_changes() + one green commit

## Success Criteria

- The 5 new assertions pass (true/true/false/false + unscoped-with-provider).
- github-monthly-usage-lock.test.js passes with `git diff` showing zero
  changes to it (explicitly verify: `git diff --stat -- tests/unit/github-monthly-usage-lock.test.js`
  is empty at commit time).
- account-fallback-no-fallback.test.js existing cases (incl. :72 bare-payment
  pin) green unedited — only the new describe added.
- No behavior change for any provider other than commandcode on text
  "payment required": parametrize the new describe with providers
  ["github","codex","qoder", undefined] → all false on bare "Payment required".

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Observable signal | Pre-decided response |
|---|---|---|---|---|---|
| commandcode 402 is request-level, not account-specific → rotation is wrong | Medium | Medium | Researcher flagged for capture confirmation; rotation cooldown is 2min (bounded blast); model-lock keys per model | commandcode accounts all exhaust on a bad request | Capture says request-level → change rule to fail-fast (remove rule or empty providers) in a revert-commit; behavior is one config line |
| Combo member prefixes are aliases that never equal rule values | Low | Medium | commandcode id === alias (registry :2,4); combo.js:70 treats the prefix as THE provider for capabilities too | scoped rule never matches in combo paths | Add resolveProviderId at combo.js call site (documented follow-up; only needed for alias≠id providers) |
| Scoped-rule skip logic accidentally skips unscoped rules | Low | High | Skip condition requires `rule.providers` truthy; unscoped rules lack the key; test pins unscoped-with-provider behavior | account-fallback suite red | Fix condition; the suite is the gate |
| Third-party callers of checkFallbackError see changed arity | Very Low | Low | 4th param optional + fail-closed = old behavior; open-sse/index.js:39 re-export unchanged signature-wise | downstream compile/test failures | None needed (optional param) |
| github pin test needs edits to keep passing | Low | High | Explicit non-goal — pin must pass UNEDITED (Success Criteria enforces via git diff) | git diff non-empty on the pin file | Stop; re-examine the skip logic (it must be wrong) |

## Security Considerations

- Pure classification logic — no secrets, no passphrase/crypto surface; none
  of the F invariants apply here.
- Fail-closed default: unknown/missing provider can never ENABLE a scoped
  rotation rule (a miscategorized provider fails fast exactly as today — the
  conservative C4 posture is preserved).
- Rule values are code, not user input (ERROR_RULES is a frozen config table);
  no injection surface.

## Red-Team Amendments (BINDING — 2026-09-06; override anything above that conflicts)

1. **RT46-A6/O6 the `cmc` alias defeats the rule in combo paths TODAY (supersedes Key Insight #4's "commandcode has id === alias … both forms match" and risk row 2's mitigation, and plan.md Unresolved #1):** the registry entry also declares `aliases: ["cmc"]` and `uiAlias: "cmc"` (open-sse/providers/registry/commandcode.js) — a combo member spelled `cmc/…` yields provider prefix `"cmc"`, the scoped rule is skipped, and a commandcode billing-402 fail-fasts instead of rotating: the exact bug this phase exists to fix, resurfacing under an alias. Fix (both): (a) the rule becomes `{ text: "payment required", providers: ["commandcode", "cmc"], cooldownMs: COOLDOWN.long }`; (b) at combo.js:335 pass `resolveProviderId(prefix) ?? prefix` (one import + one line — src/shared/constants/providers.js:121) so future alias≠id providers resolve too; (c) add the `cmc` case to the new test describe (`checkFallbackError(402, "[CommandCode error: payment required]", 0, "cmc")` → true).
2. Anchor note (RT46-O5): the pinned-test line numbers in plan.md drifted ~7–10 lines (github mock block is :3-29 with identity resolveProviderId at :15; bare-payment case :61-82; account-fallback bare pin :79, NO_FALLBACK set :7-10). Semantics verified correct — implementers should locate pins by expression, not line.

## Next steps

- None — independent phase; phase 06 sweeps it into the release.
