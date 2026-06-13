const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const p = path.join(os.homedir(), '.9router', 'db', 'data.sqlite');
console.log('path:', p);

const db = new Database(p);
const r = db.prepare("select name from sqlite_master where type='table'").all();
console.log(JSON.stringify(r));

// Check password
try {
  const pw = db.prepare("select value from settings where key='password'").all();
  console.log('password row:', JSON.stringify(pw));
} catch(e) {
  console.log('no settings/password:', e.message);
  
  // Try alternative schema
  try {
    const all = db.prepare("select * from settings").all();
    console.log('all settings:', JSON.stringify(all));
  } catch(e2) {
    // Try different table
    const allTables = db.prepare("select * from sqlite_master").all();
    console.log('all schema:', JSON.stringify(allTables));
  }
}

db.close();
