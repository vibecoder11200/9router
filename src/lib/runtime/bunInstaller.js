/**
 * Bun runtime installer: download, verify, and extract the official Bun
 * release for the host platform into <DATA_DIR>/bun/, so the OpenCode free
 * lane can spawn per-request `bun` stdio children whose TLS stack
 * (BoringSSL) passes the v2 gate where Node's is refused (plan:
 * plans/261112-2130-opencode-bun-free-lane, P0 A/B evidence).
 *
 * Bun is Apache-2.0/MIT licensed (oven-sh/bun). Downloaded at runtime rather
 * than bundled: users get the right build per OS/arch without inflating
 * 9router's install size by ~40MB.
 *
 * Version pinning: BUN_VERSION is the exact version the free-gate A/B proved
 * (P0: bun 1.4.0 replay = 200, node = 429). Bumping is deliberate — re-measure
 * the per-asset sha256 digests below at the same time (the tests fail the
 * release if a digest is missing).
 */

import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir.js";
import {
  atomicSwapIn,
  downloadToFile,
  extractZip,
  prewarmCommand,
  restoreFromPrev,
  sha256File,
} from "@/lib/runtime/assetInstaller.js";

export const BUN_VERSION = "1.4.0";
export const BUN_RELEASES_URL = "https://github.com/oven-sh/bun/releases";

// Paths resolve lazily so DATA_DIR env changes (tests) take effect per call;
// production semantics are identical (DATA_DIR is fixed at boot).
const BUN_DIR = () => path.join(getDataDir(), "bun");
const BINARY_NAME = process.platform === "win32" ? "bun.exe" : "bun";
const BINARY_PATH = () => path.join(BUN_DIR(), BINARY_NAME);
const VERSION_FILE = () => path.join(BUN_DIR(), ".version");
// Scratch copy of `.version` kept inside `.prev` during an install so a
// rollback can restore the pre-install version string. Never part of the
// Bun zip, so the `.prev` retention loop can't pick it up by name.
const PREV_VERSION_MARKER = ".version.9r";
const BUN_TAG_RE = /^v\d+(\.\d+)+$/; // mirror of the xray tag guard — the URL is built from this string

// Release zip per platform/arch, each row digest-pinned (sha256 measured off
// the published artifact at pin time; sha256 fail-closed at install time).
// A bump of BUN_VERSION MUST re-measure every row below.
export const PLATFORM_ASSETS = {
  win32: {
    x64: {
      asset: "bun-windows-x64.zip",
      sha256: "e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901",
    },
  },
  linux: {
    x64: {
      asset: "bun-linux-x64.zip",
      sha256: "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
    },
  },
};

export function getBunDir() {
  return BUN_DIR();
}

export function getBunBinaryPath() {
  return BINARY_PATH();
}

/** Is the bun binary present and non-empty? */
export function isBunInstalled() {
  try {
    return fs.existsSync(BINARY_PATH()) && fs.statSync(BINARY_PATH()).size > 0;
  } catch {
    return false;
  }
}

/** Installed version from the `.version` marker, or null when absent. */
export function getInstalledBunVersion() {
  try {
    return fs.existsSync(VERSION_FILE())
      ? fs.readFileSync(VERSION_FILE(), "utf8").trim() || null
      : null;
  } catch {
    return null;
  }
}

/** Resolve the pinned release row for the current platform/arch. */
export function detectBunAsset(platform = process.platform, arch = process.arch) {
  const row = PLATFORM_ASSETS[platform]?.[arch];
  if (!row) {
    const err = new Error(`Unsupported platform for the bun lane: ${platform}/${arch}`);
    err.code = "BUN_PLATFORM_UNSUPPORTED";
    throw err;
  }
  return row;
}

// Single-flight install lock — two concurrent ensures share one download.
let installInFlight = null;

/**
 * Download (staging) → sha256 fail-closed against the pinned digest →
 * extract → chmod → atomic swap with `.prev` rollback → `.version` marker →
 * prewarm (`bun --version`, 60s deadline — absorbs AV first-scan stalls).
 *
 * @param {{ onProgress?: (msg: string) => void, signal?: AbortSignal }} opts
 * @returns {{ installed: true, version: string, path: string }}
 */
