// Regression test: the genspark TLS sidecar harness is compiled into shared
// server chunks (pulled in by /api/providers/suggested-models and chunk 5330),
// where webpack freezes `import.meta.url` to the BUILD machine's file URL.
// A CLI bundle built on Linux (file:///root/9router/...) and installed on
// Windows made fileURLToPath throw ERR_INVALID_FILE_URL_PATH at module scope,
// 500-ing every route whose chunk loads the harness. The module must survive
// a frozen import.meta.url that is not a valid path on the running OS.
//
// We mock `node:url` to throw exactly that error, then import the module.

import { describe, it, expect, vi } from "vitest";

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fileURLToPath: () => {
      const err = new TypeError("File URL path must be absolute");
      err.code = "ERR_INVALID_FILE_URL_PATH";
      throw err;
    },
  };
});

import path from "node:path";

describe("gensparkTlsSidecar frozen import.meta.url (cross-platform bundle)", () => {
  it("imports without throwing when the frozen URL is invalid on this OS", async () => {
    delete process.env.GENSPARK_SIDECAR_SCRIPT;
    const mod = await import("open-sse/services/gensparkTlsSidecar.js");
    expect(typeof mod.SIDECAR_SCRIPT).toBe("string");
    expect(mod.SIDECAR_SCRIPT.length).toBeGreaterThan(0);
  });

  it("resolves SIDECAR_SCRIPT from the cwd/HOME candidates, never from __dirname", async () => {
    delete process.env.GENSPARK_SIDECAR_SCRIPT;
    const { SIDECAR_SCRIPT } = await import("open-sse/services/gensparkTlsSidecar.js");
    // __dirname is null under the mock, so every reachable candidate (found
    // or default) comes from this exact set regardless of machine layout.
    const reachable = new Set([
      path.join("open-sse", "services", "gensparkTlsSidecar.py"),
      "/root/9router/open-sse/services/gensparkTlsSidecar.py",
      path.join(process.env.HOME || "/root", "9router", "open-sse", "services", "gensparkTlsSidecar.py"),
    ]);
    expect(reachable.has(SIDECAR_SCRIPT)).toBe(true);
  });
});
