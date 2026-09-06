// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, providers? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - providers: optional array; when present the rule matches only if the
 *     caller-supplied provider equals one of the entries (fail-closed: an
 *     undefined/unknown provider skips the rule entirely)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },
  // C4 follow-up: account-specific auth/billing failures that several
  // executors surface as BARE 401/402 with these messages. Without text
  // evidence, NO_FALLBACK_STATUSES suppresses fallback entirely and a single
  // expired cookie / empty balance would end the request instead of rotating
  // to the next account. All of these name the ACCOUNT, not the request.
  { text: "cookie expired",           cooldownMs: COOLDOWN.long },  // gemini-web
  { text: "cookie may be expired",    cooldownMs: COOLDOWN.long },  // genspark/grok/perplexity
  { text: "auth failed",              cooldownMs: COOLDOWN.long },  // genspark/grok/perplexity
  { text: "unauthorized",             cooldownMs: COOLDOWN.long },  // commandcode parse
  { text: "invalid api key",          cooldownMs: COOLDOWN.long },  // commandcode parse
  { text: "pat exchange failed",      cooldownMs: COOLDOWN.long },  // qoder
  { text: "missing userid",           cooldownMs: COOLDOWN.long },  // qoder
  { text: "missing accesstoken",      cooldownMs: COOLDOWN.long },  // qoder
  { text: "cosy signing failed",      cooldownMs: COOLDOWN.long },  // qoder
  { text: "spending-limit",           cooldownMs: COOLDOWN.long },  // grok-cli 402 code
  { text: "insufficient credits",     cooldownMs: COOLDOWN.long },  // openrouter 402
  { text: "credit balance is too low", cooldownMs: COOLDOWN.long }, // anthropic 400
  { text: "billing",                  cooldownMs: COOLDOWN.long },  // commandcode/qoder billing
  // Scoped to commandcode (incl. the "cmc" alias): its billing 402 carries
  // "payment required" (commandcode.js), which IS account-specific evidence
  // there. For everyone else — github above all — bare "Payment required"
  // restates the 402 status and stays fail-fast (C4 contract pinned by
  // github-monthly-usage-lock).
  { text: "payment required", providers: ["commandcode", "cmc"], cooldownMs: COOLDOWN.long },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
