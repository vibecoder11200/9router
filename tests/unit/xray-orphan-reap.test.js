import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// probeProcess is mocked: the reap path must believe the fake pid is a live
// xray ("ours" keeps getVerifiedManagedPid conservative-true), while
// process.kill is spied so no real signal is ever delivered.
vi.mock("../../src/lib/processGuard.js", () => ({ probeProcess: vi.fn(() => "ours") }));

let tempDir;
let originalDataDir;
let processModule;
let killSpy;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-reap-"));
  process.env.DATA_DIR = tempDir;
  // Import AFTER DATA_DIR is set: process.js resolves XRAY_DIR at module load.
  processModule = await import("../../src/lib/xray/process.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

afterEach(() => {
  killSpy?.mockRestore();
  try { fs.rmSync(path.join(tempDir, "xray"), { recursive: true, force: true }); } catch {}
});

// A pid that stays "alive" under the signal-0 probe but receives no real
// signal: the spy intercepts every process.kill call.
const FAKE_PID = 4194301;

function fakeAliveKill() {
  killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) return true; // isPidAlive → alive
    return undefined; // SIGTERM/SIGKILL swallowed — nothing is really killed
  });
}

function pidPath() {
  return path.join(tempDir, "xray", "xray.pid");
}

function writeFakePidFile(pid = FAKE_PID) {
  fs.mkdirSync(path.dirname(pidPath()), { recursive: true });
  fs.writeFileSync(pidPath(), String(pid));
}

describe("reapOrphanedManagedXray (boot-time orphan reaper)", () => {
  it("kills a live managed xray left by a previous instance and clears the pid file", async () => {
    fakeAliveKill();
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedXray();
    expect(result.killed).toBe(true);
    expect(result.pid).toBe(FAKE_PID);
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  it("spares a pid this process spawned itself (blue-green / same-boot start)", async () => {
    fakeAliveKill();
    // setManagedPid is what blue-green promotion uses; it marks the pid as ours.
    processModule.setManagedPid(FAKE_PID);
    const result = await processModule.reapOrphanedManagedXray();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("ours");
    // Not killed → the pid file survives for the normal start-path idempotency.
    expect(fs.existsSync(pidPath())).toBe(true);
  });

  it("is a no-op when no managed pid is on file", async () => {
    const result = await processModule.reapOrphanedManagedXray();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("not_running");
  });

  it("is a no-op when the pid file points at a dead process", async () => {
    // Real process.kill semantics for signal 0 on an unlikely pid: throws.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("ESRCH");
      e.code = "ESRCH";
      throw e;
    });
    writeFakePidFile();
    const result = await processModule.reapOrphanedManagedXray();
    expect(result.killed).toBe(false);
    expect(result.reason).toBe("not_running");
  });
});
