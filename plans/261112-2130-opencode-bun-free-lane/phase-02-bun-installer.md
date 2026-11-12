# Phase 02 — Shared asset-installer helpers + Bun binary installer

Depends on: nothing (parallel with P1, P5). No runtime dependency on P0.

## Objective

Extract the five proven concerns of `src/lib/xray/installer.js` (streamed download + abort, sha256 fail-closed verify, zip-extract cascade, staging + `.prev` rollback, `.version` marker) into one shared module, then build the Bun installer as an asset table + glue (~80 lines). Kills the copy-paste divergence risk the scope critic flagged (SC-F2).

## Files

- `src/lib/runtime/assetInstaller.js` (new — shared helpers)
- `src/lib/xray/installer.js` (edit — re-import helpers, behavior identical)
- `src/lib/runtime/bunInstaller.js` (new)
- `tests/unit/asset-installer-helpers.test.js` (new)
- `tests/unit/bun-installer.test.js` (new)
- `tests/unit/xray-installer-refactor.test.js` (new — pin the refactor is behavior-identical)

## Steps

1. House rules: `impact({target: "installXray", direction: "upstream"})` + `impact({target: "isXrayInstalled"})` before touching installer.js (callers: manager.js orchestrator, routes).
2. Extract into `assetInstaller.js` (pure helpers, no xray knowledge): `downloadToFile({url, dest, onProgress, signal})` (installer.js:129-150), `sha256File(file)` (:222-227), `extractZip(zip, destDir)` with the powershell/unzip/python3 cascade (:162-209), `atomicSwapIn({stagingPath, finalPath, prevDir})` with `.prev` rollback (:253-259 + restore :404-417) — ADD the Windows EPERM delete-retry dance (5× backoff 200ms-2s) inside the swap before falling to rollback (FM-5/R9), and a `prewarmCommand({cmd, args, timeoutMs})` helper (spawn + resolve-on-exit).
3. Refactor `installer.js` to import them — diff must be behavior-identical; `xray-installer-refactor.test.js` pins the public surface (`installXray`, `isXrayInstalled`, `getBun…`-style getters, rollback paths) against mocked fs/fetch.
4. `bunInstaller.js` mirroring the xray glue:
   - `BUN_VERSION = "1.4.0"` (the exact version the A/B proved; bump = deliberate, with re-measured digests).
   - `PLATFORM_ASSETS` (data-driven, digest pinned per row):
     - win32-x64: `https://github.com/oven-sh/bun/releases/download/bun-v${V}/bun-windows-x64.zip`
     - linux-x64: `https://github.com/oven-sh/bun/releases/download/bun-v${V}/bun-linux-x64.zip`
   - Install dir `<DATA_DIR>/bun/`, binary `bun.exe`/`bun`, `.version` file.
   - `installBun({onProgress, signal})`: single-flight module lock → download (staging) → sha256 fail-closed → extract → chmod 0755 → atomicSwapIn → `.version` write → `prewarmCommand` `bun --version` (60s deadline, absorbs AV first-scan — FM-5).
   - `ensureBunInstalled()`, `isBunInstalled()`, `getBunBinaryPath()`, `getInstalledBunVersion()`; typed `BUN_PLATFORM_UNSUPPORTED` for other platforms (executor treats any failure as lane-unavailable).
   - Test asserts every asset row carries a 64-hex digest (missing → fail → release checklist catches version bumps).
   - Attribution header (bun Apache-2.0/MIT).

## Verification gate

- `cd tests && npx vitest run unit/asset-installer-helpers.test.js unit/bun-installer.test.js unit/xray-installer-refactor.test.js`:
  - Helpers: download-abort clean-up; sha mismatch → staging deleted; extract cascade mocked per-OS; atomicSwapIn EPERM retry then rollback (Windows sim).
  - Bun installer: happy path writes binary + `.version` + prewarm called; digest missing → test fails; single-flight (two concurrent ensures → one download); `.version` match → no network; unsupported platform → typed error.
  - Xray refactor: existing exported behavior unchanged (mock-based parity).
- Manual smoke (dev): `ensureBunInstalled()` → `<DATA_DIR>/bun/bun.exe --version` prints `1.4.0`.
- `detect_changes()` before commit.

## Risks

- Refactor of a proven module — mitigated by parity tests + no behavioral diff allowed in review.
- GitHub reachability from VPS — same exposure as xray today (accepted parity); status route (P6) surfaces install state.
