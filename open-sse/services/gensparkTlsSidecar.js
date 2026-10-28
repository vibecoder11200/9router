/**
 * gensparkTlsSidecar.js — Node harness for the Python curl_cffi TLS sidecar.
 *
 * The genspark-web executor can NOT use Node `fetch` for the upstream call: genspark's
 * Cloudflare edge blocks vanilla Node (undici) TLS/JA3 fingerprints with a 403
 * "Just a moment" challenge, regardless of IP or cookies. The proven bypass is a
 * Chrome TLS impersonation (curl_cffi) — ported here as a per-request Python sidecar
 * (`gensparkTlsSidecar.py` in this directory).
 *
 * This module:
 *   1. Locates the Python runtime + the sidecar venv (`/root/genspark-venv` on the
 *      server, `PYTHON` env override, else `python3`).
 *   2. Lazily bootstraps the venv ONCE if curl_cffi is missing (auto-detect +
 *      auto-install: get-pip → venv → `pip install curl_cffi`), so the server needs no
 *      manual setup.
 *   3. Spawns the sidecar, writes a {cookies, payload, proxy, timeoutSec} JSON to its
 *      stdin, and streams stdout back line-by-line.
 *   4. Maps the child's exit code to a challenge/error classification the executor can
 *      react to, while re-prefixing every streamed line with `data: ` so the existing
 *      `readGensparkSseEvents` parser keeps working unchanged.
 *
 * Fail-open by design: if the sidecar can't run (no Python, install failure), we
 * return a concise error object rather than throwing, so the executor can surface a
 * clear message ("Genspark needs the TLS sidecar; installing… / install python3 +
 * curl_cffi").
 */

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Static `node:fs` import — this module is compiled into the hot chat chunk,
// and a module-scope `createRequire(import.meta.url)("node:fs")` is the exact
// shape the webpack minifier folded to `(void 0)` in published chunk 5895
// (v0.6.65), which would 500 every /v1 request at chunk load.

// ── Environment / paths ──────────────────────────────────────────────────────

// Where the sidecar script lives. In the Next standalone bundle the module is
// compiled into .next/server/chunks/, and `__dirname` there points at the chunks
// dir — the .py (a non-JS asset) most likely won't be traced next to it. Resolve
// deterministically across candidate locations so the executor works in both the
// dev tree and the deployed standalone, rather than guessing one path.
const SIDECAR_CANDIDATES = [
  process.env.GENSPARK_SIDECAR_SCRIPT,
  path.join(__dirname, "gensparkTlsSidecar.py"),
  path.join("open-sse", "services", "gensparkTlsSidecar.py"),     // run from repo root
  "/root/9router/open-sse/services/gensparkTlsSidecar.py",         // documented server install
  path.join(process.env.HOME || "/root", "9router", "open-sse", "services", "gensparkTlsSidecar.py"),
];
export const SIDECAR_SCRIPT =
  SIDECAR_CANDIDATES.find((p) => p && fs.existsSync(p)) ||
  path.join(__dirname, "gensparkTlsSidecar.py");

// Server venv location (matches the deploy layout). PYTHON overrides the executable.
// On Windows (dev machine) the venv sits under Scripts/python.exe; on POSIX it's
// bin/python. GENSPARK_VENV_DIR overrides the whole location.
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_PYTHON = process.env.PYTHON || (IS_WINDOWS ? "python" : "python3");
const SERVER_VENV_DIR = process.env.GENSPARK_VENV_DIR || (IS_WINDOWS ? path.join(process.env.LOCALAPPDATA || ".", "genspark-venv") : "/root/genspark-venv");
const VENV_PY = IS_WINDOWS ? path.join(SERVER_VENV_DIR, ".venv", "Scripts", "python.exe") : path.join(SERVER_VENV_DIR, ".venv", "bin", "python");
const VENV_PIP = IS_WINDOWS ? path.join(SERVER_VENV_DIR, ".venv", "Scripts", "pip.exe") : path.join(SERVER_VENV_DIR, ".venv", "bin", "pip");

