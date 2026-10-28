// Boot-reaper tests for the managed DS2API sidecar (audit F4) — the
// structural twin of the managed-xray orphan bug. Mirrors
// xray-orphan-reap.test.js: probeProcess mocked, process.kill spied so no
// real signal is ever delivered.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/lib/processGuard.js", () => ({ probeProcess: vi.fn(() => "ours") }));

let tempDir;
let originalDataDir;
let processModule;
let killSpy;

const FAKE_PID = 4194303;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ds2api-reap-"));
  process.env.DATA_DIR = tempDir;
  processModule = await import("../../src/lib/ds2api/process.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake */ }
});

afterEach(() => {
  killSpy?.mockRestore();
  try { fs.rmSync(path.join(tempDir, "ds2api"), { recursive: true, force: true }); } catch {}
});

const FAKE2_PID = 4194305;

function fakeAliveKill() {
  killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) return true; // isPidAlive → alive
    return undefined; // SIGTERM/SIGKILL swallowed — nothing is really killed
  });
}

function pidPath() {
  return path.join(tempDir, "ds2api", "ds2api.pid");
}

function writeFakePidFile(pid = FAKE_PID) {
  fs.mkdirSync(path.dirname(pidPath()), { recursive: true });
  fs.writeFileSync(pidPath(), String(pid));
}

describe("reapOrphanedManagedDS2API (boot-time orphan reaper, F4)", () => {
  it("kills a live managed DS2API left by a previous instance and clears the pid file", async () => {
    fakeAliveKill();
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedDS2API();
    expect(result.killed).toBe(true);
    expect(result.pid).toBe(FAKE_PID);
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  it("does NOT kill an UNPROVABLE pid (pid-reuse guard)", async () => {
    fakeAliveKill();
    const { probeProcess } = await import("../../src/lib/processGuard.js");
    probeProcess.mockReturnValueOnce("unknown");
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedDS2API();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("unverified");
    expect(fs.existsSync(pidPath())).toBe(true);
  });

  it("is a no-op when no managed pid is on file", async () => {
    const result = await processModule.reapOrphanedManagedDS2API();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("not_running");
  });

  it("clears a stale pid file when the process is dead", async () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("ESRCH");
      e.code = "ESRCH";
      throw e;
    });
    writeFakePidFile(FAKE2_PID);
    const result = await processModule.reapOrphanedManagedDS2API();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("not_running");
  });
});
