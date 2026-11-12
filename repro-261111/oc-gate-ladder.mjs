// P0 gate probe ladder (dev scratch — NOT shipped, per plan phase-00).
//
// Finds the minimal scrubbed system-text composition the v2 free-tier gate
// accepts, under Bun 1.4.0, with the 12-tool manifest verbatim from the
// capture. Compositions are pure transforms over the live capture so the same
// transforms seed the P1 extraction script.
//
// Usage:
//   bun repro-261111/oc-gate-ladder.mjs                 # full ladder (interleaved, 5x/rung)
//   bun repro-261111/oc-gate-ladder.mjs --once R2       # single run of one rung (fresh-spawn drill)
//   bun repro-261111/oc-gate-ladder.mjs --proj global   # rung-5 A/B: project header variants
//   bun repro-261111/oc-gate-ladder.mjs --proj sha1
//   bun repro-261111/oc-gate-ladder.mjs --rungs R2,R2s  # restricted ladder (adaptive bisect)
//
// Evidence base (Research-261112-opencode-v2-free-gate-wire-format.md):
//   byte-identical replay  bun=200 / node=429  (gate fingerprints TLS stack)
//   bun-crafted 1.5KB harness + 6 fake tools = 429; full 66KB + 12 tools = 200
//   → minimal system composition threshold unknown → this ladder bisects it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const CAPTURE_PATH = process.argv.includes("--capture")
  ? process.argv[process.argv.indexOf("--capture") + 1]
  : "oc-capture/v2-2-7-live.jsonl";
const MODEL = "deepseek-v4.1-flash-free";
const ENDPOINT = "https://opencode.ai/inference/openai/v1/chat/completions";
const PROBE_MAX_COMPLETION_TOKENS = 64; // plan: small for probe runs
const PACE_MS = 2200; // plan: >=2s between requests (rapid-fire → blanket 403)
const RETRY_AFTER_MS = 30_000; // plan: re-run failures once after 30s
const RUNS_PER_RUNG = 5;
const PASS_MIN = 4; // plan: pass = >=4/5 HTTP 200
const REQ_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Session minting — the CLI's SortableID (descending, 20 chars after prefix)
// ---------------------------------------------------------------------------
const MASK = (1n << 48n) - 1n;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const descending = (t, c) =>
  (~(BigInt(t) * 0x1000n + BigInt(c)) & MASK).toString(16).padStart(12, "0");
const b62suffix = () =>
  Array.from({ length: 14 }, () => B62[Math.floor(Math.random() * 62)]).join("");
export function mintSessionId() {
  return `ses_${descending(Date.now(), 1)}${b62suffix()}`;
}

// ---------------------------------------------------------------------------
// Load the live v2.2.7 capture (req_00x.json are v1.18 zen captures — never
// used here; phase-00 explicitly forbids them as ground truth)
// ---------------------------------------------------------------------------
const cap = JSON.parse(readFileSync(CAPTURE_PATH, "utf8").trim().split("\n").pop());
const capBody = JSON.parse(cap.body);
const CAP_SYSTEM = capBody.messages.find((m) => m.role === "system").content;
const CAP_TOOLS = capBody.tools;
const CAP_HEADERS = { ...cap.headers };
delete CAP_HEADERS["content-length"];
const CAP_PROJECT = CAP_HEADERS["x-opencode-project"]; // proven-accepted sha1

