const axios = require('axios');
const { execSync } = require('child_process');

const BASE = 'http://localhost:3000';
const COMPANY_ID = 'COMP-PRIME-ERP';
const TEST_DATE = '2026-07-15T10:00:00.000Z';

const authHeaders = {
  'Content-Type': 'application/json',
  'x-user-id': 'test-user-001',
  'x-user-role': 'Admin',
  'x-user-email': 'test@example.com',
  'x-company-id': COMPANY_ID
};

function supabaseGet(path) {
  return new Promise((resolve) => {
    const result = execSync(
      `node -e "const https=require('https');https.get('https://rdtuzuzehfbwvfdzqliw.supabase.co/rest/v1/${path}',{headers:{apikey: process.env.SUPABASE_SERVICE_KEY,Authorization:'Bearer ' + process.env.SUPABASE_SERVICE_KEY}},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))})"`,
      { encoding: 'utf8', cwd: __dirname }
    );
    try { resolve(JSON.parse(result)); } catch { resolve([]); }
  });
}

async function post(path, body) {
  const res = await axios.post(`${BASE}${path}`, body, { headers: authHeaders, timeout: 60000 });
  return res.data;
}

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: authHeaders, timeout: 30000 });
  return res.data;
}

async function main() {
  console.log('=== Phase 2.3 Comprehensive Runtime Tests ===\n');
  const accountsRes = await get(`/api/accounts?company_id=${COMPANY_ID}`);
  const accounts = Array.isArray(accountsRes) ? accountsRes : (accountsRes.data || []);
  const accountMap = {};
  accounts.forEach(a => { accountMap[a.account_number] = a; });

  // 1. Test 1: Standard Expense
  console.log('--- Test 1: Standard Expense ---');
  const exp1Id = 'exp-final-' + Date.now();
  await post('/api/expenses', {
    id: exp1Id, description: 'Test Expense 1', amount: 100, expense_date: TEST_DATE,
    category: 'Operations', payment_method: 'Cash',
    account_id: accountMap['51200']?.id, offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  const exp1Entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${exp1Id}&select=*`);
  console.log('  Ledger entries:', exp1Entries.length);
  exp1Entries.forEach(e => {
    const d = e.data || {};
    const acct = accounts.find(a => a.id === d.account_id);
    console.log(`    ${d.entry_type}: ${acct?.account_number} ${acct?.name} = ${d.amount}`);
  });

  // 2. Test 2: Standard Income (verify income bug fix)
  console.log('\n--- Test 2: Standard Income ---');
  const inc1Id = 'inc-final-' + Date.now();
  await post('/api/income', {
    id: inc1Id, description: 'Test Income 1', amount: 200, income_date: TEST_DATE,
    source: 'Service', account_id: accountMap['41100']?.id,
    offset_account_id: accountMap['11110']?.id, company_id: COMPANY_ID
  });
  const inc1Entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${inc1Id}&select=*`);
  console.log('  Ledger entries:', inc1Entries.length);
  inc1Entries.forEach(e => {
    const d = e.data || {};
    const acct = accounts.find(a => a.id === d.account_id);
    console.log(`    ${d.entry_type}: ${acct?.account_number} ${acct?.name} = ${d.amount}`);
  });
  const incomeUsesCanonical = inc1Entries.every(e => {
    const d = e.data || {};
    const acct = accounts.find(a => a.id === d.account_id);
    return acct && ['11110', '11120', '11210', '11220', '11230', '11300', '11310'].includes(acct.account_number);
  });
  console.log('  Income uses canonical Cash (not 1000):', incomeUsesCanonical ? 'YES' : 'NO');

  // 3. Test 3: Transfer (Cash Drawer -> National Bank)
  console.log('\n--- Test 3: Transfer (Cash Drawer -> National Bank) ---');
  const trf1Id = 'trf-final-' + Date.now();
  await post('/api/transfers', {
    id: trf1Id, from_account_id: accountMap['11110']?.id,
    to_account_id: accountMap['11210']?.id, amount: 30,
    transfer_date: TEST_DATE, description: 'Cash->Bank', company_id: COMPANY_ID
  });
  const trf1Entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${trf1Id}&select=*`);
  console.log('  Ledger entries:', trf1Entries.length);
  trf1Entries.forEach(e => {
    const d = e.data || {};
    const acct = accounts.find(a => a.id === d.account_id);
    console.log(`    ${d.entry_type}: ${acct?.account_number} ${acct?.name} = ${d.amount}`);
  });

  // 4. Test 4: Transfer (FDH Bank -> NBS Bank)
  console.log('\n--- Test 4: Transfer (FDH Bank -> NBS Bank) ---');
  const trf2Id = 'trf-final2-' + Date.now();
  await post('/api/transfers', {
    id: trf2Id, from_account_id: accountMap['11220']?.id,
    to_account_id: accountMap['11230']?.id, amount: 20,
    transfer_date: TEST_DATE, description: 'Bank->Bank', company_id: COMPANY_ID
  });
  const trf2Entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${trf2Id}&select=*`);
  console.log('  Ledger entries:', trf2Entries.length);
  trf2Entries.forEach(e => {
    const d = e.data || {};
    const acct = accounts.find(a => a.id === d.account_id);
    console.log(`    ${d.entry_type}: ${acct?.account_number} ${acct?.name} = ${d.amount}`);
  });

  // 5. Test 5: Manual Journal
  console.log('\n--- Test 5: Manual Journal ---');
  const jrn1Id = 'jrn-final-' + Date.now();
  const jrnResult = await post('/api/ledger', {
    id: jrn1Id, date: TEST_DATE, description: 'Test Journal',
    company_id: COMPANY_ID,
    lines: [
      { accountId: accountMap['52100']?.id, debit: 50, credit: 0 },
      { accountId: accountMap['11110']?.id, debit: 0, credit: 50 }
    ]
  });
  console.log('  Journal result:', jrnResult ? 'OK' : 'FAIL');

  // 6. Test 6: Purchase
  console.log('\n--- Test 6: Purchase ---');
  const pur1Id = 'pur-final-' + Date.now();
  const purResult = await post('/api/purchases', {
    id: pur1Id, supplier_id: 'SUP-FINAL-001', supplier_name: 'Final Test Supplier',
    date: TEST_DATE, total_amount: 150, company_id: COMPANY_ID
  });
  console.log('  Purchase result:', purResult ? 'OK' : 'FAIL');

  // 7. Test 7: Invalid account rejection
  console.log('\n--- Test 7: Invalid Account Rejection ---');
  try {
    await post('/api/expenses', {
      id: 'exp-invalid-' + Date.now(), description: 'Should fail',
      amount: 100, expense_date: TEST_DATE, category: 'Test',
      account_id: '00000000-0000-0000-0000-000000000000',
      offset_account_id: '00000000-0000-0000-0000-000000000001',
      company_id: COMPANY_ID
    });
    console.log('  RESULT: ACCEPTED (BAD!)');
  } catch (e) {
    console.log('  RESULT: REJECTED (' + e.response?.status + ') - ' + (e.response?.data?.error || e.message));
  }

  // 8. Trial Balance
  console.log('\n--- Trial Balance ---');
  const allEntries = await supabaseGet('ledger_entries?select=*&limit=1000');
  let totalDebit = 0, totalCredit = 0;
  allEntries.forEach(e => {
    const d = e.data || {};
    if (d.entry_type === 'debit') totalDebit += Number(d.amount) || 0;
    if (d.entry_type === 'credit') totalCredit += Number(d.amount) || 0;
  });
  console.log('  Total Debits:', totalDebit);
  console.log('  Total Credits:', totalCredit);
  console.log('  Balanced:', totalDebit === totalCredit ? 'YES' : 'NO');
}

main().catch(e => {
  console.error('Test failed:', e.message);
  if (e.response) console.error('Response:', e.response.status, JSON.stringify(e.response.data).substring(0, 200));
  process.exit(1);
});
