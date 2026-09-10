const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('storage/database.db');

db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, rows) => {
  if (err) { console.error(err); db.close(); process.exit(1); }
  console.log('=== ALL TABLES ===');
  rows.forEach(r => console.log(r.name));
  db.close();
});
