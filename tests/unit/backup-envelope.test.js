import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  sealBackupSecret,
  openBackupSecret,
  isBackupEnvelope,
  BackupEnvelopeError,
  _setEnvelopeParamsForTests,
} from "@/lib/auth/backupEnvelope";

// RT-02: honor N9R_TEST_ENVELOPE_N (default 65536) so CI can run production
// params; when absent drop N to 4096 so the suite stays fast. Production
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

describe("backupEnvelope seal/open round-trip", () => {
  it("round-trips an ASCII secret", async () => {
    const secret = "simple-ascii-secret";
    const env = await sealBackupSecret(secret, "correct horse battery staple");
    expect(await openBackupSecret(env, "correct horse battery staple")).toBe(secret);
  });

  it("round-trips a 64-char hex secret (install-secret format)", async () => {
    const secret = "a".repeat(64);
    const env = await sealBackupSecret(secret, "pw");
    expect(await openBackupSecret(env, "pw")).toBe(secret);
  });

  it("round-trips with a Unicode password", async () => {
    const secret = "secret-with-unicode-pw";
    const password = "密码🔑パスワード";
    const env = await sealBackupSecret(secret, password);
    expect(await openBackupSecret(env, password)).toBe(secret);
  });

  it("rejects invalid seal input", async () => {
    await expect(sealBackupSecret("", "pw")).rejects.toThrow(BackupEnvelopeError);
    await expect(sealBackupSecret("s", "")).rejects.toThrow(BackupEnvelopeError);
    await expect(sealBackupSecret(null, "pw")).rejects.toThrow(BackupEnvelopeError);
    await expect(sealBackupSecret("s", 42)).rejects.toThrow(BackupEnvelopeError);
  });

  it("two seals of the same (secret, password) differ in salt AND nonce", async () => {
    const a = await sealBackupSecret("same-secret", "same-pw");
    const b = await sealBackupSecret("same-secret", "same-pw");
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("backupEnvelope open failures", () => {
  it("wrong password throws BackupEnvelopeError without echoing the password", async () => {
    const password = "super-secret-guess-me";
    const env = await sealBackupSecret("the-secret", password);
    const wrongPw = "totally-wrong";
    await expect(openBackupSecret(env, wrongPw)).rejects.toThrow(BackupEnvelopeError);
    let caught = null;
    try {
      await openBackupSecret(env, wrongPw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackupEnvelopeError);
    expect(caught.message).not.toContain(wrongPw);
    expect(caught.message).not.toContain(password);
  });

  it("tampered ciphertext throws", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    const tampered = { ...env, ct: flipOneBase64Char(env.ct) };
    await expect(openBackupSecret(tampered, "pw")).rejects.toThrow(BackupEnvelopeError);
  });

  it("tampered tag throws", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    const tampered = { ...env, tag: flipOneBase64Char(env.tag) };
    await expect(openBackupSecret(tampered, "pw")).rejects.toThrow(BackupEnvelopeError);
  });

  it("tampered salt throws", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    const tampered = { ...env, salt: flipOneBase64Char(env.salt) };
    await expect(openBackupSecret(tampered, "pw")).rejects.toThrow(BackupEnvelopeError);
  });

  it("envelope with N=1048576/r=32/p=1 throws fast (RT-01: no scrypt call)", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    const crafted = { ...env, N: 1048576, r: 32, p: 1 };
    const t0 = Date.now();
    await expect(openBackupSecret(crafted, "pw")).rejects.toThrow(BackupEnvelopeError);
    // Rejected before scrypt: at N=2^20/r=32 a real scrypt call would take
    // far longer than a shape rejection. 2 s is generous for the fast path.
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("envelope with N=NaN throws BackupEnvelopeError (integer check precedes comparisons)", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    const crafted = { ...env, N: NaN };
    await expect(openBackupSecret(crafted, "pw")).rejects.toThrow(BackupEnvelopeError);
    const craftedR = { ...env, r: NaN };
    await expect(openBackupSecret(craftedR, "pw")).rejects.toThrow(BackupEnvelopeError);
  });

  it("non-envelope input throws BackupEnvelopeError", async () => {
    await expect(openBackupSecret({}, "pw")).rejects.toThrow(BackupEnvelopeError);
    await expect(openBackupSecret(null, "pw")).rejects.toThrow(BackupEnvelopeError);
  });
});

describe("backupEnvelope shape + production params", () => {
  it("isBackupEnvelope accepts seal output", async () => {
    const env = await sealBackupSecret("secret-value", "pw");
    expect(isBackupEnvelope(env)).toBe(true);
  });

  it("isBackupEnvelope rejects {}, null, v:2, and mutated aad", () => {
    expect(isBackupEnvelope({})).toBe(false);
    expect(isBackupEnvelope(null)).toBe(false);
    const base = {
      v: 2, cipher: "aes-256-gcm", kdf: "scrypt", salt: "s", nonce: "n",
      ct: "c", tag: "t", aad: "9router-backup-v1",
    };
    expect(isBackupEnvelope(base)).toBe(false);
    expect(isBackupEnvelope({ ...base, v: 1, aad: "9router-archive-v1" })).toBe(false);
  });

  // Production params (N=65536) — slow, hence explicit 20 s timeouts (RT-02).
  it("seal emits the frozen params in-band: N=65536, r=8, p=1", { timeout: 20000 }, async () => {
    const prev = _setEnvelopeParamsForTests({ N: 65536 });
    try {
      const env = await sealBackupSecret("secret-value", "pw");
      expect(env.N).toBe(65536);
      expect(env.r).toBe(8);
      expect(env.p).toBe(1);
      expect(env.v).toBe(1);
      expect(env.cipher).toBe("aes-256-gcm");
      expect(env.kdf).toBe("scrypt");
      expect(env.aad).toBe("9router-backup-v1");
    } finally {
      _setEnvelopeParamsForTests({ N: prev });
    }
  });

  it("maxmem regression guard: open succeeds at N=65536 (proves explicit maxmem is passed)", { timeout: 20000 }, async () => {
    const prev = _setEnvelopeParamsForTests({ N: 65536 });
    try {
      const secret = "maxmem-guard-secret";
      const env = await sealBackupSecret(secret, "pw");
      // Without an explicit maxmem >= 64 MiB, Node's 32 MiB default makes
      // scrypt throw ERR_CRYPTO_SCRYPT_INVALID_PARAMETER at N=2^16/r=8.
      expect(await openBackupSecret(env, "pw")).toBe(secret);
    } finally {
      _setEnvelopeParamsForTests({ N: prev });
    }
  });

  it("open at production N=65536 rejects a wrong password with the normalized error", { timeout: 20000 }, async () => {
    const prev = _setEnvelopeParamsForTests({ N: 65536 });
    try {
      const env = await sealBackupSecret("secret-value", "right-pw");
      await expect(openBackupSecret(env, "wrong-pw")).rejects.toThrow(
        "backup envelope could not be opened"
      );
    } finally {
      _setEnvelopeParamsForTests({ N: prev });
    }
  });
});
