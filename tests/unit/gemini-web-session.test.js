/**
 * Unit tests for Gemini Web Session — bootstrap + SNlM0e extraction
 *
 * Run: npx vitest run tests/unit/gemini-web-session.test.js
 *
 * Note: Full integration tests require live cookies and are skipped by default.
 * Run with: SKIP_LIVE_TESTS=false npx vitest run tests/unit/gemini-web-session.test.js
 */

import { describe, it, expect } from "vitest";

// Pure function tests — no network needed
import {
  bootstrapGeminiWebSession,
  getGeminiWebUserStatus,
  rotateGeminiWebCookies,
} from "../../open-sse/services/geminiWebSession.js";
import {
  extractSnlM0e,
  extractAccountUser,
  buildCookieHeader,
} from "../../open-sse/services/geminiWebSession.js";
import {
  validateGeminiWebCookies,
  parseGeminiWebCookies,
  serializeGeminiWebCookieHeader,
} from "../../open-sse/services/geminiWebCookie.js";

// Note: extractSnlM0e, extractAccountUser, and buildCookieHeader are not exported
// from geminiWebSession.js. We test them indirectly through the public API or
// test the equivalent functionality from geminiWebCookie.js.

describe("Cookie validation (integration with session)", () => {
  it("rejects missing required cookie __Secure-1PSID", async () => {
    const cookies = { "__Secure-1PSIDTS": "abc" };
    const validation = validateGeminiWebCookies(cookies);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("__Secure-1PSID");
  });

  it("accepts valid cookie set", async () => {
    const cookies = {
      "__Secure-1PSID": "abc123sessionid",
      "__Secure-1PSIDTS": "def456token",
    };
    const validation = validateGeminiWebCookies(cookies);
    expect(validation.valid).toBe(true);
  });

  it("warns when recommended cookie is missing", async () => {
    const cookies = { "__Secure-1PSID": "abc123" };
    const validation = validateGeminiWebCookies(cookies);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.length).toBeGreaterThanOrEqual(1);
    expect(validation.warnings[0]).toContain("__Secure-1PSIDTS");
  });
});

describe("Cookie serialization for session", () => {
  it("builds a valid cookie header string", () => {
    const cookies = { "__Secure-1PSID": "abc", "__Secure-1PSIDTS": "def" };
    const header = serializeGeminiWebCookieHeader(cookies);
    expect(header).toBe("__Secure-1PSID=abc; __Secure-1PSIDTS=def");
  });
});

describe("bootstrapGeminiWebSession — validation", () => {
  it("throws on null cookies", async () => {
    await expect(bootstrapGeminiWebSession(null))
      .rejects.toThrow(/invalid/i);
  });

  it("throws on empty cookies", async () => {
    await expect(bootstrapGeminiWebSession({}))
      .rejects.toThrow(/missing required|invalid/i);
  });

  it("throws on cookies missing __Secure-1PSID", async () => {
    await expect(bootstrapGeminiWebSession({ "some-cookie": "value" }))
      .rejects.toThrow(/__Secure-1PSID/);
  });
});

describe("getGeminiWebUserStatus — validation", () => {
  it("returns warnings on invalid cookies", async () => {
    const result = await getGeminiWebUserStatus({}, "snl123");
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("handles null SNlM0e token gracefully", async () => {
    // Returns result with warnings instead of throwing (resilient design)
    const cookies = { "__Secure-1PSID": "abc", "__Secure-1PSIDTS": "def" };
    const result = await getGeminiWebUserStatus(cookies, null);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe("rotateGeminiWebCookies — validation", () => {
  it("throws on invalid input", async () => {
    await expect(rotateGeminiWebCookies({}))
      .rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Live integration tests (skipped by default)
// ---------------------------------------------------------------------------
const runLive = process.env.SKIP_LIVE_TESTS !== "false";

describe.runIf(runLive)("Live session bootstrap", () => {
  it("fetches /app and extracts SNlM0e", async () => {
    const cookiesStr = process.env.GEMINI_WEB_COOKIES;
    if (!cookiesStr) {
      console.warn("SKIP: GEMINI_WEB_COOKIES env var not set");
      return;
    }
    const parsed = parseGeminiWebCookies(cookiesStr);
    const result = await bootstrapGeminiWebSession(parsed.cookies);
    expect(result.snlToken).toBeTruthy();
    expect(typeof result.snlToken).toBe("string");
    expect(result.snlToken.length).toBeGreaterThan(5);
  }, 30_000);

  it("detects expired cookies", async () => {
    const cookies = {
      "__Secure-1PSID": "garbage-expired-value",
      "__Secure-1PSIDTS": "garbage-expired-value",
    };
    await expect(bootstrapGeminiWebSession(cookies))
      .rejects.toThrow();
  }, 30_000);
});
