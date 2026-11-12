---
title: "OpenCode Free lane via Bun stdio sidecar (v2 gate CLI-identical traffic)"
description: "Route the OpenCode Free (noAuth) lane through per-request Bun stdio children that replicate CLI-identical TLS + harness + tool-manifest traffic to the v2 free-tier gate, with Bun download-on-demand and fail-fast lane semantics."
status: pending
priority: P1
effort: 24h
branch: master
tags: [xray, opencode, proxy, runtime]
created: 2026-11-12
---

# OpenCode Bun Free Lane

## Overview

The v2 OpenCode free-tier gate fingerprints the TLS/HTTP stack: a byte-identical replay of the CLI's request returns **200 under Bun 1.4.0 (BoringSSL)** and **429 `FreeUsageLimitError` under Node v24** (research report, A/B reproduced). The current fork free lane (`opencodeTlsFetch` via wreq-js Chrome TLS) is refused by the v2 gate. This plan adds a **Bun lane**: per-request `bun` stdio children (genspark-sidecar shape) perform the upstream fetch with Bun's TLS stack, driven by a **wire snapshot** (harness system text + 12-tool manifest + identity headers, v2.2.7 ground truth) so fork traffic is CLI-identical.

Scope: (a) chat path free lane, (b) xray model-filter `freeChatProbe` rides the same lane, (c) Test Model button works unchanged (already POSTs the internal `/api/v1/chat/completions` → normal pipeline). Non-goals: keyed/paid opencode lane, opencode-zen, stableSessionId/rotation semantics, responses/messages-format free models (known-refused, documented — R8), no MITM tooling.

## Settled decisions (brainstorm + red-team, do not reopen)

1. **Architecture: stdio-per-request + lane semaphore ≤3 concurrent children** (user choice). Kills by construction: SSRF/port attack surface, orphan persistence, abort-propagation machinery, boot-path shutdown edits.
2. **Lane semantics: fail-fast + one bounded retry of the bun child** (user choice). The legacy wreq-js lane is gate-refused by this plan's own evidence — serving a v2-gated request on it is not a fallback, it is a guaranteed 429 wearing a degradation alert. Legacy stays reachable ONLY via explicit `opencodeFreeLaneEngine: "legacy"` setting.
3. **Wire sync: detect-and-alert only** (user choice). Applying a snapshot version happens exclusively through a fork release (extraction at dev/CI, committed snapshot). No runtime write channel from upstream — closes the prompt-injection supply chain (SEC-2).
4. **Snapshot composition is minimal-and-scrubbed, never the raw 66KB capture**: the live capture contains ~60KB of the developer's personal AGENTS.md/skills/agents — shipping it verbatim would (a) leak private config into every install and opencode.ai, (b) give every fork install a byte-identical cross-user fingerprint the gate can cluster. Phase 0 finds the minimal gate-accepted composition by live probe BEFORE the snapshot design is committed.

## Architecture

```mermaid
sequenceDiagram
    participant C as Client (chat / filter probe / Test Model)
    participant API as /api/v1/chat/completions
    participant CC as chatCore (open-sse/handlers/chatCore.js)
    participant EX as executor.execute freeLaneFetch (open-sse/executors/opencode.js:493)
    participant W as opencodeWire snapshot (open-sse/providers/opencodeWire.js)
    participant BL as opencodeBunLane (open-sse/services/opencodeBunLane.js)
    participant SEM as lane semaphore (≤3)
    participant B as bun stdio child (per request)
    participant PM as resolveXrayHttpProxyUrl (src/lib/xray/httpProxyResolver.js)
    participant XR as xray http inbound 127.0.0.1:<httpPort>
    participant OC as opencode.ai /inference/openai/v1/chat/completions

    C->>API: POST chat (free model)
    API->>CC: handleChatCore (proxy = socks5://127.0.0.1:<socksPort>)
    CC->>EX: execute({directFetch: freeLaneFetch})
    EX->>W: shapeV2FreeLaneRequestBody + mintV2IdentityHeaders
    EX->>BL: opencodeFreeLaneFetch(endpoint, init, {signal, timeoutMs, proxyUrl})
    BL->>PM: socks5://127.0.0.1:P → http://127.0.0.1:P+1? (TCP-verify, else null)
    BL->>SEM: acquire slot (≤3; queue with timeout)
    SEM->>B: spawn bun sidecar-stdio.mjs, JSON→stdin
    B->>XR: Bun fetch (BoringSSL) via HTTP proxy CONNECT
    XR->>OC: POST (rendered system + 12+caller tools, v2 identity)
    OC-->>B: SSE stream → stdout passthrough
    B-->>BL: line1 {status,headers} + body stream; child exits at end
    BL-->>EX: native Response (stream preserved)
    Note over EX: Abort/cancel → kill child → upstream fetch dies (quota safe)
    Note over BL: bun unavailable → 1 bounded retry → typed error (fail-fast)
```

## Phase index

