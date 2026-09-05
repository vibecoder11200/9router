import { describe, it, expect, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// Pin the per-install secret so CRC assertions are deterministic
// (pattern: tests/unit/apikeys-hash-migration.test.js:50-52).
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => "test-install-secret",
}));

import {
  generateApiKeyWithMachine,
  parseApiKey,
  verifyApiKeyCrc,
} from "../../src/shared/utils/apiKey.js";

describe("generateKeyId crypto upgrade (v0.6.45)", () => {
  it("keyId is 12 chars from [a-z0-9]", () => {
    const { keyId } = generateApiKeyWithMachine("machine1234");
    expect(keyId).toHaveLength(12);
    expect(keyId).toMatch(/^[a-z0-9]{12}$/);
  });

  it("key shape is sk-{machineId}-{12-char keyId}-{8 hex} with 4 dash-parts and parseApiKey round-trips", () => {
    const { key, keyId } = generateApiKeyWithMachine("machine1234");
    const parts = key.split("-");
    expect(parts).toHaveLength(4);
    expect(key).toBe(`sk-machine1234-${keyId}-${parts[3]}`);
    expect(parts[3]).toMatch(/^[0-9a-f]{8}$/);
    const parsed = parseApiKey(key);
    expect(parsed).toEqual({ machineId: "machine1234", keyId, isNewFormat: true });
  });

  it("verifyApiKeyCrc accepts a generated key and rejects one flipped keyId char", () => {
    const { key } = generateApiKeyWithMachine("machine1234");
    expect(verifyApiKeyCrc(key)).toBe(true);
    const parts = key.split("-");
    const flippedChar = parts[2][0] === "a" ? "b" : "a";
    parts[2] = flippedChar + parts[2].slice(1);
    expect(verifyApiKeyCrc(parts.join("-"))).toBe(false);
  });

  it("maskApiKey masks length-agnostically", async () => {
    const { maskApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
    const { key, keyId } = generateApiKeyWithMachine("machine1234");
    const last4 = key.slice(-4);
    expect(maskApiKey(key)).toBe(`sk-${keyId}-••••${last4}`);
  });

  it("legacy 2-part keys still parse", () => {
    const parsed = parseApiKey("sk-abcdefgh");
    expect(parsed).toEqual({ machineId: null, keyId: "abcdefgh", isNewFormat: false });
    expect(verifyApiKeyCrc("sk-abcdefgh")).toBe(true);
  });

  it("200 generated keyIds are all distinct", () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => generateApiKeyWithMachine("machine1234").keyId),
    );
    expect(ids.size).toBe(200);
  });
});
