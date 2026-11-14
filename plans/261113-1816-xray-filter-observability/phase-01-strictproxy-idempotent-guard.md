---
title: "Phase 1: StrictProxy idempotent guard"
status: done
---

# Phase 1 — StrictProxy idempotent guard

## Context Links

- Bug observed on prod 261113: `[502]: [ProxyFetch] Proxy required but failed (strictProxy=true): [ProxyFetch] Proxy required but failed (strictProxy=true): …` in `xrayModelFilterResults.error`
- v0.6.89 review fix that introduced the annotate-not-replace contract (commit 9cb8e0a3)
- Affected file: `open-sse/utils/proxyFetch.js` — catch sites at lines 466, 661, 686

## Overview

- Priority: P2
- The opencode probe path nests two strict-proxy catch layers (bridge `run()` at :466 → `fetchWithTlsFallback` caller at :686). The inner layer annotates and rethrows; the outer layer catches the SAME error object and annotates again — the prefix doubles. Purely cosmetic but it garbles the error text that phases 2–3 will surface in the UI, so it lands first.

## Key Insights

- All three sites already set `err.proxyInfra = true` after annotating — the flag IS the natural idempotency marker; guard on it (`if (strict && !err.proxyInfra)`).
- The annotate-not-replace contract (v0.6.89 P1 fix) must stay: never `new Error(...)`, always mutate message in place so `noRetry`/`statusCode`/`code`/cause survive.
- Keep three 1-line guards rather than hoisting a helper — minimal diff on a CRITICAL-risk file (proxyFetch is the transport hub).

## Requirements

- [ ] A strict-proxy failure crossing any number of nested strict catch layers carries the prefix exactly once
- [ ] Non-strict path unchanged (no annotation, console.warn fallback as today)
- [ ] Zero behavior change beyond message text; all existing strict-proxy suites stay green

## Architecture

No structural change. Each of the 3 catch sites gains the same guard:

```js
if (strict && !err.proxyInfra) {          // idempotent: nested layers must not re-annotate
  err.message = `[ProxyFetch] Proxy required but failed (strictProxy=true): ${err.message}`;
  err.proxyInfra = true;
}
```

(The `:641` site constructs a FRESH error, cannot double — leave untouched.)

## Related Code Files

- Modify: `open-sse/utils/proxyFetch.js` (3 sites: :466, :661, :686)
- Create: one unit test file (or extend an existing strict-proxy suite)

## Implementation Steps

1. Run `impact({target: "proxyAwareFetch", direction: "upstream"})` (AGENTS.md rule) — expect CRITICAL hub warning; note that the diff is message-only.
2. Add the `!err.proxyInfra` / `!proxyError.proxyInfra` guard at the 3 annotate sites.
3. Add unit test pinning single-prefix through a nested strict path; assert `message.match(/\[ProxyFetch\] Proxy required/g).length === 1`.
4. Run: `cd tests && npx vitest run unit/usage-route-lease.test.js unit/qoder-proxy-replay.test.js unit/opencode-wreq-proxy-routing.test.js` (+ the new test).

## Todo

- [ ] impact analysis on proxyAwareFetch (record blast radius here)
- [ ] Guard at :466
- [ ] Guard at :661
- [ ] Guard at :686
- [ ] Single-prefix pin test
- [ ] Strict-proxy suites green

## Success Criteria

- Nested strict failure → prefix count exactly 1 (unit-pinned)
- Existing suites `usage-route-lease`, `qoder-proxy-replay`, `opencode-wreq-proxy-routing` green
- `detect_changes` shows only proxyFetch.js symbols

## Risk Assessment

**Low.** Message-only mutation behind an existing flag. Complete setter inventory (red-team corrected — R1-F6/R2-F7/R3-F5): `proxyFetch.js` sets `err.proxyInfra = true` at **:467, :642, :662, :687, :720** (five sites); `open-sse/handlers/chatCore.js:476` COPIES the flag onto a propagated errResult (never a fresh set). The two unlisted-before fresh-error sites (:641-643 "connection proxy could not be resolved… refusing", :719-721 "Proxy required but none resolved") throw NEW errors that never re-enter an annotate site — the guard stays correct — but they are refusal wordings WITHOUT the "…but failed" prefix, which phase 2's `tunnel` matcher must cover explicitly.

**Pin-test strengthening (red-team):** the unit test asserts single-prefix on the ANNOTATE path AND that refusal-path messages (:641/:720 wordings) crossing an outer strict layer keep their original text (guard suppresses re-annotation correctly) — not just the double-prefix case.

## Security Considerations

None new — no credential-bearing strings involved; prefix text is static.
