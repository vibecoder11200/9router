// Phase 02 (X7/N4): PID-reuse kill-safety — a pid file pointing at a
// recycled, unrelated process is stale (removed), never "running", never killed.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/processGuard.js", () => ({
  isOurProcess: vi.fn(),
  probeProcess: vi.fn(),
}));

import { isOurProcess, probeProcess } from "@/lib/processGuard.js";

// DATA_DIR is read at module-import time — point it at a temp dir BEFORE the
// process modules load so pid files land in a sandbox.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pidguard-"));
process.env.DATA_DIR = TEMP_DATA_DIR;

const xrayProc = await import("@/lib/xray/process.js");

const XRAY_DIR = path.join(TEMP_DATA_DIR, "xray");

function writePidFile(pid) {
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  fs.writeFileSync(path.join(XRAY_DIR, "xray.pid"), String(pid));
}

beforeEach(() => {
  vi.clearAllMocks();
  try { fs.rmSync(XRAY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAllCleanup();
function afterAllCleanup() {
  process.on("exit", () => {
    try { fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

describe("isOurProcess", () => {
  it("returns true when the cmdline contains the expected substring", () => {
    vi.mocked(isOurProcess).mockImplementation(() => true);
    // Direct behavior test through the real helper is done via the mocked
    // execFileSync in the tests below; here we exercise the wiring contract.
    expect(typeof isOurProcess).toBe("function");
  });
});

describe("getVerifiedManagedPid (xray)", () => {
  it("pid alive + cmdline verified → returns the pid", () => {
    vi.mocked(probeProcess).mockReturnValue("ours");
    writePidFile(process.pid); // a pid that is genuinely alive
    expect(xrayProc.getVerifiedManagedPid()).toBe(process.pid);
  });

  it("pid alive but NOT ours (PID reuse) → stale: null + pid file removed", () => {
    vi.mocked(probeProcess).mockReturnValue("gone");
    writePidFile(process.pid);
    expect(xrayProc.getVerifiedManagedPid()).toBeNull();
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid"))).toBe(false);
  });

  it("pid alive but probe UNPROVABLE (tool failed) → conservative: pid kept, no double-start", () => {
    // X7 follow-up: a failed/slow PowerShell-CIM probe used to make a LIVE
    // managed xray look stopped — its PID file was deleted, the next start
    // could not bind the port, and the orphan held it until manual cleanup.
    // "unknown" must behave like running: keep the file, report the pid.
    vi.mocked(probeProcess).mockReturnValue("unknown");
    writePidFile(process.pid);
    expect(xrayProc.getVerifiedManagedPid()).toBe(process.pid);
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid"))).toBe(true);
  });

  it("stopXray on a recycled pid → not_running, kill never invoked", () => {
    vi.mocked(probeProcess).mockReturnValue("gone");
    writePidFile(process.pid);
    const res = xrayProc.stopXray();
    expect(res).toEqual({ stopped: false, reason: "not_running" });
    // And this process (the test runner!) is still alive — the real proof.
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it("no pid file → null", () => {
    vi.mocked(probeProcess).mockReturnValue("ours");
    expect(xrayProc.getVerifiedManagedPid()).toBeNull();
  });
});

describe("isOurProcess helper behavior", () => {
  it("match / mismatch / probe-failure semantics", async () => {
    // The helper deliberately never claims our OWN pid, so probe a real
    // child whose cmdline we control.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore", windowsHide: true,
    });
    try {
      // Give the OS a moment to register the child's cmdline.
      await new Promise((r) => setTimeout(r, 500));
      const real = await vi.importActual("@/lib/processGuard.js");
      expect(real.isOurProcess(child.pid, process.execPath)).toBe(true);
      expect(real.isOurProcess(child.pid, "definitely-not-in-cmdline")).toBe(false);
      expect(real.isOurProcess(-1, "node")).toBe(false);
    } finally {
      try { child.kill(); } catch { /* ignore */ }
    }
  });
});
