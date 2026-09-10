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
  // Get all accounts with all fields to check for balance
  const accounts = await query('accounts', '*');
  console.log('=== ACCOUNTS TABLE COLUMNS (first entry) ===');
  if (accounts.length > 0) {
    console.log(Object.keys(accounts[0]));
  }
  
  // Check inventory accounts for any balance
  const invAccs = accounts.filter(a => {
    const d = a.data || a;
    return d.code && ['11400','11410','11420','11430'].includes(d.code);
  });
  console.log('\n=== INVENTORY ACCOUNTS WITH ALL FIELDS ===');
  for (const a of invAccs) {
    const d = a.data || a;
    console.log(`${d.code} ${d.name}: balance=${d.balance}, opening_balance=${d.opening_balance}, account_number=${d.account_number}`);
  }

  // Check if there's a "balance" or "current_balance" field
  const accWithBalance = accounts.find(a => (a.data || a).code === '11410');
  if (accWithBalance) {
    const d = accWithBalance.data || accWithBalance;
    console.log('\nAll fields for ACC-11410:', Object.keys(d));
  }

  // Check if there's a separate balance table
  const balanceTables = ['balances', 'account_balances', 'trial_balance', 'balance_sheet'];
  for (const t of balanceTables) {
    const r = await query(t, '*');
    if (r.length > 0) {
      console.log(`\n=== ${t} EXISTS ===`);
      console.log('Count:', r.length);
      console.log(JSON.stringify(r.slice(0, 3), null, 2));
    }
  }

  // Check if there's any data in the "products" table that references ledger entries
  const products = await query('products', '*');
  const productsWithLedgerRef = products.filter(p => {
    const d = p.data || p;
    return d.ledger_id || d.journal_id || d.account_id || d.entry_id;
  });
  console.log('\nProducts with ledger references:', productsWithLedgerRef.length);

  // Check if there's a "transactions" or "accounting" table
  const transTables = ['transactions', 'accounting_transactions', 'gl_transactions'];
  for (const t of transTables) {
    const r = await query(t, '*');
    if (r.length > 0) {
      console.log(`\n=== ${t} EXISTS ===`);
      console.log('Count:', r.length);
    }
  }

  // Check the "accounts" table for any non-zero opening balances
  const nonZeroBalance = accounts.filter(a => {
    const d = a.data || a;
    return d.opening_balance && d.opening_balance !== 0;
  });
  console.log('\nAccounts with non-zero opening balance:', nonZeroBalance.length);
  if (nonZeroBalance.length > 0) {
    console.log(JSON.stringify(nonZeroBalance.slice(0, 5).map(a => ({ code: a.data?.code, name: a.data?.name, opening_balance: a.data?.opening_balance })), null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
