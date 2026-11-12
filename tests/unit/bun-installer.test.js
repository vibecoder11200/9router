import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { assetMocks } = vi.hoisted(() => ({
  assetMocks: {
    downloadToFile: vi.fn(),
    sha256File: vi.fn(),
    extractZip: vi.fn(),
    atomicSwapIn: vi.fn(),
    prewarmCommand: vi.fn(),
    restoreFromPrev: vi.fn(),
  },
}));

vi.mock("@/lib/runtime/assetInstaller.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...assetMocks };
});

import {
  BUN_VERSION,
  PLATFORM_ASSETS,
  detectBunAsset,
  ensureBunInstalled,
  getBunBinaryPath,
  getInstalledBunVersion,
  installBun,
  isBunInstalled,
} from "../../src/lib/runtime/bunInstaller.js";

const BINARY = process.platform === "win32" ? "bun.exe" : "bun";
let tmp;

function stageBunZip(dest) {
  const nested = path.join(dest, "bun-v1.4.0");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "bun.exe"), "BUN-BINARY");
  fs.writeFileSync(path.join(nested, "LICENSE"), "BUN-LICENSE");
}

// atomicSwapIn mock performs the real swap shape: staging entries → final dir
const swapMock = async ({ stagingPath, finalPath }) => {
  for (const name of fs.readdirSync(stagingPath)) {
    fs.renameSync(path.join(stagingPath, name), path.join(finalPath, name));
  }
  return { prevPopulated: false };
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "buninst-"));
  process.env.DATA_DIR = tmp;
  for (const fn of Object.values(assetMocks)) fn.mockReset();
  assetMocks.atomicSwapIn.mockImplementation(swapMock);
  assetMocks.prewarmCommand.mockResolvedValue({ ok: true, stdout: "1.4.0\n" });
  assetMocks.sha256File.mockResolvedValue(PLATFORM_ASSETS[process.platform]?.x64?.sha256 ?? "f".repeat(64));
  assetMocks.extractZip.mockImplementation(async (zip, dest) => stageBunZip(dest));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bunInstaller — asset table", () => {
  it("pins a 64-hex digest on every platform row (release checklist guard)", () => {
    for (const rows of Object.values(PLATFORM_ASSETS)) {
      for (const row of Object.values(rows)) {
        expect(row.asset).toMatch(/\.zip$/);
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(PLATFORM_ASSETS.win32.x64.sha256).toBe(
      "e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901",
    );
    expect(PLATFORM_ASSETS.linux.x64.sha256).toBe(
      "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
    );
  });

  it("unsupported platform → typed BUN_PLATFORM_UNSUPPORTED", () => {
    expect(() => detectBunAsset("sunos", "x64")).toThrowError(
      expect.objectContaining({ code: "BUN_PLATFORM_UNSUPPORTED" }),
    );
  });
});

describe("bunInstaller — install flow", () => {
  it("happy path: download → verify → extract → swap → .version → prewarm", async () => {
    const res = await installBun({});
    expect(res.installed).toBe(true);
    expect(res.version).toBe("1.4.0");
    expect(isBunInstalled()).toBe(true);
    expect(getInstalledBunVersion()).toBe("1.4.0");
    expect(getBunBinaryPath()).toBe(path.join(tmp, "bun", BINARY));
    expect(fs.readFileSync(path.join(tmp, "bun", BINARY), "utf8")).toBe("BUN-BINARY");
    expect(fs.existsSync(path.join(tmp, "bun", "bun-v1.4.0"))).toBe(false); // flattened
    expect(assetMocks.downloadToFile).toHaveBeenCalledTimes(1);
    expect(assetMocks.prewarmCommand).toHaveBeenCalledTimes(1);
    expect(assetMocks.prewarmCommand.mock.calls[0][0]).toBe(getBunBinaryPath());
  });

  it("checksum mismatch → refuse + zip deleted, nothing installed", async () => {
    assetMocks.sha256File.mockResolvedValue("deadbeef".repeat(8));
    await expect(installBun({})).rejects.toThrow(/Checksum mismatch/);
    expect(isBunInstalled()).toBe(false);
    expect(getInstalledBunVersion()).toBeNull();
  });

  it("single-flight: two concurrent ensures share one download", async () => {
    assetMocks.extractZip.mockImplementation(async (zip, dest) => {
      await new Promise((r) => setTimeout(r, 20));
      stageBunZip(dest);
    });
    const [a, b] = await Promise.all([ensureBunInstalled(), ensureBunInstalled()]);
    expect(a).toBe(b);
    expect(assetMocks.downloadToFile).toHaveBeenCalledTimes(1);
  });

  it(".version match → alreadyInstalled, no network", async () => {
    const bunDir = path.join(tmp, "bun");
    fs.mkdirSync(bunDir, { recursive: true });
    fs.writeFileSync(path.join(bunDir, BINARY), "BUN-BINARY");
    fs.writeFileSync(path.join(bunDir, ".version"), BUN_VERSION);
    const res = await installBun({});
    expect(res.alreadyInstalled).toBe(true);
    expect(assetMocks.downloadToFile).not.toHaveBeenCalled();
  });
});
