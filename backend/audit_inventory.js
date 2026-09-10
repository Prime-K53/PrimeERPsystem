const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('storage/database.db');

function query(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function main() {
  // Check inventory table schema
  const invSchema = await query("SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'");
  console.log('=== INVENTORY SCHEMA ===');
  console.log(invSchema[0].sql);

  // Check warehouse_inventory
  const whSchema = await query("SELECT sql FROM sqlite_master WHERE type='table' AND name='warehouse_inventory'");
  console.log('\n=== WAREHOUSE_INVENTORY SCHEMA ===');
  console.log(whSchema[0].sql);

  // Check inventory_transactions
  const itSchema = await query("SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory_transactions'");
  console.log('\n=== INVENTORY_TRANSACTIONS SCHEMA ===');
  console.log(itSchema[0].sql);

  // Check chart_of_accounts
  const coaSchema = await query("SELECT sql FROM sqlite_master WHERE type='table' AND name='chart_of_accounts'");
  console.log('\n=== CHART_OF_ACCOUNTS SCHEMA ===');
  console.log(coaSchema[0].sql);

  // Check ledger_entries
  const leSchema = await query("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger_entries'");
  console.log('\n=== LEDGER_ENTRIES SCHEMA ===');
  console.log(leSchema[0].sql);

  // Get inventory items
  const inventory = await query('SELECT * FROM inventory ORDER BY id');
  console.log('\n=== INVENTORY ITEMS ===');
  console.log('Count:', inventory.length);
  if (inventory.length > 0) console.log(JSON.stringify(inventory.slice(0, 5), null, 2));

  // Get warehouse_inventory
  const whInv = await query('SELECT * FROM warehouse_inventory ORDER BY id');
  console.log('\n=== WAREHOUSE_INVENTORY ===');
  console.log('Count:', whInv.length);
  if (whInv.length > 0) console.log(JSON.stringify(whInv.slice(0, 5), null, 2));

  // Get chart of accounts
  const accounts = await query('SELECT * FROM chart_of_accounts WHERE code LIKE "114%" OR code IN ("51200","32000") ORDER BY code');
  console.log('\n=== CHART_OF_ACCOUNTS (114xx, 51200, 32000) ===');
  console.log(JSON.stringify(accounts, null, 2));

  // All accounts
  const allAccounts = await query('SELECT * FROM chart_of_accounts ORDER BY code LIMIT 20');
  console.log('\n=== ALL CHART_OF_ACCOUNTS (first 20) ===');
  console.log(JSON.stringify(allAccounts, null, 2));

  // Ledger entries
  const ledger = await query('SELECT * FROM ledger_entries ORDER BY date, id');
  console.log('\n=== LEDGER ENTRIES ===');
  console.log('Count:', ledger.length);
  if (ledger.length > 0) console.log(JSON.stringify(ledger.slice(0, 10), null, 2));

  // Inventory-related ledger entries
  const invLedger = ledger.filter(e => 
    (e.debitAccountId && (e.debitAccountId.includes('114') || ['51200','32000'].includes(e.debitAccountId))) ||
    (e.creditAccountId && (e.creditAccountId.includes('114') || ['51200','32000'].includes(e.creditAccountId)))
  );
  console.log('\n=== INVENTORY-RELATED LEDGER ===');
  console.log(JSON.stringify(invLedger, null, 2));

  // Check inventory_transactions
  const invTrans = await query('SELECT * FROM inventory_transactions ORDER BY id LIMIT 20');
  console.log('\n=== INVENTORY_TRANSACTIONS (first 20) ===');
  console.log(JSON.stringify(invTrans, null, 2));

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
