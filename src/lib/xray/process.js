/**
 * Managed xray-core child process lifecycle.
 *
 * Mirrors the proven pattern from src/lib/headroom/process.js: detached spawn
 * with PID file, startup gate (process must survive N ms to count as started),
 * SIGTERM → SIGKILL escalation, and Windows-safe killing via taskkill.
 *
 * One xray process = one active outbound (the v2rayN convention). Switching
 * servers is a blue-green replace: spawn the next instance on a fresh port,
 * then drain + terminate the old one once the pool has been repointed (see
 * spawnNextManagedXray / manager.switchConfig).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { probeProcess } from "@/lib/processGuard.js";
import { getXrayBinaryPath, isXrayInstalled } from "./installer.js";

const XRAY_DIR = path.join(DATA_DIR, "xray");
const PID_FILE = path.join(XRAY_DIR, "xray.pid");
// Instances retired by a blue-green switch that are kept alive briefly so
// in-flight requests through the old SOCKS port can finish (drain).
const DRAINING_FILE = path.join(XRAY_DIR, "xray.pid.draining");
const LOG_FILE = path.join(XRAY_DIR, "xray.log");
const STARTUP_TIMEOUT_MS = 8000;

function ensureDir() {
  if (!fs.existsSync(XRAY_DIR)) fs.mkdirSync(XRAY_DIR, { recursive: true });
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  } catch { /* ignore */ }
  return null;
}

function writePid(pid) {
  ensureDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/**
 * Kill a PID on Windows WITHOUT flashing a cmd.exe console window.
 *
 * `child_process.exec(string)` routes the command through cmd.exe, which opens
 * a visible console per call. During a model-filter run that spawns a temp
 * xray per config, the per-test teardown fired one such kill — so hundreds of
 * configs produced hundreds of cmd.exe windows flooding the desktop.
 *
 * Spawning powershell.exe directly (no shell) with `windowsHide: true` and
 * `stdio: "ignore"` creates the process with CREATE_NO_WINDOW, so nothing is
 * ever visible. Resolves once the kill returns (or after a safety timeout so
 * the caller never hangs on a dead powershell).
 *
 * Only call this from win32 branches — it shells out to powershell.exe.
 */
function killPidWindows(pid) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-NoLogo", "-Command", `Stop-Process -Id ${pid} -Force`],
        { windowsHide: true, stdio: "ignore" }
      );
      p.once("exit", done);
      p.once("error", done);
      const t = setTimeout(done, 3000);
      t.unref?.();
    } catch {
      done();
    }
  });
}

/** Probe whether a pid is alive (process.kill with signal 0 throws if dead). */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns the managed pid only if the pid file exists AND the process is alive. */
export function getManagedPid() {
  const pid = readPid();
  return pid && isPidAlive(pid) ? pid : null;
}

/**
 * Like getManagedPid, but also verifies the live process's command line is
 * actually an xray binary before trusting the PID file (X7 kill-safety). A
 * recycled PID now owned by an unrelated process is treated as a stale file:
 * removed and reported as not running — never killed. An UNPROVABLE process
 * (probe tool failed/timed out while the PID is alive) keeps its PID file and
 * is reported as running: a false "running" is recoverable, a false "not
 * running" double-spawns into a port conflict and orphans the live process.
 */
export function getVerifiedManagedPid() {
  const pid = getManagedPid();
  if (!pid) return null;
  const state = probeProcess(pid, "xray");
  if (state === "gone") {
    try { clearPid(); } catch { /* best-effort */ }
    return null;
  }
  // "ours" or "unknown" — conservative: keep the PID file, don't re-spawn.
  return pid;
}

/**
 * Start a managed xray process bound to the given config file.
 * Idempotent: if a managed process is already running, returns it as-is.
 *
 * @param {{ configPath: string }} opts
 * @returns {{ pid: number, alreadyRunning: boolean }}
 * @throws {Error} with code NOT_INSTALLED if the binary is missing,
 *                 code SPAWN_FAILED / EARLY_EXIT on startup failure.
 */