export async function installBun(opts = {}) {
  const { onProgress = () => {}, signal } = opts;
  if (installInFlight) return installInFlight;
  installInFlight = _installBun(opts).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

async function _installBun({ onProgress, signal }) {
  const log = (msg) => onProgress?.(msg);

  if (!BUN_TAG_RE.test(`v${BUN_VERSION}`)) {
    const err = new Error(`invalid bun version: ${BUN_VERSION}`);
    err.code = "INVALID_VERSION";
    throw err;
  }

  if (getInstalledBunVersion() === BUN_VERSION && isBunInstalled()) {
    log(`bun ${BUN_VERSION} already installed at ${BINARY_PATH()}`);
    return { installed: true, version: BUN_VERSION, path: BINARY_PATH(), alreadyInstalled: true };
  }

  const row = detectBunAsset();
  const zipUrl = `${BUN_RELEASES_URL}/download/bun-v${BUN_VERSION}/${row.asset}`;
  const zipPath = path.join(BUN_DIR(), row.asset);

  fs.mkdirSync(BUN_DIR(), { recursive: true });
  log(`Downloading bun ${BUN_VERSION} (${row.asset})...`);
  try {
    await downloadToFile(zipUrl, zipPath, { signal });
  } catch (e) {
    throw new Error(`Failed to download ${row.asset}: ${e.message}`);
  }

  log("Verifying checksum (pinned sha256)...");
  let actualHash;
  try {
    actualHash = await sha256File(zipPath);
  } catch (e) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error(`Could not hash ${row.asset}: ${e.message}`);
  }
  if (actualHash !== row.sha256) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error(`Checksum mismatch for ${row.asset} (got sha256 ${actualHash}) — refusing to install`);
  }
  log(`Checksum verified (sha256 ${actualHash.slice(0, 12)}…), extracting to staging...`);

  const stagingDir = path.join(BUN_DIR(), `.staging-${Date.now()}`);
  const prevDir = path.join(BUN_DIR(), ".prev");
  try {
    await extractZip(zipPath, stagingDir, { signal });

    // The Bun zip nests the binary inside bun-v<version>/ — flatten the
    // staging dir FIRST so the swap moves files (not a nested version dir)
    // into BUN_DIR and the binary lands at <DATA_DIR>/bun/bun[.exe].
    const stagedBinary = findStagedBinary(stagingDir);
    if (!stagedBinary || fs.statSync(stagedBinary).size === 0) {
      throw new Error(`archive did not contain a usable ${BINARY_NAME}`);
    }
    flattenStagingDir(stagingDir);

    await atomicSwapIn({
      stagingPath: stagingDir,
      finalPath: BUN_DIR(),
      prevDir,
      previousVersion: getInstalledBunVersion(),
      versionMarkerName: PREV_VERSION_MARKER,
    });
  } catch (e) {
    throw new Error(`Failed to install verified archive: ${e.message}`);
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }

  if (process.platform !== "win32") {
    try { fs.chmodSync(BINARY_PATH(), 0o755); } catch {}
  }

  fs.writeFileSync(VERSION_FILE(), BUN_VERSION);
  try { fs.unlinkSync(zipPath); } catch {}
  log(`bun ${BUN_VERSION} installed at ${BINARY_PATH()}`);

  // Record Apache-2.0/MIT attribution.
  try {
    fs.writeFileSync(
      path.join(BUN_DIR(), "LICENSE.bun.txt"),
      `Bun is licensed under the MIT license with portions under Apache-2.0 by Oven.\nSource: https://github.com/oven-sh/bun\nRelease: bun-v${BUN_VERSION}\n`,
    );
  } catch {}

  // Prewarm: absorb AV first-scan stalls before a request path spawns it.
  const prewarm = await prewarmCommand(BINARY_PATH(), ["--version"], { timeoutMs: 60_000 });
  if (!prewarm.ok) {
    log(`bun prewarm failed (${prewarm.error}) — lane errors will surface typed; binary may still work`);
  } else {
    log(`bun prewarm OK (${prewarm.stdout.trim()})`);
  }

  return { installed: true, version: BUN_VERSION, path: BINARY_PATH(), alreadyInstalled: false };
}

/** First file inside the staging dir matching the platform binary name. */
function findStagedBinary(stagingDir) {
  const direct = path.join(stagingDir, BINARY_NAME);
  if (fs.existsSync(direct)) return direct;
  const nested = fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(stagingDir, e.name, BINARY_NAME))
    .find((p) => fs.existsSync(p));
  return nested || null;
}

/**
 * Move the nested zip directory's contents (e.g. `bun-v1.4.0/`) up into the
 * staging root (and drop the emptied nested dir) so the atomic swap moves
 * files, not a nested version dir.
 */
function flattenStagingDir(stagingDir) {
  const nested = fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  for (const dir of nested) {
    const nestedPath = path.join(stagingDir, dir.name);
    for (const name of fs.readdirSync(nestedPath)) {
      fs.renameSync(path.join(nestedPath, name), path.join(stagingDir, name));
    }
    try { fs.rmdirSync(nestedPath); } catch { /* best-effort */ }
  }
}

/** Move `.prev` contents back into the install dir (auto-rollback). */
export function rollbackBunToPrev() {
  return restoreFromPrev({
    prevDir: path.join(BUN_DIR(), ".prev"),
    finalPath: BUN_DIR(),
    versionMarkerName: PREV_VERSION_MARKER,
    versionFile: VERSION_FILE(),
  });
}

/** Ensure bun is installed, installing on demand. Returns the binary path. */
export async function ensureBunInstalled({ onProgress, signal } = {}) {
  if (isBunInstalled()) return getBunBinaryPath();
  await installBun({ onProgress, signal });
  return getBunBinaryPath();
}

/** Remove the bun binary and all extracted assets. */
export function uninstallBun() {
  if (!fs.existsSync(BUN_DIR())) return { removed: false };
  try {
    fs.rmSync(BUN_DIR(), { recursive: true, force: true });
    return { removed: true };
  } catch (e) {
    return { removed: false, error: e.message };
  }
}
