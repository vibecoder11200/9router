// v0.6.46 phase 02 — db-level Option F lifecycle: passphrase-sealed
// whole-archive export/import across installs, with BOTH install-secret
// scopes (api-keys-hmac + api-key-secret) in play.
//
// RT46-O1 harness rework: the .45 lifecycle mock aliased both scopes to one
// state.secret and ignored fileName — dual-scope adoption would be vacuous on
// it (a scope-swap bug would pass). This harness mocks installSecret with a
// per-fileName Map mirroring installSecret.js: getOrCreate reads/creates,
// adoptInstallSecret writes, readInstallSecret peeks. Installs are driven via
// becomeInstall(id, {hmac, crc}). The REAL archive.js (phase 01) seals/opens;
// envelope params follow the RT-02 fast-params pattern (N9R_TEST_ENVELOPE_N).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  _setEnvelopeParamsForTests,
  isBackupEnvelope,
  openBackupSecret,
} from "@/lib/auth/backupEnvelope";

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

// Synthetic fixture secrets (64-char hex, the real install-secret format) —
// no real secret material ever enters this file.
const state = vi.hoisted(() => ({
  HMAC_A: "a".repeat(64),
  HMAC_B: "b".repeat(64),
  CRC_A: "c".repeat(64),
  CRC_B: "d".repeat(64),
  INSTALL_A: "21111111-2222-4000-8000-00000000000a",
  INSTALL_B: "21111111-2222-4000-8000-00000000000b",
  secrets: new Map(), // fileName -> secret (the per-fileName Map, RT46-O1)
  apiKeys: new Map(),
  connections: new Map(),
  settings: new Map(),
  meta: new Map(),
  genCounter: 0,
}));

// In-memory adapter (same shape as key-portability-lifecycle.test.js —
// export/import SQL plus createApiKey's 7-param INSERT for the native
// generator).
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
      if (sql.startsWith("INSERT INTO _meta")) state.meta.set(params[0], params[1]);
      if (sql.startsWith("DELETE FROM apiKeys")) state.apiKeys.clear();
      if (sql.startsWith("DELETE FROM providerConnections")) state.connections.clear();
      if (sql.startsWith("DELETE FROM settings")) state.settings.clear();
      if (sql.startsWith("UPDATE apiKeys SET needsRekey")) {
        for (const row of state.apiKeys.values()) {
          if (row.keyHash) row.needsRekey = 1;
        }
        return { changes: state.apiKeys.size };
      }
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

// RT46-O1: per-fileName Map mock mirroring installSecret.js — each scope
// (api-keys-hmac, api-key-secret) has its own entry, so dual-scope adoption
// is observable independently.
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: (fileName = "install-secret") => {
    let secret = state.secrets.get(fileName);
    if (!secret) {
      secret = `generated-${fileName}-${++state.genCounter}`;
      state.secrets.set(fileName, secret);
    }
    return secret;
  },
  adoptInstallSecret: (fileName, secret) => {
    if (typeof secret !== "string" || !secret.trim()) throw new Error("adoptInstallSecret: empty secret");
    state.secrets.set(fileName, secret);
    return secret;
  },
  readInstallSecret: (fileName = "install-secret") => state.secrets.get(fileName) ?? null,
}));

import {
  createApiKey, exportDb, importDb, validateApiKey,
} from "../../src/lib/db/index.js";
import { parseApiKey } from "../../src/shared/utils/apiKey.js";
import { sealArchive, openArchive } from "@/lib/db/archive.js";

const PASSPHRASE = "archive-test-passphrase-2609"; // synthetic, never real
const PW = "lifecycle-fixture-password-2609"; // synthetic, never real

// Tear the world down to another install: fresh tables, its identity in
// _meta, its OWN two secrets (independent scopes).
function becomeInstall(installId, { hmac, crc }) {
  state.apiKeys.clear();
  state.connections.clear();
  state.settings.clear();
  state.meta.clear();
  state.meta.set("install-id", installId);
  state.secrets.clear();
  if (hmac !== undefined) state.secrets.set("api-keys-hmac", hmac);
  if (crc !== undefined) state.secrets.set("api-key-secret", crc);
}

const ctx = {};

