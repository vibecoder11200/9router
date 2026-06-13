const REQUIRED_COOKIE = "__Secure-1PSID";
const RECOMMENDED_COOKIE = "__Secure-1PSIDTS";
const SENSITIVE_COOKIE_NAMES = new Set([
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PSIDCC",
  "SID",
  "SSID",
  "HSID",
  "SAPISID",
  "APISID",
  "NID",
  "COMPASS",
]);

const GOOGLEISH_DOMAIN_RE = /(^|\.)(google\.com|gemini\.google\.com)$/i;
const COOKIE_PAIR_RE = /(?:^|[;\s,])([A-Za-z0-9_.-]+)\s*=\s*([^;\r\n]+)/g;
const JSON_ENTITY_QUOTE_RE = /&#34;|&quot;/g;

export class GeminiWebCookieError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GeminiWebCookieError";
    this.code = code;
    this.status = details.status || 401;
    this.warnings = details.warnings || [];
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input.trim();
  return input;
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isExpiredCookie(cookie) {
  const exp = cookie?.expirationDate ?? cookie?.expires ?? cookie?.expiry;
  if (exp == null || exp === "" || exp === 0) return false;
  const n = Number(exp);
  if (!Number.isFinite(n)) return false;
  return n < (n > 1e12 ? Date.now() : nowSeconds());
}

function domainAllowed(domain) {
  if (!domain) return true;
  return GOOGLEISH_DOMAIN_RE.test(String(domain).replace(/^\./, ""));
}

function setCookie(out, name, value, warnings, source = "unknown") {
  const key = safeTrim(name);
  const val = safeTrim(value);
  if (!key || !val) return;
  if (out[key] && out[key] !== val) {
    warnings.push(`duplicate cookie '${key}' encountered; using latest value from ${source}`);
  }
  out[key] = val;
}

function parseJsonCookieArray(arr, warnings) {
  const out = {};
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (isExpiredCookie(item)) continue;
    if (!domainAllowed(item.domain)) {
      warnings.push(`ignored cookie '${safeTrim(item.name) || "unknown"}' from non-Google domain`);
      continue;
    }
    setCookie(out, item.name, item.value, warnings, "json-array");
  }
  return out;
}

function parseJsonObject(obj, warnings) {
  const out = {};
  for (const [name, value] of Object.entries(obj || {})) {
    if (value && typeof value === "object" && "value" in value) {
      if (isExpiredCookie(value)) continue;
      if (!domainAllowed(value.domain)) continue;
      setCookie(out, name, value.value, warnings, "json-object");
    } else if (typeof value === "string" || typeof value === "number") {
      setCookie(out, name, value, warnings, "json-object");
    }
  }
  return out;
}

function tryParseJson(input, warnings) {
  if (typeof input !== "string") {
    if (Array.isArray(input)) return { cookies: parseJsonCookieArray(input, warnings), sourceFormat: "chrome-json" };
    if (input && typeof input === "object") return { cookies: parseJsonObject(input, warnings), sourceFormat: "json-object" };
    return null;
  }
  const s = input.replace(JSON_ENTITY_QUOTE_RE, '"');
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return { cookies: parseJsonCookieArray(parsed, warnings), sourceFormat: "chrome-json" };
    if (parsed && typeof parsed === "object") return { cookies: parseJsonObject(parsed, warnings), sourceFormat: "json-object" };
  } catch {
    warnings.push("input looked like JSON but could not be parsed; trying text cookie extraction");
  }
  return null;
}

function parseNetscape(input, warnings) {
  const out = {};
  let count = 0;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 7) continue;
    const [domain, , , , expires, name, ...valueParts] = cols;
    if (!domainAllowed(domain)) continue;
    const exp = Number(expires);
    if (Number.isFinite(exp) && exp > 0 && exp < nowSeconds()) continue;
    setCookie(out, name, valueParts.join(" "), warnings, "netscape");
    count++;
  }
  return count ? out : null;
}

function parsePairs(input, warnings) {
  const out = {};
  const text = input.replace(JSON_ENTITY_QUOTE_RE, '"');

  // Chrome JSON fragments in pasted text: "name":"x" ... "value":"y"
  const fragmentRe = /"name"\s*:\s*"([^"]+)"[\s\S]{0,300}?"value"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = fragmentRe.exec(text))) setCookie(out, m[1], m[2], warnings, "mixed-json-fragment");

  COOKIE_PAIR_RE.lastIndex = 0;
  while ((m = COOKIE_PAIR_RE.exec(text))) {
    const name = m[1];
    const value = m[2].trim().replace(/^"|"$/g, "");
    if (SENSITIVE_COOKIE_NAMES.has(name) || name.startsWith("__Secure-") || name === REQUIRED_COOKIE || name === RECOMMENDED_COOKIE) {
      setCookie(out, name, value, warnings, "text");
    }
  }
  return out;
}