export async function startManagedXray({ configPath }) {
  if (!isXrayInstalled()) {
    const err = new Error("Xray binary not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }

  const existing = getVerifiedManagedPid();
  if (existing) return { pid: existing, alreadyRunning: true };

  ensureDir();
  const binary = getXrayBinaryPath();
  const outFd = fs.openSync(LOG_FILE, "a");

  const child = spawn(binary, ["run", "-c", configPath], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    env: { ...process.env },
  });

  if (!child.pid) {
    fs.closeSync(outFd);
    const err = new Error("Failed to spawn xray process");
    err.code = "SPAWN_FAILED";
    throw err;
  }

  child.unref();
  writePid(child.pid);

  // Startup gate: the process must stay alive past STARTUP_TIMEOUT_MS. A fast
  // exit (bad config, port conflict, missing assets) rejects with EARLY_EXIT.
  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      if (isPidAlive(child.pid)) resolve();
      else reject(new Error("xray exited during startup — see xray.log"));
    }, STARTUP_TIMEOUT_MS);

    child.once("exit", (code) => {
      clearTimeout(startupTimer);
      clearPid();
      try { fs.closeSync(outFd); } catch {}
      const e = new Error(`xray exited early (code=${code}) — see xray.log`);
      e.code = "EARLY_EXIT";
      e.exitCode = code;
      reject(e);
    });
  });

  try { fs.closeSync(outFd); } catch {}
  return { pid: child.pid, alreadyRunning: false };
}

/**
 * Stop the managed xray process. Sends SIGTERM, escalates to SIGKILL after 2s.
 * On Windows, uses PowerShell Stop-Process (more reliable than taskkill in
 * Git Bash environments where taskkill can silently fail).
 *
 * @returns {{ stopped: boolean, pid?: number, reason?: string }}
 */
export function stopXray() {
  const pid = getVerifiedManagedPid();
  if (!pid) return { stopped: false, reason: "not_running" };

  try {
    if (process.platform === "win32") {
      // PowerShell Stop-Process is more reliable than taskkill across shells.
      // /F equivalent = -Force. Fire and forget — the caller clears the PID file.
      // killPidWindows spawns powershell directly with CREATE_NO_WINDOW so no
      // cmd.exe console flashes on screen.
      killPidWindows(pid);
    } else {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        if (isPidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }, 2000);
    }
    clearPid();
    return { stopped: true, pid };
  } catch (e) {
    clearPid();
    const err = new Error(`Failed to stop xray: ${e.message}`);
    err.code = "STOP_FAILED";
    throw err;
  }
}

/**
 * Restart: stop the managed process (waiting for it to die), then start again
 * with the same or a new config. Used when switching servers or applying
 * config changes.
 *
 * @param {{ configPath: string }} opts
 */
export async function restartXray({ configPath }) {
  const pid = getVerifiedManagedPid();
  if (pid) {
    await terminateXrayPid(pid);
    clearPid();
  }
  return startManagedXray({ configPath });
}

/**
 * Gracefully terminate an xray instance by PID: SIGTERM, escalate to SIGKILL
 * after 3s. Waits for the process to actually die so the caller can rely on
 * its ports being released. Windows uses PowerShell Stop-Process.
 */
