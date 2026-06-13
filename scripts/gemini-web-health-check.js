#!/usr/bin/env node
/**
 * Gemini Web Health Monitor — cron-based cookie health check.
 * Tests all gemini-web connections and reports expiry.
 *
 * Usage: node scripts/gemini-web-health-check.js
 * Cron: every 6 hours
 */

import { getProviderConnections, updateProviderConnection } from "../src/models/index.js";
import { extractGeminiWebCredentials } from "../open-sse/services/geminiWebCookie.js";
import { bootstrapGeminiWebSession } from "../open-sse/services/geminiWebSession.js";

// Cookie max age before warning (14 days in ms)
const COOKIE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WARNING_AGE_MS = 10 * 24 * 60 * 60 * 1000; // warn after 10 days

async function main() {
  console.log(`[${new Date().toISOString()}] Gemini Web Health Check starting...`);

  const connections = await getProviderConnections({ provider: "gemini-web" });
  console.log(`Found ${connections.length} gemini-web connection(s)`);

  for (const conn of connections) {
    console.log(`\n--- Checking: ${conn.name} (${conn.id}) ---`);

    const extracted = extractGeminiWebCredentials(conn);
    if (!extracted.valid) {
      console.log(`  ❌ Invalid cookies: ${extracted.error}`);
      await updateProviderConnection(conn.id, {
        testStatus: "error",
        lastError: extracted.error,
        lastErrorAt: new Date().toISOString(),
      });
      continue;
    }

    try {
      const session = await bootstrapGeminiWebSession(extracted.cookies, {
        timeoutMs: 15000,
      });
      console.log(`  ✅ Session OK: build_label=${session.buildLabel?.slice(0, 20)}...`);

      await updateProviderConnection(conn.id, {
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
      });
    } catch (err) {
      const status = err.status === 401 || err.status === 403 ? "error" : "unavailable";
      const errorMsg = err.status === 401 || err.status === 403
        ? "Cookie expired — re-paste your Gemini Web cookies"
        : err.message;

      console.log(`  ❌ ${status}: ${errorMsg}`);
      await updateProviderConnection(conn.id, {
        testStatus: status,
        lastError: errorMsg,
        lastErrorAt: new Date().toISOString(),
      });
    }
  }

  console.log(`\n[${new Date().toISOString()}] Gemini Web Health Check complete.`);
}

main().catch(console.error);