Execution order: **P0 → (P1 ∥ P2 ∥ P5) → P3 → P4 → P6 → P7**. P0 is a hard gate — its probe results pin the snapshot composition and the `x-opencode-project` value before any module is written.

| Phase | Title | Depends on | Key files | Effort |
|---|---|---|---|---|
| [phase-00](phase-00-gate-probe-ladder.md) | Gate probe ladder: minimal snapshot composition + project header + stdio-TLS re-proof | — | `repro-261111/oc-gate-ladder.mjs` (dev scratch) | 2h |
| [phase-01](phase-01-wire-snapshot.md) | Wire snapshot module + extraction script + detect-only sync + event types | P0 | `open-sse/providers/opencodeWire.js`, `.snapshot.json`, `scripts/extract-opencode-wire.mjs`, `src/lib/alerts/eventTypes.js` | 4h |
| [phase-02](phase-02-bun-installer.md) | Shared asset-installer helpers + Bun binary installer | — | `src/lib/runtime/assetInstaller.js`, `src/lib/runtime/bunInstaller.js`, `src/lib/xray/installer.js` (refactor) | 3h |
| [phase-03](phase-03-bun-lane-stdio.md) | Bun stdio lane: child protocol + manager + semaphore + abort | P2 | `open-sse/services/opencodeBunSidecar.mjs`, `open-sse/services/opencodeBunLane.js` | 4h |
| [phase-04](phase-04-executor-integration.md) | Executor integration: v2 shaping + fail-fast semantics + settings | P1, P3, P5 | `open-sse/executors/opencode.js`, `src/lib/db/repos/settingsRepo.js` | 4h |
| [phase-05](phase-05-http-proxy-resolver.md) | socks→http resolver (derive + TCP-verify) + stopXrayService status fix | — | `src/lib/xray/httpProxyResolver.js`, `src/lib/xray/manager.js` (small) | 2h |
| [phase-06](phase-06-status-route-docs.md) | Probe infra classifier + status GET route + docs honesty | P4 | `src/lib/xray/manager.js` (probe regex), `src/app/api/opencode-free-lane/route.js`, docs | 2h |
| [phase-07](phase-07-tests-replay-changelog-vps.md) | Full suite, replay harness, CHANGELOG, hygiene, VPS live acceptance | P1–P6 | `tests/`, `scripts/replay-opencode-free-lane.mjs`, `CHANGELOG.md`, `docs/ARCHITECTURE.md` | 3h |

File ownership: parallel phases (P1/P2/P5) touch disjoint files. `src/lib/xray/manager.js` is edited in P5 and P6 — sequential. `open-sse/executors/opencode.js` only in P4. **Rich dashboard card is a named follow-up (not in this plan)** — P6 ships a status GET route only.

## Load-bearing assumptions

1. **Gate = TLS/HTTP fingerprint + wire fidelity** — proven byte-identical A/B (Bun 200 / Node 429).
2. **Gate accepts a freshly-spawned process per request** (new TCP+TLS connection each time) — **PROVEN by P0 rung 4 (3/3 × 200, reports/p0-ladder.md)**; architecture A committed.
3. **Minimal scrubbed snapshot passes the gate** — **PROVEN by P0: composition R2 (7.7KB env-skeleton: harness + Code Mode tool guidance + fork env) passes 5/5; harness-only (R3, 1.6KB) is gate-refused; `x-opencode-project: "global"` accepted 5/5 (reports/p0-ladder.md)**. No hard stop needed (R1 not triggered).
4. **v2 endpoint** `POST https://opencode.ai/inference/openai/v1/chat/completions` (capture ground truth).
5. **Bun fetch proxy = HTTP CONNECT only** (no SOCKS — verified 1.4.0 `UnsupportedProxyProtocol`). Every fork xray config binds http inbound at socks+1 (`buildInbounds`, configBuilder.js:20-38; all three spawn sites).
6. **open-sse may import `@/lib/*`** (precedent chatCore.js:15).
7. **Test Model needs no change** (ping.js POSTs internal endpoint — scout §5).

