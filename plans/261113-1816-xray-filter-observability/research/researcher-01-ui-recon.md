# Research 01 — UI recon (phases 2–3), hard-mode session 261114

All findings verified with file:line from the current working tree (v0.6.90, commit c6875a3a).

## 1. Modal primitive

- `src/components/ui/` does NOT exist — UI kit is `src/shared/components/`.
- **`src/shared/components/Modal.js`** — default export `Modal` (line 8) + named `ConfirmModal` (line 115).
  - Props (lines 8–18): `isOpen, onClose, title, children, footer, size ("sm"|"md"|"lg"|"xl"|"full"), closeOnOverlay, showTrafficLights, className`
  - Esc handling lines 36–42; scroll-lock lines 27–34 (`document.body.style.overflow = "hidden"`); fixed overlay line 47; body scrolls internally (`max-h-[calc(85vh-100px)] overflow-y-auto`, line 102).
  - ⚠️ prop is **`isOpen`**, not `open`.
- Re-exported from `src/shared/components/index.js:6`. xray `page.js` already imports `ConfirmModal` via `@/shared/components` (page.js:5) — path proven.

## 2. Clipboard

- Shared hook **`src/shared/hooks/useCopyToClipboard.js`** — `useCopyToClipboard(resetDelay = 2000)` (line 10), `navigator.clipboard.writeText` (line 17), returns `{ copied, copy }`. Consumers: combos, endpoint, token-saver, ProviderLimits, DefaultToolCard. xray/page.js has zero clipboard usage today.

## 3. xray page.js facts

- Running-filter banner: **lines 1290–1302** (amber box on `runningModelFilter`; counters at :1296). Lines 1284–1287 are the quiet-window hint, NOT the banner.
- Idle last-run summary badge EXISTS: `visibleModelFilterResult` = `modelFilterResult || status.modelFilter` (lines 878–883), rendered in the card header at **lines 1157–1163** (`passed/tested usable · N cached`, "Stopped ·" prefix when cancelled).
- Badge component `src/shared/components/Badge.js` (line 20); variants (lines 5–12): `default, primary, success, warning, error, info`; props `size ("sm"|"md"|"lg")`, `dot`, `icon`. Import already at page.js:5.
- Count-chips precedent: `proxy-pools/ProxyXoayPoolCard.js:102–114` (row of `<Badge variant size="sm">` with counts); xray page text-chip row :1377–1379.
- Results table: lines **1336–1368**, `slice(0, 25)` at :1349, footer "Showing first 25 of N" :1362–1365. `modelFilterResult` state at :145.

## 4. Pagination

- Shared **`src/shared/components/Pagination.js`** — default export (line 6); props `currentPage, pageSize, totalItems, onPageChange, onPageSizeChange`; page-size options `[10, 20, 50]` (line 68). NOT exported from index.js — import via `@/shared/components/Pagination` (consumer example: `usage/components/RequestDetailsTab.js:7`, state usage :88–90, :155–159, :319–321).
- Local server-side precedent inside xray page.js: `SERVER_PAGE_SIZE = 200` (:73), `serverPage` (:129), slice :868–872, hand-rolled pager :1436–1476.

## 5. Sibling component pattern

`src/app/(dashboard)/dashboard/xray/`: `page.js`, `SubscriptionManager.jsx`, `VersionPanel.jsx`, `FreeLaneCard.jsx` — default imports (page.js:7–9):
```js
import SubscriptionManager from "./SubscriptionManager.jsx";
```

## Assumption audit

- (i) reusable modal exists — CONFIRMED (prop `isOpen`)
- (ii) results table ~:1330 — CONFIRMED (1336–1368)
- (iii) `modelFilterResult.results` — CONFIRMED (:145, :1336, :1349)
