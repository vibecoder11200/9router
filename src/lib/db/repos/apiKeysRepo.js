import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import { getAdapter } from "../driver.js";
import { getOrCreateInstallSecret } from "@/lib/auth/installSecret.js";

// S7: raw API keys are never stored. Lookup key = HMAC-SHA256(raw key,
// per-install secret); the legacy plaintext `key` column survives only as a
// masked display value after lazy backfill.
function hashApiKey(rawKey) {
  const secret = getOrCreateInstallSecret("api-keys-hmac");
  return crypto.createHmac("sha256", secret).update(String(rawKey)).digest("hex");
}

// Masked display form keeps the unique keyId (no UNIQUE collision on the
// display column) plus the last 4 chars for recognition.
function maskApiKey(rawKey) {
  const k = String(rawKey);
  const parts = k.split("-");
  const keyId = parts.length >= 3 ? parts[parts.length - 2] : "??????";
  const last4 = k.slice(-4);
  return `sk-${keyId}-••••${last4}`;
}

export { hashApiKey, maskApiKey };

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    // Hashed rows carry the masked display value already; a not-yet-migrated
    // legacy row still holds the raw key — mask at read so listings and the
    // API never expose it.
    key: row.keyHash ? row.key : maskApiKey(row.key),
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    // Per-key budgets (phase 08); older rows without the columns resolve to
    // the off-defaults via ??.
    budgetType: row.budgetType ?? "off",
    budgetLimit: Number(row.budgetLimit) || 0,
    budgetWindow: row.budgetWindow === "monthly" ? "monthly" : "daily",
    softThresholdPct: Number.isFinite(Number(row.softThresholdPct)) && Number(row.softThresholdPct) > 0
      ? Math.min(100, Math.floor(Number(row.softThresholdPct)))
      : 80,
    hardBlock: row.hardBlock === 1 || row.hardBlock === true,
    // v0.6.45: imported keyHash this install's secret cannot validate (re-key
    // clears it — phase 03). Older rows without the column resolve to false.
    needsRekey: row.needsRekey === 1 || row.needsRekey === true,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

/**
 * Map of keyHash → { name, id, createdAt } for usage attribution. Hashed rows
 * carry their hash; legacy rows still hold the raw key in `key` until first
 * use, so hash it here — the map then covers every key regardless of
 * migration state. Consumers holding a RAW key hash it and look it up; raw
 * keys never appear in the map itself.
 */
export async function getApiKeyHashNameMap() {
  const db = await getAdapter();
  const rows = db.all(`SELECT id, key, keyHash, name, createdAt FROM apiKeys`);
  const map = new Map();
  for (const row of rows) {
    let hash = row.keyHash;
    if (!hash && row.key && !String(row.key).includes("•")) {
      try { hash = hashApiKey(row.key); } catch { /* unreadable row — skip */ }
    }
    if (hash) map.set(hash, { name: row.name, id: row.id, createdAt: row.createdAt });
  }
  return map;
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: maskApiKey(result.key), // stored masked; the raw key is returned ONCE below
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, hashApiKey(result.key), apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  // Full key only in the creation result, so the UI can show it exactly once.
  return { ...apiKey, key: result.key };
}

