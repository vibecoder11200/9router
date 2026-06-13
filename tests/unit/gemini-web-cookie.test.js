import { describe, it, expect } from "vitest";
import {
  parseGeminiWebCookies,
  validateGeminiWebCookies,
  maskGeminiWebCookies,
  serializeGeminiWebCookieHeader,
  extractGeminiWebCredentials,
  sanitizeGeminiWebText,
  GeminiWebCookieError,
} from "../../open-sse/services/geminiWebCookie.js";

const PSID = "g.a000-test-psid-value-0076";
const PSIDTS = "sidts-CjI-test-ts-value";

describe("geminiWebCookie parser", () => {
  it("parses Chrome extension JSON array", () => {
    const input = JSON.stringify([
      { domain: ".google.com", name: "__Secure-1PSID", value: PSID, expirationDate: 1893456000 },
      { domain: ".google.com", name: "__Secure-1PSIDTS", value: PSIDTS, expirationDate: 1893456000 },
      { domain: ".evil.com", name: "__Secure-1PSID", value: "evil", expirationDate: 1893456000 },
    ]);
    const result = parseGeminiWebCookies(input);
    expect(result.sourceFormat).toBe("chrome-json");
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
    expect(result.cookies["__Secure-1PSIDTS"]).toBe(PSIDTS);
    expect(Object.values(result.cookies)).not.toContain("evil");
  });

  it("parses HTML-entity encoded JSON export", () => {
    const input = `[{&#34;domain&#34;:&#34;.google.com&#34;,&#34;name&#34;:&#34;__Secure-1PSID&#34;,&#34;value&#34;:&#34;${PSID}&#34;},{&#34;domain&#34;:&#34;.google.com&#34;,&#34;name&#34;:&#34;__Secure-1PSIDTS&#34;,&#34;value&#34;:&#34;${PSIDTS}&#34;}]`;
    const result = parseGeminiWebCookies(input);
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
    expect(result.cookies["__Secure-1PSIDTS"]).toBe(PSIDTS);
  });

  it("parses simple JSON object", () => {
    const result = parseGeminiWebCookies({ "__Secure-1PSID": PSID, "__Secure-1PSIDTS": PSIDTS });
    expect(result.sourceFormat).toBe("json-object");
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
  });

  it("parses cookie header string and preserves '=' inside values", () => {
    const result = parseGeminiWebCookies(`NID=abc==; __Secure-1PSID=${PSID}=tail; __Secure-1PSIDTS=${PSIDTS}`);
    expect(result.sourceFormat).toBe("header");
    expect(result.cookies.NID).toBe("abc==");
    expect(result.cookies["__Secure-1PSID"]).toBe(`${PSID}=tail`);
  });

  it("parses Netscape cookies.txt and ignores expired cookies", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 3600;
    const input = [
      `.google.com\tTRUE\t/\tTRUE\t${past}\tNID\texpired`,
      `.google.com\tTRUE\t/\tTRUE\t${future}\t__Secure-1PSID\t${PSID}`,
      `.google.com\tTRUE\t/\tTRUE\t${future}\t__Secure-1PSIDTS\t${PSIDTS}`,
    ].join("\n");
    const result = parseGeminiWebCookies(input);
    expect(result.sourceFormat).toBe("netscape");
    expect(result.cookies.NID).toBeUndefined();
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
  });

  it("parses key-value text with whitespace and CRLF", () => {
    const input = `\r\n __Secure-1PSID = ${PSID}\r\n\t__Secure-1PSIDTS=${PSIDTS}\n`;
    const result = parseGeminiWebCookies(input);
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
    expect(result.cookies["__Secure-1PSIDTS"]).toBe(PSIDTS);
  });

  it("parses mixed pasted JSON fragments", () => {
    const input = `random { "name": "__Secure-1PSID", "value": "${PSID}" } text { "name":"__Secure-1PSIDTS","value":"${PSIDTS}" }`;
    const result = parseGeminiWebCookies(input);
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
    expect(result.cookies["__Secure-1PSIDTS"]).toBe(PSIDTS);
  });

  it("uses latest duplicate cookie value and emits sanitized warning", () => {
    const result = parseGeminiWebCookies(`__Secure-1PSID=old; __Secure-1PSID=${PSID}; __Secure-1PSIDTS=${PSIDTS}`);
    expect(result.cookies["__Secure-1PSID"]).toBe(PSID);
    expect(result.warnings.join(" ")).toContain("duplicate cookie");
    expect(result.warnings.join(" ")).not.toContain(PSID);
  });

  it("validates missing required cookie", () => {
    const validation = validateGeminiWebCookies({ "__Secure-1PSIDTS": PSIDTS });
    expect(validation.valid).toBe(false);
    expect(validation.code).toBe("invalid_cookie");
  });

  it("throws sanitized error when requested", () => {
    expect(() => parseGeminiWebCookies(`__Secure-1PSIDTS=${PSIDTS}`, { throwOnError: true })).toThrow(GeminiWebCookieError);
    try {
      parseGeminiWebCookies(`__Secure-1PSIDTS=${PSIDTS}`, { throwOnError: true });
    } catch (err) {
      expect(err.message).not.toContain(PSIDTS);
    }
  });

  it("masks cookies", () => {
    const masked = maskGeminiWebCookies({ "__Secure-1PSID": PSID, short: "abc" });
    expect(masked["__Secure-1PSID"]).toMatch(/^g\.a0…0076$/);
    expect(masked.short).toBe("***");
  });

  it("serializes cookie header", () => {
    const header = serializeGeminiWebCookieHeader({ "__Secure-1PSID": PSID, "__Secure-1PSIDTS": PSIDTS });
    expect(header).toContain(`__Secure-1PSID=${PSID}`);
    expect(header).toContain(`__Secure-1PSIDTS=${PSIDTS}`);
  });

  it("extracts credentials from providerSpecificData cookies first", () => {
    const extracted = extractGeminiWebCredentials({
      apiKey: "bad",
      providerSpecificData: { cookies: { "__Secure-1PSID": PSID, "__Secure-1PSIDTS": PSIDTS } },
    });
    expect(extracted.valid).toBe(true);
    expect(extracted.source).toBe("providerSpecificData.cookies");
    expect(extracted.cookies["__Secure-1PSID"]).toBe(PSID);
  });

  it("extracts credentials from apiKey fallback", () => {
    const extracted = extractGeminiWebCredentials({ apiKey: `__Secure-1PSID=${PSID}; __Secure-1PSIDTS=${PSIDTS}` });
    expect(extracted.valid).toBe(true);
    expect(extracted.cookies["__Secure-1PSID"]).toBe(PSID);
  });

  it("sanitizes secret-bearing text", () => {
    const text = sanitizeGeminiWebText(`Cookie: __Secure-1PSID=${PSID}; SNlM0e: token-abc`);
    expect(text).not.toContain(PSID);
    expect(text).not.toContain("token-abc");
    expect(text).toContain("__Secure-1PSID=***");
  });

  it("handles empty input safely", () => {
    const result = parseGeminiWebCookies("");
    expect(result.cookies).toEqual({});
    expect(result.warnings.join(" ")).toContain("empty");
  });
});
