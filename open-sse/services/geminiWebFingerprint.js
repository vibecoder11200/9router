// ---------------------------------------------------------------------------
// Gemini Web — Enhanced Browser Fingerprint (Layer 1)
// Chrome client hints that real browsers send
// ---------------------------------------------------------------------------

/**
 * Generate Sec-CH-UA header value with real Chrome version format.
 * Makes requests look like they come from a real Chrome browser.
 */
export function generateClientHints() {
  const majorVersion = 137;
  const fullVersion = "137.0.7155.0";

  return {
    "Sec-CH-UA": `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-CH-UA-Platform-Version": '"15.3.0"',
    "Sec-CH-UA-Arch": '"arm64"',
    "Sec-CH-UA-Bitness": '"64"',
    "Sec-CH-UA-Model": '""',
    "Sec-CH-UA-WoW64": "?0",
    "Sec-CH-UA-Full-Version-List": `"Google Chrome";v="${fullVersion}", "Chromium";v="${fullVersion}", "Not/A)Brand";v="24.0.0.0"`,
    "Priority": "u=0, i",
  };
}

/**
 * Generate Sec-CH-UA for navigation requests (document fetch).
 */
export function generateNavigationClientHints() {
  return {
    ...generateClientHints(),
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
  };
}

/**
 * Generate Sec-CH-UA for XHR/fetch requests (RPC calls).
 */
export function generateApiClientHints() {
  return {
    ...generateClientHints(),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// ---------------------------------------------------------------------------
// User-Agent rotation pool — avoid always sending same UA
// Rotates between Mac Chrome versions to appear more natural
// ---------------------------------------------------------------------------

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
];

let _uaIndex = 0;

/**
 * Get next User-Agent in rotation.
 */
export function getNextUserAgent() {
  _uaIndex = (_uaIndex + 1) % USER_AGENTS.length;
  return USER_AGENTS[_uaIndex];
}

// ---------------------------------------------------------------------------
// TLS Cipher Suite info (Layer 5)
// Matches Chrome 137's cipher preference order
// ---------------------------------------------------------------------------

export const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

/**
 * Create a TLS Agent that mimics Chrome's cipher preferences.
 */
export function createChromeTlsAgent() {
  const https = require("https");
  return new https.Agent({
    ciphers: CHROME_CIPHERS,
    honorCipherOrder: true,
    ecdhCurve: "auto",
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    keepAlive: true,
    keepAliveMsecs: 30_000,
  });
}
