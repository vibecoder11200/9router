#!/usr/bin/env node
/**
 * Gemini Web Health Check Runner
 * Direct health check that talks to bootstrapGeminiWebSession
 * Uses sql.js for DB access since better-sqlite3 native binding is flaky
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const fs = require('fs');

const DB_PATH = '/tmp/9router-test/db/data.sqlite';

// We need to import from the project
import { extractGeminiWebCredentials } from './open-sse/services/geminiWebCookie.js';
import { bootstrapGeminiWebSession } from './open-sse/services/geminiWebSession.js';

async function run() {
  console.log(`[${new Date().toISOString()}] 🩺 Gemini Web Health Check starting...`);

  // Read DB with sql.js
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  const stmt = db.prepare('SELECT id, name, provider, authType, data, updatedAt FROM providerConnections WHERE provider = ?');
  stmt.bind(['gemini-web']);

  const connections = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    connections.push(row);
  }
  db.close();

  console.log(`Found ${connections.length} gemini-web connection(s)\n`);

  const results = [];

  for (const conn of connections) {
    console.log(`--- Checking: ${conn.name} (${conn.id.substring(0,8)}...) ---`);

    let parsedData;
    try {
      parsedData = JSON.parse(conn.data);
    } catch (e) {
      results.push({ id: conn.id, name: conn.name, status: 'error', detail: 'Invalid JSON in data field' });
      console.log(`  ❌ Invalid JSON data\n`);
      continue;
    }

    const cookies = parsedData.providerSpecificData?.cookies;
    if (!cookies || Object.keys(cookies).length === 0) {
      parsedData.testStatus = 'error';
      parsedData.lastError = 'No cookies found in connection data';
      parsedData.lastErrorAt = new Date().toISOString();

      const db2 = new SQL.Database(fs.readFileSync(DB_PATH));
      db2.run(`UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(parsedData), new Date().toISOString(), conn.id]);
      fs.writeFileSync('/dev/stdout', Buffer.from(db2.export())); // just discard
      db2.close();

      results.push({ id: conn.id, name: conn.name, status: 'error', detail: 'No cookies found' });
      console.log(`  ❌ No cookies found\n`);
      continue;
    }

    try {
      const session = await bootstrapGeminiWebSession(cookies, { timeoutMs: 15000 });
      const buildLabel = session.buildLabel?.substring(0, 40) || 'unknown';

      parsedData.testStatus = 'active';
      parsedData.lastError = null;
      parsedData.lastErrorAt = null;

      const db2 = new SQL.Database(fs.readFileSync(DB_PATH));
      db2.run(`UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(parsedData), new Date().toISOString(), conn.id]);
      fs.writeFileSync(DB_PATH, Buffer.from(db2.export()));
      db2.close();

      results.push({ id: conn.id, name: conn.name, status: 'active', detail: `buildLabel: ${buildLabel}` });
      console.log(`  ✅ Session active — buildLabel: ${buildLabel}\n`);
    } catch (err) {
      const isCookieExpired = err.status === 401 || err.status === 403;
      const status = isCookieExpired ? 'error' : 'unavailable';
      const errorMsg = isCookieExpired
        ? 'Cookie expired — re-paste your Gemini Web cookies'
        : err.message;

      parsedData.testStatus = status;
      parsedData.lastError = errorMsg;
      parsedData.lastErrorAt = new Date().toISOString();
      parsedData.errorCode = err.status || null;

      const db2 = new SQL.Database(fs.readFileSync(DB_PATH));
      db2.run(`UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`, [JSON.stringify(parsedData), new Date().toISOString(), conn.id]);
      fs.writeFileSync(DB_PATH, Buffer.from(db2.export()));
      db2.close();

      results.push({ id: conn.id, name: conn.name, status, detail: errorMsg });
      console.log(`  ❌ ${status}: ${errorMsg}\n`);
    }
  }

  console.log(`=== SUMMARY ===`);
  for (const r of results) {
    const icon = r.status === 'active' ? '✅' : r.status === 'error' ? '❌' : '⚠️';
    console.log(`${icon} ${r.name}: ${r.status} — ${r.detail}`);
  }
  console.log(`\n[${new Date().toISOString()}] Gemini Web Health Check complete.`);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
