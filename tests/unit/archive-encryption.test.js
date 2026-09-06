import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_V,
  MIN_ARCHIVE_PASSPHRASE_LENGTH,
  generateArchivePassphrase,
  normalizeArchivePassphrase,
  validateArchivePassphrase,
  sealArchive,
  openArchive,
  isEncryptedArchive,
  ArchiveError,
} from "@/lib/db/archive.js";
import {
  sealBackupSecret,
  openBackupSecret,
  AAD_BACKUP_V1,
  AAD_ARCHIVE_V1,
  _setEnvelopeParamsForTests,
} from "@/lib/auth/backupEnvelope.js";

// Same RT-02 discipline as backup-envelope.test.js: drop N to 4096 so the
// suite stays fast; CI can raise it via N9R_TEST_ENVELOPE_N. Production
// code never reads this env var — only this test file does.
const envN = Number.parseInt(process.env.N9R_TEST_ENVELOPE_N ?? "", 10);
const TEST_N = Number.isInteger(envN) && envN > 0 ? envN : 4096;

beforeAll(() => {
  _setEnvelopeParamsForTests({ N: TEST_N });
});

afterAll(() => {
  _setEnvelopeParamsForTests({ N: 65536 });
});

function flipOneBase64Char(s) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const i = Math.floor(s.length / 2);
  const replacement = s[i] === "A" ? "B" : "A";
  return s.slice(0, i) + replacement + s.slice(i + 1);
}

const PASSPHRASE_RE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

describe("generateArchivePassphrase", () => {
  it("matches the XXXXX-XXXXX-XXXXX-XXXXX Crockford shape across 200 samples", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateArchivePassphrase()).toMatch(PASSPHRASE_RE);
    }
  });

  it("never draws I/L/O/U (statistical: 4000 chars)", () => {
    const all = Array.from({ length: 200 }, () => generateArchivePassphrase()).join("");
    expect(all.replace(/-/g, "")).toHaveLength(200 * 20); // 4000 passphrase chars
    expect(all).not.toMatch(/[ILOU]/);
  });

  it("produces distinct samples", () => {
    const samples = new Set(
      Array.from({ length: 200 }, () => generateArchivePassphrase())
    );
    expect(samples.size).toBeGreaterThan(190); // collision prob ~ 200^2/2^101 ≈ 0
  });

  it("Crockford alphabet has exactly 32 chars (bias-free % mapping invariant)", () => {
    // Reconstruct the alphabet from the regex class plus the folded digits:
    // 0-9 (10) + A-H J K M N P-T V-Z (22) = 32.
    const allowed = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    expect(allowed).toHaveLength(32);
    expect(256 % allowed.length).toBe(0);
  });
});

describe("normalizeArchivePassphrase", () => {
  it("uppercases and strips spaces", () => {
    expect(normalizeArchivePassphrase("abcde fghij")).toBe("ABCDEFGH1J");
  });

  it("strips hyphens", () => {
    expect(normalizeArchivePassphrase("abcde-fghij")).toBe("ABCDEFGH1J");
  });

  it("folds I and L to 1, O to 0 (Crockford)", () => {
    expect(normalizeArchivePassphrase("ILiL")).toBe("1111");
    expect(normalizeArchivePassphrase("Oo")).toBe("00");
  });

  it("strips mixed separators and folds in one pass", () => {
    expect(normalizeArchivePassphrase(" a-b c d e f g h i j ")).toBe("ABCDEFGH1J");
  });

  it("returns empty string for non-string and empty input", () => {
    expect(normalizeArchivePassphrase("")).toBe("");
    expect(normalizeArchivePassphrase(null)).toBe("");
    expect(normalizeArchivePassphrase(undefined)).toBe("");
    expect(normalizeArchivePassphrase(42)).toBe("");
    expect(normalizeArchivePassphrase({})).toBe("");
  });
});

describe("validateArchivePassphrase (RT46-A7: raw AND normalized floors)", () => {
  it("rejects short raw input", () => {
    expect(validateArchivePassphrase("short")).toBe(false);
  });

  it("accepts 10 normalized chars from plain input", () => {
    expect(validateArchivePassphrase("abcdefghij")).toBe(true);
  });

  it("accepts hyphenated input that normalizes to 10", () => {
    expect(validateArchivePassphrase("abcde-fghij")).toBe(true);
  });

  it("rejects raw >= 10 whose normalized form is < 10 (separators don't count)", () => {
    // raw length 12, normalized "abcdef" length 6
    expect(validateArchivePassphrase("a-b-c-d-e-f-")).toBe(false);
  });

  it("rejects raw < 10 even though stripping only shrinks (impossible to pass both otherwise)", () => {
    // raw length 9 with separators: normalized can never exceed raw length
    expect(validateArchivePassphrase("ab-cde-fg")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateArchivePassphrase(null)).toBe(false);
    expect(validateArchivePassphrase(12345678901)).toBe(false);
  });

  it("MIN_ARCHIVE_PASSPHRASE_LENGTH is 10", () => {
    expect(MIN_ARCHIVE_PASSPHRASE_LENGTH).toBe(10);
  });
});

