// v0.6.45 key portability — phase-06 cross-install lifecycle (integration):
// ONE describe drives the whole v0.6.45 promise across three simulated
// installs, reusing file-level mocks (never re-mocked per test):
//   A: native 12-char keyId key (phase-04 generator, unmocked) + password-
//      sealed export (phase-01/02 envelope).
//   B: import adopts the secret (state.secret back to A's), keys validate
//      in-process, re-export re-wraps the ADOPTED secret (portable chain).
//   C: a third install imports that second archive with a WRONG password —
//      still imports, flags needsRekey, re-key round-trip restores validation.
//   + RT-19 negatives: malformed payloads throw the shape-guard error before
//     any DELETE runs (adapter records every run() SQL).
// Harness: s7-followup-regressions.test.js adapter + phase-02 stateful
// installSecret mock (RT-10 / amendment #5: getOrCreate + read + adopt share
// state.secret). Envelope params follow the RT-02 N9R_TEST_ENVELOPE_N
// fast-params pattern (backup-envelope.test.js) so the lifecycle stays fast.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import {
  _setEnvelopeParamsForTests,
  isBackupEnvelope,
  openBackupSecret,
} from "@/lib/auth/backupEnvelope";

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

// Synthetic fixture secrets (64-char hex, the real install-secret format) and
// fixed install ids — no real secret material ever enters this file.
const state = vi.hoisted(() => ({
  SECRET_A: "a".repeat(64),
  SECRET_B: "b".repeat(64),
  SECRET_C: "c".repeat(64),
  INSTALL_A: "11111111-2222-4000-8000-00000000000a",
  INSTALL_B: "11111111-2222-4000-8000-00000000000b",
  INSTALL_C: "11111111-2222-4000-8000-00000000000c",
  apiKeys: new Map(),
  connections: new Map(),
  settings: new Map(),
  meta: new Map(),
  secret: "a".repeat(64),
  adoptedFile: null,
  sql: [],
}));
const { SECRET_A, SECRET_B, SECRET_C, INSTALL_A, INSTALL_B, INSTALL_C } = state;

// In-memory adapter standing in for the SQLite driver — union of the phase-02
// harness (export/import/re-key SQL) plus createApiKey's 7-param INSERT, so
// the native key generator can create keys through the same fake. run()
// records every statement (state.sql) — RT-19 counts DELETEs from it.
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
      // RT-04 best-effort flag-all path (adopt failure after commit).
      if (sql.startsWith("UPDATE apiKeys SET needsRekey")) {
        for (const row of state.apiKeys.values()) {
          if (row.keyHash) row.needsRekey = 1;
        }
        return { changes: state.apiKeys.size };
      }
      // UPDATE apiKeys SET keyHash = ?, key = ?, needsRekey = 0 WHERE id = ?
      // (phase-03 re-key) — param order: keyHash, key, id.
      if (sql.startsWith("UPDATE apiKeys SET keyHash")) {
        const row = state.apiKeys.get(params[2]);
        if (row) {
          row.keyHash = params[0];
          row.key = params[1];
          row.needsRekey = 0; // lifecycle asserts the flag actually clears
        }
        return { changes: row ? 1 : 0 };
      }
      // createApiKey (7 params): fresh key created by the NATIVE generator.
      if (sql.startsWith("INSERT INTO apiKeys")) {
        state.apiKeys.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
          needsRekey: 0,
        });
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
// Stateful installSecret mock (phase-02 RT-10 + phase-06 amendment #5): ALL
// THREE exports share one `state.secret` — flows swap installs by swapping
// that value, so this mock is defined once and never re-mocked per test.
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => {
    if (!state.secret) state.secret = "generated-secret";
    return state.secret;
  },
  readInstallSecret: () => state.secret,
  adoptInstallSecret: (fileName, secret) => {
    if (typeof secret !== "string" || !secret.trim()) throw new Error("adoptInstallSecret: empty secret");
    state.secret = secret;
    state.adoptedFile = fileName;
    return secret;
  },
}));

import crypto from "node:crypto";
import {
  createApiKey, exportDb, importDb, getApiKeyById, validateApiKey, rekeyApiKey, maskApiKey,
} from "../../src/lib/db/index.js";
import { parseApiKey } from "../../src/shared/utils/apiKey.js";

const PW = "lifecycle-fixture-password-2609"; // synthetic, never a real password
const WRONG_PW = "definitely-not-the-export-password";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmacOf = (key, secret) => crypto.createHmac("sha256", secret).update(key).digest("hex");

// Carried across the ordered lifecycle flows (A → B → C). Vitest runs the
// tests of one file sequentially in declaration order; the lifecycle itself
// is the shared fixture (phase-06 Architecture: one describe, one chained
// flow). Only the SQL log resets per test.
const ctx = {};

// Tear the world down to another install: fresh tables, that install's
// identity in _meta, its own HMAC secret.
function becomeInstall(installId, secret) {
  state.apiKeys.clear();
  state.connections.clear();
  state.settings.clear();
  state.meta.clear();
  state.meta.set("install-id", installId);
  state.secret = secret;
  state.adoptedFile = null;
}

beforeEach(() => {
  // RT-19 counts THIS test's statements only.
  state.sql = [];
});

