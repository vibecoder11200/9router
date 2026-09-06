// v0.6.45 key portability (phase 02): password-wrapped install-secret export,
// adoption on import, and the apiKeys.needsRekey flag — including the Red-Team
// amendments RT-03..RT-10 (bcrypt-only sealing, adopt-after-commit, minimum
// shape guard, no-password unwrap skip, serialized imports).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { _setEnvelopeParamsForTests } from "@/lib/auth/backupEnvelope";

// RT-02: honor N9R_TEST_ENVELOPE_N (default 65536) so CI can run production
// params; when absent drop N to 4096 so the suite stays fast. Production code
// never reads this env var — only this test file does.
const envN = Number.parseInt(process.env.N9R_TEST_ENVELOPE_N ?? "", 10);
const TEST_N = Number.isInteger(envN) && envN > 0 ? envN : 4096;

beforeAll(() => {
  _setEnvelopeParamsForTests({ N: TEST_N });
});

afterAll(() => {
  _setEnvelopeParamsForTests({ N: 65536 });
});

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const PW = "correct horse battery staple";
const RAW_KEY = "sk-machine1234-ab12cd-9f8e7d6c";
const MASKED = "sk-ab12cd-••••7d6c";

const state = vi.hoisted(() => {
  const SECRET_A = "a".repeat(64); // exporting install ("install A")
  const SECRET_B = "b".repeat(64); // importing install ("install B")
  return {
    SECRET_A,
    SECRET_B,
    apiKeys: new Map(),
    connections: new Map(),
    settings: new Map(),
    meta: new Map(),
    secret: SECRET_A,
    adoptedFile: null,
    failAdopt: false,
    rekeyUpdateRuns: 0,
    sql: [],
  };
});
const { SECRET_A, SECRET_B } = state;

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
      if (sql.includes("FROM apiKeys")) {
        if (sql.includes("keyHash")) {
          return [...state.apiKeys.values()].find((r) => r.keyHash === params[0]);
        }
        if (sql.includes("WHERE key = ?")) {
          return [...state.apiKeys.values()].find((r) => r.key === params[0]);
        }
        if (sql.includes("WHERE id = ?")) {
          return state.apiKeys.get(params[0]);
        }
        return undefined;
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
      state.sql.push(sql);
      if (sql.startsWith("INSERT INTO _meta")) state.meta.set(params[0], params[1]);
      if (sql.startsWith("DELETE FROM apiKeys")) state.apiKeys.clear();
      if (sql.startsWith("DELETE FROM providerConnections")) state.connections.clear();
      if (sql.startsWith("DELETE FROM settings")) state.settings.clear();
      if (sql.startsWith("UPDATE apiKeys SET needsRekey")) {
        state.rekeyUpdateRuns += 1;
        for (const row of state.apiKeys.values()) {
          if (row.keyHash) row.needsRekey = 1;
        }
        return { changes: state.apiKeys.size };
      }
      if (sql.startsWith("UPDATE apiKeys SET keyHash")) {
        const row = state.apiKeys.get(params[2]);
        if (row) {
          row.keyHash = params[0];
          row.key = params[1];
        }
        return { changes: 1 };
      }
      if (sql.startsWith("INSERT OR REPLACE INTO apiKeys")) {
        state.apiKeys.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
          budgetType: params[7], budgetLimit: params[8], budgetWindow: params[9],
          softThresholdPct: params[10], hardBlock: params[11],
          needsRekey: params[12] === 1 ? 1 : 0,
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
// RT-10: stateful installSecret mock — getOrCreate/adopt/read share one secret.
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => {
    if (!state.secret) state.secret = "generated-secret";
    return state.secret;
  },
  readInstallSecret: () => state.secret,
  adoptInstallSecret: (fileName, secret) => {
    if (state.failAdopt) throw new Error("adopt-boom");
    if (typeof secret !== "string" || !secret.trim()) throw new Error("adoptInstallSecret: empty secret");
    state.secret = secret;
    state.adoptedFile = fileName;
    return secret;
  },
}));

