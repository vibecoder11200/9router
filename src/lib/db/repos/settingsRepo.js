import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  // Tunnel the app does not manage itself (e.g. cloudflared run via systemd).
  // Lets the guard/login recognize such hosts so local-only routes can be gated
  // by tunnelDashboardAccess the same way as app-managed tunnels.
  externalTunnelUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  // S6: opt-in. Pre-existing installs that saved an explicit value keep it;
  // installs that only ever ran on the old implicit default flip to false
  // (fail-closed for an exposure-surface toggle).
  tunnelDashboardAccess: false,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  ds2apiEnabled: false,
  ds2apiUrl: "http://localhost:5001",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // v2go/xray proxy integration — managed local xray-core client that turns
  // V2Ray share links into a SOCKS5/HTTP proxy 9router can route through.
  xrayEnabled: false,
  xrayAutoStart: false,
  xraySocksPort: 10808,
  xrayHttpPort: 10809,
  xraySubscriptionUrl: "https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt",
  // Subscription auto-sync interval in minutes. 0 = manual-only (scheduler off,
  // sync runs only via the "Sync Now" button). Positive values are clamped to >= 5.
  xraySyncIntervalMin: 60,
  // TOTU AI account auto-fetch scheduler. totuAutoFetch toggles it; the
  // interval in minutes (0 = manual-only, positive values clamped to >= 5).
  totuAutoFetch: false,
  totuAutoFetchIntervalMin: 60,
  // Alert system (phase 05): master gate, channel credentials, dedup window
  // (minutes, clamped 1-1440 on save), quota alert threshold (percent
  // remaining), and per-event-type enable map.
  alertsEnabled: false,
  alertsTelegramBotToken: "",
  alertsTelegramChatId: "",
  alertsDiscordWebhookUrl: "",
  alertsWebhookUrl: "",
  alertsDedupMin: 10,
  alertsQuotaThresholdPct: 20,
  alertsEvents: {
    "all-accounts-locked": true,
    "breaker-open": true,
    "breaker-recovered": true,
    "proxy-pool-exhausted": true,
    "strictproxy-violation": true,
    "quota-near-limit": true,
    "budget-threshold": true,
    "xray-node-down": true,
    "xray-rotation-failed": true,
    "totu-fetch-failed": true,
  },
  // Per-account circuit breaker (phase 06): kill switch, failure threshold
  // inside the window, window length, and base open cooldown (backoff =
  // base × 2 per consecutive open, capped at 10 min in the module).
  breakerEnabled: true,
  breakerFailureThreshold: 5,
  breakerWindowSec: 60,
  breakerBaseCooldownSec: 60,
  xrayStaleRetentionDays: 7,
  xrayAutoRotate: false,
  xrayHealthCheckIntervalMin: 10,
  xrayVersion: "",
  xraySelectedConfigId: "",
  xrayModelFilterEnabled: false,
  xrayModelFilterModel: "",
  xrayModelFilterLimit: 50,
  xrayModelFilterAll: false,
  xrayModelFilterPrune: false,
  xrayModelFilterConcurrency: 2,
  xrayModelFilterTimeoutMs: 20000,
  xrayModelFilterPauseOnTraffic: true,
  xrayModelFilterQuietMs: 15000,
  // Cache freshness: rows older than this (by testedAt) are treated as misses
  // and re-probed. 0 = cache forever (legacy behavior). Default 24h.
  xrayModelFilterCacheTtlH: 24,
  // Failed-row re-test: a cached FAIL is retried once it ages past this window,
  // so a server that was temporarily down isn't blacklisted forever.
  // 0 = never retry fails (legacy behavior). Default 1h.
  xrayModelFilterRetryFailAfterH: 1,
  // Filter execution mode:
  //  - "spawn" (default, legacy): spawn a fresh xray process per config-under-test.
  //  - "api": keep one long-lived xray + swap outbounds via the gRPC API. Much
  //    lighter on forks/RAM; falls back to "spawn" automatically if the api
  //    instance can't start (old binary, port conflict, etc.).
  xrayFilterMode: "spawn",
  // Ports for api-mode filter instance. Must not collide with the managed
  // xray (10808/10809) or each other across concurrent jobs.
  xrayFilterApiSocksPort: 53080,
  xrayFilterApiPort: 15491,
  // Pre-declared SOCKS5 account count for api-mode = max concurrency supported
  // by one filter instance. SOCKS accounts cannot be added dynamically (xray
  // Issue #6199), so this is fixed at boot of the filter xray.
  xrayFilterApiAccounts: 16,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // S6: for this one key, an EXPLICITLY saved value wins but absence must NOT
  // inherit the (old) permissive default — resolve absent to false.
  if (raw && !("tunnelDashboardAccess" in raw)) merged.tunnelDashboardAccess = false;
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}

