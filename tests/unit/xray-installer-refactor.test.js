import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Temp DATA_DIR created inside the mock factory itself (self-contained, no
// outer bindings): installXray's module-load constants bind to it at import.
vi.mock("@/lib/dataDir.js", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrayinst-"));
  return { DATA_DIR: dir, getDataDir: () => dir };
});

// Download + extract are mocked; the shared helpers (swap, sha, rollback)
// run REAL so the parity test exercises the refactored pipeline end-to-end.
vi.mock("@/lib/runtime/assetInstaller.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    downloadToFile: vi.fn(async (url, dest) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // deterministic zip bytes per requested version tag
      const tag = url.match(/download\/(v[\d.]+)\//)?.[1] || "v0";
      const bytes = Buffer.from(`ZIPBYTES-${tag}`);
      fs.writeFileSync(dest, bytes);
      return { total: bytes.length, received: bytes.length };
    }),
    extractZip: vi.fn(async (zip, destDir) => {
      const fs = await import("node:fs");
      // xray zips are flat — stage a usable binary + license; the downloaded
      // zip bytes carry the requested tag (`ZIPBYTES-<tag>`)
      const binName = process.platform === "win32" ? "xray.exe" : "xray";
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, binName), fs.readFileSync(zip, "utf8").includes("v26.3.27") ? "XRAY-BIN-A" : "XRAY-BIN-B");
      fs.writeFileSync(path.join(destDir, "LICENSE"), "XRAY-LICENSE");
    }),
  };
});

// Global fetch mock: serve zip bytes + .dgst text with the REAL sha of those
// bytes (the installer hashes the downloaded file and compares to .dgst).
vi.stubGlobal("fetch", vi.fn(async (url) => {
  if (String(url).endsWith(".dgst")) {
    const { createHash } = await import("node:crypto");
    const tag = String(url).match(/download\/(v[\d.]+)\//)?.[1] || "v0";
    const bytes = Buffer.from(`ZIPBYTES-${tag}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    return new Response(`${sha}  bundle.zip\n`, { status: 200 });
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  return new Response("unused", { status: 200 });
}));

import { getDataDir } from "@/lib/dataDir.js";
import {
  getInstalledVersion,
  getPrevXrayVersion,
  getXrayBinaryPath,
  isXrayInstalled,
  installXray,
  isValidXrayTag,
  rollbackXrayToPrev,
} from "../../src/lib/xray/installer.js";

let tmp;
const BIN = process.platform === "win32" ? "xray.exe" : "xray";

beforeEach(() => {
  tmp = getDataDir();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).endsWith(".dgst")) {
      const { createHash } = await import("node:crypto");
      const tag = String(url).match(/download\/(v[\d.]+)\//)?.[1] || "v0";
      const bytes = Buffer.from(`ZIPBYTES-${tag}`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      return new Response(`${sha}  bundle.zip\n`, { status: 200 });
    }
    return new Response("ZIPBYTES-" + String(url).match(/download\/(v[\d.]+)\//)?.[1], { status: 200 });
  }));
});

afterEach(() => {
  fs.rmSync(path.join(tmp, "xray"), { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("xray installer — refactor parity (shared helpers in, behavior out)", () => {
  it("pins the public surface: install/status/version paths", async () => {
    expect(isValidXrayTag("v26.3.27")).toBe(true);
    expect(isValidXrayTag("../../evil")).toBe(false);
    expect(getXrayBinaryPath()).toBe(path.join(tmp, "xray", BIN));

    const res = await installXray({ version: "v26.3.27" });
    expect(res).toMatchObject({ installed: true, version: "v26.3.27", alreadyInstalled: false });
    expect(isXrayInstalled()).toBe(true);
    expect(getInstalledVersion()).toBe("v26.3.27");
    expect(fs.readFileSync(path.join(tmp, "xray", BIN), "utf8")).toBe("XRAY-BIN-A");
    expect(fs.existsSync(path.join(tmp, "xray", "LICENSE.xray.txt"))).toBe(true);
  });

  it("reinstall archives the old files into .prev with a version marker", async () => {
    await installXray({ version: "v26.3.27" });
    const res2 = await installXray({ version: "v27.0.0" });
    expect(res2.alreadyInstalled).toBe(false);
    expect(getInstalledVersion()).toBe("v27.0.0");
    expect(fs.readFileSync(path.join(tmp, "xray", BIN), "utf8")).toBe("XRAY-BIN-B");
    expect(getPrevXrayVersion()).toBe("v26.3.27");
    expect(fs.readFileSync(path.join(tmp, "xray", ".prev", BIN), "utf8")).toBe("XRAY-BIN-A");
  });

  it("rollbackXrayToPrev restores the previous binary AND version marker", async () => {
    await installXray({ version: "v26.3.27" });
    await installXray({ version: "v27.0.0" });
    const restored = rollbackXrayToPrev();
    expect(restored).toBe(true);
    expect(getInstalledVersion()).toBe("v26.3.27");
    expect(fs.readFileSync(path.join(tmp, "xray", BIN), "utf8")).toBe("XRAY-BIN-A");
    expect(fs.existsSync(path.join(tmp, "xray", ".prev"))).toBe(false);
    expect(isXrayInstalled()).toBe(true);
  });
});
