---
title: "Xray model filter observability — error truth on the dashboard"
description: "StrictProxy double-prefix guard + error breakdown chips + full-run log viewer + persistent per-config results API/UI so 'why did it fail' is answerable without SSH."
status: done
priority: P2
effort: 7h
branch: master
tags: [feature, bugfix, frontend, api, xray]
blockedBy: []
blocks: []
created: 2026-11-14
---

# Xray model filter observability — error truth on the dashboard

## Overview

v0.6.90 fixed the silent filter abort, and the first full prod run (82 tested / 0 usable) immediately exposed the next gap: **the dashboard cannot answer "why did it fail"**. Answering it required SSH + sqlite queries (`62 × 429 quota · 34 × timeout · 17 × tunnel fail`). This plan moves that answer into the product:

1. **Fix** the cosmetic-but-misleading double `[ProxyFetch] Proxy required but failed (strictProxy=true):` prefix (two nested catch sites annotate the same error object).
2. **A — Error breakdown chips**: classify the run's results into error classes and render them on the filter summary line.
3. **C — Persistent results API** (built BEFORE the modal — red team proved the originally-assumed in-memory results array is dead code): read-only route over `xrayModelFilterResults` joined with `xrayConfigs`.
4. **B — Run log viewer modal**: drill into verdicts via the route (full error text, class filter, search, pagination, copy) — "Last run" and "All verdicts" modes.

