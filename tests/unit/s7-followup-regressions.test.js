// Regression coverage for the v0.6.35→v0.6.41 audit follow-ups:
//  - exportDb crashed with ReferenceError (hashApiKey/maskApiKey were
//    re-exported but never imported into module scope) on ANY db holding
//    at least one API key — broken since S7 shipped.
//  - cross-install restores of apiKeys.keyHash can never validate; importDb
//    must say so loudly instead of failing 401s in silence.
//  - "[REDACTED]" loginToken markers from an export must never be persisted
//    (they would be sent as `Bearer [REDACTED]`).
//  - usage attribution must hash-join (S7 masked the display column, so a
//    raw-key join can never match).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const state = vi.hoisted(() => ({
  apiKeys: new Map(),
  connections: new Map(),
  settings: new Map(),
  meta: new Map(),
}));

function fakeAdapter() {
  return {
    get(sql, params = []) {
      if (sql.includes("FROM settings WHERE id = 1")) {
        const data = state.settings.get("1");
        return data !== undefined ? { data } : undefined;
      }
      if (sql.includes("FROM _meta")) {
        return state.meta.has(params[0]) ? { value: state.meta.get(params[0]) } : undefined;
      }
      return undefined;
    },
    all(sql) {
      if (sql.includes("FROM apiKeys")) return [...state.apiKeys.values()];
      if (sql.includes("FROM providerConnections")) return [...state.connections.values()];
      if (sql.includes("FROM kv")) return [];
      return [];
    },
    run(sql, params = []) {
      if (sql.startsWith("INSERT INTO _meta")) state.meta.set(params[0], params[1]);
      if (sql.startsWith("DELETE FROM apiKeys")) state.apiKeys.clear();
      if (sql.startsWith("DELETE FROM providerConnections")) state.connections.clear();
      if (sql.startsWith("DELETE FROM settings")) state.settings.clear();
      if (sql.startsWith("INSERT OR REPLACE INTO apiKeys")) {
        state.apiKeys.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
          budgetType: params[7], budgetLimit: params[8], budgetWindow: params[9],
          softThresholdPct: params[10], hardBlock: params[11],
        });
        return { changes: 1 };
      }
      if (sql.startsWith("INSERT OR REPLACE INTO providerConnections")) {
        state.connections.set(params[0], {
          id: params[0], provider: params[1], authType: params[2], name: params[3],
          email: params[4], priority: params[5], isActive: params[6], data: params[7],
          createdAt: params[8], updatedAt: params[9],
        });
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO settings") || sql.includes("UPDATE settings")) {
        state.settings.set("1", params[0]);
      }
      return { changes: 1 };
    },
    transaction(fn) { fn(); },
  };
}

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => fakeAdapter()) }));
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => "test-install-secret",
}));

import crypto from "node:crypto";
import { exportDb, importDb, getApiKeyHashNameMap } from "../../src/lib/db/index.js";

const hmacOf = (key) => crypto.createHmac("sha256", "test-install-secret").update(key).digest("hex");
const RAW_KEY = "sk-machine1234-ab12cd-9f8e7d6c";
const MASKED = "sk-ab12cd-••••7d6c";

const seedKeyRow = (over = {}) => {
  const row = {
    id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY),
    name: "ci", machineId: "machine1234", isActive: 1,
    createdAt: "2026-01-01T00:00:00.000Z", budgetType: "off", budgetLimit: 0,
    budgetWindow: "daily", softThresholdPct: 80, hardBlock: 0,
    ...over, // spread LAST so explicit nulls (e.g. keyHash: null) stick
  };
  state.apiKeys.set(row.id, row);
  return row;
};

beforeEach(() => {
  state.apiKeys.clear();
  state.connections.clear();
  state.settings.clear();
  state.meta.clear();
});

