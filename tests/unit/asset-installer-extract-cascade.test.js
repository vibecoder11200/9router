import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// child_process is mocked FILE-WIDE (ESM namespace spies don't work), so the
// extractZip cascade tests live in their own file away from prewarmCommand.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: spawnMock };
});

import { extractZip } from "../../src/lib/runtime/assetInstaller.js";

let tmp;

function fakeExtractor(behavior) {
  const { EventEmitter } = require("node:events");
  const fake = new EventEmitter();
  process.nextTick(() => behavior(fake));
  return fake;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-"));
  spawnMock.mockReset();
});

describe("extractZip cascade", () => {
  it("uses the platform's first-choice extractor and rejects when it fails", async () => {
    spawnMock.mockImplementation(() => fakeExtractor((f) => f.emit("exit", 1)));
    await expect(extractZip("z.zip", path.join(tmp, "out"))).rejects.toThrow(/exit 1/);
    const firstCmd = spawnMock.mock.calls[0][0];
    if (process.platform === "win32") expect(firstCmd).toBe("powershell.exe");
    else expect(firstCmd).toBe("unzip");
  });

  it("falls back to python3 when unzip is missing (non-Windows)", async () => {
    if (process.platform === "win32") return; // cascade applies to Unix only
    spawnMock.mockImplementation((cmd) =>
      fakeExtractor((f) => (cmd === "unzip" ? f.emit("error", new Error("not found")) : f.emit("exit", 0))),
    );
    await extractZip("z.zip", path.join(tmp, "out2"));
    expect(spawnMock.mock.calls.map((c) => c[0])).toContain("python3");
  });

  it("abort signal fires the kill path and the failure surfaces", async () => {
    const controller = new AbortController();
    spawnMock.mockImplementation(() =>
      fakeExtractor((f) => {
        setTimeout(() => controller.abort(), 10);
        setTimeout(() => f.emit("exit", 1), 30);
      }),
    );
    await expect(
      extractZip("z.zip", path.join(tmp, "out3"), { signal: controller.signal }),
    ).rejects.toThrow(/exit 1/);
  });
});
