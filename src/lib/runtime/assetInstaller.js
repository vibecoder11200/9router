/**
 * Shared runtime asset-installer helpers: the five proven concerns of the
 * xray binary bootstrap (streamed download, sha256 verify, zip extraction,
 * staging swap with `.prev` rollback, prewarm) extracted so every runtime
 * binary installer (xray, bun, …) shares ONE implementation instead of
 * copy-pasting divergent copies.
 *
 * Pure helpers — no xray/bun knowledge, no version policy, no DATA_DIR.
 * Callers own version pinning, checksums, install dirs, and attribution.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/** Ensure a directory exists (helper for extraction targets). */
export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Windows path form for PowerShell quoting (forward slashes work too, but
// backslashes avoid edge cases in Expand-Archive's glob parser).
function winPath(p) {
  return p.replace(/\//g, "\\");
}

/**
 * Download a URL to a file path with optional progress reporting. Returns
 * `{ total, received }` when the download stream finishes.
 */
export async function downloadToFile(url, dest, { onProgress, signal } = {}) {
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  ensureDir(path.dirname(dest));
  const ws = createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    ws.write(Buffer.from(value));
    onProgress?.(received, total);
    if (signal?.aborted) throw new Error("download aborted");
  }
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.end(resolve);
  });
  return { total, received };
}

/** Stream a file through sha256 and return the hex digest. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

function spawnExtractor(cmd, args, { signal, failMsg }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", () => reject(new Error(failMsg)));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failMsg} (exit ${code})`));
    });
    if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGKILL"); } catch {} });
  });
}

/**
 * Extract a zip using the most reliable method for the platform:
 * PowerShell Expand-Archive on Windows (`-LiteralPath` — brackets in paths
 * don't trip the glob parser), `unzip` on Unix with a python3-zipfile
 * fallback.
 */
export async function extractZip(zipPath, destDir, { signal } = {}) {
  ensureDir(destDir);
  if (process.platform === "win32") {
    const psScript = `Expand-Archive -LiteralPath '${winPath(zipPath)}' -DestinationPath '${winPath(destDir)}' -Force`;
    await spawnExtractor("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      signal,
      failMsg: "powershell.exe not available",
    });
    return;
  }
  try {
    await spawnExtractor("unzip", ["-o", zipPath, "-d", destDir], { signal, failMsg: "unzip not available" });
  } catch {
    await spawnExtractor(
      "python3",
      ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, destDir],
      { failMsg: "neither unzip nor python3 available" },
    );
  }
}

// Windows EPERM dance (plan R9/FM-5): reinstalling over a running binary (or
// AV first-scan holding the file) makes rm/rename fail with EPERM/EBUSY.
// Retry with 200ms→2s backoff before the caller falls back to rollback.
const FS_RETRY_RETRIES = 5;
const FS_RETRY_BASE_MS = 200;
const FS_RETRY_MAX_MS = 2000;

const RETRYABLE_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENOTEMPTY"]);

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run a filesystem op with the Windows EPERM retry dance. Retries only
 * EPERM/EACCES/EBUSY/EMFILE/ENOTEMPTY; everything else rethrows immediately.
 */
export async function retryFs(op, { retries = FS_RETRY_RETRIES, baseMs = FS_RETRY_BASE_MS, maxMs = FS_RETRY_MAX_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (attempt >= retries || !RETRYABLE_FS_CODES.has(e?.code)) throw e;
      await sleep(Math.min(maxMs, baseMs * 2 ** attempt));
    }
  }
}

/**
 * Swap staged files into the final install dir, retaining the current files
 * in `prevDir` (rename, not rm — RT-5) as the rollback source for a failed
 * post-install restart. A swap that fails mid-loop (after the EPERM dance)
 * is undone from `prevDir` before throwing.
 *
 * `previousVersion` + `versionMarkerName` persist the caller's version string
 * inside `prevDir` — a rollback must restore the OLD version, or status APIs
 * report the failed tag as installed and reinstalling short-circuits.
 *
 * @returns {{ prevPopulated: boolean }}
 */
export async function atomicSwapIn({ stagingPath, finalPath, prevDir, previousVersion, versionMarkerName }) {
  let prevPopulated = false;
  try {
    fs.rmSync(prevDir, { recursive: true, force: true });
    fs.mkdirSync(prevDir, { recursive: true });
    for (const name of fs.readdirSync(stagingPath)) {
      const dest = path.join(finalPath, name);
      if (fs.existsSync(dest)) await retryFs(() => fs.renameSync(dest, path.join(prevDir, name)));
    }
    if (previousVersion && versionMarkerName) {
      fs.writeFileSync(path.join(prevDir, versionMarkerName), previousVersion);
    }
    prevPopulated = fs.readdirSync(prevDir).length > 0;
  } catch {
    // .prev best-effort — swap proceeds without a rollback source
  }

  try {
    for (const name of fs.readdirSync(stagingPath)) {
      const dest = path.join(finalPath, name);
      try {
        await retryFs(() => fs.rmSync(dest, { force: true, recursive: true }));
      } catch { /* dest absent / unremovable — rename below decides */ }
      await retryFs(() => fs.renameSync(path.join(stagingPath, name), dest));
    }
  } catch (swapErr) {
    if (prevPopulated) {
      try { restoreFromPrev({ prevDir, finalPath, versionMarkerName }); } catch { /* best-effort */ }
    }
    throw swapErr;
  }
  return { prevPopulated };
}

/**
 * Move `.prev` contents back into the install dir (auto-rollback). Restores
 * the version marker into `versionFile` when one was persisted. Returns
 * whether anything was restored.
 */
export function restoreFromPrev({ prevDir, finalPath, versionMarkerName, versionFile }) {
  if (!fs.existsSync(prevDir)) return false;
  let restored = false;
  if (versionMarkerName && versionFile) {
    const markerPath = path.join(prevDir, versionMarkerName);
    if (fs.existsSync(markerPath)) {
      try {
        const prevVersion = fs.readFileSync(markerPath, "utf8").trim();
        if (prevVersion) fs.writeFileSync(versionFile, prevVersion);
      } catch { /* best-effort */ }
      try { fs.rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
    }
  }
  for (const name of fs.readdirSync(prevDir)) {
    const dest = path.join(finalPath, name);
    try { fs.rmSync(dest, { force: true, recursive: true }); } catch { /* dest absent */ }
    try {
      fs.renameSync(path.join(prevDir, name), dest);
      restored = true;
    } catch { /* best-effort per file */ }
  }
  try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  return restored;
}

/**
 * Run a command to completion and resolve its exit status — absorbs AV
 * first-scan stalls on freshly-installed binaries (run `bun --version` once
 * so the scanner sees it before a request path ever spawns it).
 * @returns {Promise<{ ok: boolean, stdout: string, error?: string }>}
 */
export function prewarmCommand(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, stdout, error: `prewarm timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, error: err.message });
    });
    child.stdout?.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, error: code === 0 ? undefined : `exit code ${code}` });
    });
  });
}
