// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 5;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL", // masked display value (sk-•keyId-••••last4); never the raw key post-migration
      keyHash: "TEXT",             // S7: HMAC-SHA256(raw key, per-install secret)
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key budgets (phase 08): all defaults = current behavior (off).
      budgetType: "TEXT DEFAULT 'off'",       // off | usd | tokens
      budgetLimit: "REAL DEFAULT 0",          // > 0 when budgeted
      budgetWindow: "TEXT DEFAULT 'daily'",   // daily | monthly (server-local)
      softThresholdPct: "INTEGER DEFAULT 80", // edge-triggered alert threshold
      hardBlock: "INTEGER DEFAULT 0",         // 1 -> 429 at limit
      // v0.6.45: imported keyHash that this install's secret cannot validate
      // (re-key to fix). Additive-with-default — NO SCHEMA_VERSION bump needed.
      needsRekey: "INTEGER DEFAULT 0",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_key_hash ON apiKeys(keyHash)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  // v2go/xray proxy integration — catalog of synced V2Ray configs.
  xrayConfigs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      link: "TEXT NOT NULL UNIQUE",
      name: "TEXT",
      protocol: "TEXT",
      country: "TEXT",
      host: "TEXT",
      port: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      lastLatencyMs: "INTEGER",
      lastTestedAt: "TEXT",
      lastExitIp: "TEXT",
      isSelected: "INTEGER DEFAULT 0",
      addedAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_xc_country ON xrayConfigs(country)",
      "CREATE INDEX IF NOT EXISTS idx_xc_protocol ON xrayConfigs(protocol)",
      "CREATE INDEX IF NOT EXISTS idx_xc_active ON xrayConfigs(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_xc_selected ON xrayConfigs(isSelected)",
    ],
  },
  // v2go/xray sync state singleton.
  xraySyncState: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      sourceUrl: "TEXT",
      lastSyncAt: "TEXT",
      lastSyncCount: "INTEGER",
      lastSyncError: "TEXT",
      totalSyncRuns: "INTEGER DEFAULT 0",
    },
  },
  // v2go/xray model proxy filter — cached per-(config, model) probe results.
  // configId mirrors xrayConfigs.id (a sha1 of the canonical link, so it is a
  // natural fingerprint: configs whose underlying link changes get a new id
  // and therefore a fresh cache row). TTL is the subscription sync cycle —
  // rows are dropped when their config disappears from the active catalog.
  xrayModelFilterResults: {
    columns: {
      configId: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      ok: "INTEGER NOT NULL",
      latencyMs: "INTEGER",
      status: "INTEGER",
      exitIp: "TEXT",
      error: "TEXT",
      testedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (configId, model)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_xmfr_model ON xrayModelFilterResults(model)",
      "CREATE INDEX IF NOT EXISTS idx_xmfr_configId ON xrayModelFilterResults(configId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
