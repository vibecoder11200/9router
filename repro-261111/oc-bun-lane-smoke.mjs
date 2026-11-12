// P3 manual smoke: real bun lane (manager + real bun child) → live v2 gate.
// Re-proves the lane through the shipped child before executor wiring (P4).
import fs from "node:fs";

process.env.OPENCODE_BUN_PATH = process.env.OPENCODE_BUN_PATH || "bun"; // system bun 1.4.0

const { opencodeFreeLaneFetch, getBunLaneStatus } = await import("../open-sse/services/opencodeBunLane.js").catch(async (e) => {
  console.error("alias import failed:", e.message);
  process.exit(1);
});
const { getEmbeddedWireSnapshot, shapeV2FreeLaneRequestBody, mintV2IdentityHeaders, mintV2SessionId } = await import("../open-sse/providers/opencodeWire.js");
const { generateSessionId } = await import("../open-sse/executors/opencode.js");

const snapshot = getEmbeddedWireSnapshot();
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/opencode-replay/fixture.json", "utf8"));
const shaped = shapeV2FreeLaneRequestBody(
  { model: fixture.model, messages: [{ role: "user", content: fixture.userMessage }] },
  snapshot,
);
const ses = mintV2SessionId();
const headers = mintV2IdentityHeaders(snapshot, ses);

console.log("lane status:", JSON.stringify(getBunLaneStatus()));
const t0 = Date.now();
const res = await opencodeFreeLaneFetch(snapshot.endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify(shaped),
}, { timeoutMs: 60000 });
console.log(`HTTP ${res.status} in ${Date.now() - t0}ms`);
const reader = res.body.getReader();
const { value } = await reader.read();
console.log("first SSE chunk:", new TextDecoder().decode(value).slice(0, 120));
await reader.cancel(); // kills the bun child (quota-safe)
await new Promise((r) => setTimeout(r, 500));
console.log("lane status after cancel:", JSON.stringify(getBunLaneStatus()));
process.exit(0);
