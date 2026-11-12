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
 *   failure BEFORE headers: line 1 = { "error": "..." } + exit 5
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

  // Belt: when the manager closes stdin, this child's job is over — env
  // transport only (with stdin transport the close event means "payload
  // delivered", not "die", and would otherwise abort mid-request).
  if (process.env[BUNLANE_ENV_KEY]) {
    process.stdin?.on?.("close", () => {
      try { process.exit(EXIT_OK); } catch {}
    });
  }

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
    emit({ error: e?.message || String(e) });
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
        if (IS_BUN) {
          await Bun.write(Bun.stdout, value);
        } else {
          await new Promise((resolve, reject) =>
            process.stdout.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
          );
        }
      }
    }
  } catch {
    // body streaming interrupted (abort/timeout) — exit below signals why
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
