import { describe, it, expect } from "vitest";
import { validateGeminiWebCookies } from "../../open-sse/services/geminiWebCookie.js";

describe("gemini-web health check", () => {
  it("returns valid for cookies with required fields", () => {
    const cookies = {
      "__Secure-1PSID": "valid_psid_value_here_at_least_20_chars",
      "__Secure-1PSIDTS": "valid_psidts_value_here_at_least_20",
      SAPISID: "valid_sapisid_value_here_at_least_20",
    };
    const result = validateGeminiWebCookies(cookies);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns invalid when __Secure-1PSID is missing", () => {
    const cookies = {
      "__Secure-1PSIDTS": "valid_psidts_value",
      SAPISID: "valid_sapisid",
    };
    const result = validateGeminiWebCookies(cookies);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("__Secure-1PSID");
  });

  it("returns invalid when __Secure-1PSID is empty", () => {
    const cookies = {
      "__Secure-1PSID": "",
      "__Secure-1PSIDTS": "valid_psidts",
    };
    const result = validateGeminiWebCookies(cookies);
    expect(result.valid).toBe(false);
  });

  it("returns invalid for null cookies", () => {
    const result = validateGeminiWebCookies(null);
    expect(result.valid).toBe(false);
  });

  it("returns invalid for empty object", () => {
    const result = validateGeminiWebCookies({});
    expect(result.valid).toBe(false);
    expect(result.code).toBe("invalid_cookie");
  });

  it("warns about missing __Secure-1PSIDTS", () => {
    const cookies = {
      "__Secure-1PSID": "valid_psid_value_here_at_least_20_chars",
    };
    const result = validateGeminiWebCookies(cookies);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("__Secure-1PSIDTS"),
      ])
    );
  });

  it("does not throw when throwOnError is false", () => {
    const result = validateGeminiWebCookies(null, { throwOnError: false });
    expect(result.valid).toBe(false);
  });

  it("throws when throwOnError is true and cookies invalid", () => {
    expect(() => validateGeminiWebCookies(null, { throwOnError: true })).toThrow();
  });
});
