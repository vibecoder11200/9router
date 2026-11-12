/**
 * Orphan drill: parent node process SIGKILLed mid-stream with a live bun lane
 * child. The orphan must exit on its own within timeoutMs + 60s (hard
 * lifetime cap) with bounded RSS. Guards the broken-pipe hang class:
 * an orphan stuck writing into a dead stdout pipe must not pin RAM forever.
 * Usage: node repro-261111/oc-orphan-drill.mjs [holdMs]
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOLD_MS = Number(process.argv[2] || 60000);
const REQ_TIMEOUT_MS = 5000; // lane budget -> hard cap = 65s
const VICTIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "oc-orphan-victim.mjs");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: held" + String.fromCharCode(10) + String.fromCharCode(10));
  const t = setTimeout(() => res.end(), HOLD_MS);
  req.on("close", () => clearTimeout(t));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

function countBun() {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"(Get-Process bun -ErrorAction SilentlyContinue | Measure-Object).Count\"",
      { encoding: "utf8", timeout: 15000 },
    );
    return Number(out.trim()) || 0;
  } catch { return -1; }
}

const victim = spawn(process.execPath, [VICTIM, url, String(REQ_TIMEOUT_MS)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
victim.stdout.on("data", (c) => process.stdout.write("[victim] " + c));
victim.stderr.on("data", (c) => process.stderr.write("[victim-err] " + c));

await new Promise((r) => setTimeout(r, 3000)); // child spawned, streaming
const before = countBun();
console.log(`bun processes before kill: ${before}`);
if (before < 1) { console.log("SKIP: no bun child observed (bun missing?)"); server.close(); process.exit(2); }
victim.kill("SIGKILL");
console.log("victim SIGKILLed mid-stream - orphan window opens (cap = timeoutMs+60s)");
const deadline = Date.now() + REQ_TIMEOUT_MS + 60000 + 20000;
let cleared = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const n = countBun();
  if (n < before) {
    console.log(`orphan cleared (count ${before} -> ${n}) inside the hard-cap window`);
    cleared = true;
    break;
  }
}
console.log(cleared ? "PASS" : "FAIL: orphan alive past the hard-cap window");
server.close();
process.exit(cleared ? 0 : 1);