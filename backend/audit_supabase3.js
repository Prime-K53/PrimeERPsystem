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
  // Check accounts table
  const accounts = await query('accounts', '*');
  console.log('=== ACCOUNTS TABLE ===');
  console.log('Count:', accounts.length);
  console.log(JSON.stringify(accounts, null, 2));

  // Try chart_of_accounts with select=*
  const coa = await query('chart_of_accounts', '*');
  console.log('\n=== CHART_OF_ACCOUNTS ===');
  console.log('Count:', coa.length);
  if (coa.length > 0) console.log(JSON.stringify(coa.slice(0, 5), null, 2));

  // Try to get all table names from Supabase
  const schema = await query('information_schema.tables', 'table_name');
  console.log('\n=== SUPABASE TABLES ===');
  console.log(schema.length, 'tables');
  const invTables = schema.filter(t => 
    t.table_name.includes('account') || 
    t.table_name.includes('ledger') ||
    t.table_name.includes('chart') ||
    t.table_name.includes('journal') ||
    t.table_name.includes('inventory') ||
    t.table_name.includes('product')
  );
  console.log('Relevant tables:', invTables.map(t => t.table_name));

  // Try ledger_entries with select=*
  const ledger = await query('ledger_entries', '*');
  console.log('\n=== LEDGER_ENTRIES ===');
  console.log('Count:', ledger.length);
  if (ledger.length > 0) console.log(JSON.stringify(ledger.slice(0, 5), null, 2));

  // Try to find any table with account_number
  const coa2 = await query('chart_of_accounts', 'account_number,name,type,account_type,parent_account_id,normal_balance,allow_posting,is_system_account');
  console.log('\n=== CHART_OF_ACCOUNTS (with account_number) ===');
  console.log('Count:', coa2.length);
  if (coa2.length > 0) {
    const invAcc = coa2.filter(a => a.account_number && a.account_number.startsWith('114'));
    console.log('Inventory accounts:', JSON.stringify(invAcc, null, 2));
  }

  // Check if there's a Supabase view or function
  const views = await query('information_schema.views', 'table_name');
  console.log('\n=== VIEWS ===');
  const invViews = views.filter(v => v.table_name.includes('account') || v.table_name.includes('ledger') || v.table_name.includes('inventory'));
  console.log('Relevant views:', invViews.map(v => v.table_name));
}

main().catch(e => { console.error(e); process.exit(1); });
