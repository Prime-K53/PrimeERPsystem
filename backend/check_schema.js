const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('storage/database.db');

db.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('inventory','accounts','ledger')", (err, rows) => {
  if (err) { console.error(err); db.close(); process.exit(1); }
  rows.forEach(r => {
    console.log('=== ' + r.name + ' ===');
    console.log(r.sql);
    console.log();
  });
  db.close();
});
