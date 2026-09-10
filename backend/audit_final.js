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
    return [];
  }
}

async function main() {
  // Get inventory-related accounts from accounts table
  const accounts = await query('accounts', '*');
  const invAccounts = accounts.filter(a => {
    const d = a.data || a;
    return d.code && ['11400','11410','11420','11430','51200','32000'].includes(d.code);
  });
  console.log('=== INVENTORY ACCOUNTS ===');
  console.log(JSON.stringify(invAccounts.map(a => ({ id: a.id, ...(a.data || a) })), null, 2));

  // Check ledger_entries count
  const ledger = await query('ledger_entries', '*');
  console.log('\n=== LEDGER ENTRIES COUNT ===');
  console.log('Count:', ledger.length);

  // Check if there's a separate "ledger" table (not ledger_entries)
  const ledger2 = await query('ledger', '*');
  console.log('\n=== LEDGER TABLE ===');
  console.log('Count:', ledger2.length);

  // Check journal entries
  const journals = await query('journal_entries', '*');
  console.log('\n=== JOURNAL_ENTRIES ===');
  console.log('Count:', journals.length);

  const journals2 = await query('journals', '*');
  console.log('\n=== JOURNALS ===');
  console.log('Count:', journals2.length);

  // Check accounting_entries
  const acctEntries = await query('accounting_entries', '*');
  console.log('\n=== ACCOUNTING_ENTRIES ===');
  console.log('Count:', acctEntries.length);

  // Check if there's any table with "entry" in the name
  const allTables = await query('products', '*'); // Just to test
  console.log('\n=== PRODUCTS COUNT ===');
  console.log('Count:', allTables.length);

  // Get all products with their types for categorization
  const allProducts = await query('products', '*');
  let merchandiseValue = 0, rawMaterialsValue = 0, stationeryValue = 0, otherValue = 0;
  let merchandiseCount = 0, rawMaterialsCount = 0, stationeryCount = 0;
  let negativeStock = [], zeroCost = [], unclassified = [];
  let totalItems = 0;

  for (const p of allProducts) {
    const d = p.data || p;
    const stock = d.stock || 0;
    const cost = d.cost || d.costPrice || d.cost_price || 0;
    const type = (d.type || '').toLowerCase();
    const value = stock * cost;
    totalItems++;

    if (type.includes('product') || type.includes('finished')) {
      merchandiseValue += value; merchandiseCount++;
    } else if (type.includes('raw material') || type.includes('material')) {
      rawMaterialsValue += value; rawMaterialsCount++;
    } else if (type.includes('stationery')) {
      stationeryValue += value; stationeryCount++;
    } else {
      otherValue += value; unclassified.push({ id: d.id, name: d.name, type: d.type, stock, cost, value });
    }

    if (stock < 0) negativeStock.push({ id: d.id, name: d.name, stock });
    if (cost <= 0 && stock > 0) zeroCost.push({ id: d.id, name: d.name, cost, stock });
  }

  console.log('\n=== PHYSICAL INVENTORY SUMMARY ===');
  console.log('Total items:', totalItems);
  console.log('Merchandise (Products): K' + merchandiseValue.toLocaleString() + ' (' + merchandiseCount + ' items)');
  console.log('Raw Materials: K' + rawMaterialsValue.toLocaleString() + ' (' + rawMaterialsCount + ' items)');
  console.log('Stationery: K' + stationeryValue.toLocaleString() + ' (' + stationeryCount + ' items)');
  console.log('Other/Unclassified: K' + otherValue.toLocaleString() + ' (' + unclassified.length + ' items)');
  console.log('TOTAL PHYSICAL: K' + (merchandiseValue + rawMaterialsValue + stationeryValue + otherValue).toLocaleString());
  console.log('Negative stock items:', negativeStock.length);
  console.log('Zero cost items:', zeroCost.length);
  console.log('Unclassified items:', unclassified.length);

  // Check for duplicate product IDs
  const idCounts = {};
  for (const p of allProducts) {
    const id = (p.data || p).id;
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  const dupes = Object.entries(idCounts).filter(([k,v]) => v > 1);
  console.log('\nDuplicate product IDs:', dupes.length);

  // Check for items with same name
  const nameCounts = {};
  for (const p of allProducts) {
    const name = (p.data || p).name;
    nameCounts[name] = (nameCounts[name] || 0) + 1;
  }
  const nameDupes = Object.entries(nameCounts).filter(([k,v]) => v > 1);
  console.log('Items with same name:', nameDupes.length);
  if (nameDupes.length > 0) console.log('Duplicate names:', nameDupes.slice(0, 10));

  // Check if there's any data in the "accounts" table for inventory account balances
  const invAcc = accounts.find(a => (a.data || a).code === '11410');
  console.log('\n=== ACC-11410 DATA ===');
  console.log(JSON.stringify(invAcc ? invAcc.data : null, null, 2));

  // Check if accounts have any balance field
  const accWithBalance = accounts.find(a => (a.data || a).code === '11410');
  if (accWithBalance) {
    const d = accWithBalance.data || accWithBalance;
    console.log('Balance field:', d.balance, 'opening_balance:', d.opening_balance);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
