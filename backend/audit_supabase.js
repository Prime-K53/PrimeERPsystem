const axios = require('axios');

const SUPABASE_URL = 'https://rdtuzuzehfbwvfdzqliw.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

const headers = {
  apikey: SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function query(table, select = '*', filters = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    params.append(k, v);
  }
  if (params.toString()) url += '&' + params.toString();
  
  try {
    const resp = await axios.get(url, { headers, timeout: 15000 });
    return resp.data;
  } catch (e) {
    console.error(`Error querying ${table}:`, e.message);
    if (e.response) console.error('Status:', e.response.status, 'Data:', JSON.stringify(e.response.data).slice(0, 500));
    return [];
  }
}

async function main() {
  // Query products (inventory)
  const products = await query('products', '*');
  console.log('=== PRODUCTS (Inventory) ===');
  console.log('Count:', products.length);
  if (products.length > 0) {
    console.log(JSON.stringify(products.slice(0, 10), null, 2));
  }

  // Query chart_of_accounts for 114xx
  const accounts = await query('chart_of_accounts', '*', { code: 'like.114' });
  console.log('\n=== CHART_OF_ACCOUNTS (114xx) ===');
  console.log(JSON.stringify(accounts, null, 2));

  // Also check for 51200 and 32000
  const allAccounts = await query('chart_of_accounts', '*');
  const invAccounts = allAccounts.filter(a => 
    (a.code && (a.code.startsWith('114') || a.code === '51200' || a.code === '32000')) ||
    (a.account_number && (a.account_number.startsWith('114') || a.account_number === '51200' || a.account_number === '32000'))
  );
  console.log('\n=== INVENTORY-RELATED ACCOUNTS ===');
  console.log(JSON.stringify(invAccounts, null, 2));

  // Query ledger_entries for inventory accounts
  const ledger = await query('ledger_entries', '*');
  console.log('\n=== ALL LEDGER ENTRIES ===');
  console.log('Count:', ledger.length);
  
  const invLedger = ledger.filter(e => 
    (e.account_id && e.account_id.includes('114')) ||
    (e.account_code && e.account_code.includes('114')) ||
    (e.account_id && ['51200','32000'].some(c => e.account_id.includes(c))) ||
    (e.account_code && ['51200','32000'].some(c => e.account_code.includes(c)))
  );
  console.log('\n=== INVENTORY-RELATED LEDGER ===');
  console.log(JSON.stringify(invLedger, null, 2));

  // Check for products table with different name
  const prod2 = await query('products', '*', { type: 'eq.product' });
  console.log('\n=== PRODUCTS BY TYPE ===');
  console.log('Count:', prod2.length);

  // Check warehouse_inventory
  const whInv = await query('warehouse_inventory', '*');
  console.log('\n=== WAREHOUSE_INVENTORY ===');
  console.log('Count:', whInv.length);
  if (whInv.length > 0) console.log(JSON.stringify(whInv.slice(0, 5), null, 2));

  // Check if there's a separate inventory or stock table
  const stockTables = ['stock', 'inventory_items', 'stock_items', 'items'];
  for (const t of stockTables) {
    try {
      const r = await axios.get(`${SUPABASE_URL}/rest/v1/${t}?limit=1`, { headers, timeout: 5000 });
      console.log(`\n=== ${t} EXISTS ===`);
      console.log('Count:', r.data.length);
    } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