Prod evidence driving the error-class taxonomy (261113; counts from the results TABLE across recent runs — cumulative, not one run's totals, which were "82 tested / 0 usable"):
- `[429]: FreeUsageLimitError` — node alive, exit-IP free quota spent (62)
- `Probe timed out after 20000ms` — dead node (34)
- `[502]: [ProxyFetch] Proxy required but failed (strictProxy=true)` — tunnel never opened (17; the double-prefix case)

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | strictProxy annotation is idempotent — nested catches never double-prefix | P2 |
| 2 | Filter summary shows per-class failure counts (run-level, in-memory) | P2 |
| 3 | Modal lists ALL results of the last run with full error text + class filter + copy | P2 |
| 4 | New GET route serves persistent per-config results joined with configs; servers table exposes it | P2 |

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [StrictProxy idempotent guard](./phase-01-strictproxy-idempotent-guard.md) | Done (a7506899) |
| 2 | [Error classifier + breakdown chips](./phase-02-error-breakdown-chips.md) | Done (d2c40fb0) |
| 3 | [Persistent results API](./phase-03-persistent-results-api.md) | Done (e03ccb1b) |
| 4 | [Run log viewer modal](./phase-04-run-log-viewer-modal.md) | Done (94259ef0) |

## Success Criteria

- [x] A strict-failure through the nested bridge path carries the prefix exactly once (unit-pinned, incl. refusal wordings) — a7506899
- [x] After a run, the dashboard shows `N usable · N× <class> · …` (from the `lastFinishedRun` snapshot) without opening any table; aborted runs show the "aborted after N — M untested" chip — d2c40fb0; untested arithmetic corrected post-review (selected + cached − tested)
- [x] Default-mode (freeChatProbe=false) dead nodes classify as `tunnel-check`, not `other` — pinned in xray-filter-error-breakdown.test.js
- [x] The modal (route-backed) shows full verdicts with class filter/search/pagination — 94259ef0; "Last run" counts USUALLY equal the chips: parity is not guaranteed (cached/pruned rows, rotation-window leaks, tunnelOk caveat) — labels state this honestly post-review
- [x] After server restart, per-server last verdicts are still reachable via the new route — rows read the persisted xrayModelFilterResults table (real-sqlite tests)
- [x] exitIp only with explicit opt-in; soft-deleted configs never appear; parity tests (real sqlite) assert pairwise-disjoint fragments — e03ccb1b
- [x] All touched suites green from `tests/` under vitest ^5.1.0; `detect_changes` before commit; release v0.6.91 — 79/79 across 9 suites; independent code review (post-cook) found no P0/P1

## Dependencies

- `modelFilterState`/`abortedReason` shape from v0.6.90 (already on master c6875a3a)
- Phase order is now **strict**: 1 → 2 → 3 → 4 (the modal consumes phase 3's route; red-team F1 killed the original "no backend" phase 3)
- Error-class classifier + SQL fragments live in ONE module (phase 2 creates, phase 3 extends with fragments — same file, single truth)

## Research Evidence (hard-mode session 261114)

- [researcher-01-ui-recon.md](./research/researcher-01-ui-recon.md) — Modal (`src/shared/components/Modal.js`, prop `isOpen`), `useCopyToClipboard` hook, shared `Pagination` component, xray page.js line-precise facts (banner :1290–1302, idle badge :1157–1163, results table :1336–1368)
- [researcher-02-api-recon.md](./research/researcher-02-api-recon.md) — auth auto-coverage (LOCAL_ONLY prefix + deny-by-default), indexes `idx_xmfr_model`/`idx_xmfr_configId` EXIST (assumption "PK-only" refuted), canonical repo-test pattern (temp DATA_DIR + initDb), badge payload extension point
- Plan assumptions resolved: 3 confirmed, 1 refuted-and-corrected (indexes), 0 unverified

## Standing constraints (from project AGENTS.md + session rules)

- Run impact analysis before editing any symbol; warn on HIGH/CRITICAL before proceeding
- vitest runs FROM `tests/` directory only (alias config lives there), pinned ^5.1.0
- `detect_changes` before every commit
- No upstream-README churn; CHANGELOG section per release

## Red Team Review

### Session — 2026-11-14 (hard-mode)
**Reviewers:** Security Adversary (Fact Checker) · Failure Mode Analyst (Flow Tracer) · Assumption Destroyer (Scope Auditor) — 24 raw findings, deduped to 14, all evidence-backed (file:line), 0 auto-rejected.
**Findings:** 14 (14 accepted, 0 rejected) — 1 Critical, 5 High, 8 Medium
**User decision:** apply all.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Phase 3 premise false — `modelFilterResult.results` never populated (fire-and-forget POST since 11796d20); inline table dead code; badge frozen after manual runs | Critical | Accept | Phase 4 rewritten route-backed; phase reorder 3↔4; dead table removal task |
| 2 | `visibleModelFilterResult` precedence shadows live status with frozen start snapshot | High | Accept | Phase 2 (completion-watcher null-out) |
| 3 | Taxonomy gaps — default-mode `tunnel-check` string, `tunnelOk` missing from signature, v0.6.90 UpstreamError string, unstated precedence | High | Accept | Phase 2 taxonomy v2 + precedence table |
| 4 | managedRotation second writer (`cloudflare edge ip block`, status 403) misbuckets as upstream-http | High | Accept | Phase 2 `edge-ban` class + Phase 3 fragment + fixture |
| 5 | Parity flawed — overlapping predicates (ETIMEDOUT double-match), one-directional test, substr(1,60) third variant, mocked-sqlite contradiction | High | Accept | Phase 3 single-truth fragments + pairwise-disjoint test on real temp sqlite + full-text summary scan |
| 6 | New route = first inventory-wide exitIp+error exposure; passwordless under requireLogin=false+tunnel | High | Accept (modified: exitIp opt-in param) | Phase 3 Security + rows contract |
| 7 | proxyInfra inventory wrong — 5 setters + chatCore copier, not 3+1 | Medium | Accept | Phase 1 Risk Assessment corrected + refusal-wording pins |
| 8 | Soft-deleted (tombstoned) configs resurrect in the JOIN — no cascade until sync | Medium | Accept | Phase 3 `c.deletedAt IS NULL` everywhere + isActive param |
| 9 | Auto-runs silently replace live-state chips | Medium | Accept | Phase 2 `lastFinishedRun` snapshot |
| 10 | History summary unscoped (all ages + provenance) contradicts chips | Medium | Accept | Phase 3 `minTestedAt` + Phase 4 labeled modes |
| 11 | Aborted-run chips read as complete | Medium | Accept | Phase 2 aborted chip |
| 12 | No page reset on dataset change; Pagination doesn't clamp → blank pages | Medium | Accept | Phase 4 reset+clamp requirements |
| 13 | History fetch races (no abort/sequence; clear-cache mid-browse) | Medium | Accept | Phase 4 AbortController + seq guard + refetch |
| 14 | `spawn` class never persisted; plan evidence numbers conflate runs | Medium | Accept | Phase 3 empty fragment documented; Phase 2 wording fixed |

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01…04 (post-rewrite)
- Decision deltas checked: 14 (phase reorder, taxonomy v2, route-backed modal, exitIp opt-in, deletedAt filter, lastFinishedRun)
- Reconciled stale references: 6 (old phase names/links, "no new backend" claim, "no orphans" claim, old taxonomy, old classifier signature, banner line-range 1284→1290)
- Unresolved contradictions: 0

**Research correction note:** researcher-01's "(iii) CONFIRMED" for `modelFilterResult.results` verified symbol existence, not runtime population — superseded by red-team F1. Remaining researcher-01 facts (Modal/Pagination/clipboard/banner line ranges) re-verified by reviewers and stand.