describe("exportDb after S7", () => {
  it("exports a db holding an API key without crashing (ReferenceError regression)", async () => {
    seedKeyRow();
    const out = await exportDb();
    expect(Array.isArray(out.apiKeys)).toBe(true);
    expect(out.apiKeys).toHaveLength(1);
    expect(out.apiKeys[0].keyHash).toBe(hmacOf(RAW_KEY));
    expect(out.apiKeys[0].key).toBe(MASKED);
  });

  it("computes keyHash on the fly for legacy plaintext rows and masks the export", async () => {
    seedKeyRow({ key: RAW_KEY, keyHash: null });
    const out = await exportDb();
    expect(out.apiKeys[0].keyHash).toBe(hmacOf(RAW_KEY));
    expect(out.apiKeys[0].key).toBe(MASKED);
    expect(JSON.stringify(out)).not.toContain(RAW_KEY);
  });

  it("stamps meta.installId so imports can detect cross-install restores", async () => {
    seedKeyRow();
    const out = await exportDb();
    expect(typeof out.meta.installId).toBe("string");
    expect(out.meta.installId.length).toBeGreaterThan(0);
  });

  it("carries budget fields through the export", async () => {
    seedKeyRow({ budgetType: "usd", budgetLimit: 5, budgetWindow: "monthly", softThresholdPct: 90, hardBlock: 1 });
    const out = await exportDb();
    expect(out.apiKeys[0].budgetType).toBe("usd");
    expect(out.apiKeys[0].budgetLimit).toBe(5);
    expect(out.apiKeys[0].budgetWindow).toBe("monthly");
    expect(out.apiKeys[0].hardBlock).toBe(1);
  });
});

describe("importDb cross-install / redaction warnings", () => {
  it("warns when restoring apiKeys exported on a DIFFERENT install", async () => {
    const payload = {
      meta: { installId: "another-install" },
      apiKeys: [{ id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY), name: "ci", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const restored = await importDb(payload);
    expect(Array.isArray(restored.warnings)).toBe(true);
    expect(restored.warnings.join(" ")).toMatch(/different/i);
  });

  it("does not warn for a same-install restore", async () => {
    // Establish THIS install's id first.
    await exportDb();
    const localId = state.meta.get("install-id");
    const payload = {
      meta: { installId: localId },
      apiKeys: [{ id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY), name: "ci", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const restored = await importDb(payload);
    expect(restored.warnings ?? []).toHaveLength(0);
  });

  it("never persists the '[REDACTED]' loginToken marker", async () => {
    const payload = {
      // v0.6.45 RT-05: importDb now requires meta + ≥1 known table key.
      meta: { installId: "s7-test-install" },
      providerConnections: [{
        id: "c1", provider: "totu-ai", authType: "oauth", name: "totu", email: null,
        priority: 1, isActive: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        providerSpecificData: { loginToken: "[REDACTED]", apiKey: "sk-totu" },
      }],
    };
    await importDb(payload);
    const row = state.connections.get("c1");
    expect(row).toBeDefined();
    const data = JSON.parse(row.data);
    expect("loginToken" in data.providerSpecificData).toBe(false);
    expect(data.providerSpecificData.apiKey).toBe("sk-totu");
  });

  it("restores budget columns for apiKeys", async () => {
    const payload = {
      // v0.6.45 RT-05: importDb now requires meta + ≥1 known table key.
      meta: { installId: "s7-test-install" },
      apiKeys: [{
        id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY), name: "ci", isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        budgetType: "tokens", budgetLimit: 100000, budgetWindow: "monthly", softThresholdPct: 70, hardBlock: 1,
      }],
    };
    await importDb(payload);
    const row = state.apiKeys.get("k1");
    expect(row.budgetType).toBe("tokens");
    expect(row.budgetLimit).toBe(100000);
    expect(row.budgetWindow).toBe("monthly");
    expect(row.softThresholdPct).toBe(70);
    expect(row.hardBlock).toBe(1);
  });
});

describe("getApiKeyHashNameMap (usage attribution after S7)", () => {
  it("maps hash→name for migrated rows AND legacy raw rows", async () => {
    seedKeyRow({ id: "k1", keyHash: hmacOf(RAW_KEY), name: "migrated" });
    seedKeyRow({ id: "k2", key: "sk-machine1234-ffff00-aaaaaaaa", keyHash: null, name: "legacy" });
    const map = await getApiKeyHashNameMap();
    expect(map.get(hmacOf(RAW_KEY)).name).toBe("migrated");
    expect(map.get(hmacOf("sk-machine1234-ffff00-aaaaaaaa")).name).toBe("legacy");
  });

  it("never exposes raw keys through the map", async () => {
    seedKeyRow({ id: "k2", key: "sk-machine1234-ffff00-aaaaaaaa", keyHash: null, name: "legacy" });
    const map = await getApiKeyHashNameMap();
    for (const key of map.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/); // hex HMAC digests only
    }
  });
});
