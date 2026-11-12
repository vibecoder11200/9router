# P0 — Gate probe ladder report

- **Date**: 2026-11-12
- **Environment**: dev machine (home IP — the discriminating environment that produced both the 200s and 429s), Bun 1.4.0, Node v24.18.0
- **Script**: `repro-261111/oc-gate-ladder.mjs` (dev scratch, not shipped)
- **Capture**: `oc-capture/v2-2-7-live.jsonl` (v2.2.7 CLI ground truth; `req_001/002.json` are v1.18 zen captures — never used, per phase-00)
- **Model**: `deepseek-v4.1-flash-free`, `max_completion_tokens: 64`, 12-tool manifest verbatim from capture, `stream:true` + `stream_options.include_usage`, ≥2.2s pacing, fresh CLI-minted session id per request, failed runs retried once after 30s (plan rule).

## Rung results (5× interleaved round-robin per rung; pass = ≥4/5 HTTP 200)

| rung | composition | size | results | passes | verdict |
|---|---|---|---|---|---|
| R0 | sanity: byte-identical capture replay | 89.3KB | 200 | 1/1 | env discriminates, ladder valid |
| R3 | harness-only (base + `# Harness` + `# Your Model`) | 1,573B | 429,429,429,429,429 | 0/5 | **FAIL** — `FreeUsageLimitError` |
| R2 | **env-skeleton** (harness + `# Code Mode` tool guidance + fork-minted env) | 7,740B | 200,200,200,200,200 | 5/5 | **PASS** |
| R2s | R2 + upstream-only skills list (`opencode`, `report`) | 8,557B | 200,200,200,200,200 | 5/5 | PASS |
| R1 | scrubbed-full (personal skill entries → neutral placeholders, Rule blocks dropped) | 28,577B | 200,200,200,200,200 | 5/5 | PASS |

R3 failure body (all five): `{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to Open…"}}`

## Rung 4 — fresh-spawn ×3 (architecture A viability)

Best passing rung (R2), each invocation a NEW `bun` process (brand-new TCP+TLS connection per request):

| run | status | ms |
|---|---|---|
| 1 | 200 | 2,835 |
| 2 | 200 | 17,765 (model-side slow first token; still streamed) |
| 3 | 200 | 2,669 |

**3/3 × 200 → per-request fresh bun children are accepted by the gate. Architecture A (stdio-per-request) confirmed.**

## Rung 5 — `x-opencode-project` A/B (R2 composition, 5× each)

| variant | value | results | verdict |
|---|---|---|---|
| global | `"global"` | 200 ×5 | **PASS** |
| sha1 | `sha1("/home/deploy/.9router")` (fork-minted per-install value) | 200 ×5 | PASS |

Both accepted. **Decision: ship `x-opencode-project: "global"`** — less per-install tracking (plan SEC-5 preference).

## Decisions pinned for downstream phases

1. **Shipping composition = R2 (7.7KB)**: base system prompt + `# Harness` + `# Your Model` (per-model section, fork-minted) + `# Code Mode` tool guidance (verbatim upstream, ~6KB — the load-bearing chunk) + fork-minted env tail (`Today's date` / `<env>` block with cwd/platform placeholders). NO skills list, NO personal sections. Rung 3 (harness-only) is **gate-refused** — the harness prefix alone is insufficient.
2. **`x-opencode-project: "global"`** (rung 5).
3. **Fresh-spawn per request**: proven 3/3 — the lane may spawn a bun child per request (architecture A stands; branch B not needed).
4. **Scrub transforms validated live**: skills scrub, personal-drop, env re-mint (pure functions in `oc-gate-ladder.mjs`, seeds of `scripts/extract-opencode-wire.mjs`).
5. Personal-residue scan across all compositions: **0 hits** (`ankha|9router|ClaudeKit|Orchestration Protocol|## Rule:|AGENTS.md|.claude|ak-|gitnexus`).

## Hard-stop check (plan R1)

Not triggered — the minimal scrubbed composition passes; no personal content is required by the gate.

## Cost

~35 free-tier completions spent (paced, single-PONG probes). Negligible.
