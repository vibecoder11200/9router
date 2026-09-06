# Research: v0.6.46 Option F — archive crypto UX & format

Researcher: agent (inline report persisted by orchestrator). Date: 2026-09-06.
Note: WebSearch quota exhausted mid-run; key claims rest on official docs (age spec, GitHub docs, EFF) plus standard references.

## 1. Passphrase generator (show-once mode)

**GitHub recovery-code precedent** (docs.github.com — 2FA recovery methods): set of 16 one-time codes, shown via "View" once, with explicit Download / Print / Copy affordances. Regeneration invalidates all prior codes. Show-once is deliberate (no server-side retrievability). For 9router: the generated passphrase never exists server-side at all in the generator path (generate → use immediately → show once); even stronger. Keep the discipline: display once, never log, never store.

**Encoding choice (~80–128 bits, human-transcribed):**
- EFF diceware long list: 7776 words = 12.9 bits/word; 6 words ≈ 77 bits, 8 ≈ 103. Best for retyping-from-memory; costs shipping a 7776-word list to both CLI and web.
- **Crockford Base32** (excludes I, L, O, U): 5 bits/char. 20 chars = 100 bits, grouped `xxxxx-xxxxx-xxxxx-xxxxx`. Typo-resistant, case-insensitive, unambiguous.
- Backup passphrase is used rarely, likely pasted from a saved copy → Base32 grouping wins; diceware rejected (list cost > benefit for one-time unlock events).

**Recommended spec (dual terminal + web):**
- Generate: Crockford Base32, 20 chars (100 bits), `xxxxx-xxxxx-xxxxx-xxxxx`, via `crypto.randomBytes` rejection-sampled; `normalizeArchivePassphrase()` on import input (strip hyphens/spaces, uppercase, Crockford-decode; accept user-chosen passphrases verbatim, min length ~10 checked at export only; strip checksum chars if present, don't require them).
- Display: monospace show-once panel ("This passphrase cannot be shown again"), Copy + Download `.txt` (web) / terminal print + warning (CLI). Mandatory confirm-by-retyping before export finalizes — catches clipboard loss AND validates capture.
- "Generate for me" is the secondary path; user-chosen stays primary.

## 2. Encrypted-archive format precedent

**age v1** (C2SP spec): header `age-encryption.org/v1` + self-describing recipient stanzas (type name + args) + HMAC over header; payload = fresh nonce + 64 KiB chunks each ChaCha20-Poly1305-sealed, nonce = counter + final-chunk flag (STREAM). KeePass kdbx carries cipher/KDF UUIDs; OpenSSL `enc`'s weakness is exactly its non-self-describing header. Our `{format:"9router-encrypted-archive", v:1, envelope:{...}}` matches the precedent: format string = magic, v = migration hook, envelope already carries KDF params. Detection: top-level `format` key present → encrypted; absent → legacy plaintext JSON.

**One-shot GCM vs chunked:** one-shot AES-256-GCM safe well past 50MB (NIST SP 800-38D limits irrelevant with per-file fresh key/nonce). Real ceiling is memory: ~3-4× transient copies (JSON string ~2× as UTF-16, Buffer, GCM output) → ~200MB peak at 50MB. age's chunking exists for streaming/seek on unbounded files, not correctness at our size. **Verdict: one-shot fine ≤50-100MB; document a ~100MB ceiling; defer STREAM-style chunking (YAGNI).**

## 3. Nesting / double-encryption pitfalls

- No crypto problem; engineering pitfalls only: keep Buffers end-to-end from serialization onward; single `buf.toString("utf8")` immediately before `JSON.parse` on decrypt (one string round-trip unavoidable, ~2-3× file size peak).
- AAD `"9router-archive-v1"` domain-separates correctly from `"9router-backup-v1"`.
- Suppressing inner authSecretEnvelope under F: right call (double prompt, zero gain) — UX decision; whole-payload encryption already protects the secret. Import must accept BOTH shapes (F-archive without inner envelope; legacy .45 export with inner envelope) via format-key detection.
- Error UX: GCM auth failure ≡ wrong passphrase → "wrong passphrase or corrupted archive", never partial decrypt.

## 4. scrypt params for F

Keep the SAME frozen tuple (N=2^16, r=8, p=1, maxmem=128MiB) shared with backupEnvelope.js — same secret class, same human passphrases, same attack economics; one constant, one validation path. Domain separation lives in the AAD, not the params. Future param changes go through archive `v:2` (age precedent: version line + ignore-unknown). N=2^16 + 100-bit generated passphrase is far beyond attackable; user-chosen weak passphrases are the real weak point and +1 N exponent doesn't fix that.

## Sources
- age v1 spec: https://github.com/C2SP/C2SP/blob/main/age.md
- GitHub 2FA recovery codes: https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication-recovery-methods
- EFF diceware: https://eff.org/dice
- Crockford Base32: https://crockford.com/base32.html
- NIST SP 800-38D: https://csrc.nist.gov/pubs/sp/800/38/d/final

## Unresolved questions
1. User-chosen passphrase: strength meter (zxcvbn dep) vs length floor only? (recommend floor — no new deps)
2. Web passphrase generation client-side (Web Crypto) vs server-side-once? (server simpler; must never log that endpoint response)
3. Import UX stance: passphrase lost = unrecoverable (state in confirm dialog).
4. Crockford checksum char: strip if present, don't require.