describe("archive import lifecycle (v0.6.46 phase 02, Option F)", () => {
  afterEach(() => {
    // The env-override test mutates process.env — never leak it sideways.
    delete process.env.API_KEY_SECRET;
  });

  it("A→B: plainSecrets export seals both scopes; passphrase import adopts BOTH, key validates AND parses", async () => {
    becomeInstall(state.INSTALL_A, { hmac: state.HMAC_A, crc: state.CRC_A });

    const created = await createApiKey("archive-lifecycle", "machine1234");
    ctx.rawKey = created.key;

    const payload = await exportDb({ plainSecrets: true });
    expect(payload.plainSecrets).toBeDefined();
    expect(payload.plainSecrets["api-keys-hmac"]).toBe(state.HMAC_A);
    expect(payload.plainSecrets["api-key-secret"]).toBe(state.CRC_A);
    expect(payload.meta.secretsPlain).toBe(true);
    // F suppresses the .45 inner envelope (secrets ride plain instead).
    expect(payload.authSecretEnvelope).toBeUndefined();
    expect(payload.meta.authSecretWrapped).toBe(false);
    // Raw key never leaves the box.
    expect(JSON.stringify(payload)).not.toContain(created.key);

    const wrapper = await sealArchive(JSON.stringify(payload), PASSPHRASE);
    expect(wrapper.format).toBe("9router-encrypted-archive");
    // Sealed wrapper never contains secret material or the raw key in clear.
    const wrapperBlob = JSON.stringify(wrapper);
    expect(wrapperBlob).not.toContain(state.HMAC_A);
    expect(wrapperBlob).not.toContain(created.key);

    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });
    const inner = JSON.parse(await openArchive(wrapper, PASSPHRASE));
    expect(inner.authSecretEnvelope).toBeUndefined(); // risk-row pin

    const restored = await importDb(inner, {});

    // BOTH scopes adopted: hash validation (hmac) AND structural parse (crc).
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_A);
    expect(await validateApiKey(ctx.rawKey)).toBe(true);
    expect(parseApiKey(ctx.rawKey)).not.toBeNull();
    expect(restored.needsRekeyCount).toBe(0);
    // RT46-A2(a): adopting a DIFFERENT secret than install B's own pushes the
    // non-suppressible replacement warning (route surfaces restored.warnings).
    expect((restored.warnings ?? []).join(" ")).toMatch(
      /This archive replaced this install's key-derivation secrets/
    );
    ctx.inner = inner;
  });

  it("API_KEY_SECRET set on the importing install: hmac still adopted, CRC skipped + env warning, parse fails", async () => {
    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });
    process.env.API_KEY_SECRET = "env-crc-override-fixture"; // synthetic

    const restored = await importDb(ctx.inner, {});

    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A); // hmac unaffected
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_B); // NOT adopted
    expect(await validateApiKey(ctx.rawKey)).toBe(true); // hash lookup is hmac-scoped
    expect(parseApiKey(ctx.rawKey)).toBeNull(); // CRC now computed under the env secret
    const warnings = (restored.warnings ?? []).join(" ");
    expect(warnings).toMatch(/API_KEY_SECRET env override is active/);
    expect(warnings).toMatch(/replaced this install's key-derivation secrets/); // hmac still replaced B's
  });

  it("same secrets on the importing install: no replacement warning (RT46-A2 — only DIFFERENT secrets warn)", async () => {
    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_A, crc: state.CRC_A }); // already A's secrets

    const restored = await importDb(ctx.inner, {});
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_A);
    expect(await validateApiKey(ctx.rawKey)).toBe(true);
    expect((restored.warnings ?? []).join(" ")).not.toMatch(/replaced this install's/);
  });

  it("db-level guard: exportDb({}) and exportDb({password}) NEVER emit plainSecrets (F route is the only caller)", async () => {
    becomeInstall(state.INSTALL_A, { hmac: state.HMAC_A, crc: state.CRC_A });

    const plain = await exportDb({});
    expect(plain.plainSecrets).toBeUndefined();
    expect(plain.authSecretEnvelope).toBeUndefined();

    const sealed = await exportDb({ password: PW });
    expect(sealed.plainSecrets).toBeUndefined();
    expect(isBackupEnvelope(sealed.authSecretEnvelope)).toBe(true);
    // Decision B: password exports additionally wrap the CRC secret.
    expect(isBackupEnvelope(sealed.crcSecretEnvelope)).toBe(true);
    expect(sealed.meta.crcSecretWrapped).toBe(true);
    expect(await openBackupSecret(sealed.crcSecretEnvelope, PW)).toBe(state.CRC_A);
    expect(JSON.stringify(sealed)).not.toContain(state.HMAC_A);
    expect(JSON.stringify(sealed)).not.toContain(state.CRC_A);
  });

  it("exportDb({plainSecrets:true}) under API_KEY_SECRET: env value never leaks, crc omitted from plainSecrets", async () => {
    becomeInstall(state.INSTALL_A, { hmac: state.HMAC_A, crc: state.CRC_A });
    process.env.API_KEY_SECRET = "env-crc-override-fixture"; // synthetic

    const payload = await exportDb({ plainSecrets: true });
    expect(payload.plainSecrets["api-keys-hmac"]).toBe(state.HMAC_A);
    expect(payload.plainSecrets["api-key-secret"]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("env-crc-override-fixture");
  });
});
