#!/usr/bin/env node
// Quick test script
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const fs = require('fs');

const SQL = await initSqlJs();
const buf = fs.readFileSync('/tmp/9router-test/db/data.sqlite');
const db = new SQL.Database(buf);
const stmt = db.prepare('SELECT id, name, provider, authType, data, updatedAt FROM providerConnections WHERE provider = ?');
stmt.bind(['gemini-web']);
let count = 0;
while (stmt.step()) {
  const row = stmt.getAsObject();
  const d = JSON.parse(row.data);
  console.log('CONN:', row.id.substring(0,8), row.name, '| status:', d.testStatus, '| cookies:', d.providerSpecificData?.cookies ? Object.keys(d.providerSpecificData.cookies).length : 0);
  count++;
}
db.close();
console.log('Total:', count);
