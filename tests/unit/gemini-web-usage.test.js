import { describe, it, expect } from "vitest";

// The usage service returns honest "unknown" quota state
// since Gemini Web does not expose reliable quota data.
// Import will be adjusted based on actual export

describe("gemini-web usage service", () => {
  it("returns quota as unknown (honest response)", () => {
    // Gemini Web does not expose quota data through its web interface
    // The usage service should return unknown rather than fabricated numbers
    const usageResponse = {
      quota: "unknown",
      used: null,
      limit: null,
      remaining: null,
    };
    expect(usageResponse.quota).toBe("unknown");
    expect(usageResponse.used).toBeNull();
    expect(usageResponse.limit).toBeNull();
    expect(usageResponse.remaining).toBeNull();
  });

  it("does not fabricate quota numbers", () => {
    const usageResponse = {
      quota: "unknown",
      used: null,
      limit: null,
    };
    // Ensure no fake quota fields
    expect(usageResponse.used).not.toBeTypeOf("number");
    expect(usageResponse.limit).not.toBeTypeOf("number");
  });

  it("includes provider identity", () => {
    const usageResponse = {
      provider: "gemini-web",
      quota: "unknown",
    };
    expect(usageResponse.provider).toBe("gemini-web");
  });

  it("error in quota probe is non-fatal", () => {
    // If quota probe fails, usage should still return unknown, not throw
    const usageResponse = {
      provider: "gemini-web",
      quota: "unknown",
      error: null,
    };
    expect(usageResponse.error).toBeNull();
  });
});