// Per-request timeout the sidecar applies upstream (also used to abort the child).
const DEFAULT_TIMEOUT_MS = 90_000;

// ── Exit codes agreed with gensparkTlsSidecar.py ─────────────────────────────
const EXIT_OK = 0;
const EXIT_BAD_ARGS = 2;
const EXIT_CHALLENGE = 3;
const EXIT_APP_ERROR = 4;
const EXIT_TRANSPORT = 5;
const EXIT_NOT_FOUND = 127;

// Machine line the sidecar emits on stderr when Cloudflare/anti-bot cookies were
// re-issued on a successful authenticated response. Matches COOKIE_REFRESH_PREFIX
// in gensparkTlsSidecar.py. The harness parses this into `refreshedCookies`.
export const COOKIE_REFRESH_PREFIX = "[genspark-cookie-refresh]";

/**
 * Find the python executable + whether it's the sidecar venv.
 *
 * Resolution order:
 *   1. If the server venv exists and its python is executable → use it.
 *   2. If PYTHON env is set → use it verbatim.
 *   3. `python3` on PATH.
 *
 * Returns { command, args: [], isVenv } or null if nothing usable is found.
 */
export function findSidecarPython() {
  // Prefer the prebuilt sidecar venv (already installed curl_cffi).
  try {
    if (fs.existsSync(VENV_PY)) {
      return { command: VENV_PY, isVenv: true };
    }
  } catch { /* fall through */ }

  return { command: DEFAULT_PYTHON, isVenv: false };
}

/**
 * Idempotent one-time bootstrap: create the venv and install curl_cffi.
 * Returns { ok, message, command }. Never throws.
 */
