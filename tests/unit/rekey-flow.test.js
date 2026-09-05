import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// In-memory adapter standing in for the SQLite driver — only what the repo uses.
const state = vi.hoisted(() => ({ rows: new Map(), runs: [] }));

function fakeAdapter() {
  return {
    get(sql, params = []) {
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
      return undefined;
    },
    all() {
      return [...state.rows.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    run(sql, params = []) {
      state.runs.push({ sql, params });
      if (sql.startsWith("INSERT INTO apiKeys")) {
        state.rows.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
        });
        return { changes: 1 };
      }
      // UPDATE apiKeys SET keyHash = ?, key = ?, needsRekey = 0 WHERE id = ?
      // param order: keyHash, key, id (phase-03 rekey).
      if (sql.startsWith("UPDATE apiKeys SET keyHash")) {
        const row = state.rows.get(params[2]);
        if (row) {
          row.keyHash = params[0];
          row.key = params[1];
          row.needsRekey = 0;
        }
        return { changes: row ? 1 : 0 };
      }
      if (sql.startsWith("UPDATE apiKeys SET needsRekey")) {
        for (const row of state.rows.values()) row.needsRekey = 1;
        return { changes: state.rows.size };
      }
      return { changes: 0 };
    },
    transaction(fn) { fn(); },
  };
}

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => fakeAdapter()) }));
// Deterministic per-install secret for the HMAC assertions.
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => "test-install-secret",
}));

import crypto from "node:crypto";
import {
  rekeyApiKey, maskApiKey, hashApiKey,
} from "../../src/lib/db/repos/apiKeysRepo.js";
import {
  checkRekeyLock, recordRekeyFail, recordRekeySuccess, resetRekeyLimiter,
} from "../../src/lib/auth/rekeyLimiter.js";

// Raw key of a DIFFERENT install: 4 parts, garbage CRC ("deadbeef") — parseApiKey
// rejects it under the test secret, exactly like a key pasted cross-install.
const RAW_KEY = "sk-machine1234-ab12cd34efgh-deadbeef";
const FOREIGN_KEY = "sk-other9999zzzz-zz99wxyz99aa-0badf00d";

const hmacOf = (key) => crypto.createHmac("sha256", "test-install-secret").update(key).digest("hex");

let seq = 0;
function seedRow({ raw, needsRekey = 1, keyHash = "foreignhash0000000000000000000000" }) {
  const id = `key-${++seq}`;
  state.rows.set(id, {
    id,
    key: maskApiKey(raw), // imported rows carry the masked display value
    keyHash,
    name: `imported-${seq}`,
    machineId: "machine1234",
    isActive: 1,
    createdAt: `2026-09-0${(seq % 9) + 1}T00:00:00.000Z`,
    needsRekey,
  });
  return id;
}

beforeEach(() => {
  state.rows.clear();
  state.runs.length = 0;
  resetRekeyLimiter();
});