export async function terminateXrayPid(pid) {
  if (!pid || !isPidAlive(pid)) return;
  if (process.platform === "win32") {
    await killPidWindows(pid);
    // Give the OS a moment to release the port.
    await new Promise((r) => setTimeout(r, 500));
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 30 && isPidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Overwrite the managed PID file (used by blue-green switch to promote the
 *  new instance, or to restore the previous one when a candidate fails). */
export function setManagedPid(pid) {
  if (pid) writePid(pid);
  else clearPid();
}

// ─── draining-instance bookkeeping (blue-green switch) ─────────────────────
// Retired instances stay alive for a drain window so requests already riding
// their SOCKS port can finish. The registry is persisted so the boot reaper
// can kill orphans after a crash/restart (in-flight requests died with the
// Node process anyway).

export function getDrainingPids() {
  try {
    if (!fs.existsSync(DRAINING_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(DRAINING_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && Number.isFinite(Number(e.pid)));
  } catch {
    return [];
  }
}

export function addDrainingPid(pid) {
  if (!pid) return;
  const list = getDrainingPids();
  if (list.some((e) => Number(e.pid) === Number(pid))) return;
  list.push({ pid: Number(pid), since: Date.now() });
  ensureDir();
  fs.writeFileSync(DRAINING_FILE, JSON.stringify(list));
}

export function removeDrainingPid(pid) {
  const list = getDrainingPids();
  const next = list.filter((e) => Number(e.pid) !== Number(pid));
  try {
    if (next.length) fs.writeFileSync(DRAINING_FILE, JSON.stringify(next));
    else if (fs.existsSync(DRAINING_FILE)) fs.unlinkSync(DRAINING_FILE);
  } catch { /* best-effort */ }
}

/**
 * Spawn the NEXT managed instance without touching the current one and
 * without the fixed 8s startup gate: the caller races port-readiness against
 * the early-exit promise instead, so a healthy instance is promoted as soon
 * as its SOCKS port accepts connections and a bad one fails fast.
 *
 * Does NOT write the PID file — the caller promotes via setManagedPid() only
 * after the new instance passes its health probe (and restores the old PID
 * on failure).
 *
 * @param {{ configPath: string }} opts
 * @returns {Promise<{ pid: number, exitPromise: Promise<number> }>}
 *   exitPromise resolves with the exit code if the process dies on its own
 *   (bad config, port conflict) — race it against readiness.
 */
export async function spawnNextManagedXray({ configPath }) {
  if (!isXrayInstalled()) {
    const err = new Error("Xray binary not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  ensureDir();
  const binary = getXrayBinaryPath();
  const outFd = fs.openSync(LOG_FILE, "a");
  let child;
  try {
    child = spawn(binary, ["run", "-c", configPath], {
      stdio: ["ignore", outFd, outFd],
      detached: true,
      windowsHide: true,
      env: { ...process.env },
    });
  } finally {
    try { fs.closeSync(outFd); } catch {}
  }
  if (!child.pid) {
    const err = new Error("Failed to spawn xray process");
    err.code = "SPAWN_FAILED";
    throw err;
  }
  child.unref();
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { pid: child.pid, exitPromise };
}

/** Tail the xray runtime log for the dashboard log viewer. */
export function getXrayLogTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Spawn a TEMPORARY xray instance for one-off config testing (the per-row
 * "Test" button). Returns a handle { pid, kill } so the caller can terminate
 * it WITHOUT touching the shared PID file used by the active service.
 *
 * This isolation is essential: startManagedXray/stopXray share one PID file,
 * so a test that used them would clobber the active proxy's tracking state.
 */
export async function spawnTempXray({ configPath }) {
  if (!isXrayInstalled()) {
    const err = new Error("Xray binary not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const binary = getXrayBinaryPath();
  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(binary, ["run", "-c", configPath], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    env: { ...process.env },
  });
  try { fs.closeSync(outFd); } catch {}
  if (!child.pid) throw new Error("Failed to spawn temp xray");
  child.unref();
  return {
    pid: child.pid,
    kill() {
      try {
        if (process.platform === "win32") {
          // Fire and forget — killPidWindows spawns powershell with
          // CREATE_NO_WINDOW so per-test teardown doesn't flash a cmd console.
          // (This kill fires once per config during a model-filter run.)
          killPidWindows(child.pid);
        } else {
          process.kill(child.pid, "SIGKILL");
        }
      } catch { /* already dead */ }
    },
  };
}

export { LOG_FILE as XRAY_LOG_FILE, PID_FILE as XRAY_PID_FILE };
