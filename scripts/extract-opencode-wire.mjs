#!/usr/bin/env node
/**
 * OpenCode v2 free-lane wire snapshot extractor (dev/CI only — never runs on
 * the server; the committed snapshot is the ONLY runtime source, releases are
 * the only update path).
 *
 * Parses a live v2 CLI capture (`oc-capture/v2-2-7-live.jsonl`, the only
 * accepted ground truth — req_001/002.json are v1.18 zen captures), applies
 * the scrub transforms P0 validated live (see
 * plans/261112-2130-opencode-bun-free-lane/reports/p0-ladder.md), and emits:
 *   - open-sse/providers/opencodeWire.snapshot.json  (committed)
 *   - tests/fixtures/opencode-replay/fixture.json    (sanitized, no sessions)
 *
 * Contamination check is BLOCKING: any personal marker in the output fails
 * with a non-zero exit (plan risk R10).
 *
 * Usage:
 *   node scripts/extract-opencode-wire.mjs --from-capture oc-capture/v2-2-7-live.jsonl
 *   node scripts/extract-opencode-wire.mjs --check                # regenerate in-memory, byte-compare to committed
 *   node scripts/extract-opencode-wire.mjs --from-repo D:/9router-mod/opencode-v2-src   # upstream diff-report only
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_CAPTURE = "oc-capture/v2-2-7-live.jsonl";
const SNAPSHOT_PATH = "open-sse/providers/opencodeWire.snapshot.json";
const FIXTURE_PATH = "tests/fixtures/opencode-replay/fixture.json";

// Personal-content blocklist (plan R10). Any hit anywhere in the emitted
// snapshot/fixture fails the run — the gate must never see, and no install
// must ever ship, the developer's private config.
const CONTAMINATION_RE =
  /ankha|9router-mod|ClaudeKit|Orchestration Protocol|## Rule:|AGENTS\.md|\.claude|ak-|gitnexus/i;

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (name) => process.argv.includes(name);

// ---------------------------------------------------------------------------
// Section anchors (measured on the 2026-11-12 v2.2.7 capture)
// ---------------------------------------------------------------------------
function sectionSlices(sys) {
  const lines = sys.split("\n");
  const idx = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`anchor not found in capture system text: ${re}`);
    return i;
  };
  const yourModel = idx(/^# Your Model/);
  const codeMode = idx(/^# Code Mode/);
  const skills = idx(/^<available_skills>/);
  const personal = idx(/^Instructions from:/);
  const envDate = idx(/^Today's date:/);
  return {
    baseHarness: lines.slice(0, yourModel).join("\n"),
    yourModel: lines.slice(yourModel, codeMode).join("\n"),
    codeMode: lines.slice(codeMode, skills).join("\n"),
    envTail: lines.slice(envDate).join("\n"),
  };
}

// Personal temp-path line → neutral equivalent (proven passing in P0 R2).
function scrubEnvTail(envTail) {
  return envTail
    .split("\n")
    .map((l) => {
      if (/^Today's date:/.test(l)) return "Today's date: {{DATE_UTC}}";
      if (/^\s*Working directory:/.test(l)) return "  Working directory: {{CWD}}";
      if (/^\s*Workspace root folder:/.test(l)) return "  Workspace root folder: {{CWD}}";
      if (/^\s*Is directory a git repo:/.test(l)) return "  Is directory a git repo: no";
      if (/^\s*Platform:/.test(l)) return "  Platform: {{PLATFORM}}";
      if (/Prefer .* over generic system temporary directories/.test(l))
        return "  Prefer the system temporary directory over hard-coding /tmp; it is pre-created and approved for external tool output.";
      return l;
    })
    .join("\n");
}

// "# Your Model" is CLI-minted per request → placeholder pair.
function scrubYourModel(yourModel) {
  return yourModel
    .split("\n")
    .map((l) => {
      if (/^- Name:/.test(l)) return "- Name: {{MODEL_NAME}}";
      if (/^- Model ID:/.test(l)) return "- Model ID: {{MODEL_ID}}";
      return l;
    })
    .join("\n");
}

// P0-proven composition R2: harness + Code Mode tool guidance + fork env.
// NO skills list, NO personal sections — the gate refuses the bare harness
// (R3) but accepts this (5/5), and the skills list in a dev capture is
// personal residue.
function buildSystemTextTemplate(sys) {
  const s = sectionSlices(sys);
  return [
    s.baseHarness,
    scrubYourModel(s.yourModel),
    s.codeMode,
    scrubEnvTail(s.envTail),
  ].join("\n");
}

function checkContamination(label, text) {
  const hit = text.match(CONTAMINATION_RE);
  if (hit) {
    console.error(`CONTAMINATION in ${label}: matched /${hit[0]}/ — refusing to emit (plan R10).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
const capturePath = argValue("--from-capture") || DEFAULT_CAPTURE;
const repoPath = argValue("--from-repo");
const checkOnly = hasFlag("--check");
const skipFixture = hasFlag("--no-fixture");

const captureRaw = fs.readFileSync(capturePath, "utf8");
const sourceSha = createHash("sha256").update(captureRaw).digest("hex");
const cap = JSON.parse(captureRaw.trim().split("\n").pop());
if (cap.kind !== "primary" || !cap.body || !cap.headers) {
  console.error(`unexpected capture shape in ${capturePath} — need a kind=primary request line`);
  process.exit(1);
}
const capBody = JSON.parse(cap.body);
const sys = capBody.messages.find((m) => m.role === "system")?.content;
if (!sys) {
  console.error("capture has no system message — wrong capture? (v1.18 zen captures carry no harness)");
  process.exit(1);
}

const snapshot = {
  clientVersion: String(cap.headers["user-agent"] || "").match(/opencode\/latest\/([^/]+)\//)?.[1] || "2.2.7",
  sourceSha,
  endpoint: cap.url,
  systemTextTemplate: buildSystemTextTemplate(sys),
  tools: capBody.tools,
  // P0 rung 5: both "global" and a minted sha1 pass 5/5 — ship "global"
  // (less per-install tracking).
  xOpencodeProject: "global",
  capturedAt: cap.t,
};

const snapshotJson = JSON.stringify(snapshot, null, 2) + "\n";
checkContamination("snapshot", snapshotJson);

// Optional upstream cross-check: diff-report only, never authoritative (the
// capture is ground truth; the repo is a pinned tag that may lag the CLI).
if (repoPath) {
  const sysTxtPath = path.join(repoPath, "packages/core/src/session/runner/prompt/system.txt");
  const upstream = fs.readFileSync(sysTxtPath, "utf8");
  const rendered = snapshot.systemTextTemplate
    .replace(/\{\{MODEL_NAME\}\}/, "X")
    .replace(/\{\{MODEL_ID\}\}/, "x")
    .replace(/\{\{DATE_UTC\}\}/, "X")
    .replace(/\{\{CWD\}\}/g, "x")
    .replace(/\{\{PLATFORM\}\}/, "x");
  const starts = rendered.startsWith(upstream.replace("${OPENCODE_TOOL_GUIDANCE}", "").replace(/\n\n\n/, "\n"));
  console.log(`[cross-check] upstream system.txt ${Buffer.byteLength(upstream)}B; capture harness prefix match: ${starts ? "yes" : "NO (report-only — capture is ground truth)"}`);
}

if (checkOnly) {
  const committed = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  if (committed !== snapshotJson) {
    console.error("snapshot drift: regenerated snapshot differs from committed opencodeWire.snapshot.json");
    console.error("Regenerate intentionally: node scripts/extract-opencode-wire.mjs --from-capture …");
    process.exit(1);
  }
  console.log(`snapshot check OK (${Buffer.byteLength(snapshotJson)}B, clientVersion ${snapshot.clientVersion}, ${snapshot.tools.length} tools)`);
  process.exit(0);
}

fs.writeFileSync(SNAPSHOT_PATH, snapshotJson);
console.log(`wrote ${SNAPSHOT_PATH} (${Buffer.byteLength(snapshotJson)}B, clientVersion ${snapshot.clientVersion})`);

if (!skipFixture) {
  // Sanitized replay fixture (P7 Mode A): concrete rendered system text, the
  // verbatim tool manifest, no session ids / project hash (minted at replay).
  const fixture = {
    endpoint: snapshot.endpoint,
    model: capBody.model,
    systemText: snapshot.systemTextTemplate
      .replace(/\{\{MODEL_NAME\}\}/g, capBody.model.replace(/-free$/, "").split("-").map((w) => (w.match(/^\d/) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" "))
      .replace(/\{\{MODEL_ID\}\}/g, capBody.model)
      .replace(/\{\{DATE_UTC\}\}/g, "Thu Nov 12 2026")
      .replace(/\{\{CWD\}\}/g, "/workspace")
      .replace(/\{\{PLATFORM\}\}/g, "linux"),
    userMessage: capBody.messages.find((m) => m.role === "user")?.content || "Reply with the single word PONG",
    tools: snapshot.tools,
    capturedAt: snapshot.capturedAt,
  };
  const fixtureJson = JSON.stringify(fixture, null, 2) + "\n";
  checkContamination("fixture", fixtureJson);
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, fixtureJson);
  console.log(`wrote ${FIXTURE_PATH} (${Buffer.byteLength(fixtureJson)}B)`);
}