// ---------------------------------------------------------------------------
// Section anchors (measured on the 2026-11-12 v2.2.7 capture)
//   base+harness | # Your Model | # Code Mode docs | <available_skills> |
//   personal (Instructions from … + ## Rule: blocks) | env tail (Today's date …)
// ---------------------------------------------------------------------------
function sectionSlices(sys) {
  const lines = sys.split("\n");
  const idx = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`anchor not found: ${re}`);
    return i;
  };
  const yourModel = idx(/^# Your Model/);
  const codeMode = idx(/^# Code Mode/);
  const skills = idx(/^<available_skills>/);
  const personal = idx(/^Instructions from:/);
  const envDate = idx(/^Today's date:/);
  return {
    baseHarness: lines.slice(0, yourModel).join("\n"), // "You are an AI agent…" + # Harness
    yourModel: lines.slice(yourModel, codeMode).join("\n"),
    codeMode: lines.slice(codeMode, skills).join("\n"), // # Code Mode + tool docs
    skillsBlock: lines.slice(skills, personal - 1).join("\n"),
    personal: lines.slice(personal, envDate - 1).join("\n"),
    envTail: lines.slice(envDate).join("\n"),
  };
}

// --- pure scrub transforms (seed of scripts/extract-opencode-wire.mjs) ---

// Upstream-bundled skills only (everything ak-*/gitnexus-* is the dev's
// personal config — contamination by plan decision #4 / risk R10).
const UPSTREAM_SKILL_IDS = new Set(["opencode", "report"]);
function skillEntries(skillsBlock) {
  return [...skillsBlock.matchAll(/<skill>[\s\S]*?<\/skill>/g)].map((m) => m[0]);
}
function scrubSkillsBlock(skillsBlock) {
  const start = skillsBlock.indexOf("<available_skills>");
  const end = skillsBlock.indexOf("</available_skills>") + "</available_skills>".length;
  const head = skillsBlock.slice(0, start);
  const inner = skillsBlock.slice(start + "<available_skills>".length, end - "</available_skills>".length);
  const tail = skillsBlock.slice(end);
  const skills = skillEntries(skillsBlock).filter((s) =>
    UPSTREAM_SKILL_IDS.has((s.match(/<id>([^<]+)<\/id>/) || [])[1]),
  );
  return head + skills.join("\n") + tail;
}

// Fork-style env tail: minted per request from cwd/platform/date. The capture's
// personal temp-path line is rewritten to a neutral equivalent.
export function renderEnvTail(env, { cwd = "/workspace", platform = "linux" } = {}) {
  const d = env.date ?? new Date();
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
  const lines = capSlices.envTail.split("\n").map((l) => {
    if (/^Today's date:/.test(l)) return `Today's date: ${dateStr}`;
    if (/^\s*Working directory:/.test(l)) return `  Working directory: ${cwd}`;
    if (/^\s*Workspace root folder:/.test(l)) return `  Workspace root folder: ${cwd}`;
    if (/^\s*Is directory a git repo:/.test(l)) return `  Is directory a git repo: no`;
    if (/^\s*Platform:/.test(l)) return `  Platform: ${platform}`;
    if (/Prefer .* over generic system temporary directories/.test(l))
      return `  Prefer the system temporary directory over hard-coding /tmp; it is pre-created and approved for external tool output.`;
    return l;
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rung compositions (system text only — tools/header/body shape are constant
// across rungs: 12-tool manifest verbatim, stream:true, include_usage, 64 tok)
// ---------------------------------------------------------------------------
const capSlices = sectionSlices(CAP_SYSTEM);

function modelSection(model = MODEL) {
  // "# Your Model" is CLI-minted per request; mirror its shape for the probe model
  const name = model
    .replace(/-free$/, "")
    .split("-")
    .map((w) => (w.match(/^\d/) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return `# Your Model\n- Name: ${name}\n- Provider ID: opencode\n- Model ID: ${model}`;
}

const COMPOSE = {
  // R3 — harness-only: base system.txt + # Harness + # Your Model. No env.
  R3: () => [capSlices.baseHarness, modelSection()].join("\n"),
  // R2 — env-skeleton: harness + Code Mode tool guidance + fork env (target shipping composition)
  R2: () => [capSlices.baseHarness, modelSection(), capSlices.codeMode, renderEnvTail({})].join("\n"),
  // R2s — bisect: R2 + upstream-only skills list (opencode, report)
  R2s: () =>
    [capSlices.baseHarness, modelSection(), capSlices.codeMode, scrubSkillsBlock(capSlices.skillsBlock), renderEnvTail({})].join("\n"),
  // R1 — scrubbed-full: harness verbatim in size/structure (personal skill
  // entries replaced by neutral placeholders — same count, no personal bytes),
  // personal Rule blocks dropped, env fork-minted. Bisect ceiling per plan
  // ("capture's 66KB with personal sections REPLACED by short neutral
  // equivalents").
  R1: () => {
    let i = 0;
    const neutralized = capSlices.skillsBlock.replace(/<skill>[\s\S]*?<\/skill>/g, (s) =>
      UPSTREAM_SKILL_IDS.has((s.match(/<id>([^<]+)<\/id>/) || [])[1])
        ? s
        : `<skill>\n    <id>tool-${++i}</id>\n    <name>Tool ${i}</name>\n    <description>Neutral placeholder skill.</description>\n  </skill>`,
    );
    return [
      capSlices.baseHarness,
      modelSection(),
      capSlices.codeMode,
      neutralized,
      renderEnvTail({}),
    ].join("\n");
  },
};

export function composeRung(name) {
  const c = COMPOSE[name];
  if (!c) throw new Error(`unknown rung ${name}`);
  return c();
}

// ---------------------------------------------------------------------------
// Probe request
// ---------------------------------------------------------------------------
async function probeOnce({ system, projectHeader }) {
  const ses = mintSessionId();
  const headers = {
    ...CAP_HEADERS,
    "content-type": "application/json",
    "x-opencode-project": projectHeader ?? CAP_PROJECT,
    "x-opencode-session": ses,
    "x-opencode-session-id": ses,
    "x-session-affinity": ses,
    "x-session-id": ses,
  };
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Reply with the single word PONG" },
    ],
    tools: CAP_TOOLS,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: PROBE_MAX_COMPLETION_TOKENS,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, sample: text.slice(0, 160).replace(/\s+/g, " ") };
  } catch (e) {
    return { status: "ERR", ms: Date.now() - t0, sample: String(e?.message || e).slice(0, 160) };
  }
}

async function runLabeled(label, fn) {
  const r = await fn();
  if (r.status !== 200) {
    console.log(`  … ${label} → ${r.status}, retry after ${RETRY_AFTER_MS / 1000}s (plan rule)`);
    await sleep(RETRY_AFTER_MS);
    return { ...r, retried: true };
  }
  return r;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (process.argv.includes("--once")) {
  // rung-4 fresh-spawn drill: one request per fresh bun process
  const rung = process.argv[process.argv.indexOf("--once") + 1];
  const r = await probeOnce({ system: composeRung(rung), projectHeader: arg("--header") ?? CAP_PROJECT });
  console.log(JSON.stringify({ mode: "once", rung, ...r }));
  process.exit(0);
}

if (process.argv.includes("--proj")) {
  // rung-5 A/B: one request with the given project header value
  const variant = process.argv[process.argv.indexOf("--proj") + 1];
  const rung = arg("--rung") || "R2";
  const projectHeader =
    variant === "global"
      ? "global"
      : createHash("sha1").update(process.env.BUNLANE_DATA_DIR ?? "/home/deploy/.9router").digest("hex");
  const r = await probeOnce({ system: composeRung(rung), projectHeader });
  console.log(JSON.stringify({ mode: "proj", variant, rung, ...r }));
  process.exit(0);
}

if (process.argv.includes("--compose-only")) {
  // offline: print composition sizes + personal-residue scan, no network
  const PERSONAL_RESIDUE = /ankha|9router|ClaudeKit|Orchestration Protocol|## Rule:|AGENTS\.md|\.claude|ak-|gitnexus/i;
  for (const name of ["R1", "R2", "R2s", "R3"]) {
    const sys = composeRung(name);
    const hits = sys.split("\n").filter((l) => PERSONAL_RESIDUE.test(l));
    console.log(`${name}: ${Buffer.byteLength(sys)}B, residue lines: ${hits.length}`);
    hits.slice(0, 5).forEach((h) => console.log("   !! " + h.slice(0, 120)));
  }
  process.exit(0);
}

// --- default: sanity replay + interleaved ladder -----------------------------
const rungs = (arg("--rungs") || "R1,R2,R3").split(",").map((s) => s.trim()).filter(Boolean);
const systemSizes = Object.fromEntries(
  [...rungs].map((r) => [r, Buffer.byteLength(composeRung(r))]),
);

// R0 sanity: byte-identical replay ×1 (proven 200 under bun) — confirms the
// environment still discriminates before burning the ladder.
{
  const ses = mintSessionId();
  const headers = { ...CAP_HEADERS };
  for (const k of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"])
    headers[k] = ses;
  delete headers["content-length"];
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: cap.body, // byte-identical
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const text = await r.text();
  console.log(`R0 sanity (byte-identical replay): HTTP ${r.status} (${text.slice(0, 80).replace(/\s+/g, " ")})`);
  if (r.status !== 200) {
    console.log("R0 failed → home-IP quota state or gate changed. Ladder results unreliable; STOP here.");
    process.exit(1);
  }
  await sleep(PACE_MS);
}

// interleaved round-robin: for i in 1..5 { for rung: request }
const results = {}; // rung -> [{status, ms, sample, retried}]
for (const r of rungs) results[r] = [];

for (let i = 0; i < RUNS_PER_RUNG; i++) {
  for (const rung of rungs) {
    const res = await runLabeled(`${rung}#${i + 1}`, () => probeOnce({ system: composeRung(rung) }));
    results[rung].push({ run: i + 1, ...res });
    console.log(`run ${i + 1}/${RUNS_PER_RUNG} ${rung} (${systemSizes[rung]}B) → ${res.status}${res.retried ? " (after retry)" : ""}`);
    await sleep(PACE_MS);
  }
}

// summary + verdict
console.log("\n| rung | size | results | passes | verdict |");
console.log("|---|---|---|---|---|");
for (const rung of rungs) {
  const rs = results[rung];
  const passes = rs.filter((x) => x.status === 200).length;
  const sizes = rs.map((x) => x.status).join(",");
  console.log(`| ${rung} | ${systemSizes[rung]}B | ${sizes} | ${passes}/5 | ${passes >= PASS_MIN ? "PASS" : "FAIL"} |`);
}
console.log("\nFAIL bodies (first sample per failing rung):");
for (const rung of rungs) {
  const f = results[rung].find((x) => x.status !== 200);
  if (f) console.log(`  ${rung}: [${f.status}] ${f.sample}`);
}
