import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { DATA_DIR } from "@/lib/dataDir.js";

const IS_WIN = process.platform === "win32";
const WHICH_CMD = IS_WIN ? "where" : "which";

const DS2API_DIR = path.join(DATA_DIR, "ds2api");
// Accept either naming convention in DATA_DIR on any platform: `go build -o ds2api`
// yields `ds2api` everywhere, while Windows releases often ship `ds2api.exe`.
const DS2API_BINARY_CANDIDATES = [
  path.join(DS2API_DIR, "ds2api"),
  path.join(DS2API_DIR, "ds2api.exe"),
];

const HEALTH_TIMEOUT_MS = 3000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export const DEFAULT_DS2API_URL = process.env.DS2API_URL || "http://localhost:5001";

// Resolve the DS2API binary path: first DATA_DIR, then PATH
export function findDS2APIBinary() {
  for (const candidate of DS2API_BINARY_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const out = execSync(`${WHICH_CMD} ds2api`, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString().trim();
    return out ? out.split(/\r?\n/)[0].trim() : null;
  } catch {
    return null;
  }
}

export function getDS2APIDataDir() {
  if (!fs.existsSync(DS2API_DIR)) fs.mkdirSync(DS2API_DIR, { recursive: true });
  return DS2API_DIR;
}

// Probe whether DS2API is reachable at the given URL by hitting /v1/models
export async function probeDS2APIRunning(url) {
  if (!url) return false;
  const base = String(url).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export function isLoopbackDS2APIUrl(url) {
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Aggregate status for the dashboard: installed, running
export async function getDS2APIStatus(url) {
  const binaryPath = findDS2APIBinary();
  const installed = Boolean(binaryPath);
  const running = await probeDS2APIRunning(url);
  const localUrl = isLoopbackDS2APIUrl(url);
  return { installed, path: binaryPath, running, localUrl, canStart: installed && localUrl };
}

