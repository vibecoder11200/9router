// Phase 02 (X1/X9): reaper scans the real DATA_DIR/xray, matches filter-api
// artifacts (base + overlays) and model-test configs, and never touches the
// live config.json / pid files. Process kills are skipped in this test run.
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-reaper-"));
process.env.DATA_DIR = TEMP_DATA_DIR;

const { reapOrphanedTempProbes, startPeriodicTempReaper } = await import("../../src/lib/xray/reaper.js");

const XRAY_DIR = path.join(TEMP_DATA_DIR, "xray");

function write(name) {
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  fs.writeFileSync(path.join(XRAY_DIR, name), "{}");
  return path.join(XRAY_DIR, name);
}

beforeEach(() => {
  try { fs.rmSync(XRAY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

process.on("exit", () => {
  try { fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("reapOrphanedTempProbes patterns (X1/X9)", () => {
  it("unlinks model-test configs, filter-api base configs AND their overlays", async () => {
    write("config.json");
    write("xray.pid");
    write("config.json.model-test-abc123.json");
    write("filter-api-51808-51908.json");
    write("filter-api-51808-51908.json.ob-proxy.json");

    const res = await reapOrphanedTempProbes({ skipProcessKill: true });

    expect(res.unlinked).toBe(3);
    expect(fs.existsSync(path.join(XRAY_DIR, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid"))).toBe(true);
  });

  it("draining registry is removed even when empty of verifiable pids", async () => {
    write("xray.pid.draining");
    // Entries whose pids don't exist are skipped, file still cleared.
    fs.writeFileSync(path.join(XRAY_DIR, "xray.pid.draining"), JSON.stringify([{ pid: 999999999 }]));
    await reapOrphanedTempProbes({ skipProcessKill: true });
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid.draining"))).toBe(false);
  });

  it("missing dir is tolerated", async () => {
    const res = await reapOrphanedTempProbes({ xrayDir: path.join(TEMP_DATA_DIR, "nope"), skipProcessKill: true });
    expect(res.unlinked).toBe(0);
  });
});

describe("reapOrphanedTempProbes fileMaxAgeMs (periodic sweep safety)", () => {
  function ageFile(file, msAgo) {
    const at = new Date(Date.now() - msAgo);
    fs.utimesSync(file, at, at);
  }

  it("keeps fresh temp files, unlinks only stale ones", async () => {
    const fresh = write("config.json.model-test-fresh.json");
    const stale = write("config.json.model-test-stale.json");
    ageFile(stale, 20 * 60 * 1000);

    const res = await reapOrphanedTempProbes({ skipProcessKill: true, fileMaxAgeMs: 10 * 60 * 1000 });

    expect(res.unlinked).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("fileMaxAgeMs=0 (boot default) unlinks everything matching", async () => {
    const fresh = write("config.json.model-test-fresh.json");
    const res = await reapOrphanedTempProbes({ skipProcessKill: true });
    expect(res.unlinked).toBe(1);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it("includeDraining=false leaves the blue-green draining registry alone", async () => {
    fs.mkdirSync(XRAY_DIR, { recursive: true });
    fs.writeFileSync(path.join(XRAY_DIR, "xray.pid.draining"), JSON.stringify([{ pid: 999999999 }]));
    await reapOrphanedTempProbes({ skipProcessKill: true, includeDraining: false });
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid.draining"))).toBe(true);
    // Boot default still clears it (previous behavior).
    await reapOrphanedTempProbes({ skipProcessKill: true });
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid.draining"))).toBe(false);
  });
});

describe("startPeriodicTempReaper (safety net between boots)", () => {
  function writeStale(name) {
    const file = write(name);
    const at = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(file, at, at);
    return file;
  }

  it("skips sweeps while busy, reaps stale orphans once idle, stop() halts", async () => {
    const stale = writeStale("config.json.model-test-periodic.json");
    let busy = true;

    const handle = startPeriodicTempReaper({
      intervalMs: 150,
      fileMaxAgeMs: 10 * 60 * 1000,
      isBusy: async () => busy,
      xrayDir: XRAY_DIR,
      skipProcessKill: true,
      includeDraining: false,
    });

    try {
      // Busy (model filter running): nothing is reaped.
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(stale)).toBe(true);

      // Idle: the stale orphan is swept.
      busy = false;
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(stale)).toBe(false);

      // Stopped: no further sweeps.
      handle.stop();
      const stale2 = writeStale("config.json.model-test-periodic-2.json");
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(stale2)).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
