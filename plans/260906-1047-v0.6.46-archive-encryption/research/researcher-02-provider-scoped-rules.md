# Research: Provider-scoped "payment required" error rules (v0.6.46)

Researcher: agent (inline report persisted by orchestrator). Date: 2026-09-06.

## 1. Repo evidence (verified current anchors)

**Rule table** — `open-sse/config/errorConfig.js`
- `ERROR_RULES` :59-98: flat array `{text?, status?, cooldownMs?, backoff?}`, text rules first (order = priority), then status rules. ~23 text rules; NO provider dimension.
- Bare `{status:402, cooldownMs:long}` at :94.
- :87-90: comment documents deliberate absence of "payment required" rule + "Provider-scoped rules are the eventual fix."
- `COOLDOWN = {long: 2min, short: 5s}` :45-48.

**Classification engine** — `open-sse/services/accountFallback.js`
- `NO_FALLBACK_STATUSES = Set([400,401,402,404,405,413,422])` :10 (C4 fail-fast).
- `checkFallbackError(status, errorText, backoffLevel)` :27-68: text-rule match → fallback; else bare NO_FALLBACK status → no-fallback; else status rules; else transient. **No provider parameter exists.**

**Call sites (provider availability):**
- `src/sse/services/auth.js:309` — inside `markAccountUnavailable(connectionId, status, errorText, provider, model)`; **provider in scope** (used by the github test).
- `open-sse/services/accountFallback.js:227` — takes (status, errorText, backoffLevel) only.
- `open-sse/services/combo.js:335` — provider resolvable from model mapping but not passed.

**Test pins:**
- `tests/unit/github-monthly-usage-lock.test.js:66-72` — bare "Payment required" 402 from github must NOT rotate. :20-37 mocks `@/shared/constants/providers.js` (resolveProviderId identity).
- `tests/unit/account-fallback-no-fallback.test.js:9` pins NO_FALLBACK set; :72 pins `checkFallbackError(402,"Payment required").shouldFallback === false`; :56 shows commandcode 401 text arrives wrapped `[CommandCode error: unauthorized]`.

**commandcode identification** — `open-sse/executors/commandcode.js`
- :106 `parseCommandCodeError`: `lower.includes("payment required") || lower.includes("billing")` → 402/billing_error. :288 wraps as `[CommandCode error: ${message}]`. commandcode billing-402 text reaches checkFallbackError containing literal "payment required" — the exact string github also emits bare. Disambiguate by provider context, not text.

## 2. Design precedent (web)

- **LiteLLM**: normalizes per-provider errors into a unified exception hierarchy at the adapter layer; fallback policy is per-model-deployment lists keyed by exception type. No user-configurable per-provider text-rule table.
- OpenRouter / new-api / portkey: no public precedent for per-provider text-rule scoping in a shared table; norm is adapter-layer classification.
- Verdict: **no direct precedent for per-provider config tables; industry norm is adapter-layer classification.** Our engine is shared (accountFallback.js) so adapter-layer would be string-hacking; explicit scoping is cleaner.

## 3. Options

| Option | Backward compat | Testability | Blast radius | Complexity |
|---|---|---|---|---|
| (a) per-rule `providers: []` allowlist (absent = all) | Perfect — unscoped rules unchanged | Trivial | Only the new scoped rule | Low: one skip-check + thread provider through 3 call sites |
| (b) `providersExclude` | Same | Same | Same | Same; allowlist is the natural mental model |
| (c) provider rule tables `rules.commandcode` | merge/drift risk; breaks flat top-to-bottom invariant (:52) | OK | Higher — reshapes ERROR_RULES | Medium-high |
| (d) generic predicate | rules stop being serializable data | Testable | Unbounded logic-in-config creep | High; YAGNI |

**Recommendation: (a).** Thread `provider` into `checkFallbackError(status, errorText, backoffLevel, provider)` (optional/undefined-safe so existing callers + tests compile unchanged). Add:
```js
{ text: "payment required", providers: ["commandcode"], cooldownMs: COOLDOWN.long },
```
github's bare "Payment required" skips the scoped rule (provider mismatch) → falls to NO_FALLBACK 402 → fail-fast preserved (github pin stays green, zero edits). commandcode billing 402 matches text evidence → rotates.
Guardrail: `checkFallbackError` with provider undefined skips scoped rules (fail-closed to current behavior) until call sites are plumbed.

## Recommendations
1. Optional `providers` array on ERROR_RULES entries; skip when present && (provider undefined || !includes(provider)).
2. Thread provider from auth.js:309 (free) + combo.js:335 (resolve from model→provider map); accountFallback.js:227 passes through.
3. Re-add the scoped rule; remove NOTE comment at errorConfig.js:87-90; document `providers` in the :53 doc comment.
4. Tests: github pin unchanged; `checkFallbackError(402,"Payment required",0,"commandcode").shouldFallback === true`; undefined-provider → false (fail-closed).
5. Verify with a real capture that commandcode billing-402 is account-specific (rotate) before shipping.

## Unresolved questions
- commandcode 402 account-specific vs request-level — confirm with capture.
- combo.js:335: provider id vs alias string per combo member (plumbing detail).
- providersExclude: YAGNI until a real case.

Sources: LiteLLM exception mapping (docs.litellm.ai/docs/exception_mapping), routing (docs.litellm.ai/docs/routing), proxy reliability. Other projects assessed from prior knowledge (lower confidence; web search rate-limited).
