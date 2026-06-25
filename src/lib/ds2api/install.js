// DS2API binary installer: download the right GitHub release artifact for the
// current platform/arch, verify its sha256 against the release checksums, and
// extract it into DATA_DIR/ds2api. No Go toolchain required.
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

export const DS2API_VERSION = process.env.DS2API_VERSION || "v4.6.1";

const DS2API_DIR = path.join(DATA_DIR, "ds2api");
const VERSION_FILE = path.join(DS2API_DIR, ".installed_version");
const DOWNLOAD_TIMEOUT_MS = 180000;
const IS_WIN = process.platform === "win32";

export const BINARY_NAME = IS_WIN ? "ds2api.exe" : "ds2api";
export const BINARY_PATH = path.join(DS2API_DIR, BINARY_NAME);
export const STATIC_ADMIN_DIR = path.join(DS2API_DIR, "static", "admin");

const RELEASE_BASE = "https://github.com/CJackHwang/ds2api/releases/download";

// Map current Node platform/arch → ds2api release asset label + archive extension.
// Asset naming confirmed in temp/ds2api/scripts/{release-targets.sh,build-release-archives.sh}.
const PLATFORM_MAP = {
  "win32-x64": { label: "windows_amd64", ext: "zip" },
  "win32-arm64": { label: "windows_arm64", ext: "zip" },
  "darwin-x64": { label: "darwin_amd64", ext: "tar.gz" },
  "darwin-arm64": { label: "darwin_arm64", ext: "tar.gz" },
  "linux-x64": { label: "linux_amd64", ext: "tar.gz" },
  "linux-arm64": { label: "linux_arm64", ext: "tar.gz" },
  "linux-arm": { label: "linux_armv7", ext: "tar.gz" },
};

export function resolveAsset() {
  const key = `${process.platform}-${process.arch}`;
  const asset = PLATFORM_MAP[key];
  if (!asset) {
    const err = new Error(`Unsupported platform/arch for DS2API auto-install: ${key}`);
    err.code = "UNSUPPORTED_PLATFORM";
    throw err;
  }
  const file = `ds2api_${DS2API_VERSION}_${asset.label}.${asset.ext}`;
  return { ...asset, file, url: `${RELEASE_BASE}/${DS2API_VERSION}/${file}` };
}

function ensureDir() {
  if (!fs.existsSync(DS2API_DIR)) fs.mkdirSync(DS2API_DIR, { recursive: true });
}

export function getInstallStatus() {
  const binaryPresent = fs.existsSync(BINARY_PATH);
  let version = null;
  try {
    if (fs.existsSync(VERSION_FILE)) version = fs.readFileSync(VERSION_FILE, "utf8").trim();
  } catch { /* ignore */ }
  return {
    installed: binaryPresent,
    version,
    expectedVersion: DS2API_VERSION,
    upToDate: binaryPresent && version === DS2API_VERSION,
    binaryPath: binaryPresent ? BINARY_PATH : null,
    staticAdminPresent: fs.existsSync(STATIC_ADMIN_DIR),
  };
}

async function downloadToFile(url, dest) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  ensureDir();
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function fetchSha256Sums() {
  const url = `${RELEASE_BASE}/${DS2API_VERSION}/sha256sums.txt`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`sha256sums.txt download failed (${res.status})`);
  return res.text();
}

function expectedHash(sumsText, file) {
  // lines: "<sha256>  <file>"
  const line = sumsText.split(/\r?\n/).find((l) => l.trim().endsWith(file));
  return line ? line.trim().split(/\s+/)[0] : null;
}

function sha256File(dest) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(dest));
  return h.digest("hex");
}

// Extract a release archive into a staging dir. Archives contain a single top dir
// `ds2api_{ver}_{label}/` holding `ds2api(.exe)`, `static/admin/`, config.example.json, etc.
// Uses the `tar` CLI (bsdtar ships on Win10+, macOS, Linux) for both .tar.gz and .zip.
function extractArchive(archivePath, ext) {
  const staging = path.join(DS2API_DIR, ".stage");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const args = ext === "zip" ? ["-xf", archivePath, "-C", staging] : ["-xzf", archivePath, "-C", staging];
  try {
    execFileSync("tar", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const hint = IS_WIN
      ? "Extraction needs 'tar' (Windows 10+ bundles bsdtar) or run: Expand-Archive in PowerShell"
      : "Extraction needs 'tar' installed";
    throw new Error(`${hint}: ${e.message}`);
  }
  const entries = fs.readdirSync(staging).filter((n) => !n.startsWith("."));
  return entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()
    ? path.join(staging, entries[0])
    : staging;
}

export async function installDS2API({ force = false } = {}) {
  const status = getInstallStatus();
  if (status.upToDate && !force) return { ...status, skipped: true };

  const asset = resolveAsset();
  ensureDir();
  const archivePath = path.join(DS2API_DIR, asset.file);

  await downloadToFile(asset.url, archivePath);

  const expected = expectedHash(await fetchSha256Sums(), asset.file);
  if (expected) {
    const actual = sha256File(archivePath);
    if (actual !== expected) {
      fs.rmSync(archivePath, { force: true });
      throw new Error(`sha256 mismatch for ${asset.file}: expected ${expected}, got ${actual}`);
    }
  }

  const extractedRoot = extractArchive(archivePath, asset.ext);

  const binSrc = path.join(extractedRoot, BINARY_NAME);
  if (!fs.existsSync(binSrc)) throw new Error(`Binary ${BINARY_NAME} not found in archive`);
  fs.rmSync(BINARY_PATH, { force: true });
  fs.copyFileSync(binSrc, BINARY_PATH);
  if (!IS_WIN) fs.chmodSync(BINARY_PATH, 0o755);

  const staticSrc = path.join(extractedRoot, "static", "admin");
  if (fs.existsSync(staticSrc)) {
    fs.rmSync(STATIC_ADMIN_DIR, { recursive: true, force: true });
    fs.cpSync(staticSrc, STATIC_ADMIN_DIR, { recursive: true });
  }

  fs.rmSync(path.join(DS2API_DIR, ".stage"), { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
  fs.writeFileSync(VERSION_FILE, DS2API_VERSION);

  return getInstallStatus();
}

export { DS2API_DIR };