## Risk table

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| R1 | Only the full personal 66KB system text passes the gate (P0 rung 3 fails) | M×H | **Hard stop**: do NOT ship private config. Replan with upstream-repo-derived harness + longer upstream-deterministic env sections; possibly give up lane (acceptable loss — keyed lane unaffected) |
| R2 | Gate rejects per-request fresh TLS connections (P0 rung 4 fails) | L×H | Switch to branch B (persistent HTTP sidecar + full mitigations: token auth, pidfile reaper, PDEATHSIG, abort wiring) — design recorded in phase-00 |
| R3 | Bun zip ~90MB download fails on VPS | M×M | Shared installer helpers (staging + sha256 + rollback); status route surfaces install state; lane errors are typed and visible |
| R4 | Upstream drift breaks lane post-release | M×H | Detect-only sync + `OPENCODE_WIRE_DRIFT` alert → fork release regenerates snapshot (extract script); embedded snapshot is the only runtime source (no half-updates, no injection channel) |
| R5 | socks→http resolver points at dead/wrong port | M×M | Derive socks+1 THEN TCP-verify at resolve time (ground truth, self-healing across HMR/restart/blue-green); loopback-only; 30s negative cache; verify-fail → typed "unmapped proxy" state (visible, not silent) |
| R6 | RAM blowup: concurrency × bun children | M×H | Lane semaphore ≤3 concurrent children (filter is patient; queue with timeout); VPS checklist measures RSS |
| R7 | Executor `execute` regression (chat hot path) | L×H | `impact()` before edit; bun lane strictly additive inside `freeLaneFetch`; engine setting `"legacy"` restores today's exact path; full opencode suites must stay green |
| R8 | 3 responses/messages free models (muse-spark-1.2/1.3-contributor-free, union-alpha; registry opencode.js:43-45) remain gate-refused | H×L | Documented as known-refused in CHANGELOG + ARCHITECTURE + status route `lane` field; separate plan if ever requested |
| R9 | Windows: reinstall over running bun.exe (EPERM) / AV first-scan stall | M×M | No persistent child by design (risk mostly moot); EPERM delete-retry dance in shared helpers; post-install `bun --version` pre-warm |
| R10 | Snapshot committed with personal content residue | L×H | Extraction script includes a contamination check (blocklist markers: `AGENTS.md`, personal paths) wired into CI-side test; P0 fixture is scrubbed by hand first |

## Acceptance criteria

1. **P0 gate green**: ladder report committed (`plans/.../reports/p0-ladder.md`) showing the chosen minimal composition × N runs → 200, fresh-spawn ×3 → 200, project-header choice recorded.
2. **Live chat 200 (VPS)**: free-lane chat-completions model returns 200 SSE through the bun lane (exit via xray http inbound or direct per pool binding).
3. **Fail-fast**: sidecar/bun unavailable → ONE bounded retry → typed `OpenCodeFreeLaneUnavailable` error surfaced to the client; exactly one `OPENCODE_BUN_LANE_UNAVAILABLE` critical alert (deduped 1/h). After recovery, next request = 200.
4. **Filter probe**: `freeChatProbe` run routes through the lane; per-node verdicts reflect reality.
5. **Test Model** on a free model → success, zero changes to `models/test/ping.js`.
6. **Hygiene**: capture plugin deleted (done pre-plan), `oc-capture/` gitignored after fixture derivation, no personal content in committed snapshot (CI-side contamination test green).
7. **House rules**: every phase commit preceded by `impact()` (where existing symbols are touched) and `detect_changes()`; full vitest suite green; CHANGELOG entry present.

## Red Team Review

4-persona adversarial review completed (Assumptions / Failure-Modes / Security / Scope-Critic); full reports in `plans/reports/` (red-team session output, findings summarized below). Dispositions:

- **ACCEPTED (design-changing)**: dead-fallback lane → fail-fast semantics (AD-F1/FM-3); wrong capture artifact + personal-content contamination → minimal-scrubbed snapshot + P0 ladder (AD-F2); half-applied sync → detect-only (AD-F3/FM-4/SEC-2); abort propagation → stdio kill-child semantics (AD-F4/FM-2); port-registry holes → derive+TCP-verify resolver (AD-F5, adopting SC-F4's simpler resolver); orphan/duplicate children → stdio-per-request (FM-1); SSRF port → stdio, no port at all (SEC-1); DATA_DIR script exec → spawn from app dir (SEC-3); capture-plugin residue → immediate cleanup + hygiene box (SEC-4); installer copy-paste → shared assetInstaller helpers (SC-F2); 3-phase event-type dance → eventTypes in P1 (SC-F3 partial); R8 honesty → docs + status field (SC-F5); phase re-cut with hard P0 gate.
- **REJECTED/DEFERRED**: rich dashboard card (P6 keeps a GET status route only); replay Modes B/C reduced to notes; sync-ticker fold into opencodeCatalog — kept a self-contained detect job in P1 (KISS, no coupling to catalog's cache semantics).

## Unresolved questions (implementation-time, non-blocking)

- ~~Exact minimal system composition~~ — **resolved by P0: R2 env-skeleton (7.7KB), see reports/p0-ladder.md**.
- Semaphore queue timeout default (start 30s; tune on VPS checklist).

## Validation Log

### Verification Results (post red-team fixes)
- Claims checked: 22 (file:line anchors across phases vs repo) | Verified: 21 | Failed: 1 (fixed: planner referenced `oc-capture/req_001.json` — a v1.18 zen/responses capture — as v2.2.7 ground truth; corrected to the live capture now at `oc-capture/v2-2-7-live.jsonl` — AD-F2)
- Interview: user confirmed architecture A (stdio + semaphore), fail-fast, detect-only sync, apply-all red-team fixes (2 rounds, 2026-11-12).