describe("key portability lifecycle (v0.6.45 phase-06)", () => {
  it("Flow A — install A: createApiKey yields a native 12-char keyId; export seals the secret", async () => {
    becomeInstall(INSTALL_A, SECRET_A);

    const created = await createApiKey("lifecycle", "machine1234");
    ctx.rawKey = created.key;
    ctx.rowId = created.id;

    // Phase-04 made the generator native — no mock here: 12-char
    // crypto-random keyId, structurally parseable with a valid CRC.
    // (createApiKey returns the raw key once; keyId rides inside it.)
    const parsed = parseApiKey(created.key);
    expect(parsed?.isNewFormat).toBe(true);
    expect(parsed?.keyId).toMatch(/^[a-z0-9]{12}$/);

    const payload = await exportDb({ password: PW });
    ctx.payloadA = payload;

    expect(isBackupEnvelope(payload.authSecretEnvelope)).toBe(true);
    expect(payload.meta.authSecretWrapped).toBe(true);
    expect(payload.meta.installId).toBe(INSTALL_A);

    // Exported row: masked display (12-char keyId segment), HMAC under A's
    // secret, never the raw key, never the wrapped secret's plaintext.
    const row = payload.apiKeys[0];
    expect(row.id).toBe(created.id);
    expect(row.key).toBe(maskApiKey(created.key));
    expect(row.key.split("-")[1]).toMatch(/^[a-z0-9]{12}$/);
    expect(row.keyHash).toBe(hmacOf(created.key, SECRET_A));
    expect(row.needsRekey).toBe(0);

    const blob = JSON.stringify(payload);
    expect(blob).not.toContain(created.key);
    expect(blob).not.toContain(SECRET_A);
  });

  it("Flow B — install B: import adopts the secret, key validates, re-export re-wraps it", async () => {
    becomeInstall(INSTALL_B, SECRET_B);

    const restored = await importDb(ctx.payloadA, { password: PW });

    // Adoption: this install now signs with A's secret — in-process, no
    // restart (readInstallSecret sees it too, RT-10).
    expect(state.adoptedFile).toBe("api-keys-hmac");
    expect(sha256(state.secret)).toBe(sha256(SECRET_A));
    expect(restored.apiKeys).toHaveLength(1);
    expect(restored.apiKeys[0].needsRekey).toBe(0);
    expect(restored.needsRekeyCount).toBe(0);
    expect(await validateApiKey(ctx.rawKey)).toBe(true);

    // Cross-install warning suppressed when adoption succeeded — in fact the
    // clean-adopt import carries no warnings at all.
    const warnings = restored.warnings ?? [];
    expect(warnings.join(" ")).not.toMatch(/different/i);
    expect(warnings).toHaveLength(0);

    // Portable chain: exporting on B re-wraps the ADOPTED secret, so a third
    // install needs only the same password (assert second envelope exists and
    // opens back to A's secret; plaintext never in the JSON).
    const payload2 = await exportDb({ password: PW });
    ctx.payloadB = payload2;
    expect(isBackupEnvelope(payload2.authSecretEnvelope)).toBe(true);
    expect(payload2.meta.authSecretWrapped).toBe(true);
    expect(payload2.meta.installId).toBe(INSTALL_B);
    expect(await openBackupSecret(payload2.authSecretEnvelope, PW)).toBe(SECRET_A);
    expect(JSON.stringify(payload2)).not.toContain(SECRET_A);
  });

  it("Flow C — install C: wrong password still imports (flagged), re-key restores validation", async () => {
    becomeInstall(INSTALL_C, SECRET_C);

    // Wrong password must NOT throw — the import succeeds with the re-key
    // warning, and the carried keyHash row is flagged inert.
    const restored = await importDb(ctx.payloadB, { password: WRONG_PW });

    expect(state.adoptedFile).toBeNull(); // adoption never ran
    expect(sha256(state.secret)).toBe(sha256(SECRET_C));
    expect(restored.needsRekeyCount).toBe(1);
    expect(restored.apiKeys[0].needsRekey).toBe(1);
    const warnings = (restored.warnings ?? []).join(" ");
    expect(warnings).toMatch(/re-key/i);
    expect(warnings).not.toContain(PW);

    // Re-key round-trip (phase-03): paste the raw key once → re-hashed under
    // THIS install's secret, flag cleared, validation works again.
    const rekeyed = await rekeyApiKey(ctx.rowId, ctx.rawKey);
    expect(rekeyed.error).toBeUndefined();
    expect(rekeyed.key.needsRekey).toBe(false);
    expect(JSON.stringify(rekeyed)).not.toContain(ctx.rawKey);

    expect(await validateApiKey(ctx.rawKey)).toBe(true);
    const fresh = await getApiKeyById(ctx.rowId);
    expect(fresh.needsRekey).toBe(false);
    expect(fresh.key).toBe(maskApiKey(ctx.rawKey));
  });

  it("RT-19 — malformed payloads throw the shape-guard error before ANY DELETE runs", () => {
    // Both rejects are the phase-02 RT-05 guard, not the generic payload error.
    expect(() => importDb({})).toThrow("not a 9Router backup archive");
    expect(() => importDb({ unexpected: 1 })).toThrow("not a 9Router backup archive");
    const deletes = state.sql.filter((s) => s.startsWith("DELETE"));
    expect(deletes).toHaveLength(0);
  });
});