// Budget column writes are validated here so every caller (API route, import)
// gets the same clamps (phase 08): type off/usd/tokens, limit > 0 when
// budgeted, window daily/monthly, pct 1-100, hardBlock boolean.
function normalizeBudgetFields(data) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(data, "budgetType")) {
    out.budgetType = ["usd", "tokens"].includes(data.budgetType) ? data.budgetType : "off";
  }
  if (Object.prototype.hasOwnProperty.call(data, "budgetLimit")) {
    const n = Number(data.budgetLimit);
    out.budgetLimit = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (Object.prototype.hasOwnProperty.call(data, "budgetWindow")) {
    out.budgetWindow = data.budgetWindow === "monthly" ? "monthly" : "daily";
  }
  if (Object.prototype.hasOwnProperty.call(data, "softThresholdPct")) {
    const n = Number(data.softThresholdPct);
    out.softThresholdPct = Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 80;
  }
  if (Object.prototype.hasOwnProperty.call(data, "hardBlock")) {
    out.hardBlock = data.hardBlock === true || data.hardBlock === 1 ? 1 : 0;
  }
  return out;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    // `key` is a display value now — callers rename/toggle; they never rotate
    // the secret through this path, and an incoming `key` is ignored rather
    // than written (it would desync from keyHash).
    const budget = normalizeBudgetFields(data);
    const next = {
      budgetType: budget.budgetType ?? (row.budgetType ?? "off"),
      budgetLimit: (budget.budgetLimit ?? Number(row.budgetLimit ?? 0)) || 0,
      budgetWindow: budget.budgetWindow ?? (row.budgetWindow ?? "daily"),
      softThresholdPct: budget.softThresholdPct ?? (row.softThresholdPct ?? 80),
      hardBlock: budget.hardBlock ?? (row.hardBlock ?? 0),
    };
    db.run(
      `UPDATE apiKeys SET name = ?, machineId = ?, isActive = ?,
        budgetType = ?, budgetLimit = ?, budgetWindow = ?, softThresholdPct = ?, hardBlock = ?
        WHERE id = ?`,
      [
        merged.name, merged.machineId, merged.isActive ? 1 : 0,
        next.budgetType, next.budgetLimit, next.budgetWindow,
        next.softThresholdPct, next.hardBlock,
        id,
      ]
    );
    const fresh = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    result = rowToKey(fresh ?? row);
  });
  return result;
}

// v0.6.45 re-key: restore an inert imported key against THIS install's
// secret. Ownership proof needs no old secret — a full masked-string compare
// against the row's own display value. Validation is STRUCTURAL only
// ("sk-" prefix, 2 or 4 dash-parts): parseApiKey's CRC is install-bound and a
// raw key pasted from the exporting install always fails it (phase-03 Key
// Insights). The raw key is never stored raw, returned only via the masked
// rowToKey output, and never logged.
export async function rekeyApiKey(id, rawKey) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return { error: "not_found" };
  const k = String(rawKey ?? "");
  const parts = k.split("-");
  if (!k.startsWith("sk-") || (parts.length !== 2 && parts.length !== 4)) return { error: "invalid" };
  // RT-11: re-key exists ONLY for flagged (inert) rows. Without this gate the
  // masked-compare proof publishes keyId + CRC-derived last4 (≈16 unknown
  // bits), so an any-row rekey surface would allow silent attacker-key
  // substitution in ~65k online guesses.
  if (row.needsRekey !== 1 && row.needsRekey !== true) return { error: "not_needed" };
  if (maskApiKey(k) !== rowToKey(row).key) return { error: "mismatch" };
  db.run(
    `UPDATE apiKeys SET keyHash = ?, key = ?, needsRekey = 0 WHERE id = ?`,
    [hashApiKey(k), maskApiKey(k), id]
  );
  return { key: rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id])) };
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/**
 * Fetch the full apiKeys row for a raw key — hash-first, then the legacy
 * plaintext fallback with the same lazy backfill as validateApiKey. Returns
 * null for unknown keys. Budget enforcement (phase 08) reads the budget*
 * columns from this row so the auth path stays one SELECT.
 */
export async function getApiKeyRow(key) {
  if (!key) return null;
  const db = await getAdapter();
  const isActive = (row) => row.isActive === 1 || row.isActive === true;

  // 1. Hash-first: the normal path for migrated/created keys.
  const row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ?`, [hashApiKey(key)]);
  if (row) return row;

  // 2. Legacy plaintext fallback + lazy backfill (one transaction): the key
  //    keeps working whether or not the backfill write succeeds.
  const legacy = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!legacy) return null;
  if (isActive(legacy)) {
    try {
      db.transaction(() => {
        db.run(`UPDATE apiKeys SET keyHash = ?, key = ? WHERE id = ?`, [
          hashApiKey(key),
          maskApiKey(key),
          legacy.id,
        ]);
      });
    } catch (err) {
      console.warn("[apiKeys] lazy hash backfill failed (key remains usable):", err?.message);
    }
  }
  return legacy;
}

export async function validateApiKey(key) {
  const row = await getApiKeyRow(key);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