export function parseGeminiWebCookies(input, options = {}) {
  const warnings = [];
  const normalized = normalizeInput(input);
  if (normalized == null || normalized === "") {
    return { cookies: {}, sourceFormat: "empty", warnings: ["empty cookie input"] };
  }

  const jsonResult = tryParseJson(normalized, warnings);
  let cookies = jsonResult?.cookies || {};
  let sourceFormat = jsonResult?.sourceFormat || "auto";

  if (!Object.keys(cookies).length && typeof normalized === "string") {
    const netscape = parseNetscape(normalized, warnings);
    if (netscape && Object.keys(netscape).length) {
      cookies = netscape;
      sourceFormat = "netscape";
    } else {
      cookies = parsePairs(normalized, warnings);
      sourceFormat = normalized.includes(";") ? "header" : "kv";
    }
  }

  const validation = validateGeminiWebCookies(cookies, { throwOnError: false });
  warnings.push(...validation.warnings);
  if (options.throwOnError && !validation.valid) {
    throw new GeminiWebCookieError(validation.code, validation.error, { warnings });
  }

  return { cookies, sourceFormat, warnings };
}

export function validateGeminiWebCookies(cookies, options = {}) {
  const warnings = [];
  if (!cookies || typeof cookies !== "object") {
    const result = { valid: false, code: "invalid_cookie", error: "Invalid Gemini Web cookie input", warnings };
    if (options.throwOnError) throw new GeminiWebCookieError(result.code, result.error, { warnings });
    return result;
  }
  if (!safeTrim(cookies[REQUIRED_COOKIE])) {
    const result = { valid: false, code: "invalid_cookie", error: `Missing required Gemini Web cookie: ${REQUIRED_COOKIE}`, warnings };
    if (options.throwOnError) throw new GeminiWebCookieError(result.code, result.error, { warnings });
    return result;
  }
  if (!safeTrim(cookies[RECOMMENDED_COOKIE])) warnings.push(`recommended Gemini Web cookie missing: ${RECOMMENDED_COOKIE}`);
  return { valid: true, code: null, error: null, warnings };
}

export function maskSecret(value) {
  const s = safeTrim(value);
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function maskGeminiWebCookies(cookies = {}) {
  const out = {};
  for (const [k, v] of Object.entries(cookies || {})) out[k] = maskSecret(v);
  return out;
}

export function serializeGeminiWebCookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .filter(([k, v]) => safeTrim(k) && safeTrim(v))
    .map(([k, v]) => `${k}=${safeTrim(v)}`)
    .join("; ");
}

export function sanitizeGeminiWebText(text) {
  let s = safeTrim(text);
  for (const name of SENSITIVE_COOKIE_NAMES) {
    s = s.replace(new RegExp(`(${name}\\s*=\\s*)[^;\\s]+`, "g"), `$1***`);
  }
  s = s.replace(/SNlM0e["'\s:=]+[^"'\s,;]+/g, "SNlM0e=***");
  return s;
}

export function extractGeminiWebCredentials(credentials = {}) {
  const psd = credentials?.providerSpecificData || {};
  if (psd.cookies && typeof psd.cookies === "object") {
    const validation = validateGeminiWebCookies(psd.cookies, { throwOnError: false });
    return { cookies: psd.cookies, source: "providerSpecificData.cookies", warnings: validation.warnings, valid: validation.valid, error: validation.error };
  }
  const input = psd.cookieText || credentials.apiKey || credentials.accessToken || "";
  const parsed = parseGeminiWebCookies(input, { throwOnError: false });
  const validation = validateGeminiWebCookies(parsed.cookies, { throwOnError: false });
  return { cookies: parsed.cookies, source: parsed.sourceFormat, warnings: parsed.warnings, valid: validation.valid, error: validation.error };
}

export const GEMINI_WEB_COOKIE_SENTINEL = "__cookie_stored_in_provider_specific_data__";
export const GEMINI_WEB_REQUIRED_COOKIE = REQUIRED_COOKIE;
export const GEMINI_WEB_RECOMMENDED_COOKIE = RECOMMENDED_COOKIE;
