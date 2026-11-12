/**
 * P7 Mode A replay harness — re-proves the shipped bun lane against the live
 * v2 gate WITHOUT the executor: fixture request -> real opencodeBunLane
 * (manager + per-request bun child) -> 200 + first SSE chunk, x3 consecutive.
 *
 * Dev/CI machine with bun available. NEVER run against the gate from the VPS
 * (VPS acceptance spends completions via the app, not this harness).
 *
 * Usage: node scripts/replay-opencode-free-lane.mjs [--runs N] [--no-cancel]
 *
 * Research provenance (Node-vs-Bun differential, wire fidelity): see the plan
 * reports/. If Mode A ever 429s with a fresh sync-matching snapshot, STOP:
 * that is a research round, not an implementation fix (plan R4 discipline).
 */

import { register } from "node:module";
register("./lib/alias-loader.mjs", import.meta.url);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { opencodeFreeLaneFetch, getBunLaneStatus } = await import("open-sse/services/opencodeBunLane.js");
const { getEmbeddedWireSnapshot, shapeV2FreeLaneRequestBody, mintV2IdentityHeaders, mintV2SessionId } =
  await import("open-sse/providers/opencodeWire.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "opencode-replay", "fixture.json");

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx >= 0 ? Number(args[runsIdx + 1]) || 3 : 3;
const NO_CANCEL = args.includes("--no-cancel");

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const snapshot = getEmbeddedWireSnapshot();

console.log("--- Mode A replay: shipped bun lane -> live v2 gate ---");
console.log("snapshot clientVersion=" + snapshot.clientVersion + " capturedAt=" + snapshot.capturedAt);
if (snapshot.endpoint !== fixture.endpoint) {
  console.log("NOTE: snapshot endpoint drifted from the fixture (" + fixture.endpoint + " -> " + snapshot.endpoint + ") - continuing with the snapshot");
}

const laneStatus = getBunLaneStatus();
console.log("lane: bun=" + (laneStatus.bunVersion || (laneStatus.installed ? "installed" : "NOT INSTALLED")) + " busy=" + laneStatus.busy + "/" + laneStatus.maxConcurrency);

let pass = 0;
const results = [];
for (let i = 1; i <= RUNS; i++) {
  // fresh identity per replay - never reuse a minted session across requests
  const sessionId = mintV2SessionId();
  const shaped = shapeV2FreeLaneRequestBody(
    { model: fixture.model, messages: [{ role: "user", content: fixture.userMessage }], stream: true },
    snapshot,
  );
  const headers = mintV2IdentityHeaders(snapshot, sessionId);
  const t0 = Date.now();
  try {
    const res = await opencodeFreeLaneFetch(snapshot.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(shaped),
    }, { timeoutMs: 60000 });

    let firstChunk = null;
    if (res.status === 200 && res.body) {
      const reader = res.body.getReader();
      const first = await reader.read();
      if (!first.done) {
        firstChunk = new TextDecoder().decode(first.value).slice(0, 160);
        if (!NO_CANCEL) {
          // consumer cancel -> killChild (quota-safe abort proof on every run)
          await reader.cancel();
        } else {
          for (let n = 0; n < 2; n++) {
            const c = await reader.read();
            if (c.done) break;
            firstChunk += new TextDecoder().decode(c.value);
          }
        }
      }
    }
    const ok = res.status === 200 && firstChunk !== null;
    const dt = Date.now() - t0;
    results.push({ run: i, status: res.status, ms: dt, chunk: firstChunk });
    console.log("run " + i + ": HTTP " + res.status + " in " + dt + "ms" + (firstChunk ? " - first chunk: " + JSON.stringify(firstChunk) : ""));
    if (ok) pass++;
    else if (res.status === 429) {
      console.error("STOP: fresh session + sync-matching snapshot got 429 - research round required (plan R4), NOT an implementation fix.");
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 2000)); // paced >=2s between replays
  } catch (e) {
    results.push({ run: i, error: e.message });
    console.error("run " + i + ": lane error - " + e.message);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log("--- " + pass + "/" + RUNS + " runs returned 200 + first SSE chunk ---");
console.log(JSON.stringify(results, null, 2));
process.exit(pass === RUNS ? 0 : 1);