describe("rekeyApiKey (phase-03)", () => {
  it("happy path: flagged row + matching raw key re-hashes under the CURRENT secret, clears the flag", async () => {
    const id = seedRow({ raw: RAW_KEY });
    const result = await rekeyApiKey(id, RAW_KEY);

    expect(result.error).toBeUndefined();
    expect(result.key.keyHash).toBeUndefined(); // rowToKey never exposes the hash
    const row = state.rows.get(id);
    expect(row.keyHash).toBe(hmacOf(RAW_KEY));
    expect(row.key).toBe(maskApiKey(RAW_KEY));
    expect(row.needsRekey).toBe(0);
    expect(result.key.needsRekey).toBe(false);
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
  });

  it("mismatch: raw key of a different keyId → error, row unchanged", async () => {
    const id = seedRow({ raw: RAW_KEY });
    const result = await rekeyApiKey(id, FOREIGN_KEY);

    expect(result).toEqual({ error: "mismatch" });
    const row = state.rows.get(id);
    expect(row.keyHash).toBe("foreignhash0000000000000000000000");
    expect(row.needsRekey).toBe(1);
  });

  it("invalid: non-sk-, 3-part, 5-part, and empty inputs → { error: 'invalid' }", async () => {
    const id = seedRow({ raw: RAW_KEY });
    expect(await rekeyApiKey(id, "banana")).toEqual({ error: "invalid" });
    expect(await rekeyApiKey(id, "sk-a-b")).toEqual({ error: "invalid" }); // 3 parts
    expect(await rekeyApiKey(id, "sk-a-b-c-d")).toEqual({ error: "invalid" }); // 5 parts
    expect(await rekeyApiKey(id, "")).toEqual({ error: "invalid" });
    expect(await rekeyApiKey(id, null)).toEqual({ error: "invalid" });
    // DEVIATION NOTE: phase file listed "sk-only" as invalid, but a 2-part key
    // IS structurally valid (legacy format) — against this row it yields
    // mismatch, per the binding step-1 code. Pinned here:
    expect(await rekeyApiKey(id, "sk-only")).toEqual({ error: "mismatch" });
  });

  it("not found id → { error: 'not_found' }", async () => {
    expect(await rekeyApiKey("missing", RAW_KEY)).toEqual({ error: "not_found" });
  });

  it("RT-11 gate: needsRekey=0 row → { error: 'not_needed' }, row unchanged", async () => {
    const id = seedRow({ raw: RAW_KEY, needsRekey: 0 });
    const result = await rekeyApiKey(id, RAW_KEY);

    expect(result).toEqual({ error: "not_needed" });
    const row = state.rows.get(id);
    expect(row.keyHash).toBe("foreignhash0000000000000000000000");
    expect(row.needsRekey).toBe(0);
  });

  it("masked-compare proof: foreign-CRC raw key still passes the structural path", async () => {
    // Pin the cross-install reality: parseApiKey (install-bound CRC) rejects
    // this key under the test secret, yet rekey accepts it — the mask compare
    // is the real proof, CRC is deliberately NOT enforced (phase-03).
    const { parseApiKey } = await vi.importActual("../../src/shared/utils/apiKey.js");
    expect(parseApiKey(RAW_KEY)).toBeNull();

    const id = seedRow({ raw: RAW_KEY });
    const result = await rekeyApiKey(id, RAW_KEY);
    expect(result.error).toBeUndefined();
    expect(state.rows.get(id).keyHash).toBe(hmacOf(RAW_KEY));
  });

  it("raw key never appears in the JSON-serialized result", async () => {
    const id = seedRow({ raw: RAW_KEY });
    const result = await rekeyApiKey(id, RAW_KEY);
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
    expect(JSON.stringify(result)).not.toContain('"keyHash"');
  });
});

describe("rekeyLimiter (RT-11)", () => {
  it("5th mismatch per key engages the 15-minute lock; 6th attempt is blocked", async () => {
    for (let i = 1; i <= 4; i++) {
      const fail = recordRekeyFail("key-locked");
      expect(fail.lockedNow).toBe(false);
    }
    expect(checkRekeyLock("key-locked")).toEqual({ locked: false });

    const fifth = recordRekeyFail("key-locked");
    expect(fifth.lockedNow).toBe(true);
    expect(fifth.retryAfter).toBe(15 * 60);

    const lock = checkRekeyLock("key-locked");
    expect(lock.locked).toBe(true);
    expect(lock.retryAfter).toBeGreaterThan(0);

    // Other key ids are unaffected by a per-key lock.
    expect(checkRekeyLock("key-other")).toEqual({ locked: false });
  });

  it("recordRekeySuccess clears the per-key counter", () => {
    for (let i = 0; i < 4; i++) recordRekeyFail("key-ok");
    recordRekeySuccess("key-ok");
    // Counter restarted: 4 more fails after success do NOT lock.
    let last;
    for (let i = 0; i < 4; i++) last = recordRekeyFail("key-ok");
    expect(last.lockedNow).toBe(false);
    expect(checkRekeyLock("key-ok").locked).toBe(false);
  });

  it("global budget: 20 mismatches across ids in the hour lock everything", () => {
    for (let i = 0; i < 20; i++) recordRekeyFail(`key-g-${i}`);
    const lock = checkRekeyLock("key-fresh");
    expect(lock.locked).toBe(true);
    expect(lock.retryAfter).toBeGreaterThan(0);
  });
});
