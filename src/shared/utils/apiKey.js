import crypto from "crypto";
import { getOrCreateInstallSecret } from "@/lib/auth/installSecret.js";

// S9: no committed fallback constant. When the env var is unset the HMAC
// secret is the per-install secret file (0o600, DATA_DIR/auth) — an attacker
// who knows the source can no longer forge key CRCs.
let cachedSecret = null;
function apiKeySecret() {
  if (process.env.API_KEY_SECRET) return process.env.API_KEY_SECRET;
  if (!cachedSecret) cachedSecret = getOrCreateInstallSecret("api-key-secret");
  return cachedSecret;
}

/**
 * Generate 12-char random keyId (crypto-strong, ~62.04 bits: 36^12 = 2^62.04).
 * v0.6.45: was 6 chars from a non-crypto PRNG (~31 bits). Longer keyIds are
 * transparent to parseApiKey/maskApiKey (split/index-based, no length
 * assumptions); existing 6-char keys keep validating. This raises the
 * brute-force cost of forging key STRINGS against hash lookups (~62 bits);
 * the re-key proof's strength comes from its needsRekey-only gate + mismatch
 * lockout (phase-03 RT-11), not from keyId length (keyId is published in the
 * masked display, so that proof stays 16 bits / last4 regardless).
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(crypto.randomInt(chars.length));
  }
  return result;
}

/**
 * Generate CRC (8-char HMAC)
 */
function generateCrc(machineId, keyId) {
  return crypto
    .createHmac("sha256", apiKeySecret())
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

/**
 * Generate API key with machineId embedded
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} machineId - 16-char machine ID
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId) {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Parse API key and extract machineId + keyId
 * Supports both formats:
 * - New: sk-{machineId}-{keyId}-{crc8}
 * - Old: sk-{random8}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string, isNewFormat: boolean } | null}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");
  
  // New format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    
    // Validate CRC
    const expectedCrc = generateCrc(machineId, keyId);
    if (crc !== expectedCrc) return null;
    
    return { machineId, keyId, isNewFormat: true };
  }
  
  // Old format: sk-{random8} = 2 parts
  if (parts.length === 2) {
    return { machineId: null, keyId: parts[1], isNewFormat: false };
  }
  
  return null;
}

/**
 * Verify API key CRC (only for new format)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  
  // Old format doesn't have CRC, always valid if parsed
  if (!parsed.isNewFormat) return true;
  
  // New format already verified in parseApiKey
  return true;
}

/**
 * Check if API key is new format (contains machineId)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isNewFormatKey(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}

