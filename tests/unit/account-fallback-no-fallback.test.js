import { describe, it, expect } from "vitest";
import { checkFallbackError, NO_FALLBACK_STATUSES } from "../../open-sse/services/accountFallback.js";

// C4: deterministic client errors must not lock accounts or trigger fallback.
// The old default (`shouldFallback: true` for ANY unmatched status) made a
// single bad request lock every account of a provider for 30s each.
describe("NO_FALLBACK_STATUSES (C4)", () => {
  it("exports the documented deterministic client-error set", () => {
    expect([...NO_FALLBACK_STATUSES].sort()).toEqual([400, 401, 402, 404, 405, 413, 422]);
  });

  it.each([400, 401, 402, 404, 405, 413, 422])(
    "status %d → no fallback, no cooldown",
    (status) => {
      const { shouldFallback, cooldownMs } = checkFallbackError(status, "Invalid request body");
      expect(shouldFallback).toBe(false);
      expect(cooldownMs).toBe(0);
    }
  );

  it("keeps fallback when TEXT evidence makes the error account-specific", () => {
    // Text rules outrank the no-fallback set: a 402 "quota exceeded" is THIS
    // account running out — the next account may still have credits.
    expect(checkFallbackError(402, "quota exceeded").shouldFallback).toBe(true);
    expect(checkFallbackError(400, "rate limit hit").shouldFallback).toBe(true);
  });

  it("keeps fallback for transient/server statuses", () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      const { shouldFallback } = checkFallbackError(status, "server overloaded");
      expect(shouldFallback, `status ${status}`).toBe(true);
    }
  });

  it("keeps fallback for unmatched odd statuses (e.g. 403 without a rule)", () => {
    // 403 has no ERROR_RULES entry in all providers; conservative default.
    const { shouldFallback } = checkFallbackError(403, "forbidden");
    expect(shouldFallback).toBe(true);
  });
});

// C4 follow-up (audit v0.6.35→0.6.41): executors fabricate BARE 401/402 with
// these account-specific messages. Without text rules, NO_FALLBACK_STATUSES
// suppressed fallback entirely — one expired cookie or empty balance ended
// the request instead of rotating to the next account.
describe("account-specific fabricated 401/402 texts (C4 follow-up)", () => {
  it.each([
    [401, "Cookie expired or invalid — re-paste your Gemini cookies"],            // gemini-web
    [401, "Genspark auth failed — session_id cookie may be expired or invalid."], // genspark
    [401, "Grok auth failed — SSO cookie may be expired. Re-paste your sso cookie value from grok.com."], // grok
    [401, "Perplexity auth failed — session cookie may be expired. Re-paste your __Secure-next-auth.session-token."], // perplexity
    [401, "qoder PAT exchange failed: http 401"],                                 // qoder
    [401, "qoder credential is missing userId; reconnect the account"],           // qoder
    [401, "qoder credential is missing accessToken; reconnect the account"],      // qoder
    [401, "qoder cosy signing failed: bad key"],                                  // qoder
    [401, "[CommandCode error: unauthorized]"],                                   // commandcode
    [402, "personal-team-blocked:spending-limit"],                                // grok-cli
    [402, "Insufficient credits"],                                                // openrouter
    [400, "Your credit balance is too low"],                                      // anthropic
    [402, "qoder billing block (402)"],                                           // qoder
  ])("falls back on %i %j", (status, message) => {
    const { shouldFallback, cooldownMs } = checkFallbackError(status, message);
    expect(shouldFallback, message).toBe(true);
    expect(cooldownMs).toBeGreaterThan(0);
  });

  it("still fails fast on bare 4xx whose text names the REQUEST, not the account", () => {
    expect(checkFallbackError(400, "Invalid request body").shouldFallback).toBe(false);
    expect(checkFallbackError(422, "model does not support tool use").shouldFallback).toBe(false);
    // Bare "Payment required" restates the status only — pinned to fail fast
    // by the github-monthly-usage-lock C4 contract.
    expect(checkFallbackError(402, "Payment required").shouldFallback).toBe(false);
  });
});
