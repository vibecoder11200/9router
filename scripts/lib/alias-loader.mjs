/**
 * ESM resolve hook mapping the repo's vite aliases for plain-node dev tools:
 *   "@/x"        -> <repoRoot>/src/x
 *   "open-sse/x" -> <repoRoot>/open-sse/x
 *
 * Registered from dev scripts via `register("./alias-loader.mjs", import.meta.url)`
 * (node >= 20.6) — lets app modules with "@/lib/..." imports run outside vitest.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// <root>/scripts/lib/alias-loader.mjs → walk up to the repo root
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export async function resolve(specifier, context, nextResolve) {
  let candidateBase = null;
  if (specifier.startsWith("@/")) candidateBase = path.join(REPO_ROOT, "src", specifier.slice(2));
  else if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    candidateBase = path.join(REPO_ROOT, "open-sse", specifier.slice("open-sse/".length));
  }
  if (candidateBase !== null) {
    // app code is webpack-style: extensionless specifiers resolve to .js or /index.js
    for (const candidate of [candidateBase, candidateBase + ".js", path.join(candidateBase, "index.js")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true, format: "module" };
      }
    }
  }
  return nextResolve(specifier, context);
}