describe("sealArchive / openArchive round-trip", () => {
  it("round-trips with the ORIGINAL mixed-case/hyphenated passphrase (symmetry)", async () => {
    const json = JSON.stringify({ secret: "abc", tokens: [{ k: "v" }] });
    const shown = generateArchivePassphrase(); // canonical hyphenated form
    // Symmetry means: whatever the USER typed at seal time must work at open
    // time verbatim. Use a deliberately mixed-case, space-separated variant.
    const userTyped = shown.toLowerCase().replace(/-/g, " ");
    expect(userTyped).not.toBe(shown);
    const file = await sealArchive(json, userTyped);
    expect(await openArchive(file, userTyped)).toBe(json);
  });

  it("round-trips the canonical generated form exactly", async () => {
    const json = JSON.stringify({ a: 1 });
    const pass = generateArchivePassphrase();
    const file = await sealArchive(json, pass);
    expect(await openArchive(file, pass)).toBe(json);
  });

  it("emits the archive container shape", async () => {
    const file = await sealArchive("{}", "abcdefghij");
    expect(file.format).toBe(ARCHIVE_FORMAT);
    expect(file.v).toBe(ARCHIVE_V);
    expect(file.envelope.aad).toBe(AAD_ARCHIVE_V1);
    expect(ARCHIVE_FORMAT).toBe("9router-encrypted-archive");
    expect(ARCHIVE_V).toBe(1);
  });

  it("isEncryptedArchive accepts seal output and rejects near-misses", async () => {
    const file = await sealArchive("{}", "abcdefghij");
    expect(isEncryptedArchive(file)).toBe(true);
    expect(isEncryptedArchive(null)).toBe(false);
    expect(isEncryptedArchive({})).toBe(false);
    expect(isEncryptedArchive([])).toBe(false);
    expect(isEncryptedArchive({ format: "other", v: 1, envelope: {} })).toBe(false);
    expect(isEncryptedArchive({ ...file, envelope: null })).toBe(true); // detection key only
  });

  it("rejects an empty or whitespace-only passphrase (BackupEnvelopeError path via seal)", async () => {
    await expect(sealArchive("{}", "")).rejects.toThrow();
    await expect(sealArchive("{}", "   ")).rejects.toThrow();
  });

  it("does NOT enforce the length floor — a 5-char passphrase seals fine (policy-free)", async () => {
    const file = await sealArchive("{}", "abcde");
    expect(await openArchive(file, "abcde")).toBe("{}");
  });
});

describe("cross-AAD domain separation", () => {
  it("a backup-AAD envelope fails openArchive (ArchiveError)", async () => {
    const json = JSON.stringify({ x: 1 });
    const backupEnvelope = await sealBackupSecret(json, "abcdefghij"); // default AAD_BACKUP_V1
    const fakeArchive = { format: ARCHIVE_FORMAT, v: ARCHIVE_V, envelope: backupEnvelope };
    await expect(openArchive(fakeArchive, "abcdefghij")).rejects.toThrow(ArchiveError);
  });

  it("an archive-AAD envelope fails openBackupSecret default (type-binding proven)", async () => {
    const file = await sealArchive("{}", "abcdefghij");
    await expect(openBackupSecret(file.envelope, "abcdefghij")).rejects.toThrow();
    // and the archive envelope is not a backup envelope by shape either
    // (aad mismatch against the default)
  });

  it("seal/open with an unknown aad constant is rejected by the envelope layer", async () => {
    await expect(
      sealBackupSecret("s", "pw", { aad: "9router-evil-v1" })
    ).rejects.toThrow("invalid seal input");
    await expect(
      openBackupSecret({}, "pw", { aad: "9router-evil-v1" })
    ).rejects.toThrow("backup envelope could not be opened");
  });
});

describe("openArchive failure normalization", () => {
  it("wrong passphrase throws the single normalized ArchiveError", async () => {
    const file = await sealArchive("{}", "abcdefghij");
    let caught = null;
    try {
      await openArchive(file, "zzzzzzzzzz");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveError);
    expect(caught.name).toBe("ArchiveError");
    expect(caught.message).toBe("wrong archive passphrase or corrupted archive");
    expect(caught.message).not.toContain("zzzzzzzzzz");
  });

  it("tampered envelope.ct throws ArchiveError (no partial output)", async () => {
    const file = await sealArchive(JSON.stringify({ a: 1 }), "abcdefghij");
    const tampered = {
      ...file,
      envelope: { ...file.envelope, ct: flipOneBase64Char(file.envelope.ct) },
    };
    await expect(openArchive(tampered, "abcdefghij")).rejects.toThrow(ArchiveError);
  });

  it("tampered envelope.tag throws ArchiveError", async () => {
    const file = await sealArchive("{}", "abcdefghij");
    const tampered = {
      ...file,
      envelope: { ...file.envelope, tag: flipOneBase64Char(file.envelope.tag) },
    };
    await expect(openArchive(tampered, "abcdefghij")).rejects.toThrow(ArchiveError);
  });

  it("missing/absent envelope throws ArchiveError (file?.envelope)", async () => {
    await expect(openArchive({}, "abcdefghij")).rejects.toThrow(ArchiveError);
    await expect(openArchive(null, "abcdefghij")).rejects.toThrow(ArchiveError);
  });
});
