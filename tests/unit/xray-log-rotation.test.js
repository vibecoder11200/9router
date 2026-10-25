// Log hygiene for ~/.9router/xray/xray.log. Before rotation existed, every
// spawn path (managed start, blue-green switch, per-config temp probes)
// appended to one file forever — a box whose nodes violated the v26.10.21
// plaintext-VLESS policy grew a 318MB xray.log from failed-start blocks, and
// the dashboard log viewer then slurped the whole file per poll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
let originalDataDir;

let processModule;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-logrot-"));
  process.env.DATA_DIR = tempDir;
  // Import AFTER DATA_DIR is set: process.js resolves XRAY_DIR at module load.
  processModule = await import("../../src/lib/xray/process.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

function logPath() {
  return path.join(tempDir, "xray", "xray.log");
}

describe("maybeRotateXrayLog (spawn-boundary rotation)", () => {
  it("rotates an over-cap log to xray.log.old and starts a fresh file target", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    // Over the 10MiB cap by one line, with a recognizable tail.
    const filler = "x".repeat(1024);
    const lines = Array(10 * 1024 + 2).fill(filler); // > 10MiB of text
    lines[lines.length - 1] = "LAST-LINE-BEFORE-ROTATION";
    fs.writeFileSync(logPath(), lines.join("\n"));
    expect(fs.statSync(logPath()).size).toBeGreaterThan(10 * 1024 * 1024);

    processModule.maybeRotateXrayLog();

    expect(fs.existsSync(logPath())).toBe(false); // next openSync("a") starts fresh
    expect(fs.readFileSync(`${logPath()}.old`, "utf8").endsWith("LAST-LINE-BEFORE-ROTATION")).toBe(true);
  });

  it("replaces the previous .old on a second rotation (bounded disk: log + .old)", () => {
    fs.writeFileSync(logPath(), "second-generation");
    // Manually age the .old so the swap is observable.
    fs.writeFileSync(`${logPath()}.old`, "first-generation");
    fs.appendFileSync(logPath(), "x".repeat(10 * 1024 * 1024 + 1));

    processModule.maybeRotateXrayLog();

    expect(fs.existsSync(logPath())).toBe(false);
    expect(fs.readFileSync(`${logPath()}.old`, "utf8").startsWith("second-generation")).toBe(true);
  });

  it("is a no-op under the cap and when the log does not exist", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), "small");
    processModule.maybeRotateXrayLog();
    expect(fs.readFileSync(logPath(), "utf8")).toBe("small");

    fs.rmSync(logPath(), { force: true });
    expect(() => processModule.maybeRotateXrayLog()).not.toThrow();
  });
});

describe("getXrayLogTail on an oversized log (dashboard viewer)", () => {
  it("returns only the last maxLines from the tail window, without slurping the file", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    // 300KB of numbered lines — above the 256KB tail window. Track length
    // incrementally: re-joining per iteration is quadratic and times out.
    const lines = [];
    let total = 0;
    for (let i = 0; total <= 300 * 1024; i++) {
      lines.push(`line-${i}`);
      total += `line-${i}`.length + 1;
    }
    fs.writeFileSync(logPath(), lines.join("\n"));

    const tail = processModule.getXrayLogTail(5);
    const tailLines = tail.split("\n");
    expect(tailLines).toHaveLength(5);
    expect(tailLines.at(-1)).toBe(`line-${lines.length - 1}`);
    expect(tail).not.toContain("line-0\n"); // head of the file is outside the window
  });

  it("returns everything when the log is small", () => {
    fs.writeFileSync(logPath(), "one\ntwo\nthree");
    expect(processModule.getXrayLogTail(10)).toBe("one\ntwo\nthree");
    expect(processModule.getXrayLogTail()).toBe("one\ntwo\nthree");
  });
});
