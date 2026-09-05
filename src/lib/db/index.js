// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { getMeta, setMeta } from "./helpers/metaStore.js";
import crypto from "node:crypto";

/**
 * Stable per-install identity, stored in _meta (NOT derived from the HMAC
 * secret — exporting it must never leak key-derivation material). exportDb
 * stamps it so importDb can tell "archive from another install" apart and
 * warn that restored API keyHash values can never validate there (S7 keys
 * are install-bound: hash lookup uses this install's secret, raw keys are
 * gone by design).
 */
async function getInstallId() {
  let id = await getMeta("install-id");
  if (!id) {
    id = crypto.randomUUID();
    await setMeta("install-id", id);
  }
  return id;
}

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  markProxyEntryCooldown,
  mutateProxyPoolEntries,
  stampProxyEntryUsed,
  setEntryCooldown,
  normalizeCooldownUntil,
} from "./repos/proxyPoolsRepo.js";

// API keys
// Local import (NOT just the re-export below): exportDb computes keyHash for
// legacy rows. Since S7 the re-export created no local binding and exportDb
// threw ReferenceError on any database holding at least one API key.
import { hashApiKey, maskApiKey } from "./repos/apiKeysRepo.js";
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getApiKeyRow, getApiKeyHashNameMap,
  hashApiKey, maskApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// v2go/xray proxy integration
export {
  getXrayConfigs, getXrayConfigById, getXrayConfigByLink, getXrayConfigCounts, getXrayFacets,
  upsertXrayConfig, bulkUpsertXrayConfigs,
  markStaleXrayConfigs, deleteStaleXrayConfigs, cleanupStaleXrayConfigs, deleteXrayConfig, clearXrayConfigs,
  setSelectedXrayConfig, getSelectedXrayConfig, updateXrayTestResult,
  getXraySyncState, setXraySyncState,
} from "./repos/xrayRepo.js";

// v2go/xray model proxy filter — cached probe results
export {
  getModelFilterResult, getModelFilterResultsByConfigIds, getModelFilterCacheStats,
  getNextHealthyConfigsForModel,
  upsertModelFilterResult,
  clearModelFilterResultsByModel, clearAllModelFilterResults,
  deleteModelFilterResultsByConfigIds, pruneOrphanModelFilterResults,
} from "./repos/modelFilterResultsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    meta: { installId: await getInstallId(), exportedAt: new Date().toISOString() },
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => {
      const data = parseJson(r.data, {});
      // X12: session tokens must never leave the box via DB export.
      if (data?.providerSpecificData?.loginToken) {
        data.providerSpecificData = { ...data.providerSpecificData, loginToken: "[REDACTED]" };
      }
      return { ...data, id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt };
    }),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      // S7: exports carry the hash (computed on the fly for legacy rows) and
      // the masked display value — a raw key never leaves the box, and the
      // backup restores as an already-migrated row.
      keyHash: r.keyHash || hashApiKey(r.key),
      key: r.keyHash ? r.key : maskApiKey(r.key),
      name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt,
      // Phase-08 budget config must survive export/import round-trips.
      budgetType: r.budgetType ?? "off",
      budgetLimit: Number(r.budgetLimit) || 0,
      budgetWindow: r.budgetWindow === "monthly" ? "monthly" : "daily",
      softThresholdPct: Number(r.softThresholdPct) || 80,
      hardBlock: r.hardBlock === 1 || r.hardBlock === true ? 1 : 0,
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

// Settings keys an imported archive must never overwrite (S1): a crafted
// import could otherwise swap the bcrypt password hash or replant the sudo
// ciphertext. Current values are preserved over imported ones.
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  // Cross-install restore (S7 follow-up): apiKeys.keyHash is HMAC'd with the
  // EXPORTING install's secret. On a different install the hash can never
  // match and the raw key exists nowhere, so restored keys are permanently
  // unvalidatable — surface that loudly instead of failing 401s in silence.
  // (Same-install restores share the secret and keep working.)
  let crossInstallKeys = false;
  try {
    const importedInstallId = payload.meta?.installId;
    if (importedInstallId && (payload.apiKeys || []).length > 0) {
      crossInstallKeys = importedInstallId !== (await getInstallId());
    }
  } catch { /* warning is best-effort */ }
  let redactedLoginTokens = 0;

  db.transaction(() => {
    // Snapshot protected settings BEFORE the wipe — they must survive the
    // import (see PROTECTED_SETTING_KEYS below).
    const currentRow = db.get(`SELECT data FROM settings WHERE id = 1`);
    const currentSettings = parseJson(currentRow?.data, null) ?? {};

    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      const importedSettings = { ...payload.settings };
      for (const key of PROTECTED_SETTING_KEYS) {
        if (key in currentSettings) importedSettings[key] = currentSettings[key];
        else delete importedSettings[key];
      }
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(importedSettings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      // X12: exports redact session tokens as the literal "[REDACTED]". Never
      // persist that marker — it would be sent as `Authorization: Bearer
      // [REDACTED]` and surface downstream as a misleading "token expired".
      let redactedTokens = 0;
      if (rest?.providerSpecificData?.loginToken === "[REDACTED]") {
        rest.providerSpecificData = { ...rest.providerSpecificData };
        delete rest.providerSpecificData.loginToken;
        redactedTokens++;
      }
      if (redactedTokens) redactedLoginTokens += redactedTokens;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      // Legacy archives (pre-S7) carry the raw key and no hash — insert as-is;
      // the lazy backfill in validateApiKey migrates it on first use. Archives
      // from this version carry keyHash + masked key directly. Budget columns
      // (phase 08) ride the same row when present.
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt,
          budgetType, budgetLimit, budgetWindow, softThresholdPct, hardBlock) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id, k.key, k.keyHash || null, k.name || null, k.machineId || null,
          k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(),
          k.budgetType || "off", Number(k.budgetLimit) || 0,
          k.budgetWindow === "monthly" ? "monthly" : "daily",
          Number(k.softThresholdPct) || 80,
          k.hardBlock === 1 || k.hardBlock === true ? 1 : 0,
        ]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  const restored = await exportDb();
  const warnings = [];
  if (crossInstallKeys) {
    warnings.push(
      "This archive was exported on a different 9Router install. Its API keys cannot work here (raw keys are never stored), so create new keys and update your tools."
    );
  }
  if (redactedLoginTokens > 0) {
    warnings.push(
      `${redactedLoginTokens} connection(s) had their session login token redacted in the export — sign in again for those accounts (balance/usage display).`
    );
  }
  if (warnings.length) restored.warnings = warnings;
  return restored;
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
