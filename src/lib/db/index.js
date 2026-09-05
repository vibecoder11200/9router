// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { getMeta, setMeta } from "./helpers/metaStore.js";
import { isBackupEnvelope, openBackupSecret } from "@/lib/auth/backupEnvelope.js";
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
  rekeyApiKey,
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
//
// v0.6.45 key portability: `options.password` (a dashboard password already
// verified by the caller against the STORED bcrypt hash — RT-03) wraps the
// "api-keys-hmac" install secret into `authSecretEnvelope` so a backup is
// portable across installs. Without a password the archive is envelope-less
// (`meta.authSecretWrapped === false`) and imported keyHash rows cannot
// validate on another install (needsRekey flags them on import).
export async function exportDb(options = {}) {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    meta: {
      installId: await getInstallId(),
      exportedAt: new Date().toISOString(),
      authSecretWrapped: false,
    },
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
      // Sticky: an inert (needsRekey) row re-exported stays inert until
      // re-keyed on some install.
      needsRekey: r.needsRekey === 1 || r.needsRekey === true ? 1 : 0,
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

  if (typeof options.password === "string" && options.password) {
    const { sealBackupSecret } = await import("@/lib/auth/backupEnvelope.js");
    const { getOrCreateInstallSecret } = await import("@/lib/auth/installSecret.js");
    out.authSecretEnvelope = await sealBackupSecret(getOrCreateInstallSecret("api-keys-hmac"), options.password);
    out.meta.authSecretWrapped = Boolean(out.authSecretEnvelope);
  }

  return out;
}

// Settings keys an imported archive must never overwrite (S1): a crafted
// import could otherwise swap the bcrypt password hash or replant the sudo
// ciphertext. Current values are preserved over imported ones.
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

// RT-05: minimum shape a payload must have before importDb may wipe anything.
// A wrong file pick ({}, {"unexpected":1}) must NEVER reach the DELETEs —
// it would drop every table and (worse) reset auth to the "123456" fallback.
const KNOWN_TABLE_KEYS = [
  "settings", "providerConnections", "providerNodes", "proxyPools", "apiKeys",
  "combos", "modelAliases", "customModels", "mitmAlias", "pricing",
];

// RT-07: serialize the whole unwrap→transaction→adopt sequence. db.transaction
// callbacks are synchronous, but the scrypt unwrap and the awaited exportDb
// yield between them — two overlapping imports must never interleave and pair
// rows with the wrong secret.
let importChain = Promise.resolve();

export function importDb(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  // RT-05 shape guard FIRST — before any DELETE could run.
  if (
    !payload.meta || typeof payload.meta !== "object" ||
    !KNOWN_TABLE_KEYS.some((k) => k in payload && payload[k] !== undefined)
  ) {
    throw new Error("Invalid database payload: not a 9Router backup archive");
  }
  const run = importChain.then(
    () => doImportDb(payload, options),
    () => doImportDb(payload, options)
  );
  // A rejected import never poisons the chain for later imports.
  importChain = run.then(() => undefined, () => undefined);
  return run;
}

