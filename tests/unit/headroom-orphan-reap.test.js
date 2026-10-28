// Boot-reaper tests for the managed headroom proxy (audit F5): the start/
// stop/restart paths must only trust a cmdline-VERIFIED pid, and an orphan
// from a previous instance must be reaped at boot instead of adopted forever.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/lib/processGuard.js", () => ({ probeProcess: vi.fn(() => "ours") }));
vi.mock("../../src/lib/headroom/detect.js", () => ({
  findHeadroomBinary: vi.fn(() => null),
  findPython310: vi.fn(() => null),
  HEADROOM_COMPRESSION_EXTRAS: [],
  EXTRA_MARKERS: {},
  getInstalledHeadroomExtras: vi.fn(() => ({})),
}));

let tempDir;
let originalDataDir;
let processModule;
let killSpy;

const FAKE_PID = 4194306;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-headroom-reap-"));
  process.env.DATA_DIR = tempDir;
  processModule = await import("../../src/lib/headroom/process.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake */ }
});

afterEach(() => {
  killSpy?.mockRestore();
  try { fs.rmSync(path.join(tempDir, "headroom"), { recursive: true, force: true }); } catch {}
});

function fakeAliveKill() {
  killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) return true; // isPidAlive → alive
    return undefined; // SIGTERM/SIGKILL swallowed — nothing is really killed
  });
}

function pidPath() {
  return path.join(tempDir, "headroom", "proxy.pid");
}

function writeFakePidFile(pid = FAKE_PID) {
  fs.mkdirSync(path.dirname(pidPath()), { recursive: true });
  fs.writeFileSync(pidPath(), String(pid));
}

describe("reapOrphanedManagedHeadroom (boot-time orphan reaper, F5)", () => {
  it("kills a live managed proxy left by a previous instance and clears the pid file", async () => {
    fakeAliveKill();
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedHeadroom();
    expect(result.killed).toBe(true);
    expect(result.pid).toBe(FAKE_PID);
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  it("does NOT kill an UNPROVABLE pid (pid-reuse guard)", async () => {
    fakeAliveKill();
    const { probeProcess } = await import("../../src/lib/processGuard.js");
    probeProcess.mockReturnValueOnce("unknown");
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedHeadroom();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("unverified");
    expect(fs.existsSync(pidPath())).toBe(true);
  });

  it("is a no-op when no managed pid is on file", async () => {
    const result = await processModule.reapOrphanedManagedHeadroom();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("not_running");
  });
});

describe("stopHeadroomProxy kill-safety (F5)", () => {
  it("refuses to stop a pid whose cmdline is NOT the headroom binary (recycled pid)", async () => {
    fakeAliveKill();
    const { probeProcess } = await import("../../src/lib/processGuard.js");
    probeProcess.mockReturnValueOnce("gone"); // not our process → stale file
    writeFakePidFile();
    const result = processModule.stopHeadroomProxy();
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("not_running");
    // The stale file was cleared, and no signal was delivered to the pid.
    expect(fs.existsSync(pidPath())).toBe(false);
  });
});
