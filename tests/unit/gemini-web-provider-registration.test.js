import { describe, it, expect } from "vitest";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("gemini-web provider registration", () => {
  it("is registered in WEB_COOKIE_PROVIDERS", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"]).toBeDefined();
  });

  it("has correct id", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].id).toBe("gemini-web");
  });

  it("has correct name", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].name).toBe("Gemini Web");
  });

  it("has alias", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].alias).toBe("gweb");
  });

  it("has cookie authType", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].authType).toBe("cookie");
  });

  it("has authHint", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].authHint).toBeTruthy();
    expect(typeof WEB_COOKIE_PROVIDERS["gemini-web"].authHint).toBe("string");
  });

  it("has passthroughModels enabled", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].passthroughModels).toBe(true);
  });

  it("has serviceKinds including llm", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].serviceKinds).toContain("llm");
  });

  it("has deprecationNotice with risk warning", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].deprecationNotice).toContain("Risk Notice");
  });

  it("has website URL", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].website).toBe("https://gemini.google.com");
  });

  it("has textIcon fallback", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].textIcon).toBe("GW");
  });

  it("has color", () => {
    expect(WEB_COOKIE_PROVIDERS["gemini-web"].color).toBe("#4285F4");
  });
});
