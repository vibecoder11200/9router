/**
 * OpenCode Bun-lane stdio child (plan P3). One child per request, spawned by
 * opencodeBunLane.js: performs the upstream fetch with the SPAWNING runtime's
 * TLS stack — under Bun (the lane's normal runtime) that is BoringSSL, which
 * the v2 free-tier gate accepts where Node's is refused (P0 A/B evidence).
 *
 * stdout protocol (the ONLY channel — stderr is debug):
 *   line 1: JSON  { "status": N, "headers": {...} }          — on response headers
 *   then  : RAW response body bytes, verbatim (SSE passthrough) until EOF
 *   exit 0 at stream end
 *   failure BEFORE headers: line 1 = { "error": "...", "phase": "upstream" } + exit 5
 *     ("phase" distinguishes the upstream fetch dying — dead node / socks
 *     closed / TLS refused, i.e. per-request evidence — from internal script
 *     failures, which omit it and stay lane-level)
 *   idle timeout (no body chunk for idleTimeoutMs): abort upstream, exit 6
 *   malformed request: { "error": "..." } + exit 7
 *
 * Abort = the manager kills the child → the OS closes the pipe → the upstream
 * fetch dies with it. No orphan class, no port, no auth surface.
 *
 * Runs under Bun in production AND under plain node in tests (the script
 * detects the runtime; the Bun-only `proxy` fetch option is exercised in the
 * manual smoke only — node tests validate the protocol itself).
 */

// Request arrives on env BUNLANE_REQ (JSON) or — for large bodies (>100KB) —
// as the entire stdin payload (the manager closes stdin after writing).
const BUNLANE_ENV_KEY = "BUNLANE_REQ";
const EXIT_OK = 0;
const EXIT_UPSTREAM_ERROR = 5;
const EXIT_IDLE_TIMEOUT = 6;
const EXIT_BAD_REQUEST = 7;

const IS_BUN = typeof Bun !== "undefined";

function emit(obj) {
  const line = JSON.stringify(obj) + "\n";
  if (IS_BUN) {
    Bun.write(Bun.stdout, line);
  } else {
    process.stdout.write(line);
  }
}

// stdout is the ONLY protocol channel — a write into a pipe whose reader died
// (orphaned child, killed parent) must never wedge the process: race every
// body write with a timeout; the catch path exits (hard lifetime cap backs it).
function writeWithTimeout(value) {
  const WRITE_TIMEOUT_MS = 10_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("stdout write timeout (broken pipe)")),
      WRITE_TIMEOUT_MS,
    );
    const write = IS_BUN
      ? Bun.write(Bun.stdout, value)
      : new Promise((res, rej) =>
          process.stdout.write(Buffer.from(value), (err) => (err ? rej(err) : res())),
        );
    write.then(
      () => { clearTimeout(timer); resolve(); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function readStdinAll() {
  if (IS_BUN) {
    return await new Response(Bun.stdin).text();
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let req;
  try {
    const raw = process.env[BUNLANE_ENV_KEY] || (await readStdinAll());
    req = JSON.parse(raw);
  } catch (e) {
    emit({ error: `bad request: ${e?.message || e}` });
    process.exit(EXIT_BAD_REQUEST);
  }
  if (!req || typeof req.url !== "string") {
    emit({ error: "bad request: url required" });
    process.exit(EXIT_BAD_REQUEST);
  }

  const timeoutMs = Number(req.timeoutMs) || 120_000;
  const idleTimeoutMs = Number(req.idleTimeoutMs) || timeoutMs;

  // Hard lifetime cap (orphan hygiene): defense-in-depth — if this process
  // ever gets stuck where the watchdogs cannot rescue it — e.g. a Bun.write
  // into a stdout pipe whose reader died (parent crash/killed mid-stream):
  // the 120s abort fires but the stuck write never notices it. This timer
  // calls process.exit() DIRECTLY: an async hang leaves the loop free,
  // so timers still run; exit needs no cooperation from the stuck await.
  const HARD_LIFETIME_MS = timeoutMs + 60_000;
  setTimeout(() => {
    try { process.exit(EXIT_OK); } catch {}
  }, HARD_LIFETIME_MS);

  // NO stdin belt: env transport closes stdin at spawn BY DESIGN (spawnChild
  // ends stdin immediately), so a stdin-close belt would kill live streams at
  // an arbitrary point after headers (replay proved it: 200s with empty
  // bodies). Orphan protection = the idle/total watchdogs below, this hard
  // cap, and the manager releasing the slot on child exit — not a stdin
  // sentinel.

  const abort = new AbortController();
  let idleTimer = null;
  let idleFired = false;
  const armIdleWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      try { abort.abort(new Error("idle timeout")); } catch {}
    }, idleTimeoutMs);
  };

  const totalTimer = setTimeout(() => {
    try { abort.abort(new Error("request timeout")); } catch {}
  }, timeoutMs);

  const fetchOptions = {
    method: req.method || "GET",
    headers: req.headers || {},
    redirect: "follow",
    signal: abort.signal,
  };
  if (req.body !== undefined && req.body !== null) fetchOptions.body = req.body;
  // Bun-only: HTTP-proxy egress (CONNECT). The gate accepts Bun's BoringSSL
  // stack; node's fetch has no proxy option — tests validate the protocol.
  if (req.proxy && IS_BUN) fetchOptions.proxy = req.proxy;

  let res;
  try {
    armIdleWatchdog();
    res = await fetch(req.url, fetchOptions);
  } catch (e) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    // phase: "upstream" — the fetch itself died (dead node, socks reset,
    // connection refused). Per-request evidence, NOT a lane outage: the xray
    // model filter probes dead nodes on purpose and must see this as a normal
    // probe failure, not a lane-level unavailable that aborts the whole run.
    emit({ error: e?.message || String(e), phase: "upstream" });
    process.exit(EXIT_UPSTREAM_ERROR);
  }

  emit({ status: res.status, headers: Object.fromEntries(res.headers.entries()) });

  try {
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleWatchdog(); // each chunk defers the idle watchdog
        await writeWithTimeout(value); // broken-pipe hang → 10s → exit
      }
    }
  } catch {
    // body streaming interrupted (abort/timeout/broken stdout) — exit below
  }
  clearTimeout(totalTimer);
  if (idleTimer) clearTimeout(idleTimer);
  if (idleFired) process.exit(EXIT_IDLE_TIMEOUT);
  process.exit(EXIT_OK);
}

main().catch((e) => {
  try {
    emit({ error: e?.message || String(e) });
    process.exit(EXIT_UPSTREAM_ERROR);
  } catch {
    process.exit(EXIT_UPSTREAM_ERROR);
  }
});
