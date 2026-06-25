import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { spawn } from "child_process";
import { findDS2APIBinary, getDS2APIDataDir } from "./detect.js";

const DS2API_DIR = getDS2APIDataDir();
const PID_FILE = path.join(DS2API_DIR, "ds2api.pid");
const LOG_FILE = path.join(DS2API_DIR, "ds2api.log");
const CONFIG_FILE = path.join(DS2API_DIR, "config.json");
const CREDENTIALS_FILE = path.join(DS2API_DIR, "credentials.json");
const DEFAULT_PORT = 5001;
const STARTUP_TIMEOUT_MS = 10000;

function ensureDir() {
  if (!fs.existsSync(DS2API_DIR)) fs.mkdirSync(DS2API_DIR, { recursive: true });
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

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function getManagedPid() {
  const pid = readPid();
  return pid && isPidAlive(pid) ? pid : null;
}

// Strong, auto-generated secrets so 9router can talk to the sidecar's admin API and
// so callers route through it — the user never handles these. Env override wins.
function generateCredentials() {
  return {
    adminKey: crypto.randomBytes(24).toString("hex"),
    apiKey: `sk-9r-ds2api-${crypto.randomBytes(18).toString("hex")}`,
  };
}

export function ensureCredentials() {
  ensureDir();
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
      if (raw?.adminKey && raw?.apiKey) return raw;
    }
  } catch { /* corrupt file — regenerate */ }
  const creds = generateCredentials();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

export function getCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch { /* ignore */ }
  return null;
}

// DS2API manages its own config (accounts, api_keys) via its admin API; we point
// DS2API_CONFIG_PATH at DATA_DIR/ds2api/config.json so it bootstraps an empty
// file-backed store there (token persistence survives restarts). cwd keeps pid/log
// co-located. Admin key is the managed credential (env DS2API_ADMIN_KEY overrides).
export async function startDS2API({ port } = {}) {
  const safePort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : DEFAULT_PORT;
  const binary = findDS2APIBinary();
  if (!binary) {
    const err = new Error("DS2API binary not installed. Use the dashboard Install action (or set DS2API binary in PATH).");
    err.code = "NOT_INSTALLED";
    throw err;
  }

  const existing = getManagedPid();
  if (existing) return { pid: existing, alreadyRunning: true };

  ensureDir();
  const { adminKey } = ensureCredentials();

  const outFd = fs.openSync(LOG_FILE, "a");

  const child = spawn(binary, [], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    cwd: DS2API_DIR,
    env: {
      ...process.env,
      PORT: String(safePort),
      DS2API_ADMIN_KEY: process.env.DS2API_ADMIN_KEY || adminKey,
      DS2API_CONFIG_PATH: CONFIG_FILE,
    },
  });

  if (!child.pid) {
    fs.closeSync(outFd);
    clearPid();
    const err = new Error("Failed to spawn DS2API process");
    err.code = "SPAWN_FAILED";
    throw err;
  }

  child.unref();
  writePid(child.pid);

  // Wait until the process stays alive briefly or exits fast
  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      if (isPidAlive(child.pid)) resolve();
      else reject(new Error("DS2API exited during startup — see ds2api.log"));
    }, STARTUP_TIMEOUT_MS);

    child.once("exit", (code) => {
      clearTimeout(startupTimer);
      clearPid();
      fs.closeSync(outFd);
      const e = new Error(`DS2API exited early (code=${code}) — see ds2api.log`);
      e.code = "EARLY_EXIT";
      reject(e);
    });
  });

  fs.closeSync(outFd);
  return { pid: child.pid, alreadyRunning: false };
}

export function stopDS2API() {
  const pid = getManagedPid();
  if (!pid) return { stopped: false, reason: "not_running" };
  try {
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      if (isPidAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 2000);
    clearPid();
    return { stopped: true, pid };
  } catch (e) {
    clearPid();
    const err = new Error(`Failed to stop DS2API: ${e.message}`);
    err.code = "STOP_FAILED";
    throw err;
  }
}

export function getDS2APILogTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch { return ""; }
}
