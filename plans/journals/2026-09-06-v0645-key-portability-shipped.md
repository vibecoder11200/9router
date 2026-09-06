---
title: v0.6.45 key-portability shipped
date: 2026-09-06
summary: "Portable API-key backups (wrapped secret + adoption), re-key fallback, 62-bit keyIds, CLI backup menu — red-teamed plan, zero-new-failures gate, tagged v0.6.45"
---

# v0.6.45 key-portability shipped

## What happened
Cooked plans/260906-0343-v0.6.45-key-portability/plan.md (--auto --parallel) end to end: 7 commits for phases 01→06 (envelope module, keyId upgrade, export/adoption, re-key flow, CLI backup menu, release), each its own green commit. Tagged v0.6.45; Build-and-Release/Docker/CI workflows auto-triggered (no manual dispatch needed this time, unlike v0.6.44).

## Decision
Code-review gate returned REQUEST CHANGES with one blocker: auth and envelope-sealing shared a single bcrypt-only check, so fresh installs (no stored password) got 401 on export — contradicting the binding RT-03/RT-17 amendments. Fixed by splitting: full baseline auth (bcrypt OR local default/initial) gates the route, the stored-hash check alone gates sealing; fresh installs export envelope-less + warning. Also hardened the RT-05 shape guard against null table values ({meta:{}, settings:null} previously wiped everything) and wrapped the CLI backup API calls in try/catch (non-latin1 passwords rejected the promise and killed the TUI). Added tests/unit/database-route.test.js — the route layer had zero tests, which is exactly where the blocker lived.

## Incidents worth remembering
1. A subagent's exportDb restructure silently dropped the `settings` key — caught ONLY by the full-suite failing-set diff (db-sqlite-vs-lowdb roundtrip). The diff method keeps earning its cost.
2. An interrupted baseline worktree ran its full suite WITHOUT node_modules (1941 vs 2863 tests) and produced a bogus 54-"new-failures" comparison. Always sanity-check run sizes before trusting a failing-set diff.
3. `git worktree remove --force` followed a node_modules JUNCTION and recursively wiped the MAIN repo's node_modules. Restored via npm ci from lockfiles. Never junction node_modules into a worktree you'll force-remove — or remove the junction before `worktree remove`.

## Verification
65/65 green across 8 new/extended test files; failing-set diff vs 7770cb9d = zero new failures (single delta unit/process-guard passes standalone in both trees — load flake). Reports in plans/reports/260906-v0645-*.

## Next steps
- v0.6.46 roadmap (phase-07 sketch): Option F whole-archive encryption; also deferred: provider-scoped payment-required rules, api-key-secret (CRC) scope wrapping decision.
- Consider adding route-handler tests to the standing checklist — both release-gate catches (v0.6.44 masked-key sweep, v0.6.45 route blocker) were in layers the unit suite doesn't see.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
