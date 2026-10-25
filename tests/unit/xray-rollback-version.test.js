// Regression for the rollback `.version` mismatch: installXray used to leave
// VERSION_FILE naming the FAILED tag after restoreFromPrevDir, so status/APIs
// reported the wrong version and reinstalling that tag short-circuited as
// alreadyInstalled against the rolled-back binary. The fix persists the
// pre-install version into `.prev/.version.9r` and restores it on rollback.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
let originalDataDir;

let installer;

beforeAll(async () => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-rollback-"));
  process.env.DATA_DIR = tempDir;
  // Import AFTER DATA_DIR is set: installer.js resolves XRAY_DIR at module load.
  installer = await import("../../src/lib/xray/installer.js");
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

function writePrev({ withMarker }) {
  const xrayDir = path.join(tempDir, "xray");
  fs.rmSync(path.join(xrayDir, ".prev"), { recursive: true, force: true });
  fs.mkdirSync(path.join(xrayDir, ".prev"), { recursive: true });
  // The retained OLD binary and the pre-install version marker.
  fs.writeFileSync(path.join(xrayDir, ".prev", "xray.exe"), "old-binary");
  if (withMarker) fs.writeFileSync(path.join(xrayDir, ".prev", ".version.9r"), "v1.0.0");
  // The failed install left the NEW tag behind.
  fs.writeFileSync(path.join(xrayDir, ".version"), "v9.9.9");
}

describe("rollbackXrayToPrev restores the pre-install version", () => {
  it("rewrites .version from the .prev marker and consumes the marker", () => {
    writePrev({ withMarker: true });
    expect(installer.getInstalledVersion()).toBe("v9.9.9");

    expect(installer.rollbackXrayToPrev()).toBe(true);

    expect(installer.getInstalledVersion()).toBe("v1.0.0");
    // The marker is scratch — it must not survive into the install dir.
    expect(fs.existsSync(path.join(tempDir, "xray", ".version.9r"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "xray", ".prev"))).toBe(false);
    // The retained binary came back.
    expect(fs.readFileSync(path.join(tempDir, "xray", "xray.exe"), "utf8")).toBe("old-binary");
  });

  it("leaves .version untouched when .prev carried no marker (first install)", () => {
    writePrev({ withMarker: false });
    expect(installer.rollbackXrayToPrev()).toBe(true);
    // No marker → no claim about the old version; the file stays as-is.
    expect(installer.getInstalledVersion()).toBe("v9.9.9");
  });
});

describe("getPrevXrayVersion (the dashboard Rollback button's source)", () => {
  it("reports the retained version while .prev exists", () => {
    writePrev({ withMarker: true });
    expect(installer.getPrevXrayVersion()).toBe("v1.0.0");
  });

  it("is null without a marker, without .prev, and after a rollback consumes it", () => {
    writePrev({ withMarker: false });
    expect(installer.getPrevXrayVersion()).toBeNull();

    fs.rmSync(path.join(tempDir, "xray", ".prev"), { recursive: true, force: true });
    expect(installer.getPrevXrayVersion()).toBeNull();

    writePrev({ withMarker: true });
    expect(installer.rollbackXrayToPrev()).toBe(true);
    expect(installer.getPrevXrayVersion()).toBeNull();
  });
});
