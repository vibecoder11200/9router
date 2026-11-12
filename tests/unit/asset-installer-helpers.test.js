import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  atomicSwapIn,
  downloadToFile,
  extractZip,
  prewarmCommand,
  restoreFromPrev,
  retryFs,
  sha256File,
} from "../../src/lib/runtime/assetInstaller.js";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assetinst-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("downloadToFile", () => {
  it("streams a response body to disk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello asset", { status: 200 })));
    try {
      const dest = path.join(tmp, "sub", "asset.bin");
      const res = await downloadToFile("https://example.test/a", dest);
      expect(res.received).toBe(11);
      expect(fs.readFileSync(dest, "utf8")).toBe("hello asset");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("non-OK response throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    try {
      await expect(
        downloadToFile("https://example.test/a", path.join(tmp, "x.bin")),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("sha256File", () => {
  it("hashes file content", async () => {
    const { createHash } = await import("node:crypto");
    const f = path.join(tmp, "h.bin");
    fs.writeFileSync(f, "deterministic");
    expect(await sha256File(f)).toBe(createHash("sha256").update("deterministic").digest("hex"));
  });
});

describe("retryFs — Windows EPERM dance", () => {
  it("retries EPERM then succeeds", async () => {
    let calls = 0;
    const out = await retryFs(() => {
      if (++calls < 3) {
        const e = new Error("locked");
        e.code = "EPERM";
        throw e;
      }
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows non-retryable codes immediately", async () => {
    let calls = 0;
    await expect(
      retryFs(() => {
        calls++;
        const e = new Error("nope");
        e.code = "ENOENT";
        throw e;
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });
});

describe("atomicSwapIn", () => {
  it("archives existing files to .prev, swaps staging in, persists version marker", async () => {
    const finalDir = path.join(tmp, "final");
    const prevDir = path.join(finalDir, ".prev");
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, "old.exe"), "OLD");
    fs.writeFileSync(path.join(finalDir, ".version"), "v1");

    const staging = path.join(tmp, "staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "new.exe"), "NEW");
    fs.writeFileSync(path.join(staging, "LICENSE.txt"), "LICENSE");

    const { prevPopulated } = await atomicSwapIn({
      stagingPath: staging,
      finalPath: finalDir,
      prevDir,
      previousVersion: "v1",
      versionMarkerName: ".version.9r",
    });

    expect(prevPopulated).toBe(true);
    expect(fs.readFileSync(path.join(finalDir, "new.exe"), "utf8")).toBe("NEW");
    // only staging-named files are swapped/archived (xray RT-5 semantics):
    // foreign pre-existing files stay untouched in the final dir
    expect(fs.readFileSync(path.join(finalDir, "old.exe"), "utf8")).toBe("OLD");
    expect(fs.readFileSync(path.join(finalDir, ".version"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(prevDir, ".version.9r"), "utf8")).toBe("v1");
  });

  it("EPERM during swap is retried, then rolled back (Windows sim)", { timeout: 20_000 }, async () => {
    const finalDir = path.join(tmp, "final");
    const prevDir = path.join(finalDir, ".prev");
    fs.mkdirSync(finalDir, { recursive: true });
    // a STAGING-named file pre-exists → it is archived to .prev, and the
    // failing swap rename must roll it back from there
    fs.writeFileSync(path.join(finalDir, "new.exe"), "STALE");

    const staging = path.join(tmp, "staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "new.exe"), "NEW");

    const realRename = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      renameCalls++;
      // fail ONLY the swap direction (staging → final); archive (final →
      // .prev) and rollback (.prev → final) renames must pass through
      if (String(a).includes(staging)) {
        const e = new Error("EPERM sim");
        e.code = "EPERM";
        throw e;
      }
      return realRename(a, b);
    });

    try {
      await expect(
        atomicSwapIn({ stagingPath: staging, finalPath: finalDir, prevDir }),
      ).rejects.toThrow(/EPERM sim/);
      // the EPERM dance retried the rename before giving up (>=5 attempts)
      expect(renameCalls).toBeGreaterThanOrEqual(5);
      // rollback restored the archived STALE file from .prev
      expect(fs.readFileSync(path.join(finalDir, "new.exe"), "utf8")).toBe("STALE");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("restoreFromPrev", () => {
  it("restores files and the version marker", () => {
    const finalDir = path.join(tmp, "final");
    const prevDir = path.join(finalDir, ".prev");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(path.join(prevDir, "bin.exe"), "OLD");
    fs.writeFileSync(path.join(prevDir, ".version.9r"), "v1");
    fs.writeFileSync(path.join(finalDir, "bin.exe"), "BROKEN");
    fs.writeFileSync(path.join(finalDir, ".version"), "v2-bad");

    const restored = restoreFromPrev({
      prevDir,
      finalPath: finalDir,
      versionMarkerName: ".version.9r",
      versionFile: path.join(finalDir, ".version"),
    });
    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(finalDir, "bin.exe"), "utf8")).toBe("OLD");
    expect(fs.readFileSync(path.join(finalDir, ".version"), "utf8")).toBe("v1");
  });
});

describe("prewarmCommand", () => {
  it("resolves ok for a zero-exit command", async () => {
    const res = await prewarmCommand(process.execPath, ["-e", "console.log('warm')"], { timeoutMs: 15_000 });
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("warm");
  });

  it("resolves not-ok for a failing command", async () => {
    const res = await prewarmCommand(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 15_000 });
    expect(res.ok).toBe(false);
  });
});

