// Phase 08 repo tests: budget columns at the apiKeysRepo layer — rowToKey
// defaults for pre-migration rows (columns absent → off/0/daily/80/false),
// updateApiKey budget writes (clamps + preservation), getApiKeyRow lookup
// paths, and the getSpendForKey SQL shape (raw key bound, ISO window,
// SUM(cost) + SUM(prompt+completion)).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const state = vi.hoisted(() => ({ rows: new Map(), queries: [] }));

function fakeAdapter() {
  return {
    get(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql.includes("FROM apiKeys WHERE keyHash")) {
        for (const r of state.rows.values()) if (r.keyHash === params[0]) return r;
        return undefined;
      }
      if (sql.includes("FROM apiKeys WHERE key = ?")) {
        for (const r of state.rows.values()) if (r.key === params[0]) return r;
        return undefined;
      }
      if (sql.includes("FROM apiKeys WHERE id")) {
        return state.rows.get(params[0]);
      }
      if (sql.includes("SUM(cost)")) {
        return { usd: 1.5, tokens: 1200 };
      }
      return undefined;
    },
    all(sql) {
      if (sql.startsWith("PRAGMA table_info")) return [];
      return [...state.rows.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    run(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql.startsWith("INSERT INTO apiKeys")) {
        state.rows.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
        });
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE apiKeys SET name")) {
        // v0.5.99 UPDATE: name, machineId, isActive, budget×5,
        // access×2 (upstream keyAccess), id
        const row = state.rows.get(params[10]);
        if (!row) return { changes: 0 };
        Object.assign(row, {
          name: params[0], machineId: params[1], isActive: params[2],
          budgetType: params[3], budgetLimit: params[4], budgetWindow: params[5],
          softThresholdPct: params[6], hardBlock: params[7],
          accessRestricted: params[8], accessAllow: params[9],
        });
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE apiKeys SET keyHash")) {
        const row = state.rows.get(params[2]);
        if (row) { row.keyHash = params[0]; row.key = params[1]; }
        return { changes: row ? 1 : 0 };
      }
      return { changes: 0 };
    },
    transaction(fn) { fn(); },
  };
}

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => fakeAdapter()) }));
vi.mock("@/lib/auth/installSecret.js", () => ({ getOrCreateInstallSecret: () => "test-install-secret" }));

import {
  createApiKey,
  updateApiKey,
  getApiKeyRow,
  validateApiKey,
} from "../../src/lib/db/repos/apiKeysRepo.js";
import { getSpendForKey } from "../../src/lib/db/repos/usageRepo.js";

const LEGACY_RAW = "sk-machine1234-ab12cd-9f8e7d6c";

// Seed one legacy-style row: hash-migrated display key + no budget columns
// (a pre-phase-08 DB right after ALTER adds columns with defaults; the
// in-memory row simply leaves them undefined — same read semantics).
async function seedLegacyRow() {
  const row = {
    id: "k-legacy",
    key: "sk-legacy-display-••••d6c",
    keyHash: null, // filled below via the repo's own hash fn
    name: "legacy",
    machineId: "machine1234",
    isActive: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const created = await createApiKey("tmp", "m");
  // Use the created row's hashing path instead: create then relabel id.
  state.rows.delete(created.id);
  const { hashApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
  row.keyHash = hashApiKey(LEGACY_RAW);
  state.rows.set(row.id, row);
  return row;
}

beforeEach(() => {
  state.rows.clear();
  state.queries.length = 0;
});

describe("budget columns at the repo layer (phase 08)", () => {
  it("pre-migration rows read as unbudgeted (all defaults = current behavior)", async () => {
    await seedLegacyRow();
    const row = await getApiKeyRow(LEGACY_RAW);
    expect(row.id).toBe("k-legacy");
    // raw row passes through with defaults undefined — rowToKey normalizes:
    const { getApiKeyById } = await import("../../src/lib/db/repos/apiKeysRepo.js");
    const view = await getApiKeyById("k-legacy");
    expect(view.budgetType).toBe("off");
    expect(view.budgetLimit).toBe(0);
    expect(view.budgetWindow).toBe("daily");
    expect(view.softThresholdPct).toBe(80);
    expect(view.hardBlock).toBe(false);
  });

  it("validateApiKey remains a thin isActive wrapper over getApiKeyRow", async () => {
    await seedLegacyRow();
    expect(await validateApiKey(LEGACY_RAW)).toBe(true);
    expect(await validateApiKey("sk-wrong")).toBe(false);
    const row = await getApiKeyRow(LEGACY_RAW);
    expect(row).not.toBe(false);
    expect(row.name).toBe("legacy");
  });

  it("updateApiKey writes budget fields with clamps and preserves untouched ones", async () => {
    const row = await seedLegacyRow();
    // Budget on with clamping: pct 250 → 100, limit -5 → 0
    const updated = await updateApiKey(row.id, {
      budgetType: "usd", budgetLimit: -5, budgetWindow: "monthly",
      softThresholdPct: 250, hardBlock: true,
    });
    expect(updated.budgetType).toBe("usd");
    expect(updated.budgetLimit).toBe(0);       // invalid → 0 (route blocks type≠off+limit<=0 upstream)
    expect(updated.budgetWindow).toBe("monthly");
    expect(updated.softThresholdPct).toBe(100);
    expect(updated.hardBlock).toBe(true);

    // Plain rename: budget fields preserved
    const renamed = await updateApiKey(row.id, { name: "renamed" });
    expect(renamed.name).toBe("renamed");
    expect(renamed.budgetType).toBe("usd");
    expect(renamed.budgetWindow).toBe("monthly");
    expect(renamed.hardBlock).toBe(true);

    // Garbage type normalizes to off
    const offed = await updateApiKey(row.id, { budgetType: "eth" });
    expect(offed.budgetType).toBe("off");
  });

  it("getSpendForKey binds the RAW key + ISO window and sums the right columns", async () => {
    const since = new Date(2026, 8, 5, 0, 0, 0);
    const spend = await getSpendForKey(LEGACY_RAW, since);
    expect(spend).toEqual({ usd: 1.5, tokens: 1200 });
    const q = state.queries.find((x) => x.sql.includes("SUM(cost)"));
    expect(q).toBeTruthy();
    expect(q.sql).toContain("SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0))");
    expect(q.sql).toContain("apiKey = ? AND timestamp >= ?");
    expect(q.params[0]).toBe(LEGACY_RAW);            // raw string, not a fingerprint
    expect(q.params[1]).toBe(since.toISOString());   // ISO, lexicographic-safe
  });

  it("getSpendForKey with no key short-circuits without a query", async () => {
    expect(await getSpendForKey("", new Date())).toEqual({ usd: 0, tokens: 0 });
    expect(state.queries.find((x) => x.sql.includes("SUM(cost)"))).toBeUndefined();
  });
});