async function bootstrapSidecarVenv(log) {
  const basePython = DEFAULT_PYTHON;
  const venvDir = SERVER_VENV_DIR;

  try {
    if (fs.existsSync(VENV_PY)) {
      return { ok: true, command: VENV_PY };
    }

    log?.info?.("GENSPARK-TLS", `bootstrapping genspark TLS sidecar venv at ${venvDir} (one-time)`);

    fs.mkdirSync(venvDir, { recursive: true });

    // ensure venv module exists: ensurepip may be missing (some distros). Try it,
    // then fall back to get-pip.py.
    const ensure = await runCmd(basePython, ["-m", "ensurepip", "--upgrade"], { log });
    log?.info?.("GENSPARK-TLS", `ensurepip: rc=${ensure.code}`);
    if (ensure.code !== 0) {
      // Download get-pip.py from the PyPA bootstrap page — PyPI is reachable from the server.
      try {
        const getPip = await new Promise((resolve, reject) => {
          https.get("https://bootstrap.pypa.io/get-pip.py", (res) => {
            if (res.statusCode !== 200) { reject(new Error(`get-pip.py HTTP ${res.statusCode}`)); res.resume(); return; }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          }).on("error", reject);
        });
        const getPipPath = path.join(venvDir, "get-pip.py");
        fs.writeFileSync(getPipPath, getPip);
        await runCmd(basePython, [getPipPath], { log });
        fs.rmSync(getPipPath, { force: true });
      } catch (e) {
        log?.warn?.("GENSPARK-TLS", `get-pip.py bootstrap failed: ${e.message}`);
        return { ok: false, message: `could not install pip (${e.message}) — install python3-pip manually then retry` };
      }
    }

    // Create the venv.
    const venvRun = await runCmd(basePython, ["-m", "venv", path.join(venvDir, ".venv")], { log });
    if (venvRun.code !== 0) {
      return { ok: false, message: `venv creation failed (rc=${venvRun.code})` };
    }

    // Install curl_cffi into the venv. Try the venv pip first, then python -m pip.
    const pipCmd = fs.existsSync(VENV_PIP) ? VENV_PIP : VENV_PY;
    const pipArgs = fs.existsSync(VENV_PIP) ? ["install", "-q", "curl_cffi"] : ["-m", "pip", "install", "-q", "curl_cffi"];
    const pipRun = await runCmd(pipCmd, pipArgs, { log });
    if (pipRun.code !== 0) {
      return { ok: false, message: `pip install curl_cffi failed (rc=${pipRun.code}) — run "${pipArgs.join(" ")}" manually` };
    }

    log?.info?.("GENSPARK-TLS", `sidecar venv ready: ${VENV_PY}`);
    return { ok: true, command: VENV_PY };
  } catch (e) {
    log?.warn?.("GENSPARK-TLS", `venv bootstrap error: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

/** Run a command and resolve when it exits. */
function runCmd(command, args, { log } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve({ code: -1 }));
    child.on("close", (code) => resolve({ code: code ?? -1 }));
  });
}

// Bootstrapping state.
let bootstrapPromise = null;
let pythonCommand = null;
let pythonChecked = false;

/**
 * Resolve the python command, bootstrapping the venv once if needed.
 * Returns { command } or { error }.
 */
async function resolvePython(log) {
  if (pythonCommand) return { command: pythonCommand };
  if (pythonChecked && !pythonCommand) {
    // Previous check said missing; try re-resolve after a bootstrap attempt.
  }

  const found = findSidecarPython();
  if (!found) {
    pythonChecked = true;
    return { error: "No Python runtime found (needed for the genspark TLS sidecar). Install python3 on the server." };
  }

  // If it's not the venv yet, check python3 has curl_cffi; if not, bootstrap once.
  if (found.isVenv) {
    pythonCommand = found.command;
    return { command: pythonCommand };
  }

  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      // Probe for curl_cffi on the base python first (dev machines already have it).
      const probe = await new Promise((resolve) => {
        execFile(found.command, ["-c", "import curl_cffi"], { timeout: 15_000 }, (err) => resolve(err ? null : "ok"));
      });
      if (probe === "ok") {
        log?.info?.("GENSPARK-TLS", "base python already has curl_cffi");
        return { command: found.command };
      }
      const boot = await bootstrapSidecarVenv(log);
      if (boot.ok) return { command: boot.command };
      return { error: boot.message };
    })();
  }

  const result = await bootstrapPromise;
  if (result.command) {
    pythonCommand = result.command;
    return { command: pythonCommand };
  }
  pythonChecked = true;
  return { error: result.error || "genspark TLS sidecar unavailable" };
}

/**
 * Spawn the sidecar for one request and stream the upstream response.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.cookies   full genspark browser jar
 * @param {object} opts.payload                  the ai_chat body for /api/agent/ask_proxy
 * @param {string|null} opts.proxy               optional http(s) proxy URL
 * @param {number} [opts.timeoutMs=90000]        per-request timeout
 * @param {object} opts.log
 * @param {AbortSignal} [opts.signal]            abort the request (kills the child)
 * @returns {Promise<{body: ReadableStream, exitHint: string|null, error?: {message, code, status, kind}}>}
 *
 * The returned `body`:
 *   - On success, a ReadableStream of `data: <json>\n`-prefixed lines (so the
 *     existing `readGensparkSseEvents` handles the parsing identically).
 *   - On failure (challenge / transport / bad args / bootstrap error), `body` is a
 *     small ReadableStream that emits the error classification the executor turns
 *     into a clear HTTP error Response; `error` is also populated for convenience.
 */
export async function gensparkSidecarFetch({ cookies, payload, proxy, timeoutMs = DEFAULT_TIMEOUT_MS, log, signal, url = null, method = "POST" }) {
  const { command, error } = await resolvePython(log);
  if (error) {
    return {
      error: { message: error, code: "SIDECAR_UNAVAILABLE", status: 502, kind: "sidecar_unavailable" },
      exitHint: null,
      body: null,
    };
  }

  const child = spawn(command, [SIDECAR_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Capture the child's stderr (diagnostics) and its exit info, but do NOT block the
  // stdout stream on close — streaming starts as soon as data arrives.
  let stderr = "";
  let exitResolve;
  const exitDone = new Promise((resolve) => { exitResolve = resolve; });
  let settledCode = null;
  const setExit = (code, err) => {
    if (settledCode != null && err == null && code === settledCode) return;
    if (settledCode != null) return;
    settledCode = code;
    exitResolve({ code, error: err });
  };

  // Cookie write-back: the sidecar emits exactly one `[genspark-cookie-refresh]
  // <json>` line on stderr when Cloudflare/anti-bot cookies were re-issued on a
  // successful authenticated call. Parse it into `refreshedCookies` (resolved with
  // the diff object) — or null when nothing was refreshed by the time the child
  // closes. We must NOT pre-resolve to null: `resolve` is idempotent, so an
  // upfront null would swallow the real value once the sentinel line arrives.
  let refreshedResolve;
  const refreshedCookies = new Promise((resolve) => { refreshedResolve = resolve; });
  child.on("error", (err) => { setExit(EXIT_TRANSPORT, err.message); refreshedResolve(null); });
  child.on("close", (code) => { setExit(code ?? EXIT_TRANSPORT, null); refreshedResolve(null); });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text.slice(-4000);
    const idx = text.indexOf(COOKIE_REFRESH_PREFIX);
    if (idx >= 0) {
      const jsonPart = text.slice(idx + COOKIE_REFRESH_PREFIX.length).trim().split("\n")[0].trim();
      try {
        const parsed = JSON.parse(jsonPart);
        if (parsed && typeof parsed === "object") refreshedResolve(parsed);
      } catch {
        // malformed refresh line is non-fatal; ignore it
      }
    }
  });

  // Build the request as a `data: <line>\n`-prefixed stream of the upstream lines.
  // The executor's readGensparkSseEvents consume this unchanged; we re-prefix so we
  // reuse the proven SSE parser rather than writing a second one.
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      let buffer = "";
      let ended = false;
      const push = (line) => {
        if (!line) return;
        controller.enqueue(encoder.encode(`data: ${line}\n`));
      };

      // Transport errors that occur before any stdout still surface. If the child
      // exits with EXIT_TRANSPORT before streaming anything, error the stream so the
      // executor catches it as upstream_error.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          push(line);
        }
      });
      child.stdout.on("end", () => {
        if (buffer.trim()) push(buffer.trim());
        ended = true;
        controller.close();
      });
      // If the child closes without ever enqueuing stdout, surface a transport error
      // (unless it was an app-level exit — then the empty body is the signal).
      child.on("close", async () => {
        const { code } = await exitDone;
        if (!ended && code === EXIT_TRANSPORT) {
          const diag = stderr.trim().split("\n").slice(-3).join(" | ");
          try { controller.error(new Error(`genspark sidecar failed${diag ? ` (${diag})` : ""}`)); } catch { /* ignore */ }
        }
      });
    },
    cancel() {
      try { child.kill(); } catch { /* ignore */ }
    },
  });

  // Write the request to the child's stdin.
  try {
    const req = JSON.stringify({ cookies, payload, proxy: proxy || null, timeoutSec: Math.ceil(timeoutMs / 1000), url: url || null, method });
    child.stdin.write(req);
    child.stdin.end();
  } catch (err) {
    try { child.kill(); } catch { /* ignore */ }
  }

  // Abort wiring: kill the child when the request is aborted.
  if (signal) {
    if (signal.aborted) {
      try { child.kill(); } catch { /* ignore */ }
    } else {
      signal.addEventListener("abort", () => { try { child.kill(); } catch { /* ignore */ } }, { once: true });
    }
  }

  // Exit hint resolves when the child closes — a fast-path classification for the
  // executor. It does NOT gate the body stream (which starts flowing immediately via
  // stdout events), so first-token latency stays identical to a direct fetch.
  // classifyError() on the streamed body remains the authoritative signal.
  const exitHint = exitDone.then(({ code: exitCode }) => {
    if (exitCode === EXIT_CHALLENGE) return "challenge";
    if (exitCode === EXIT_APP_ERROR) return "app_error";
    if (exitCode === EXIT_TRANSPORT) return "transport";
    if (exitCode === EXIT_BAD_ARGS) return "bad_args";
    return null;
  });

  return { body, exitHint, refreshedCookies };
}

export default gensparkSidecarFetch;