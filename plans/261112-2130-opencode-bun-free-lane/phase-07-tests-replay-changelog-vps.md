# Phase 07 — Full suite, replay harness, CHANGELOG, hygiene, VPS live acceptance

Depends on: P1–P6 all landed.

## Objective

Close the loop: full-suite green, a replay harness re-proving the lane through the shipped stack, CHANGELOG + docs polish, research-residue hygiene, and the VPS live acceptance checklist that defines "done".

## Files

- `scripts/replay-opencode-free-lane.mjs` (new, dev tool)
- `CHANGELOG.md` (edit — one entry)
- `.gitignore` (edit — `oc-capture/` after the fixture derivation in P1)
- `tests/unit/` — gap-fills from the consolidation run only
- `plans/261112-2130-opencode-bun-free-lane/reports/vps-acceptance.md` (new — checklist output)

## Steps

1. Full suite: `cd tests && npx vitest run` — everything green, including pre-existing `opencode-session`, `opencode-fingerprint`, `opencode-free-*`, `opencode-go-*` (zero regression on keyed lanes + session semantics) and the new suites from P1–P6. Baseline known-fails (Windows env noise) unchanged vs HEAD.
2. Replay harness (dev/CI machine with bun; NEVER on the VPS):
   - Mode A: load `tests/fixtures/opencode-replay/`, mint fresh session ids, replay through the REAL `opencodeBunLane.opencodeFreeLaneFetch` (manager + child, no executor) → expect 200 + first SSE chunk ×3 consecutive.
   - Notes-only (no assertions, research provenance): the Node-vs-Bun differential lives in `Research-261112-opencode-v2-free-gate-wire-format.md`; if Mode A ever 429s with a fresh sync-matching snapshot → STOP, new research round (not an implementation fix).
3. Hygiene (red-team SEC-4, verify — do not assume):
   - [ ] `C:\Users\ankha\.config\opencode\plugins\oc-capture-hooks.js` absent (deleted pre-plan — verify).
   - [ ] `~/.local/share/opencode/capture/` absent.
   - [ ] `oc-capture/` gitignored; committed tree contains only `tests/fixtures/opencode-replay/` (sanitized).
   - [ ] `git grep -l "Orchestration Protocol\|review-audit-self-decision" -- open-sse tests` → empty (contamination belt-and-braces).
4. CHANGELOG entry: `feat(opencode): Bun stdio lane for the OpenCode v2 free-tier gate (CLI-identical traffic, fail-fast, no silent fallback)` — mentions: default engine bun, `"legacy"` kill-switch, detect-only snapshot sync, the 3 known-refused responses/messages free models (R8), and the bun download-on-demand.
5. Conventional commit; `detect_changes()` before commit; final whole-feature `detect_changes({scope: "compare", base_ref: "master"})` if landed on a branch.

## VPS live acceptance checklist (the measurable "done" — every box must pass)

1. `GET /api/opencode-free-lane` → `bun.installed: true`, `lane.busy: 0`, `snapshot.clientVersion: "2.2.7"`, `engine: "bun"`.
2. **Chat 200 (acceptance #2)**: `oc/deepseek-v4.1-flash-free` via internal `/api/v1/chat/completions` with the opencode pool binding as-is → streaming 200, content received; `getBunLaneStatus().lastErrorAt` null.
3. **Filter probe (acceptance #4)**: model-filter `freeChatProbe: true` over ≥2 configs → per-node verdicts; one deliberately-dead config marked failed without polluting others; concurrency ≤3 children observed (`ps aux | grep -c "[b]un"` ≤ 3 during the run).
4. **RAM**: peak bun child RSS < 80MB each; total box memory headroom recorded before/during/after.
5. **Test Model (acceptance #5)**: dashboard Test on the free model → success; `models/test/ping.js` diff = none.
6. **Fail-fast drill (acceptance #3)**: `chmod -x <DATA_DIR>/bun/bun` (or rename) → next chat returns the typed 503 `OPENCODE_FREE_LANE_UNAVAILABLE` within the bounded retry window; exactly ONE critical alert; restore → next request 200 via bun. (Legacy is NOT expected to serve — by design.)
7. **Abort drill**: start a chat, kill the client mid-stream → bun child exits within ~1s (`ps` empty of stragglers) — quota-safety proof in production.
8. **Snapshot detect-only**: wait/trigger the sync tick with a mocked-newer version (temporarily point the module's fetch at a stub via test hook is NOT available in prod — instead: verify no file under `<DATA_DIR>` was written by the sync and the alert path is wired by checking code + one forced alert through the test suite) — box: DATA_DIR contains no runtime-written snapshot; drift alert arrives when version differs (validated in unit tests; prod spot-check optional).
9. **Shutdown/restart hygiene**: app restart → lane healthy again; no bun processes linger after stop.

## Verification gate

- `cd tests && npx vitest run` green (baseline diff unchanged).
- Mode A replay output attached to this plan's `reports/`.
- VPS checklist executed, outputs recorded in `reports/vps-acceptance.md`.

## Risks

- Live gate shifts between plan and execution — checklist step 2 is the arbiter; a 429 there with healthy lane + matching snapshot = STOP + research round (plan R4 discipline).
- Checklist spends a handful of free-tier completions — negligible, paced ≥2s.
