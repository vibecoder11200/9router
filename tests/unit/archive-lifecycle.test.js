// v0.6.46 phase 06 — the whole F promise in ONE file, cross-install:
//
//   install A (secrets hmac:A + crc:A, native keys ×2)
//     ├─ F-export: exportDb({plainSecrets:true}) → sealArchive(json,
//     │   generateArchivePassphrase()) → FILE
//     └─ F-off export: exportDb({password}) → authSecretEnvelope +
//         crcSecretEnvelope (.45+B semantics, both scopes wrapped)
//
//   install B (secrets hmac:B + crc:B)
//     ├─ openArchive(FILE, pass) → importDb(inner, {password:""}) → BOTH
//     │   scopes adopted: validateApiKey true (hmac) AND parseApiKey non-null
//     │   (crc), needsRekeyCount 0, inner carries NO authSecretEnvelope
//     ├─ openArchive(FILE, wrong) → ArchiveError constant, importDb never
//     │   reached (world provably untouched)
//     └─ importDb(F-off payload, {password}) → both envelopes adopted;
//         with API_KEY_SECRET env set: hmac still adopted, CRC skipped +
//         env warning.
//
// Harness: phase-02's RT46-O1 per-fileName Map installSecret mock — NOT the
// .45 single-secret alias (that makes dual-scope adoption vacuous; a
// scope-swap bug would pass). Each scope (api-keys-hmac / api-key-secret) is
// independently observable, so "both adopted" and "CRC skipped under env
// override" are real assertions. REAL crypto (node:crypto scrypt + AES-GCM)
// with the RT-02 fast-params hook (N9R_TEST_ENVELOPE_N, default 4096),
// restored to production params after. Keys are created with the NATIVE
// generator (generateApiKeyWithMachine) and seeded through the same fake
// adapter the other lifecycle harnesses use.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  _setEnvelopeParamsForTests,
  isBackupEnvelope,
} from "@/lib/auth/backupEnvelope";

// RT-02: honor N9R_TEST_ENVELOPE_N (default 65536) so CI can run production
// params; when absent drop N to 4096 so the lifecycle stays fast. Production
// code never reads this env var — only this test file does.
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
  HMAC_A: "a".repeat(64),
  HMAC_B: "b".repeat(64),
  CRC_A: "c".repeat(64),
  CRC_B: "d".repeat(64),
  INSTALL_A: "31111111-2222-4000-8000-00000000000a",
  INSTALL_B: "31111111-2222-4000-8000-00000000000b",
  secrets: new Map(), // fileName -> secret (the RT46-O1 per-fileName Map)
  apiKeys: new Map(),
  connections: new Map(),
  settings: new Map(),
  meta: new Map(),
  genCounter: 0,
}));

// In-memory adapter (same shape as archive-import.test.js — export/import SQL
// plus the 7-param INSERT used to seed natively generated keys).
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

