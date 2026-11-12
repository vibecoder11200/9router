# Phase 00 — Gate probe ladder (hard gate before any module)

Depends on: nothing. Everything downstream consumes this phase's report.

## Objective

Pin the three unknowns the whole design stands on, by live probe, BEFORE writing the snapshot module:

1. **Minimal system-text composition the gate accepts** (the 66KB capture is ~60KB personal config — cannot ship; find the smallest scrubbed composition that still returns 200).
2. **`x-opencode-project` value**: `"global"` vs a minted sha1-hex (the 200 proof used the CLI's real project hash; `"global"` is what the CLI sends for project-less sessions — likely fine, must be proven).
3. **Fresh-spawn TLS**: the gate accepts a request from a freshly spawned bun process with a brand-new TCP+TLS connection (architecture A's per-request child) — proven 3× consecutive.

Failure modes are pre-decided (risk table R1/R2): rung-3 failure → STOP, replan snapshot composition; rung-4 failure → switch to persistent-HTTP branch B.

## Files

- `repro-261111/oc-gate-ladder.mjs` (new, dev scratch — not shipped) — derives compositions from `oc-capture/v2-2-7-live.jsonl` (the real v2.2.7 capture; `req_001.json`/`req_002.json` are v1.18 zen captures, DO NOT use).
- `plans/261112-2130-opencode-bun-free-lane/reports/p0-ladder.md` (new — the committed result).

## Ladder rungs (each: fresh CLI-minted session id, run 5× interleaved, pass = ≥4/5 HTTP 200)

Rungs run under **bun** (system bun is installed on the dev machine). All rungs keep: v2 endpoint, `Bearer public`, UA `opencode/latest/2.2.7/cli`, 4 session headers, `x-opencode-client: cli`, 12-tool manifest verbatim from the capture, `stream: true`, `stream_options.include_usage`, `max_completion_tokens: 32000` (small for probe runs: 64).

- **Rung 1 — scrubbed-full**: system message = capture's 66KB with personal sections REPLACED by short neutral equivalents (drop `# ~/.config/opencode/AGENTS.md`, `# Orchestration Protocol`, `## Rule: *` blocks; keep harness prefix verbatim + env skeleton). Expect 200 — proves size/structure matters more than personal bytes.
- **Rung 2 — env-skeleton**: harness (756B upstream `system.txt` + tool guidance) + fork-style env sections (cwd/platform/date, ~1-2KB total). This is the target shipping composition.
- **Rung 3 — harness-only**: bare harness, no env sections. If this passes, ship even smaller.
- **Rung 4 — fresh-spawn ×3**: take the best passing rung, run it 3× consecutive, each in a NEW `bun` process (separate invocations), expect 200 all three (proves per-request child viability).
- **Rung 5 — project-header A/B**: best rung with `x-opencode-project: "global"` and with `x-opencode-project: <sha1-of-DATA_DIR-path>` — record which pass. Prefer `"global"` if both pass (less per-install tracking, SEC-5).

Pacing: ≥2s between requests (zen notes: rapid-fire from one identity → blanket 403). Model: `deepseek-v4.1-flash-free`.

## Steps

1. Write `oc-gate-ladder.mjs`: loads capture, builds the rung compositions (scrub transforms as pure functions — these same transforms seed the P1 extraction script), runs the ladder, prints a markdown table (rung × run → status).
2. Run from the dev machine (same home IP that produced both 200s and 429s — a discriminating environment).
3. Write `reports/p0-ladder.md`: full table + chosen composition + project-header decision + any 429 bodies.
4. Decision: if rung 2 or 3 passes → proceed with minimal composition. If ONLY rung 1 passes → flag to user: shipping requires ≥ scrubbed-full size; acceptable (no personal content) but larger snapshot — proceed with rung-1 composition, note in report. If NOTHING passes → hard stop, replan (gate may have changed — re-run research).

## Verification gate

- `bun repro-261111/oc-gate-ladder.mjs` completes; `reports/p0-ladder.md` committed; plan.md risk R1/R2 status updated from "P0 pending" to resolved.
- No repo source files touched (scratch + report only) — no impact()/detect_changes needed yet.

## Risks

- Ladder itself burns a handful of free-tier completions — negligible, and paced.
- Home-IP quota state changes mid-ladder → false negatives: interleave rungs (round-robin), re-run failures once after 30s before recording fail.
