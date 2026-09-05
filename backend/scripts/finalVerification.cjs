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
  try {
    const res = await axios.post(`${BASE}${path}`, body, { headers: authHeaders, timeout: 60000 });
    return { ok: true, data: res.data, status: res.status };
  } catch (e) {
    return { ok: false, error: e.response?.data?.error || e.message, status: e.response?.status };
  }
}

async function get(path) {
  try {
    const res = await axios.get(`${BASE}${path}`, { headers: authHeaders, timeout: 30000 });
    return { ok: true, data: res.data, status: res.status };
  } catch (e) {
    return { ok: false, error: e.response?.data?.error || e.message, status: e.response?.status };
  }
}

const results = {};

async function main() {
  console.log('=== Phase 2.3 Final Verification Pass ===\n');

  // 1. Get accounts
  const accountsRes = await get(`/api/accounts?company_id=${COMPANY_ID}`);
  const accounts = accountsRes.ok ? (Array.isArray(accountsRes.data) ? accountsRes.data : (accountsRes.data.data || [])) : [];
  const accountMap = {};
  accounts.forEach(a => { accountMap[a.account_number] = a; });

  // 2. Income test (verify canonical Cash, not legacy 1000)
  console.log('--- Income Test ---');
  const incId = 'inc-final-' + Date.now();
  const incRes = await post('/api/income', {
    id: incId, source: 'Service', amount: 100, income_date: TEST_DATE,
    account_id: accountMap['41100']?.id, offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  await new Promise(r => setTimeout(r, 2000));
  const incEntries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${incId}&select=*`);
  const incDebit = incEntries.find(e => e.data?.entry_type === 'debit');
  const incCredit = incEntries.find(e => e.data?.entry_type === 'credit');
  const incDebitAcct = accounts.find(a => a.id === incDebit?.data?.account_id);
  const incCreditAcct = accounts.find(a => a.id === incCredit?.data?.account_id);
  results.income = {
    debit: incDebitAcct ? `${incDebitAcct.account_number} ${incDebitAcct.name}` : 'NOT FOUND',
     debitIs1000: incDebitAcct?.account_number === '11110',
     credit: incCreditAcct ? `${incCreditAcct.account_number} ${incCreditAcct.name}` : 'NOT FOUND',
     creditIs41100: incCreditAcct?.account_number === '41100',
     pass: incDebitAcct?.account_number === '11110' && incCreditAcct?.account_number === '41100'
  };
  console.log('  Debit:', results.income.debit, '(should be 11110 Cash Drawer)');
  console.log('  Credit:', results.income.credit, '(should be 41100 Product Sales)');
  console.log('  Result:', results.income.pass ? 'PASS' : 'FAIL');

  // 3. Expense test
  console.log('\n--- Expense Test ---');
  const expId = 'exp-final-' + Date.now();
  await post('/api/expenses', {
    id: expId, description: 'Final Expense', amount: 200, expense_date: TEST_DATE,
    category: 'Operations', payment_method: 'Cash',
    account_id: accountMap['51200']?.id, offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  await new Promise(r => setTimeout(r, 2000));
  const expEntries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${expId}&select=*`);
  const expDebit = expEntries.find(e => e.data?.entry_type === 'debit');
  const expCredit = expEntries.find(e => e.data?.entry_type === 'credit');
  const expDebitAcct = accounts.find(a => a.id === expDebit?.data?.account_id);
  const expCreditAcct = accounts.find(a => a.id === expCredit?.data?.account_id);
  results.expense = {
    debit: expDebitAcct ? `${expDebitAcct.account_number} ${expDebitAcct.name}` : 'NOT FOUND',
    credit: expCreditAcct ? `${expCreditAcct.account_number} ${expCreditAcct.name}` : 'NOT FOUND',
    pass: expDebitAcct?.account_number === '51200' && expCreditAcct?.account_number === '11110'
  };
  console.log('  Debit:', results.expense.debit, '(should be 51200 COGS)');
  console.log('  Credit:', results.expense.credit, '(should be 11110 Cash Drawer)');
  console.log('  Result:', results.expense.pass ? 'PASS' : 'FAIL');

  // 4. Transfer test
  console.log('\n--- Transfer Test ---');
  const trfId = 'trf-final-' + Date.now();
  await post('/api/transfers', {
    id: trfId, from_account_id: accountMap['11110']?.id,
    to_account_id: accountMap['11210']?.id, amount: 50,
    transfer_date: TEST_DATE, description: 'Final Transfer', company_id: COMPANY_ID
  });
  await new Promise(r => setTimeout(r, 2000));
  const trfEntries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${trfId}&select=*`);
  const trfDebit = trfEntries.find(e => e.data?.entry_type === 'debit');
  const trfCredit = trfEntries.find(e => e.data?.entry_type === 'credit');
  const trfDebitAcct = accounts.find(a => a.id === trfDebit?.data?.account_id);
  const trfCreditAcct = accounts.find(a => a.id === trfCredit?.data?.account_id);
  results.transfer = {
    debit: trfDebitAcct ? `${trfDebitAcct.account_number} ${trfDebitAcct.name}` : 'NOT FOUND',
    credit: trfCreditAcct ? `${trfCreditAcct.account_number} ${trfCreditAcct.name}` : 'NOT FOUND',
    pass: trfDebitAcct?.account_number === '11210' && trfCreditAcct?.account_number === '11110'
  };
  console.log('  Debit:', results.transfer.debit, '(should be 11210 National Bank)');
  console.log('  Credit:', results.transfer.credit, '(should be 11110 Cash Drawer)');
  console.log('  Result:', results.transfer.pass ? 'PASS' : 'FAIL');

  // 5. Manual Journal test
  console.log('\n--- Manual Journal Test ---');
  const jrnId = 'jrn-final-' + Date.now();
  const jrnRes = await post('/api/ledger', {
    id: jrnId, date: TEST_DATE, description: 'Final Journal',
    company_id: COMPANY_ID,
    lines: [
      { accountId: accountMap['52100']?.id, debit: 75, credit: 0 },
      { accountId: accountMap['11110']?.id, debit: 0, credit: 75 }
    ]
  });
  results.journal = { ok: jrnRes.ok, error: jrnRes.error };
  console.log('  Result:', jrnRes.ok ? 'PASS' : `FAIL: ${jrnRes.error}`);

  // 6. Negative tests
  console.log('\n--- Negative Tests ---');
  const neg1 = await post('/api/expenses', {
    id: 'exp-neg1-' + Date.now(), description: 'Nonexistent account',
    amount: 100, expense_date: TEST_DATE, category: 'Test',
    account_id: '00000000-0000-0000-0000-000000000000',
    offset_account_id: accountMap['11110']?.id, company_id: COMPANY_ID
  });
  results.neg1_nonexistent = { rejected: !neg1.ok, error: neg1.error };
  console.log('  Nonexistent account:', neg1.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED (${neg1.error})`);

  const neg2 = await post('/api/expenses', {
    id: 'exp-neg2-' + Date.now(), description: 'Malformed',
    amount: 100, expense_date: TEST_DATE, category: 'Test',
    account_id: 'not-a-uuid', offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  results.neg2_malformed = { rejected: !neg2.ok, error: neg2.error };
  console.log('  Malformed account:', neg2.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED (${neg2.error})`);

  // Try to post expense with legacy 1000 account (old Cash)
  const oldCash = await supabaseGet('chart_of_accounts?data->>account_number=eq.1000&select=*&limit=1');
  const oldCashId = oldCash[0]?.id;
  if (oldCashId) {
    const neg3 = await post('/api/expenses', {
      id: 'exp-neg3-' + Date.now(), description: 'Legacy Cash test',
      amount: 100, expense_date: TEST_DATE, category: 'Test',
      account_id: accountMap['51200']?.id, offset_account_id: oldCashId,
      company_id: COMPANY_ID
    });
    results.neg3_legacy = { ok: neg3.ok, rejected: !neg3.ok };
    console.log('  Legacy 1000 in transaction:', neg3.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED (${neg3.error})`);
  }

  // 7. COA verification
  console.log('\n--- COA Verification ---');
  results.coa = {
    expected: 65,
    actual: accounts.length,
    correct: accounts.length === 65
  };
  const keyAccounts = {
    '11110': 'Cash Drawer', '11120': 'Petty Cash', '11210': 'National Bank',
    '11220': 'FDH Bank', '11230': 'NBS Bank', '11310': 'Trade Debtors',
    '12100': 'Motor Vehicles', '12500': 'Accumulated Depreciation',
    '21110': 'Trade Creditors', '21210': 'VAT Payable', '21220': 'PAYE Payable',
    '31000': "Owner's Capital", '32000': 'Retained Earnings', '33000': 'Current Year Earnings',
    '34000': 'Drawings', '41100': 'Product Sales', '51200': 'Cost of Goods Sold',
    '52100': 'Salaries & Wages'
  };
  results.coa.keyAccounts = {};
  for (const [num, name] of Object.entries(keyAccounts)) {
    const a = accountMap[num];
    results.coa.keyAccounts[num] = {
      exists: !!a,
      name: a?.name,
      matches: a?.name === name,
      normalBalance: a?.normal_balance
    };
  }
  // Check special cases
  results.coa.accumulatedDepreciation = accountMap['12500']?.normal_balance === 'CREDIT';
  results.coa.drawings = accountMap['34000']?.normal_balance === 'DEBIT';
  results.coa.cashDrawerExists = accountMap['11110']?.name === 'Cash Drawer';
  results.coa.nationalBankExists = accountMap['11210']?.name === 'National Bank';
  results.coa.fdhBankExists = accountMap['11220']?.name === 'FDH Bank';
  results.coa.nbsBankExists = accountMap['11230']?.name === 'NBS Bank';
  results.coa.productSalesExists = accountMap['41100']?.name === 'Product Sales';
  results.coa.cogsExists = accountMap['51200']?.name === 'Cost of Goods Sold';
  console.log('  65/65 accounts:', results.coa.correct ? 'PASS' : `FAIL (${accounts.length})`);
  console.log('  Accumulated Depreciation CREDIT:', results.coa.accumulatedDepreciation ? 'PASS' : 'FAIL');
  console.log('  Drawings DEBIT:', results.coa.drawings ? 'PASS' : 'FAIL');

  // 8. Trial Balance for test transactions only
  console.log('\n--- Trial Balance (test transactions only) ---');
  const testIds = [incId, expId, trfId];
  let totalDebit = 0, totalCredit = 0;
  for (const refId of testIds) {
    const entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${refId}&select=*`);
    entries.forEach(e => {
      const d = e.data || {};
      if (d.entry_type === 'debit') totalDebit += Number(d.amount) || 0;
      if (d.entry_type === 'credit') totalCredit += Number(d.amount) || 0;
    });
  }
  results.trialBalance = {
    testDebit: totalDebit,
    testCredit: totalCredit,
    balanced: totalDebit === totalCredit
  };
  console.log('  Test Debits:', totalDebit);
  console.log('  Test Credits:', totalCredit);
  console.log('  Balanced:', results.trialBalance.balanced ? 'PASS' : 'FAIL');

  // Summary
  console.log('\n=== RESULTS SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
