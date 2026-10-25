/**
 * Xray-core binary bootstrap: download, verify, and extract the official
 * xray release for the host platform into ~/.9router/xray/.
 *
 * The binary is MPL-2.0 licensed (XTLS/Xray-core). We download at runtime
 * rather than bundling it in-repo so users get the right build per OS/arch
 * without inflating 9router's install size by ~60MB. The license text and
 * attribution are preserved alongside the binary.
 *
 * Version pinning: XRAY_VERSION below is the default. Override at runtime
 * via the XRAY_VERSION env var to upgrade/downgrade. The installed version
 * is recorded in a .version file and re-checked on each start.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

// Latest verified stable as of implementation. All newer tags are marked
// prerelease at time of writing. Override with the XRAY_VERSION env var.
export const XRAY_VERSION = process.env.XRAY_VERSION || "v26.3.27";
export const XRAY_RELEASES_URL = "https://github.com/XTLS/Xray-core/releases";

const XRAY_DIR = path.join(DATA_DIR, "xray");
const BINARY_NAME = process.platform === "win32" ? "xray.exe" : "xray";
const BINARY_PATH = path.join(XRAY_DIR, BINARY_NAME);
const VERSION_FILE = path.join(XRAY_DIR, ".version");
// Scratch copy of `.version` kept inside `.prev` during an install so a
// rollback can restore the pre-install version string (RT-5). Never part of
// the Xray zip, so the `.prev` retention loop can't pick it up by name.
const PREV_VERSION_MARKER = ".version.9r";
const DOWNLOAD_LOG = path.join(XRAY_DIR, "download.log");

// Release asset naming per platform/arch. Verified against the XTLS/Xray-core
// releases page (each platform ships a Xray-<os>-<arch>.zip + .dgst pair).
const PLATFORM_ASSETS = {
  win32: {
    x64: "Xray-windows-64.zip",
    ia32: "Xray-windows-32.zip",
    arm64: "Xray-windows-arm64-v8a.zip",
  },
  linux: {
    x64: "Xray-linux-64.zip",
    arm64: "Xray-linux-arm64-v8a.zip",
    arm: "Xray-linux-arm32-v7a.zip",
  },
  darwin: {
    x64: "Xray-macos-64.zip",
    arm64: "Xray-macos-arm64-v8a.zip",
  },
};

export function getXrayDir() {
  return XRAY_DIR;
}

export function getXrayBinaryPath() {
  return BINARY_PATH;
}

export function getXrayConfigPath() {
  return path.join(XRAY_DIR, "config.json");
}

/** Resolve the release zip asset name for the current (or given) platform. */
export function detectPlatformAsset(platform = process.platform, arch = process.arch) {
  const map = PLATFORM_ASSETS[platform];
  if (!map) {
    const err = new Error(`Unsupported platform: ${platform}`);
    err.code = "UNSUPPORTED_PLATFORM";
    throw err;
  }
  const asset = map[arch];
  if (!asset) {
    const err = new Error(`Unsupported arch ${arch} for ${platform}`);
    err.code = "UNSUPPORTED_ARCH";
    throw err;
  }
  return asset;
}

/** Is the xray binary present and executable? */
export function isXrayInstalled() {
  try {
    return fs.existsSync(BINARY_PATH) && fs.statSync(BINARY_PATH).size > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the installed version (from .version file), or null if the binary
 * is absent. Does NOT invoke the binary — use getXrayRuntimeVersion for that.
 */
export function getInstalledVersion() {
  try {
    return fs.existsSync(VERSION_FILE)
      ? fs.readFileSync(VERSION_FILE, "utf8").trim() || null
      : null;
  } catch {
    return null;
  }
}

/** Run `xray version` and parse the first line. Returns null on failure. */
export function getXrayRuntimeVersion() {
  return new Promise((resolve) => {
    if (!isXrayInstalled()) return resolve(null);
    execFile(BINARY_PATH, ["version"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/Xray\s+([\d.]+)/i) || stdout.match(/v?([\d.]+)/);
      resolve(m ? m[1] : stdout.split("\n")[0].trim() || null);
    });
  });
}

function ensureDir() {
  if (!fs.existsSync(XRAY_DIR)) fs.mkdirSync(XRAY_DIR, { recursive: true });
}

/**
 * Download a URL to a file path with progress reporting via the callback.
 * Returns when the download stream finishes.
 */
async function downloadToFile(url, dest, { signal } = {}) {
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  ensureDir();
  const ws = createWriteStream(dest);
  let received = 0;
  // Read body as a stream and pipe to disk, reporting progress.
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    ws.write(Buffer.from(value));
    if (signal?.aborted) throw new Error("download aborted");
  }
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.end(resolve);
  });
  return { total, received };
}