async function doImportDb(payload, options = {}) {
  const db = await getAdapter();
  const password = typeof options.password === "string" ? options.password : "";
  const envelope = payload.authSecretEnvelope;

  // Cross-install restore (S7 follow-up): apiKeys.keyHash is HMAC'd with the
  // EXPORTING install's secret. When the envelope's secret is adopted below,
  // hashes DO validate despite differing installIds — so the cross-install
  // warning is suppressed for adopted imports. A missing imported installId
  // counts as unknown (foreignOrUnknown): pre-v0.6.44 archives with keyHash
  // flag needsRekey; that is advisory-only and re-key is optional.
  let importedInstallId = null;
  let crossInstallKeys = false;
  let foreignOrUnknown = false;
  try {
    importedInstallId = payload.meta?.installId ?? null;
    const localInstallId = await getInstallId();
    foreignOrUnknown = importedInstallId !== localInstallId;
    if (importedInstallId && (payload.apiKeys || []).length > 0) {
      crossInstallKeys = foreignOrUnknown;
    }
  } catch { /* warning is best-effort */ }

  // Unwrap BEFORE the transaction (async scrypt cannot run inside the sync
  // transaction callback). RT-06: skip entirely without a password — an
  // envelope-bearing archive imported password-less goes straight to inert
  // instead of burning a full scrypt to inevitably fail.
  let newSecret = null;
  let unwrapFailed = false;
  if (password && isBackupEnvelope(envelope)) {
    try {
      newSecret = await openBackupSecret(envelope, password);
    } catch {
      unwrapFailed = true; // wrong password or tamper — NEVER hard-fail the import
    }
  }

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
      // the lazy backfill in validateApiKey migrates it on first use (and such
      // rows are never needsRekey: their hash is computed locally on arrival).
      // Archives from this version carry keyHash + masked key directly, plus
      // budget columns (phase 08) and the sticky needsRekey flag. Inert rows =
      // keyHash present AND the envelope's secret was NOT recovered AND the
      // archive is from a different/unknown install — same-install wrong or
      // missing password leaves the local secret untouched, so hashes still
      // validate and needsRekey stays 0.
      const inert = !newSecret && Boolean(k.keyHash) && foreignOrUnknown;
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt,
          budgetType, budgetLimit, budgetWindow, softThresholdPct, hardBlock, needsRekey) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id, k.key, k.keyHash || null, k.name || null, k.machineId || null,
          k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(),
          k.budgetType || "off", Number(k.budgetLimit) || 0,
          k.budgetWindow === "monthly" ? "monthly" : "daily",
          Number(k.softThresholdPct) || 80,
          k.hardBlock === 1 || k.hardBlock === true ? 1 : 0,
          (k.needsRekey === 1 || k.needsRekey === true || inert) ? 1 : 0,
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

  // RT-04: adopt AFTER the transaction commits — nothing inside the sync
  // transaction needs the secret (INSERT values come verbatim from the
  // payload). If adoption fails post-commit, imported rows are stranded
  // inert-but-unflagged: best-effort flag every keyHash row needsRekey and
  // surface the re-key warning (import still succeeds).
  let adopted = false;
  let adoptFailed = false;
  if (newSecret) {
    try {
      const { adoptInstallSecret } = await import("@/lib/auth/installSecret.js");
      adoptInstallSecret("api-keys-hmac", newSecret);
      adopted = true;
    } catch (err) {
      adoptFailed = true;
      console.error("[DB][import] key secret adoption failed after commit — imported API keys need re-keying:", err?.message);
      try {
        db.run(`UPDATE apiKeys SET needsRekey = 1 WHERE keyHash IS NOT NULL`);
      } catch { /* best-effort */ }
    }
  }

  const restored = await exportDb();
  const needsRekeyCount = (restored.apiKeys || []).filter((k) => k.needsRekey).length;
  const warnings = [];
  if (unwrapFailed) {
    warnings.push(
      `The backup embedded an encrypted key secret, but the password did not match the one used when the backup was exported. Everything else was imported. ${needsRekeyCount} API key(s) were restored but cannot authenticate until re-keyed (Endpoint page → Re-key, or CLI) — paste each raw key once.`
    );
  }
  if (adoptFailed) {
    warnings.push(
      `The backup's embedded key secret could not be activated on this install. Everything else was imported. ${needsRekeyCount} API key(s) were restored but cannot authenticate until re-keyed (Endpoint page → Re-key, or CLI) — paste each raw key once.`
    );
  }
  if (crossInstallKeys && !adopted) {
    warnings.push(
      "This archive was exported on a different 9Router install and its API-key secret was not restored, so the imported keys cannot authenticate here (raw keys are never stored) — re-key them (Endpoint page → Re-key, or CLI) and update your tools."
    );
  }
  if (redactedLoginTokens > 0) {
    warnings.push(
      `${redactedLoginTokens} connection(s) had their session login token redacted in the export — sign in again for those accounts (balance/usage display).`
    );
  }
  if (!envelope && !importedInstallId && (payload.apiKeys || []).some((k) => k.keyHash)) {
    warnings.push(
      "This backup predates v0.6.44 and carries no install id or embedded secret — if it came from another machine, its keys need re-keying."
    );
  }
  if (warnings.length) restored.warnings = warnings;
  restored.needsRekeyCount = needsRekeyCount;
  return restored;
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