import crypto from "node:crypto";
import { exportDb, importDb, validateApiKey } from "../../src/lib/db/index.js";
import { isBackupEnvelope } from "@/lib/auth/backupEnvelope";

const hmacOf = (key, secret) => crypto.createHmac("sha256", secret).update(key).digest("hex");

const seedKeyRow = (over = {}) => {
  const row = {
    id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY, state.secret),
    name: "ci", machineId: "machine1234", isActive: 1,
    createdAt: "2026-01-01T00:00:00.000Z", budgetType: "off", budgetLimit: 0,
    budgetWindow: "daily", softThresholdPct: 80, hardBlock: 0, needsRekey: 0,
    ...over, // spread LAST so explicit nulls (e.g. keyHash: null) stick
  };
  state.apiKeys.set(row.id, row);
  return row;
};

// Simulate restoring onto a DIFFERENT install: fresh tables, fresh install id,
// different local HMAC secret.
function becomeInstallB() {
  state.apiKeys.clear();
  state.connections.clear();
  state.settings.clear();
  state.meta.clear();
  state.meta.set("install-id", "install-b");
  state.secret = SECRET_B;
}

beforeEach(() => {
  state.apiKeys.clear();
  state.connections.clear();
  state.settings.clear();
  state.meta.clear();
  state.secret = SECRET_A;
  state.adoptedFile = null;
  state.failAdopt = false;
  state.rekeyUpdateRuns = 0;
  state.sql = [];
});

describe("exportDb password sealing", () => {
  it("embeds an envelope and meta.authSecretWrapped=true when given a password", async () => {
    seedKeyRow();
    const out = await exportDb({ password: PW });
    expect(isBackupEnvelope(out.authSecretEnvelope)).toBe(true);
    expect(out.meta.authSecretWrapped).toBe(true);
    // The wrapped secret must not be recoverable from the JSON without the pw.
    expect(JSON.stringify(out)).not.toContain(SECRET_A);
  });

  it("exports envelope-less with meta.authSecretWrapped=false without a password", async () => {
    seedKeyRow();
    const out = await exportDb();
    expect(out.authSecretEnvelope).toBeUndefined();
    expect(out.meta.authSecretWrapped).toBe(false);
  });

  it("carries needsRekey through the export (sticky flag)", async () => {
    seedKeyRow({ needsRekey: 1 });
    const out = await exportDb();
    expect(out.apiKeys[0].needsRekey).toBe(1);
  });
});