/**
 * Extract a zip using the most reliable method for the platform.
 *
 * Windows: PowerShell's Expand-Archive is the most universally available
 * zip extractor (GNU tar in Git Bash can't do zips; bsdtar exists on Win10+
 * but may be shadowed by GNU tar in PATH). We shell out to powershell.exe.
 *
 * macOS/Linux: the `unzip` command is pre-installed on macOS and virtually
 * every Linux distro. Falls back to Python's zipfile module if absent.
 */
async function extractZip(zipPath, destDir, { signal } = {}) {
  ensureDirFn(destDir);
  if (process.platform === "win32") {
    // PowerShell Expand-Archive — robust on all Windows 10+ setups.
    // Use -LiteralPath so brackets in the path don't trip the glob parser.
    const psScript = `Expand-Archive -LiteralPath '${winPath(zipPath)}' -DestinationPath '${winPath(destDir)}' -Force`;
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => reject(new Error("powershell.exe not available")));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`powershell Expand-Archive exited with code ${code}`));
      });
      if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGKILL"); } catch {} });
    });
    return;
  }
  // Unix: try unzip, fall back to python3.
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("unzip", ["-o", zipPath, "-d", destDir], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => reject(new Error("unzip not available")));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`unzip exited with code ${code}`));
      });
      if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGKILL"); } catch {} });
    });
  } catch (e) {
    // Fallback: python3 zipfile
    await new Promise((resolve, reject) => {
      const script = `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`;
      const child = spawn("python3", ["-c", script, zipPath, destDir], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => reject(new Error("neither unzip nor python3 available")));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`python3 zipfile exited with code ${code}`));
      });
    });
  }
}

