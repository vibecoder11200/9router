# Phase 06 — Probe infra classifier + status GET route + docs honesty

Depends on: P4, P5 (sequential after P5 — both touch `src/lib/xray/manager.js`).

## Objective

(a) Teach the model-filter probe when "both lanes down" is an infra failure (must not pollute the filter cache); (b) a read-only status GET route (the rich dashboard card is a named follow-up, out of this plan); (c) honest docs for the known-refused models and the lane's operational contract.

## Files

- `src/lib/xray/manager.js` (edit — infra-error regex, :986 area)
- `src/app/api/opencode-free-lane/route.js` (new — GET only in this plan)
- `docs/ARCHITECTURE.md` (edit — free-lane transport section)
- `tests/unit/xray-free-chat-probe-bun-lane.test.js` (new)
- `tests/unit/opencode-free-lane-status-route.test.js` (new)

## Steps

1. House rules: `impact({target: "testSingleConfigWithModel", direction: "upstream"})` (callers: filter runner + model-filter route :35); `detect_changes()` before commit.
2. Infra classifier (`testSingleConfigWithModel`, :986): extend the regex to include `OPENCODE_FREE_LANE_UNAVAILABLE` (the typed error code from P4) — when the free lane is down, every node fails identically and says nothing about the node: `infraError: true` → runner aborts, prune refuses, cache stays clean. The probe path itself needs NO other change: it already rides `handleChatCore` (:949) with `strictProxy` + temp socks (:942), and P4/P5 make the executor resolve the temp pair automatically (probe proxy URL stays socks — the resolver, not the caller, owns mapping).
3. Status route (GET only):
   - `GET /api/opencode-free-lane` → `{ engine, bun: {installed, version}, lane: getBunLaneStatus(), snapshot: {clientVersion, sourceSha, capturedAt}, lastUnavailableAlertAt }` — all read-only pulls from P1/P2/P3 exports + settings. `lane.modelsKnownRefused: ["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free", "union-alpha"]` — R8 made observable.
   - No POST actions in this plan (install button/engine toggle UI = follow-up; settings editable via existing settings API).
4. Docs:
   - `docs/ARCHITECTURE.md`: free-lane transport section — Bun lane primary / `"legacy"` kill-switch / fail-fast semantics (no silent fallback), snapshot lifecycle (embedded-only + detect-only sync + release-time regeneration via `scripts/extract-opencode-wire.mjs`), stdio child model (abort = kill = quota-safe), socks→http derive+verify resolver, and the R8 known-refused models list with the reason (v2 gate, responses/messages shaping out of scope).
   - Operational note: the detect-only sync pings `opencode.ai/update/api/latest/cli/npm` from the server (install IP visible to upstream) — documented so operators decide consciously (SEC-5 residue).

## Verification gate

- `cd tests && npx vitest run unit/xray-free-chat-probe-bun-lane.test.js unit/opencode-free-lane-status-route.test.js`
  - Classifier: probe error carrying `OPENCODE_FREE_LANE_UNAVAILABLE` → result `infraError: true`; ordinary per-node HTTP failure (e.g. 429 via the lane) → normal result (NOT infra).
  - Probe end-to-end (mocked executor lane): freeChatProbe=true + chat-format model + temp socks proxy → lane received the temp pair's http URL; freeChatProbe=false → skip path unchanged.
  - Route: GET shape; auth required like sibling read routes; no mutating verbs implemented.
- `detect_changes()` before commit.

## Risks

- manager.js second edit in the plan (after P5) — sequential ordering + detect_changes keeps diffs attributable.
- Status route accidentally becomes a de-facto dashboard API surface — scope held at GET-only; UI follow-up gets its own design pass.
