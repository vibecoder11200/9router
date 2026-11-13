import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const {
  assertRequiredApiArtifacts,
  copyDeepSeekPowFiles,
  assertDeepSeekPowFiles,
  copyOpencodeBunSidecar,
  assertOpencodeBunSidecar,
  copyStandaloneBuild,
  mergeServerArtifacts,
} = require("../../cli/scripts/build-cli.js");

const tempDirs = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-build-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeFixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function createCompleteServer(buildDistDir) {
  const serverDir = path.join(buildDistDir, "server");
  writeFixture(serverDir, "app/api/v1/chat/completions/route.js", "chat route");
  writeFixture(serverDir, "app/api/v1/messages/route.js", "messages route");
  writeFixture(serverDir, "chunks/openai-provider.js", "openai chunk");
  writeFixture(serverDir, "chunks/anthropic-provider.js", "anthropic chunk");
  return serverDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CLI build server artifacts", () => {
  for (const { name, standalonePath } of [
    {
      name: "legacy nested app",
      standalonePath: (appDir, buildDistDir) => path.join(appDir, ".next", "standalone", "app"),
    },
    {
      name: "Next 16 workspace",
      standalonePath: (appDir, buildDistDir) => path.join(buildDistDir, "standalone", path.basename(appDir)),
    },
  ]) {
    it(`merges complete API routes and provider chunks for the ${name} layout`, () => {
      const root = createTempDir();
      const appDir = path.join(root, "9router");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const cliAppDir = path.join(root, "cli-app");
      const standaloneDir = standalonePath(appDir, buildDistDir);

      writeFixture(standaloneDir, "server.js", "standalone server");
      writeFixture(
        standaloneDir,
        ".next-cli-build/server/app/api/v1/chat/completions/route.js",
        "standalone chat route",
      );
      createCompleteServer(buildDistDir);

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
      mergeServerArtifacts(buildDistDir, cliAppDir);
      assertRequiredApiArtifacts(cliAppDir);

      const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
        "messages route",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/openai-provider.js"), "utf8"),
        "openai chunk",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/anthropic-provider.js"), "utf8"),
        "anthropic chunk",
      );
    });
  }

  it("merges idempotently without removing standalone-generated files", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");

    createCompleteServer(buildDistDir);
    writeFixture(packagedServer, "standalone-only.js", "keep me");

    mergeServerArtifacts(buildDistDir, cliAppDir);
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(packagedServer, "standalone-only.js"), "utf8"),
      "keep me",
    );
    assert.equal(
      fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
      "messages route",
    );
  });

  it("reports the missing required API route artifact path", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");

    writeFixture(
      path.join(buildDistDir, "server"),
      "app/api/v1/chat/completions/route.js",
      "chat route",
    );
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.throws(
      () => assertRequiredApiArtifacts(cliAppDir),
      (error) => error.message.includes(path.join(
        cliAppDir,
        ".next-cli-build/server/app/api/v1/messages/route.js",
      )),
    );
  });
});

describe("CLI build DeepSeek PoW worker files", () => {
  function createPoWSource(appDir) {
    writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker");
    writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-hash.js", "hash");
  }

  it("copies worker and hash next to each other (standalone tracing drops the worker's import)", () => {
    const root = createTempDir();
    const appDir = path.join(root, "9router");
    const cliAppDir = path.join(root, "cli-app");
    createPoWSource(appDir);
    // What standalone tracing ships today: worker only.
    writeFixture(path.join(cliAppDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker");

    copyDeepSeekPowFiles(appDir, cliAppDir);
    assertDeepSeekPowFiles(cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js"), "utf8"),
      "hash",
    );
  });

  it("fails loudly when a PoW source file is missing", () => {
    const root = createTempDir();
    const appDir = path.join(root, "9router");
    const cliAppDir = path.join(root, "cli-app");
    writeFixture(path.join(appDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker");

    assert.throws(() => copyDeepSeekPowFiles(appDir, cliAppDir), /deepseek-pow-hash\.js/);
  });

  it("reports the missing PoW file path", () => {
    const root = createTempDir();
    const cliAppDir = path.join(root, "cli-app");
    writeFixture(path.join(cliAppDir, "open-sse/lib"), "deepseek-pow-worker.mjs", "worker");

    assert.throws(
      () => assertDeepSeekPowFiles(cliAppDir),
      (error) => error.message.includes(path.join(cliAppDir, "open-sse/lib/deepseek-pow-hash.js")),
    );
  });
});

describe("CLI build OpenCode bun-lane sidecar", () => {
  it("copies the sidecar into app/open-sse/services (v0.6.85: tarball shipped without it)", () => {
    const root = createTempDir();
    const appDir = path.join(root, "9router");
    const cliAppDir = path.join(root, "cli-app");
    writeFixture(path.join(appDir, "open-sse/services"), "opencodeBunSidecar.mjs", "sidecar");

    copyOpencodeBunSidecar(appDir, cliAppDir);
    assertOpencodeBunSidecar(cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(cliAppDir, "open-sse/services/opencodeBunSidecar.mjs"), "utf8"),
      "sidecar",
    );
  });

  it("fails loudly when the sidecar source is missing", () => {
    const root = createTempDir();
    const appDir = path.join(root, "9router");
    const cliAppDir = path.join(root, "cli-app");

    assert.throws(() => copyOpencodeBunSidecar(appDir, cliAppDir), /opencodeBunSidecar\.mjs/);
  });

  it("reports the missing sidecar path from the assert", () => {
    const root = createTempDir();
    const cliAppDir = path.join(root, "cli-app");

    assert.throws(
      () => assertOpencodeBunSidecar(cliAppDir),
      (error) =>
        error.message.includes(path.join(cliAppDir, "open-sse/services/opencodeBunSidecar.mjs")),
    );
  });
});
