/**
 * RAM probe for the bun lane: hold N concurrent lane children against a local
 * SSE server and sample actual bun.exe working sets. Answers "10-20 requests
 * at once - how much RAM?" with real numbers (semaphore caps children at 3;
 * queued requests are promises, not processes).
 */
import { register } from "node:module";
register(new URL("../scripts/lib/alias-loader.mjs", import.meta.url).href, import.meta.url);
import http from "node:http";
import { execSync } from "node:child_process";
const { opencodeFreeLaneFetch, getBunLaneStatus } = await import("open-sse/services/opencodeBunLane.js");

const HOLD_MS = Number(process.argv[2] || 8000);   // how long the server holds each stream
const N_REQ = Number(process.argv[3] || 12);       // concurrent requests to fire

function sampleBunRss() {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-Process bun -ErrorAction SilentlyContinue | Select-Object Id,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress\"",
      { encoding: "utf8", timeout: 15000 },
    );
    const j = JSON.parse(out || "[]");
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: held\n\n");
  const t = setTimeout(() => { res.end(); }, HOLD_MS);
  req.on("close", () => clearTimeout(t));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
console.log(`firing ${N_REQ} concurrent lane requests, server holds ${HOLD_MS}ms ...`);
const t0 = Date.now();
const results = [];
for (let i = 0; i < N_REQ; i++) {
  results.push(
    opencodeFreeLaneFetch(url, { method: "GET" })
      .then(async (r) => { const b = await r.text(); return { i, status: r.status, bytes: b.length, ms: Date.now() - t0 }; })
      .catch((e) => ({ i, err: e.code || e.message.slice(0, 60), ms: Date.now() - t0 })),
  );
}
await new Promise((r) => setTimeout(r, 2500)); // children spawned / queue formed
const status = getBunLaneStatus();
console.log(`lane state while held: busy=${status.busy} queued=${status.queued} max=${status.maxConcurrency}`);
const rss = sampleBunRss();
console.log(`bun processes: ${rss.length}`);
for (const p of rss) console.log(`  pid=${p.Id} rss=${p.MB}MB`);
const total = rss.reduce((s, p) => s + (Number(p.MB) || 0), 0);
console.log(`TOTAL bun RSS while ${status.busy} children live: ${Math.round(total)}MB`);
const done = await Promise.all(results);
const ok = done.filter((d) => d.status === 200).length;
const busy = done.filter((d) => d.err && String(d.err).includes("BUSY")).length;
console.log(`settled: ${ok}/${N_REQ} ok (200), ${busy} BUSY-typed, max wait ${Math.max(...done.map((d) => d.ms))}ms`);
server.close();