describe("importDb adoption + needsRekey", () => {
  it("adopts the envelope secret cross-install with the right password; keys validate in-process", async () => {
    seedKeyRow();
    const payload = await exportDb({ password: PW });
    becomeInstallB();

    const restored = await importDb(payload, { password: PW });

    expect(state.adoptedFile).toBe("api-keys-hmac");
    expect(state.secret).toBe(SECRET_A); // exporter's secret adopted
    expect(restored.apiKeys[0].needsRekey).toBe(0);
    expect(restored.needsRekeyCount).toBe(0);
    // Adoption overwrote the in-process secret too — no restart needed.
    expect(await validateApiKey(RAW_KEY)).toBe(true);
    // Cross-install warning is suppressed when adoption succeeded.
    expect((restored.warnings ?? []).join(" ")).not.toMatch(/different/i);
  });

  it("wrong password: no throw, keyHash rows flagged needsRekey, amber re-key warning", async () => {
    seedKeyRow();
    const payload = await exportDb({ password: PW });
    becomeInstallB();

    const restored = await importDb(payload, { password: "totally-wrong" });

    expect(state.adoptedFile).toBeNull(); // adoption never ran
    expect(state.secret).toBe(SECRET_B);
    expect(restored.apiKeys[0].needsRekey).toBe(1);
    expect(restored.needsRekeyCount).toBe(1);
    const warnings = (restored.warnings ?? []).join(" ");
    expect(warnings).toMatch(/re-key/i);
    expect(warnings).not.toContain(PW);
  });

  it("same-install import without password keeps needsRekey at 0 and stays silent", async () => {
    seedKeyRow();
    const payload = await exportDb();
    const restored = await importDb(payload);
    expect(restored.needsRekeyCount).toBe(0);
    expect(restored.apiKeys[0].needsRekey).toBe(0);
    expect(restored.warnings ?? []).toHaveLength(0);
  });

  it("pre-S7 raw-key archive rows (no keyHash) are never flagged", async () => {
    const payload = {
      meta: { installId: "another-install" },
      apiKeys: [{ id: "k1", key: RAW_KEY, keyHash: null, name: "legacy", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const restored = await importDb(payload);
    expect(restored.apiKeys[0].needsRekey).toBe(0);
    expect(restored.needsRekeyCount).toBe(0);
  });

  it("RT-06: envelope present but no password skips unwrap (straight to inert)", async () => {
    seedKeyRow();
    const payload = await exportDb({ password: PW });
    becomeInstallB();

    const restored = await importDb(payload); // no password offered
    expect(state.adoptedFile).toBeNull();
    expect(state.secret).toBe(SECRET_B);
    expect(restored.needsRekeyCount).toBe(1);
    expect(restored.apiKeys[0].needsRekey).toBe(1);
  });

  it("no envelope + no installId + keyHash rows → informational warning + needsRekey 1", async () => {
    const payload = {
      meta: {},
      apiKeys: [{ id: "k1", key: MASKED, keyHash: hmacOf(RAW_KEY, SECRET_A), name: "old", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const restored = await importDb(payload);
    expect(restored.needsRekeyCount).toBe(1);
    const warnings = (restored.warnings ?? []).join(" ");
    expect(warnings).toMatch(/predates v0\.6\.44|another machine/i);
  });

  it("RT-04: adoptInstallSecret throwing post-commit flags all keyHash rows and still succeeds", async () => {
    seedKeyRow();
    seedKeyRow({ id: "k2", keyHash: hmacOf("sk-machine1234-ab12cd-zzzzzz", SECRET_A) });
    const payload = await exportDb({ password: PW });
    becomeInstallB();
    state.failAdopt = true;

    const restored = await importDb(payload, { password: PW }); // must NOT throw

    expect(state.rekeyUpdateRuns).toBe(1); // best-effort UPDATE ran
    expect(restored.needsRekeyCount).toBe(2); // both keyHash rows flagged
    expect((restored.warnings ?? []).join(" ")).toMatch(/re-key/i);
  });

  it("RT-05: empty/garbage payloads throw before ANY DELETE runs", async () => {
    // importDb throws synchronously on shape rejection — call in try/catch so
    // the assertion also fails loudly if it ever resolves instead.
    // Null table values count as absent: {meta:{}, settings:null} would pass
    // a plain presence check, wipe every table, and restore nothing.
    for (const bad of [{ meta: {} }, { unexpected: 1 }, {}, { meta: {}, settings: null }]) {
      let threw = false;
      try { await importDb(bad); } catch { threw = true; }
      expect(threw).toBe(true);
    }
    const deletes = state.sql.filter((s) => s.startsWith("DELETE"));
    expect(deletes).toHaveLength(0);
  });

  it("RT-07: overlapping imports serialize (second waits for the first)", async () => {
    seedKeyRow();
    const payloadA = await exportDb({ password: PW });
    becomeInstallB();
    seedKeyRow({ id: "k9", keyHash: hmacOf("sk-machine1234-ab12cd-999999", SECRET_B) });
    const payloadB = await exportDb({ password: PW });

    // Both imports adopt; the mutex must let each run to completion in order
    // rather than interleaving unwrap/transaction/adopt across requests.
    const [a, b] = await Promise.all([
      importDb(payloadA, { password: PW }),
      importDb(payloadB, { password: PW }),
    ]);
    expect(a.needsRekeyCount).toBe(0);
    expect(b.needsRekeyCount).toBe(0);
    expect(state.adoptedFile).toBe("api-keys-hmac");
  });
});
