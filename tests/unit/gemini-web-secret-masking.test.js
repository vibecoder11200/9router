import { describe, it, expect } from "vitest";
import {
  maskGeminiWebCookies,
  sanitizeGeminiWebText,
  maskSecret,
} from "../../open-sse/services/geminiWebCookie.js";

describe("gemini-web secret masking", () => {
  const sampleCookies = {
    "__Secure-1PSID": "a".repeat(40),
    "__Secure-1PSIDTS": "b".repeat(40),
    "__Secure-3PSID": "c".repeat(40),
    SAPISID: "d".repeat(30),
    SID: "e".repeat(20),
    HSID: "f".repeat(15),
    APISID: "g".repeat(25),
    NID: "h".repeat(35),
  };

  it("masks all cookie values", () => {
    const masked = maskGeminiWebCookies(sampleCookies);
    for (const [key, original] of Object.entries(sampleCookies)) {
      expect(masked[key]).not.toBe(original);
      expect(masked[key]).toContain("…");
    }
  });

  it("masks short values with ***", () => {
    const masked = maskGeminiWebCookies({ short: "abc" });
    expect(masked.short).toBe("***");
  });

  it("handles empty cookies", () => {
    const masked = maskGeminiWebCookies({});
    expect(masked).toEqual({});
  });

  it("handles null/undefined cookies", () => {
    expect(maskGeminiWebCookies(null)).toEqual({});
    expect(maskGeminiWebCookies(undefined)).toEqual({});
  });

  it("maskSecret handles edge cases", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret(null)).toBe("");
    expect(maskSecret(undefined)).toBe("");
    expect(maskSecret("ab")).toBe("***");
    expect(maskSecret("abcdefgh")).toBe("***");
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd…mnop");
  });

  it("sanitizeGeminiWebText removes cookie values", () => {
    const text = "__Secure-1PSID=secret_value_here; SAPISID=another_secret";
    const sanitized = sanitizeGeminiWebText(text);
    expect(sanitized).not.toContain("secret_value_here");
    expect(sanitized).not.toContain("another_secret");
    expect(sanitized).toContain("__Secure-1PSID");
    expect(sanitized).toContain("SAPISID");
  });

  it("sanitizeGeminiWebText masks SNlM0e", () => {
    const text = "SNlM0e=some_token_value";
    const sanitized = sanitizeGeminiWebText(text);
    expect(sanitized).not.toContain("some_token_value");
    expect(sanitized).toContain("SNlM0e");
  });

  it("sanitizeGeminiWebText handles clean text", () => {
    const text = "This is a clean message with no secrets";
    const sanitized = sanitizeGeminiWebText(text);
    expect(sanitized).toBe(text);
  });

  it("masked output preserves key names", () => {
    const masked = maskGeminiWebCookies(sampleCookies);
    expect(Object.keys(masked).sort()).toEqual(Object.keys(sampleCookies).sort());
  });
});