import { getAdapter } from "../../src/lib/db/driver.js";
import {
  exportDb, importDb, validateApiKey,
} from "../../src/lib/db/index.js";
import { hashApiKey, maskApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { parseApiKey, generateApiKeyWithMachine } from "@/shared/utils/apiKey.js";
import {
  ArchiveError,
  generateArchivePassphrase,
  sealArchive,
  openArchive,
  isEncryptedArchive,
} from "@/lib/db/archive.js";

const PASSPHRASE_RE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;
const WRONG_PASS = "definitely-wrong-pass"; // synthetic, never the real one
const PW = "lifecycle-fixture-password-2609"; // synthetic, never a real password

// Tear the world down to another install: fresh tables, its identity in
// _meta, its OWN two secrets (independent scopes — the RT46-O1 core).
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

// Create keys with the NATIVE generator (CRC signed under the CURRENT
// api-key-secret scope) and seed them as migrated rows (masked display +
// hmac keyHash) through the same fake adapter createApiKey would use.
async function seedNativeKeys(count) {
  const db = await getAdapter();
  const rawKeys = [];
  for (let i = 0; i < count; i++) {
    const { key } = generateApiKeyWithMachine("machine1234");
    rawKeys.push(key);
    db.run(
      `INSERT INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        `key-${++state.genCounter}`,
        maskApiKey(key),
        hashApiKey(key), // HMAC under the current api-keys-hmac scope
        "archive-lifecycle",
        "machine1234",
        1,
        new Date().toISOString(),
      ]
    );
  }
  return rawKeys;
}

const ctx = {};

describe("archive lifecycle (v0.6.46 phase 06 — the whole F promise)", () => {
  afterEach(() => {
    // The env-override test mutates process.env — never leak it sideways
    // (belt-and-braces on top of that test's own finally).
    delete process.env.API_KEY_SECRET;
  });

  it("A→B over F: seal with a GENERATED passphrase, import adopts BOTH scopes, key validates AND parses", async () => {
    becomeInstall(state.INSTALL_A, { hmac: state.HMAC_A, crc: state.CRC_A });

    const rawKeys = await seedNativeKeys(2);
    ctx.rawKeys = rawKeys;

    // Sanity: on A both scopes already work (CRC signed under CRC_A).
    expect(parseApiKey(rawKeys[0])).not.toBeNull();
    expect(await validateApiKey(rawKeys[0])).toBe(true);

    // F-export: plain secrets inside the payload, sealed route-side.
    const payload = await exportDb({ plainSecrets: true });
    expect(payload.plainSecrets["api-keys-hmac"]).toBe(state.HMAC_A);
    expect(payload.plainSecrets["api-key-secret"]).toBe(state.CRC_A);
    expect(payload.meta.secretsPlain).toBe(true);
    // F suppresses the .45 inner envelope — secrets ride plain instead.
    expect(payload.authSecretEnvelope).toBeUndefined();
    expect(payload.crcSecretEnvelope).toBeUndefined();
    expect(payload.meta.authSecretWrapped).toBe(false);
    // Raw keys never leave the box.
    const payloadBlob = JSON.stringify(payload);
    for (const k of rawKeys) expect(payloadBlob).not.toContain(k);

    // Route-side sealing with a GENERATED passphrase (100-bit Crockford).
    const pass = generateArchivePassphrase();
    expect(pass).toMatch(PASSPHRASE_RE);
    ctx.file = await sealArchive(JSON.stringify(payload), pass);
    ctx.pass = pass;
    expect(isEncryptedArchive(ctx.file)).toBe(true);
    // Sealed wrapper never contains secret material or raw keys in clear.
    const wrapperBlob = JSON.stringify(ctx.file);
    for (const k of rawKeys) expect(wrapperBlob).not.toContain(k);
    expect(wrapperBlob).not.toContain(state.HMAC_A);
    expect(wrapperBlob).not.toContain(state.CRC_A);

    // Install B: both scopes are B's OWN before the import — a scope-swap
    // bug would show up as these pre-assertions failing.
    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_B);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_B);
    expect(parseApiKey(rawKeys[0])).toBeNull(); // CRC not yet adopted

    const inner = JSON.parse(await openArchive(ctx.file, ctx.pass));
    // F carries NO envelope — the passphrase is the only trust anchor.
    expect(inner.authSecretEnvelope).toBeUndefined();

    const restored = await importDb(inner, { password: "" });

    // BOTH scopes adopted: hash validation (hmac) AND structural parse (crc),
    // for BOTH keys.
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_A);
    expect(await validateApiKey(rawKeys[0])).toBe(true);
    expect(await validateApiKey(rawKeys[1])).toBe(true);
    expect(parseApiKey(rawKeys[0])).not.toBeNull();
    expect(parseApiKey(rawKeys[1])).not.toBeNull();
    expect(restored.needsRekeyCount).toBe(0);
    expect(restored.apiKeys).toHaveLength(2);
    // exportDb's map emits the sticky flag numerically (1/0).
    for (const k of restored.apiKeys) expect(k.needsRekey).toBe(0);
    // RT46-A2(a): adopting DIFFERENT secrets than B's own pushes the
    // non-suppressible replacement warning.
    expect((restored.warnings ?? []).join(" ")).toMatch(
      /This archive replaced this install's key-derivation secrets/
    );
  });

  it("wrong passphrase: ArchiveError with the constant message, importDb never reached (world untouched)", async () => {
    // Fresh install B again — proving the open fails BEFORE anything changes.
    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });

    let caught = null;
    try {
      await openArchive(ctx.file, WRONG_PASS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveError);
    expect(caught.name).toBe("ArchiveError");
    expect(caught.message).toBe("wrong archive passphrase or corrupted archive");
    // No input echo.
    expect(caught.message).not.toContain(WRONG_PASS);

    // Hard fail: no partial output, no import — B's own secrets and tables
    // are exactly as they were.
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_B);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_B);
    expect(state.apiKeys.size).toBe(0);
    expect(state.meta.get("install-id")).toBe(state.INSTALL_B);
  });

  it("F-off from the same install A: password export carries BOTH envelopes; import on B adopts both (.45+B)", async () => {
    becomeInstall(state.INSTALL_A, { hmac: state.HMAC_A, crc: state.CRC_A });
    const rawKeys = await seedNativeKeys(2);

    const sealed = await exportDb({ password: PW });
    // Both scopes wrapped, no plain secrets — the .45+B dual-envelope shape.
    expect(sealed.plainSecrets).toBeUndefined();
    expect(sealed.meta.secretsPlain).toBeUndefined();
    expect(isBackupEnvelope(sealed.authSecretEnvelope)).toBe(true);
    expect(isBackupEnvelope(sealed.crcSecretEnvelope)).toBe(true);
    expect(sealed.meta.authSecretWrapped).toBe(true);
    expect(sealed.meta.crcSecretWrapped).toBe(true);
    const blob = JSON.stringify(sealed);
    for (const k of rawKeys) expect(blob).not.toContain(k);
    expect(blob).not.toContain(state.HMAC_A);
    expect(blob).not.toContain(state.CRC_A);

    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });
    const restored = await importDb(sealed, { password: PW });

    // Both adopted under the dashboard password: validate AND parse.
    expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A);
    expect(state.secrets.get("api-key-secret")).toBe(state.CRC_A);
    expect(await validateApiKey(rawKeys[0])).toBe(true);
    expect(parseApiKey(rawKeys[0])).not.toBeNull();
    expect(restored.needsRekeyCount).toBe(0);
    // Envelope-sourced recovery is EXEMPT from the replacement warning —
    // this IS the documented .45 portability path.
    expect((restored.warnings ?? []).join(" ")).not.toMatch(/replaced this install's/);

    ctx.fOffPayload = sealed;
    ctx.fOffKeys = rawKeys;
  });

  it("API_KEY_SECRET set on the importing install: hmac still adopted, CRC skipped + env warning, parse fails", async () => {
    becomeInstall(state.INSTALL_B, { hmac: state.HMAC_B, crc: state.CRC_B });
    process.env.API_KEY_SECRET = "env-crc-override-fixture"; // synthetic
    try {
      const restored = await importDb(ctx.fOffPayload, { password: PW });

      // hmac scope adopted → keyHash validation works…
      expect(state.secrets.get("api-keys-hmac")).toBe(state.HMAC_A);
      expect(await validateApiKey(ctx.fOffKeys[0])).toBe(true);
      // …but the CRC scope is NOT adopted (env wins) → parse fails.
      expect(state.secrets.get("api-key-secret")).toBe(state.CRC_B);
      expect(parseApiKey(ctx.fOffKeys[0])).toBeNull();
      // CRC failure never touches needsRekey (hmac drove recovery).
      expect(restored.needsRekeyCount).toBe(0);
      const warnings = (restored.warnings ?? []).join(" ");
      expect(warnings).toMatch(/API_KEY_SECRET env override is active/);
      // The env VALUE never leaks into the response.
      expect(warnings).not.toContain("env-crc-override-fixture");
    } finally {
      delete process.env.API_KEY_SECRET;
    }
  });
});
