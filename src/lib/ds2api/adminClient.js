// Thin client for the DS2API admin REST API (JWT-gated /admin/*).
// Used by 9router server routes to manage DeepSeek-web accounts/keys so the user
// never has to leave the 9router dashboard. Request/response shapes confirmed from
// temp/ds2api/internal/httpapi/admin/**.
//
// All public methods take (base, adminKey) and auto-attach a cached JWT.

const JWT_RENEW_LEAD_MS = 60_000;
const tokenCache = new Map(); // base -> { token, expiresAt }

class AdminApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.detail = detail;
  }
}

function normalizeBase(base) {
  return String(base || "").trim().replace(/\/$/, "");
}

async function login(base, adminKey) {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new AdminApiError(`ds2api admin login failed (${res.status})`, res.status, data.detail);
  }
  const expiresIn = Number(data.expires_in) || 3600;
  tokenCache.set(base, { token: data.token, expiresAt: Date.now() + expiresIn * 1000 });
  return data.token;
}

async function getToken(base, adminKey) {
  const cached = tokenCache.get(base);
  if (cached && cached.expiresAt - Date.now() > JWT_RENEW_LEAD_MS) return cached.token;
  return login(base, adminKey);
}

async function adminFetch(base, adminKey, reqPath, { method = "GET", body, signal } = {}) {
  const token = await getToken(base, adminKey);
  const res = await fetch(`${base}${reqPath}`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal || AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new AdminApiError(`ds2api admin ${method} ${reqPath} failed (${res.status})`, res.status, data.detail || data.error);
  }
  return data;
}

// --- accounts ---
export async function listAccounts(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/accounts");
}
export async function addAccount(base, adminKey, account) {
  return adminFetch(base, adminKey, "/admin/accounts", { method: "POST", body: account });
}
export async function updateAccount(base, adminKey, identifier, account) {
  return adminFetch(base, adminKey, `/admin/accounts/${encodeURIComponent(identifier)}`, { method: "PUT", body: account });
}
export async function deleteAccount(base, adminKey, identifier) {
  return adminFetch(base, adminKey, `/admin/accounts/${encodeURIComponent(identifier)}`, { method: "DELETE" });
}
export async function testAccount(base, adminKey, { identifier, model, message } = {}) {
  return adminFetch(base, adminKey, "/admin/accounts/test", { method: "POST", body: { identifier, model, message } });
}
export async function testAllAccounts(base, adminKey, { model } = {}) {
  return adminFetch(base, adminKey, "/admin/accounts/test-all", { method: "POST", body: { model } });
}
export async function clearSessions(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/accounts/sessions/delete-all", { method: "POST", body: {} });
}

// --- keys (caller api_keys) ---
// There is no GET /admin/keys; keys are listed via GET /admin/config (fields `keys`
// = string[], `api_keys` = [{key,name,remark}]). addKey rejects duplicates (400).
export async function getConfig(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/config");
}
export async function listKeys(base, adminKey) {
  const cfg = await getConfig(base, adminKey);
  const stringKeys = Array.isArray(cfg.keys) ? cfg.keys : [];
  const apiKeys = Array.isArray(cfg.api_keys) ? cfg.api_keys.map((k) => k.key) : [];
  return { items: [...new Set([...stringKeys, ...apiKeys].filter(Boolean))] };
}
export async function addKey(base, adminKey, key) {
  return adminFetch(base, adminKey, "/admin/keys", { method: "POST", body: { key } });
}
export async function deleteKey(base, adminKey, key) {
  return adminFetch(base, adminKey, `/admin/keys/${encodeURIComponent(key)}`, { method: "DELETE" });
}
// Ensure a caller key exists; tolerate the duplicate-error (concurrent first start).
export async function ensureKey(base, adminKey, key) {
  const { items = [] } = await listKeys(base, adminKey).catch(() => ({}));
  if (items.includes(key)) return { ensured: false };
  try {
    await addKey(base, adminKey, key);
    return { ensured: true };
  } catch (e) {
    // "key 已存在" / already-exists → fine
    if (e.status === 400) return { ensured: false };
    throw e;
  }
}

// --- runtime / config ---
export async function getQueueStatus(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/queue/status");
}
export async function getVersion(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/version");
}
export async function getSettings(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/settings");
}
export async function updateSettings(base, adminKey, settings) {
  return adminFetch(base, adminKey, "/admin/settings", { method: "PUT", body: settings });
}
export async function exportConfig(base, adminKey) {
  return adminFetch(base, adminKey, "/admin/config/export");
}
export async function importConfig(base, adminKey, config) {
  return adminFetch(base, adminKey, "/admin/config/import", { method: "POST", body: config });
}

export { AdminApiError };
