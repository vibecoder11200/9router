---
title: "Phase 4: Run log viewer modal"
status: done
---

# Phase 4 — Run log viewer modal (backed by the persistent route)

## Context Links

- Phase 3 route `GET /api/xray/configs/model-filter/results` (this modal's data source — the originally-assumed `modelFilterResult.results` is dead code, red-team F1)
- Phase 2 `lastFinishedRun` snapshot + classifier
- `src/app/(dashboard)/dashboard/xray/page.js` — dead inline table :1336-1368 (removed or repurposed by this phase), completion watcher :330-358, banner :1290-1302
- Research: [researcher-01-ui-recon.md](./research/researcher-01-ui-recon.md)
- Red-team findings applied: F1 (route-backed), F12 (page reset + clamp), F13 (fetch races)

## Research Evidence (hard-mode 261114)

- **Modal: `Modal` from `@/shared/components`** (`src/shared/components/Modal.js:8`) — props `isOpen, onClose, title, children, footer, size ("sm"…"full"), closeOnOverlay`; Esc (:36-42) + scroll-lock (:27-34) built in. ⚠️ prop is `isOpen`. Import path proven (page.js:5).
- **Clipboard: `useCopyToClipboard`** (`src/shared/hooks/useCopyToClipboard.js:10`) — `{copied, copy}`.
- **Pagination: `Pagination` from `@/shared/components/Pagination`** (:6; props `currentPage, pageSize, totalItems, onPageChange, onPageSizeChange`; sizes [10,20,50] :68). ⚠️ **Does NOT clamp** (startItem/endItem unchecked, :10-13) — out-of-range page + slice = blank table; this phase must clamp (see Requirements).
- **Placement:** default-export sibling `.jsx` (pattern: SubscriptionManager/VersionPanel/FreeLaneCard, page.js:7-9).

## Overview

- Priority: P2
- Full drill-in over the pool's filter verdicts: "Last run" mode (route scoped by the last finished run's startedAt via `minTestedAt` — matches the chips) and "All verdicts" mode (explicitly labeled as spanning runs incl. rotation writes). Live-run mode rides the status counters. The dead inline table (:1336-1368) is removed and replaced by a single "View run log" entry point.

## Key Insights

- **Route-backed, not memory-backed (F1):** the modal fetches phase 3's route; there is no in-memory results array to rely on. "Last run" = `minTestedAt = lastFinishedRun.startedAt` + `model = lastFinishedRun.model` — the route's History then counts exactly what the chips counted (modulo the documented tunnelOk caveat, phase 3).
- **Two labeled views, honestly distinguished (F10):** "Last run (N tested)" vs "All persisted verdicts (spans runs, incl. auto-rotation)" — the label is permanent UI text, not a tooltip; rows show relative testedAt age.
- **Live mode:** while `status.modelFilter.status === "running"`, the modal's footer shows live counters from the status poll (tested/passed/failed/errorBreakdown) — read-only; row data stays whatever the route last returned (no half-run row rendering).
- **Dataset-change discipline (F12):** page resets to 1 on class-chip change, search input (debounced 300ms), view toggle, and pageSize change; plus `safePage = Math.min(page, totalPages)` clamp before slicing (the page's own server-table precedent: page.js:868-872 `safeServerPage`).
- **Fetch hygiene (F13):** one AbortController per dataset-affecting interaction; a monotonically increasing fetch sequence number discards stale responses (last-started-wins, NOT last-resolved-wins); after clear-cache success the modal refetches; a response with `total === 0` mid-session renders the cleared-cache state regardless of which response delivered it.

## Requirements

- [ ] "View run log" button (card, next to the idle badge once `lastFinishedRun` exists; also from the running banner while a run is live)
- [ ] Columns: server name/host, country, class badge (phase 2 variant map), status, latency, testedAt age, full error (wrap; `exitIp` column ONLY when the user enabled it via an in-modal toggle that sets `includeExitIp=1`, default off)
- [ ] Modes: "Last run" (minTestedAt-scoped) / "All verdicts" (labeled) — toggle refetches with sequence guard
- [ ] Filter: class chips (from summary) + free-text search over name/host/error (server-side via the route's search param)
- [ ] Copy: single-row error copy + "copy summary" (byClass + rows as TSV) via `useCopyToClipboard`
- [ ] Page reset + clamp on every dataset change; `Pagination` component
- [ ] Clear-cache mid-session → cleared state; refetch after clear-cache action
- [ ] Remove/replace the dead inline table (:1336-1368) and its footer — one drill-in entry point, no dead code left behind
- [ ] Servers-table status upgrade: `/api/xray/configs` badge payload (`c.modelFilterResult`, route.js:45-50) gains `errorClass` (repo row already carries `error`/`status` — additive, zero extra queries); the servers table renders the class label + testedAt tooltip
- [ ] Zero new npm dependencies

## Architecture

```
page.js: lastFinishedRun (phase 2) + status poll
  └─ <FilterRunLogModal isOpen onClose lastRun={lastFinishedRun} live={status.modelFilter}/>
        ├─ mode toggle: Last run (minTestedAt=lastRun.startedAt) | All verdicts
        ├─ fetch: route(page,class,search,minTestedAt,includeExitIp) — AbortController + seq guard
        ├─ toolbar: class chips (from view=summary) + search (debounced) + copy
        ├─ table: Pagination (clamped), class badge, full error, testedAt age
        └─ live footer while running: counters from `live` prop (read-only)
```

## Related Code Files

- Create: `src/app/(dashboard)/dashboard/xray/FilterRunLogModal.jsx`
- Modify: `src/app/(dashboard)/dashboard/xray/page.js` — modal state, entry buttons, dead-table removal, servers-table status column
- Modify: `src/app/api/xray/configs/route.js` — badge payload gains `errorClass` (classifier call on the already-fetched row)
- Modify (possible): `src/lib/xray/modelFilterErrors.js` — variant/label map re-export for the modal (single source)

## Implementation Steps

1. Build `FilterRunLogModal.jsx` (default export, sibling): fetch layer with AbortController + seq; modes; clamped pagination; copy actions.
2. page.js wiring: entry buttons, modal state, remove dead table + footer, servers-table status column.
3. `/api/xray/configs` badge payload: add `errorClass` (persisted-fields classifier call) + servers-table render.
4. Manual smoke: mixed run → open modal (Last run counts == chips); class filter; page deep → filter (reset works); toggle All verdicts (label + different counts); clear cache while open (cleared state + refetch); esc; copy TSV; servers-table badges match modal classes.
5. Existing xray suites stay green (no new component-test stack — repo norm); route test for the extended badge payload in the established style.

## Todo

- [ ] Modal component (fetch hygiene + modes + clamp + copy)
- [ ] page.js wiring + dead-table removal
- [ ] Manual smoke checklist (incl. race + reset scenarios)
- [ ] Xray suites green

## Success Criteria

- "Last run" mode's per-class counts equal the phase-2 chips (fixture-level parity already pinned in phase 3; this is the UI-level check)
- Deep page → filter change never blanks the table (reset + clamp)
- Rapid toggle Last↔All never shows stale-view data (sequence guard)
- No dead JSX remains at the old :1336-1368 table

## Risk Assessment

- **Low.** Presentational + one well-understood fetch loop; all failure modes (races, blank pages, stale data) are explicitly specified. Depends on phase 3's route contract — frozen before this phase starts.

## Security Considerations

- All error text renders as React children (auto-escaped); never `dangerouslySetInnerHTML`
- exitIp column off by default (phase-3 exposure mitigation); the in-modal toggle is explicit user action
- Clipboard writes user-initiated only
