// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

const inflight = new Map();

// Native dynamic import the bundler cannot rewrite. A plain `import(<string>)`
// in the published bundles is compiled into the bundler's own loader, and that
// loader is not native import: the standalone build folded a binding to
// undefined (v0.6.65), the CLI build mangled CJS interop (v0.6.66, "j is not a
// function") and treated a file:// URL as a module specifier (v0.6.67 on the
// server, "Cannot find module 'file:///...'" — the same URL imports fine in
// plain node). Constructing the import inside new Function puts it beyond the
// bundler's static reach, so V8 executes a real native import. Server-side
// Node only (new Function is not available under browser CSP).
const nativeImport = new Function("u", "return import(u)");

/**
 * Resolve a package's entry file from the runtime dir WITHOUT createRequire.
 * In the published webpack bundle every obtainable form of createRequire
 * proved fragile: the static named import had its binding folded to
 * `undefined` by the minifier ("(void 0).resolve(...)", shipped in v0.6.65),
 * and the dynamic-import form hit CJS interop — the namespace only exposes
 * `.default`, so the destructured `createRequire` was not a function
 * ("j is not a function", shipped in v0.6.66). Reading package.json and
 * walking the exports/main fields ourselves is interop-free and minifier-
 * proof. Covers the two pinned lazy deps (wreq-js, playwright-core), whose
 * "." export maps are simple condition objects; anything fancier falls
 * through to MODULE_NOT_FOUND and the on-demand install path below.
 */
function resolveRuntimeEntry(pkg) {
  const root = path.join(getRuntimeDir(), "node_modules", pkg);
  const missing = (msg) => Object.assign(new Error(msg), { code: "ERR_MODULE_NOT_FOUND" });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    throw missing(`Cannot find package '${pkg}' in the runtime dir`);
  }
  const dot = manifest.exports?.["."] ?? (typeof manifest.exports === "string" ? manifest.exports : null);
  const cond = typeof dot === "string"
    ? dot
    : (dot && typeof dot === "object" && !Array.isArray(dot) ? (dot.import || dot.default || dot.require || dot.node) : null);
  const target = cond || manifest.module || manifest.main;
  if (!target || typeof target !== "string") throw missing(`Package '${pkg}' has no resolvable entry`);
  const entry = path.join(root, target);
  if (!fs.existsSync(entry)) throw missing(`Cannot find module '${pkg}' (entry ${target} missing)`);
  return entry;
}

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await nativeImport(pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  try {
    return await nativeImport(pathToFileURL(resolveRuntimeEntry(pkg)).href);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
  return nativeImport(pathToFileURL(resolveRuntimeEntry(pkg)).href);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
