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
  // Get all products with data fields
  const products = await query('products', '*');
  console.log('=== ALL PRODUCTS ===');
  console.log('Count:', products.length);
  
  // Calculate physical inventory
  let merchandiseValue = 0, rawMaterialsValue = 0, stationeryValue = 0, totalValue = 0;
  let merchandiseCount = 0, rawMaterialsCount = 0, stationeryCount = 0;
  let negativeStock = [], zeroCost = [], unclassified = [];
  
  for (const p of products) {
    const d = p.data || p;
    const stock = d.stock || 0;
    const cost = d.cost || d.costPrice || d.cost_price || 0;
    const type = (d.type || '').toLowerCase();
    const value = stock * cost;
    totalValue += value;
    
    if (type.includes('product') || type.includes('finished')) {
      merchandiseValue += value; merchandiseCount++;
    } else if (type.includes('raw material') || type.includes('material')) {
      rawMaterialsValue += value; rawMaterialsCount++;
    } else if (type.includes('stationery')) {
      stationeryValue += value; stationeryCount++;
    } else {
      unclassified.push({ id: d.id, name: d.name, type: d.type, stock, cost, value });
    }
    
    if (stock < 0) negativeStock.push({ id: d.id, name: d.name, stock });
    if (cost <= 0 && stock > 0) zeroCost.push({ id: d.id, name: d.name, cost, stock });
  }
  
  console.log('\n=== PHYSICAL INVENTORY VALUATION ===');
  console.log('Merchandise (Products): K' + merchandiseValue.toLocaleString());
  console.log('Raw Materials: K' + rawMaterialsValue.toLocaleString());
  console.log('Stationery: K' + stationeryValue.toLocaleString());
  console.log('Total Physical: K' + totalValue.toLocaleString());
  console.log('Items counted:', products.length);
  console.log('Unclassified:', unclassified.length);
  console.log('Negative stock:', negativeStock.length);
  console.log('Zero cost:', zeroCost.length);
  
  // Get chart_of_accounts with correct columns
  const accounts = await query('chart_of_accounts', '*');
  console.log('\n=== CHART OF ACCOUNTS ===');
  console.log('Count:', accounts.length);
  
  // Find inventory accounts
  const invAccounts = accounts.filter(a => 
    (a.account_number && a.account_number.startsWith('114')) ||
    (a.code && a.code.startsWith('114')) ||
    (a.name && a.name.toLowerCase().includes('inventory'))
  );
  console.log('\n=== INVENTORY ACCOUNTS ===');
  console.log(JSON.stringify(invAccounts, null, 2));
  
  // Find 51200 and 32000
  const cogsAccounts = accounts.filter(a => 
    (a.account_number && ['51200','32000'].includes(a.account_number)) ||
    (a.code && ['51200','32000'].includes(a.code))
  );
  console.log('\n=== COGS/EQUITY ACCOUNTS ===');
  console.log(JSON.stringify(cogsAccounts, null, 2));
  
  // Get ledger_entries
  const ledger = await query('ledger_entries', '*');
  console.log('\n=== LEDGER ENTRIES ===');
  console.log('Count:', ledger.length);
  
  // Find ledger entries for inventory accounts
  const invLedger = ledger.filter(e => {
    const accId = e.account_id || '';
    const accCode = e.account_code || '';
    return accId.includes('114') || accCode.includes('114') ||
           accId.includes('51200') || accCode.includes('51200') ||
           accId.includes('32000') || accCode.includes('32000');
  });
  console.log('\n=== INVENTORY-RELATED LEDGER ===');
  console.log(JSON.stringify(invLedger, null, 2));
  
  // Check if there's a separate accounts or accounts table
  const accTables = ['accounts', 'account', 'coa'];
  for (const t of accTables) {
    try {
      const r = await axios.get(`${SUPABASE_URL}/rest/v1/${t}?limit=1`, { headers, timeout: 5000 });
      console.log(`\n=== ${t} EXISTS ===`);
      console.log('Count:', r.data.length);
    } catch (e) {
      // skip
    }
  }
  
  // Check for any table with 11400
  const allTables = ['ledger', 'journal', 'journal_entries', 'accounting_entries'];
  for (const t of allTables) {
    try {
      const r = await axios.get(`${SUPABASE_URL}/rest/v1/${t}?limit=1`, { headers, timeout: 5000 });
      console.log(`\n=== ${t} EXISTS ===`);
      console.log('Count:', r.data.length);
    } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