// Ensure a directory exists (helper for extraction target).
function ensureDirFn(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Convert a path to Windows backslash form for PowerShell (forward slashes
// work too, but backslashes avoid any edge cases with PowerShell quoting).
function winPath(p) {
  return p.replace(/\//g, "\\");
}

/** Stream a file through sha256 and return the hex digest. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Strict release-tag validation (RT-1, Critical): `installXray` builds BOTH
 * the zip URL and the `.dgst` URL from this string with `redirect: "follow"`
 * — a traversal payload like "../../../../attacker/repo/releases/download/v1"
 * would otherwise fetch an attacker's zip AND the attacker's `.dgst`, making
 * the sha256 gate verify against the attacker's own digest. Enforced here
 * AND at the API route (defense in depth — the lib is also callable from
 * boot paths).
 */
const XRAY_TAG_RE = /^v\d+(\.\d+)+$/;

export function isValidXrayTag(version) {
  return typeof version === "string" && XRAY_TAG_RE.test(version);
}

/**
 * Download and install the xray binary for the current platform.
 * Skips if the requested version is already installed.
 *
 * X5 supply-chain hardening: the published `.dgst` checksum is fetched and
 * the archive's sha256 verified BEFORE extraction; extraction goes to a
 * staging dir; a running managed instance is stopped before the verified
 * files are swapped into place. A missing/unparseable .dgst fails the install
 * (fail-closed — never run an unverified binary).
 *
 * RT-5 swap hardening: the previous files are RETAINED in `.prev` (rename,
 * not rm) so a failed post-install restart can auto-rollback; a swap that
 * fails mid-loop is undone from `.prev` before throwing.
 *
 * @param {{ version?: string, onProgress?: (msg) => void, signal?: AbortSignal }} opts
 * @returns {{ installed: true, version: string, path: string }}
 */
export async function installXray(opts = {}) {
  const { version = XRAY_VERSION, onProgress = () => {}, signal } = opts;
  const log = (msg) => {
    onProgress(msg);
    try { ensureDir(); fs.appendFileSync(DOWNLOAD_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  };

  if (!isValidXrayTag(version)) {
    const err = new Error(`invalid xray version tag: ${JSON.stringify(version)}`);
    err.code = "INVALID_VERSION";
    throw err;
  }

  const installedVersion = getInstalledVersion();
  if (installedVersion === version && isXrayInstalled()) {
    log(`xray ${version} already installed at ${BINARY_PATH}`);
    return { installed: true, version, path: BINARY_PATH, alreadyInstalled: true };
  }

  const asset = detectPlatformAsset();
  const baseUrl = `${XRAY_RELEASES_URL}/download/${version}`;
  const zipUrl = `${baseUrl}/${asset}`;
  const zipPath = path.join(XRAY_DIR, asset);

  ensureDir();
  log(`Downloading xray ${version} (${asset})...`);
  try {
    await downloadToFile(zipUrl, zipPath, { signal });
  } catch (e) {
    throw new Error(`Failed to download ${asset}: ${e.message}`);
  }

  // Verify the published checksum before touching the install dir (X5).
  log(`Verifying checksum (${asset}.dgst)...`);
  let expectedHashes;
  try {
    const dgstRes = await fetch(`${zipUrl}.dgst`, { redirect: "follow", signal });
    if (!dgstRes.ok) throw new Error(`HTTP ${dgstRes.status} ${dgstRes.statusText}`);
    const dgstText = await dgstRes.text();
    // The .dgst lists digests in several algorithms; 64-hex tokens are sha256.
    expectedHashes = [...dgstText.matchAll(/\b[a-f0-9]{64}\b/gi)].map((m) => m[0].toLowerCase());
    if (expectedHashes.length === 0) throw new Error("no sha256 digest found in .dgst");
  } catch (e) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error(`Checksum verification unavailable for ${asset} (${e.message}) — refusing to install an unverified binary`);
  }
  const actualHash = await sha256File(zipPath);
  if (!expectedHashes.includes(actualHash)) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error(`Checksum mismatch for ${asset} (got sha256 ${actualHash}) — refusing to install`);
  }
  log(`Checksum verified (sha256 ${actualHash.slice(0, 12)}…), extracting to staging...`);

  const stagingDir = path.join(XRAY_DIR, `.staging-${Date.now()}`);
  const prevDir = path.join(XRAY_DIR, ".prev");
  try {
    await extractZip(zipPath, stagingDir, { signal });

    const stagedBinary = path.join(stagingDir, BINARY_NAME);
    if (!fs.existsSync(stagedBinary) || fs.statSync(stagedBinary).size === 0) {
      throw new Error(`archive did not contain a usable ${BINARY_NAME}`);
    }

    // Stop a running managed instance before swapping the binary out from
    // under it (Windows also refuses to replace a running .exe) (X5). The
    // stop also clears the stale PID file so a crash mid-swap never leaves
    // the manager pointing at a dead process.
    try {
      const { getManagedPid, terminateXrayPid, setManagedPid } = await import("./process.js");
      const runningPid = getManagedPid();
      if (runningPid) {
        log("Stopping running xray before binary swap...");
        await terminateXrayPid(runningPid);
        setManagedPid(null);
      }
    } catch { /* process module/pid unavailable — proceed with the swap */ }

    // Retain the current files in `.prev` (rename, not rm) BEFORE swapping —
    // the auto-rollback source for a failed post-install restart (RT-5).
    let prevPopulated = false;
    try {
      const previousVersion = getInstalledVersion();
      fs.rmSync(prevDir, { recursive: true, force: true });
      fs.mkdirSync(prevDir, { recursive: true });
      for (const name of fs.readdirSync(stagingDir)) {
        const dest = path.join(XRAY_DIR, name);
        if (fs.existsSync(dest)) fs.renameSync(dest, path.join(prevDir, name));
      }
      // `.version` is 9router's own file (never part of the Xray zip), so the
      // loop above never archives it. Persist it separately: rollback must
      // restore the OLD version string, or status/APIs report the failed tag
      // as installed and reinstalling that tag short-circuits as
      // alreadyInstalled with the rolled-back binary.
      if (previousVersion) fs.writeFileSync(path.join(prevDir, PREV_VERSION_MARKER), previousVersion);
      prevPopulated = fs.readdirSync(prevDir).length > 0;
    } catch { /* .prev best-effort — swap proceeds without rollback source */ }

    try {
      for (const name of fs.readdirSync(stagingDir)) {
        const dest = path.join(XRAY_DIR, name);
        try { fs.rmSync(dest, { force: true, recursive: true }); } catch { /* dest absent */ }
        fs.renameSync(path.join(stagingDir, name), dest);
      }
    } catch (swapErr) {
      // Mid-swap failure on a mixed-version dir is worse than the old
      // install: undo from `.prev` before propagating.
      if (prevPopulated) {
        log(`swap failed (${swapErr.message}) — restoring previous files from .prev`);
        try { restoreFromPrevDir(); } catch { /* best-effort */ }
      }
      throw swapErr;
    }
  } catch (e) {
    throw new Error(`Failed to install verified archive: ${e.message}`);
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // chmod +x on Unix so the binary is executable.
  if (process.platform !== "win32") {
    try { fs.chmodSync(BINARY_PATH, 0o755); } catch {}
  }

  fs.writeFileSync(VERSION_FILE, version);
  try { fs.unlinkSync(zipPath); } catch {}
  log(`xray ${version} installed at ${BINARY_PATH}`);

  // Record MPL-2.0 attribution.
  try {
    fs.writeFileSync(
      path.join(XRAY_DIR, "LICENSE.xray.txt"),
      `Xray-core is licensed under MPL-2.0 by XTLS.\nSource: https://github.com/XTLS/Xray-core\nRelease: ${version}\n`
    );
  } catch {}

  return { installed: true, version, path: BINARY_PATH, alreadyInstalled: false };
}

/** Move `.prev` contents back into the install dir (auto-rollback, RT-5). */
export function rollbackXrayToPrev() {
  return restoreFromPrevDir();
}

/** Version held in `.prev` (the RT-5 rollback source), or null if none. */
export function getPrevXrayVersion() {
  try {
    const marker = path.join(XRAY_DIR, ".prev", PREV_VERSION_MARKER);
    if (!fs.existsSync(marker)) return null;
    return fs.readFileSync(marker, "utf8").trim() || null;
  } catch { return null; }
}

function restoreFromPrevDir() {
  const prevDir = path.join(XRAY_DIR, ".prev");
  if (!fs.existsSync(prevDir)) return false;
  let restored = false;
  // The version marker belongs to VERSION_FILE, not the install dir — after a
  // rollback the file must name the binary that is actually running again.
  const markerPath = path.join(prevDir, PREV_VERSION_MARKER);
  if (fs.existsSync(markerPath)) {
    try {
      const prevVersion = fs.readFileSync(markerPath, "utf8").trim();
      if (prevVersion) fs.writeFileSync(VERSION_FILE, prevVersion);
    } catch { /* best-effort */ }
    try { fs.rmSync(markerPath, { force: true }); } catch { /* best-effort */ }
  }
  for (const name of fs.readdirSync(prevDir)) {
    const dest = path.join(XRAY_DIR, name);
    try { fs.rmSync(dest, { force: true, recursive: true }); } catch { /* dest absent */ }
    try {
      fs.renameSync(path.join(prevDir, name), dest);
      restored = true;
    } catch { /* best-effort per file */ }
  }
  try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  return restored;
}

/** Remove the xray binary and all extracted assets. */
export function uninstallXray() {
  if (!fs.existsSync(XRAY_DIR)) return { removed: false };
  try {
    fs.rmSync(XRAY_DIR, { recursive: true, force: true });
    return { removed: true };
  } catch (e) {
    return { removed: false, error: e.message };
  }
}

/** Tail the download/install log for UI progress display. */
export function getDownloadLogTail(maxLines = 30) {
  try {
    if (!fs.existsSync(DOWNLOAD_LOG)) return "";
    const lines = fs.readFileSync(DOWNLOAD_LOG, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}
