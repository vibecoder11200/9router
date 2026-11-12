# Phase 01 — Wire snapshot module + extraction script + detect-only sync + event types

Depends on: P0 (composition + project-header decisions are inputs).

## Objective

A self-contained wire-snapshot module holding the committed, scrubbed snapshot (P0-chosen composition), rendering fork request shapes from it, with a **detect-and-alert-only** sync job (no runtime apply — releases are the only update path). Alert event types are formalized HERE (kills the old three-phase constant dance).

## Files

- `open-sse/providers/opencodeWire.js` (new)
- `open-sse/providers/opencodeWire.snapshot.json` (new, generated+scrubbed, committed)
- `scripts/extract-opencode-wire.mjs` (new, dev/CI)
- `src/lib/alerts/eventTypes.js` (edit — two additive constants)
- `tests/unit/opencode-wire-snapshot.test.js` (new)
- `tests/fixtures/opencode-replay/` (new — sanitized fixture derived from `oc-capture/v2-2-7-live.jsonl`)

## Snapshot schema (committed)

```json
{
  "clientVersion": "2.2.7",
  "sourceSha": "fedc6f20...",
  "endpoint": "https://opencode.ai/inference/openai/v1/chat/completions",
  "systemTextTemplate": "<P0-chosen composition with {{PLACEHOLDER}} markers for cwd/platform/date>",
  "tools": [ /* 12 manifests: edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute */ ],
  "xOpencodeProject": "<P0 rung-5 decision: 'global' | 'per-install-sha1'>",
  "capturedAt": "2026-11-12T..."
}
```

## Steps

1. `scripts/extract-opencode-wire.mjs` (runs at dev/CI only):
   - `--from-capture <path>`: parse `oc-capture/v2-2-7-live.jsonl` → apply the SAME scrub transforms P0 validated (pure functions shared with the ladder script — copy them in; the ladder is scratch, the script is canonical) → emit snapshot JSON (stable key order, pretty).
   - Contamination check built-in and blocking: reject output containing personal markers (`AGENTS.md`, `Orchestration Protocol`, `## Rule:`, absolute personal paths). Exit non-zero on hit (R10).
   - `--from-repo <path>` (optional cross-check): read upstream `system.txt` from `D:\9router-mod\opencode-v2-src` pinned tag; assert harness prefix matches the capture's harness prefix; diff-report only.
   - Emits the sanitized replay fixture to `tests/fixtures/opencode-replay/` as a side output (session ids/env scrubbed).
2. Generate + commit the v2.2.7 snapshot (composition per P0 report).
3. `open-sse/providers/opencodeWire.js`:
   - `getEmbeddedWireSnapshot()` — static import of the committed JSON. **The embedded snapshot is the ONLY runtime source** (detect-only sync never writes it).
   - `renderSystemText(snapshot, env)` — fill `{{CWD}}`, `{{PLATFORM}}`, `{{DATE_UTC}}`; **hard-fail (throw) on ANY leftover `{{` after render** (unknown placeholder = extraction bug, never ship literal markers upstream — AD-F3).
   - `shapeV2FreeLaneRequestBody(body, snapshot)` — NEW body object: messages = [rendered harness system, ...conversation messages (caller system dropped)], tools = [...snapshot.tools, ...callerTools deduped by name], `stream: true`, `stream_options: {include_usage: true}`, `max_completion_tokens: body.max_completion_tokens || body.max_tokens || 32000`. Caller-tool renames stay in the existing `recordRenamedToolNames` flow (opencode.js:9) — merge only.
   - `mintV2IdentityHeaders(snapshot, sessionId)` — per capture: `authorization: Bearer public`, `user-agent: opencode/latest/<clientVersion>/cli`, `x-opencode-client: cli`, `x-opencode-project: <snapshot.xOpencodeProject>` (per-install sha1 resolved at call time if that's the P0 choice), 4 equal session headers, `content-type: application/json`, NO `accept`.
   - `mintV2SessionId()` — re-export the executor's `generateSessionId` (opencode.js:69); do not re-implement.
   - `startWireSnapshotSync()` — detect-only, idempotent, unref'd 24h tick (self-contained; NOT folded into opencodeCatalog — no coupling): fetch `https://opencode.ai/update/api/latest/cli/npm` (10s AbortController), validate `sha` matches `/^[0-9a-f]{40}$/` (SEC-2), compare `version` to `snapshot.clientVersion`; on mismatch → `emitAlert(OPENCODE_WIRE_DRIFT, { current, latest, note: "fork release required: run scripts/extract-opencode-wire.mjs" })`. Never fetches system.txt at runtime, never writes any file. Failures logged, never thrown.
   - `__test__` reset/inject hooks.
4. `src/lib/alerts/eventTypes.js` (+ tests updated in P7 consolidation; suite here covers the constants):
   - `OPENCODE_WIRE_DRIFT: "opencode-wire-drift"` (warn)
   - `OPENCODE_BUN_LANE_UNAVAILABLE: "opencode-bun-lane-unavailable"` (critical — consumed by P4)
5. Lazy sync start: first `getEmbeddedWireSnapshot()` call from the executor path starts the timer (P4 wires the call site).

## Verification gate

- `cd tests && npx vitest run unit/opencode-wire-snapshot.test.js`:
  - Render: no `{{` residue (incl. an adversarial case with an unknown placeholder → expect throw).
  - Structural invariants (NOT a pinned hash — deliberate snapshot bumps must not break tests): harness prefix match, length bounds, 12 tool names exact set, endpoint exact, contamination blocklist absent.
  - Shaping: caller-system dropped, tools merge/dedupe, include_usage, max_completion_tokens default.
  - Sync: mocked fetch — version mismatch → alert emitted, NO file writes anywhere; fetch failure → no alert storm (dedupe), no throw; 40-hex sha validation rejects crafted values.
  - eventTypes: both constants present with correct severity mapping.
- Contamination CI check: run `node scripts/extract-opencode-wire.mjs --from-capture oc-capture/v2-2-7-live.jsonl --check` → exits 0 against the committed snapshot.
- New files + one additive edit to eventTypes.js — `impact()` on eventTypes exports unnecessary (constant table); `detect_changes()` before commit.

## Risks

- Snapshot JSON size depends on P0 (rung-2 target: a few KB; rung-1 fallback: tens of KB scrubbed) — either acceptable, size recorded in the P0 report.
- `.snapshot.json` is generated-but-committed: `--check` mode keeps it honest; regeneration documented in the script header + ARCHITECTURE (P7).
