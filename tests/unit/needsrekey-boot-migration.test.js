// Boot-migration pin (v0.6.45): a v0.6.44-shaped DB (apiKeys WITHOUT
// needsRekey) must gain the column back on next boot via the additive
// syncSchemaFromTables path — no SCHEMA_VERSION bump, no destructive step.
// A second adapter over the same file + runMigrationOnce is how a real
// reboot looks to migrate.js (its dedupe Set is per adapter object;
// vi.resetModules can't reliably re-init aliased driver state in-process).
// Harness copied from unit/db-sqlite-vs-lowdb.test.js (temp DATA_DIR).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
let originalDataDir;

beforeAll(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-boot-migration-"));
  process.env.DATA_DIR = tempDir;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

describe("boot migration — v0.6.44-shaped DB gains apiKeys.needsRekey", () => {
  it("additive sync re-adds the dropped column on the next boot", async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(" ")); };

    const { initDb } = await import("@/lib/db/index.js");
    await initDb(); // boot 1: creates the v0.6.45 schema

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("needsRekey");
    db.run(`ALTER TABLE apiKeys DROP COLUMN needsRekey`); // now v0.6.44-shaped
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).not.toContain("needsRekey");

    // boot 2 over the same file
    const { createBetterSqliteAdapter } = await import("@/lib/db/adapters/betterSqliteAdapter.js");
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const adapter2 = createBetterSqliteAdapter(path.join(tempDir, "db", "data.sqlite"));
    await runMigrationOnce(adapter2);

    console.log = origLog;
    expect(adapter2.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("needsRekey");
    expect(logs).toContain("[DB][sync] +column apiKeys.needsRekey");
  });
});
