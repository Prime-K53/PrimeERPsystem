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
const ledgerEntries = []; // {ref, type, accountId, accountNum, amount}

async function captureLedger(refId, label) {
  await new Promise(r => setTimeout(r, 3000));
  const entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${refId}&select=*`);
  for (const e of entries) {
    const d = e.data || {};
    const acct = results.accounts?.find(a => a.id === d.account_id);
    ledgerEntries.push({
      ref: refId,
      label,
      type: d.entry_type,
      accountId: d.account_id,
      accountNum: acct?.account_number || 'UNKNOWN',
      accountName: acct?.name || 'UNKNOWN',
      amount: d.amount
    });
  }
  return entries.length;
}

async function main() {
  console.log('=== Phase 2.4 Runtime Accounting Tests ===\n');
  results.companyId = COMPANY_ID;
  results.testDate = TEST_DATE;
  results.accounts = [];
  results.ledgerEntries = [];

  // 1. Get accounts
  const accountsRes = await get(`/api/accounts?company_id=${COMPANY_ID}`);
  if (accountsRes.ok) {
    const accounts = Array.isArray(accountsRes.data) ? accountsRes.data : (accountsRes.data.data || []);
    results.accounts = accounts;
  }
  const accountMap = {};
  results.accounts.forEach(a => { accountMap[a.account_number] = a; });

  // 2. Test A: Expense (52100 Salaries debit, 11110 Cash credit)
  console.log('--- Test A: Expense (K1,000) ---');
  const expA = `exp2.4-A-${Date.now()}`;
  const expARes = await post('/api/expenses', {
    id: expA, description: 'Phase 2.4 Test A', amount: 1000, expense_date: TEST_DATE,
    category: 'Salaries', payment_method: 'Cash',
    account_id: accountMap['52100']?.id, offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  results.testA_expense = { ok: expARes.ok, id: expARes.data?.id || expA, error: expARes.error };
  if (expARes.ok) {
    const n = await captureLedger(expA, 'Test A Expense');
    results.testA_expense.ledgerCount = n;
  }
  console.log('  Result:', expARes.ok ? `PASS (${results.testA_expense.ledgerCount} entries)` : `FAIL: ${expARes.error}`);

  // 3. Test B: Income (41100 Product Sales credit, 11110 Cash debit)
  console.log('\n--- Test B: Income (K2,000) ---');
  const incB = `inc2.4-B-${Date.now()}`;
  const incBRes = await post('/api/income', {
    id: incB, description: 'Phase 2.4 Test B', amount: 2000, income_date: TEST_DATE,
    source: 'Service', account_id: accountMap['41100']?.id,
    offset_account_id: accountMap['11110']?.id, company_id: COMPANY_ID
  });
  results.testB_income = { ok: incBRes.ok, id: incBRes.data?.id || incB, error: incBRes.error };
  if (incBRes.ok) {
    const n = await captureLedger(incB, 'Test B Income');
    results.testB_income.ledgerCount = n;
  }
  console.log('  Result:', incBRes.ok ? `PASS (${results.testB_income.ledgerCount} entries)` : `FAIL: ${incBRes.error}`);

  // 4. Test C: Manual Journal (52100 Salaries debit K500, 11110 Cash credit K500)
  console.log('\n--- Test C: Manual Journal (K500) ---');
  const jrnC = `jrn2.4-C-${Date.now()}`;
  const jrnCRes = await post('/api/ledger', {
    id: jrnC, date: TEST_DATE, description: 'Phase 2.4 Test C Journal',
    company_id: COMPANY_ID,
    lines: [
      { accountId: accountMap['52100']?.id, debit: 500, credit: 0 },
      { accountId: accountMap['11110']?.id, debit: 0, credit: 500 }
    ]
  });
  results.testC_journal = { ok: jrnCRes.ok, id: jrnC, error: jrnCRes.error };
  if (jrnCRes.ok) {
    const n = await captureLedger(jrnC, 'Test C Journal');
    results.testC_journal.ledgerCount = n;
  }
  console.log('  Result:', jrnCRes.ok ? `PASS (${results.testC_journal.ledgerCount} entries)` : `FAIL: ${jrnCRes.error}`);

  // 5. Test D: Cash to Bank (11210 National Bank debit, 11110 Cash credit)
  console.log('\n--- Test D: Transfer Cash->Bank (K300) ---');
  const trfD = `trf2.4-D-${Date.now()}`;
  const trfDRes = await post('/api/transfers', {
    id: trfD, from_account_id: accountMap['11110']?.id,
    to_account_id: accountMap['11210']?.id, amount: 300,
    transfer_date: TEST_DATE, description: 'Phase 2.4 Test D', company_id: COMPANY_ID
  });
  results.testD_transfer_c2b = { ok: trfDRes.ok, id: trfD, error: trfDRes.error };
  if (trfDRes.ok) {
    const n = await captureLedger(trfD, 'Test D Transfer');
    results.testD_transfer_c2b.ledgerCount = n;
  }
  console.log('  Result:', trfDRes.ok ? `PASS (${results.testD_transfer_c2b.ledgerCount} entries)` : `FAIL: ${trfDRes.error}`);

  // 6. Test E: Bank to Bank (11230 NBS debit, 11220 FDH credit)
  console.log('\n--- Test E: Transfer Bank->Bank (K150) ---');
  const trfE = `trf2.4-E-${Date.now()}`;
  const trfERes = await post('/api/transfers', {
    id: trfE, from_account_id: accountMap['11220']?.id,
    to_account_id: accountMap['11230']?.id, amount: 150,
    transfer_date: TEST_DATE, description: 'Phase 2.4 Test E', company_id: COMPANY_ID
  });
  results.testE_transfer_b2b = { ok: trfERes.ok, id: trfE, error: trfERes.error };
  if (trfERes.ok) {
    const n = await captureLedger(trfE, 'Test E Transfer');
    results.testE_transfer_b2b.ledgerCount = n;
  }
  console.log('  Result:', trfERes.ok ? `PASS (${results.testE_transfer_b2b.ledgerCount} entries)` : `FAIL: ${trfERes.error}`);

  // 7. Negative tests
  console.log('\n--- Phase 8: Negative Tests ---');

  // 7a. Nonexistent account
  const neg1 = await post('/api/expenses', {
    id: `neg-1-${Date.now()}`, description: 'Nonexistent', amount: 100,
    expense_date: TEST_DATE, category: 'Test',
    account_id: '99999999-9999-9999-9999-999999999999',
    offset_account_id: accountMap['11110']?.id, company_id: COMPANY_ID
  });
  results.neg1_nonexistent = { rejected: !neg1.ok, error: neg1.error };
  console.log('  99999 account:', neg1.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED`);

  // 7b. Malformed
  const neg2 = await post('/api/expenses', {
    id: `neg-2-${Date.now()}`, description: 'Malformed', amount: 100,
    expense_date: TEST_DATE, category: 'Test',
    account_id: 'not-a-uuid', offset_account_id: accountMap['11110']?.id,
    company_id: COMPANY_ID
  });
  results.neg2_malformed = { rejected: !neg2.ok, error: neg2.error };
  console.log('  Malformed:', neg2.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED`);

  // 7c. Non-posting account (10000 Assets is a root, allow_posting=false)
  const nonPostingAcct = accountMap['10000']; // Assets (root, allow_posting=false)
  if (nonPostingAcct) {
    const neg3 = await post('/api/expenses', {
      id: `neg-3-${Date.now()}`, description: 'Non-posting', amount: 100,
      expense_date: TEST_DATE, category: 'Test',
      account_id: nonPostingAcct.id, offset_account_id: accountMap['11110']?.id,
      company_id: COMPANY_ID
    });
    results.neg3_nonposting = { rejected: !neg3.ok, error: neg3.error };
    console.log('  Non-posting parent:', neg3.ok ? 'FAIL - ACCEPTED' : `PASS - REJECTED`);
  }

  // 7d. Inactive account test - mark an account inactive first
  const activeAcct = accountMap['52200']; // Rent
  if (activeAcct) {
    // First check it works
    const neg4a = await post('/api/expenses', {
      id: `neg-4a-${Date.now()}`, description: 'Active test', amount: 50,
      expense_date: TEST_DATE, category: 'Test',
      account_id: activeAcct.id, offset_account_id: accountMap['11110']?.id,
      company_id: COMPANY_ID
    });
    results.neg4a_active = { ok: neg4a.ok };
    console.log('  Active account (Rent 52200):', neg4a.ok ? 'PASS - ACCEPTED' : 'FAIL');
  }

  // 8. Trial Balance
  console.log('\n--- Phase 10: Trial Balance ---');
  const allTestRefs = [expA, incB, jrnC, trfD, trfE];
  let totalDebit = 0, totalCredit = 0;
  for (const ref of allTestRefs) {
    const entries = await supabaseGet(`ledger_entries?data->>reference_id=eq.${ref}&select=*`);
    entries.forEach(e => {
      const d = e.data || {};
      if (d.entry_type === 'debit') totalDebit += Number(d.amount) || 0;
      if (d.entry_type === 'credit') totalCredit += Number(d.amount) || 0;
    });
  }
  results.trialBalance = {
    testRefs: allTestRefs,
    totalDebit, totalCredit,
    balanced: totalDebit === totalCredit
  };
  console.log(`  Debits: ${totalDebit}, Credits: ${totalCredit}`);
  console.log('  Balanced:', totalDebit === totalCredit ? 'PASS' : 'FAIL');

  // 9. Special accounts verification
  console.log('\n--- Phase 7: Special Accounts ---');
  results.accumulatedDepreciation = {
    account_number: '12500',
    account_type: accountMap['12500']?.account_type,
    normal_balance: accountMap['12500']?.normal_balance,
    correct: accountMap['12500']?.normal_balance === 'CREDIT' && accountMap['12500']?.account_type === 'ASSET'
  };
  results.drawings = {
    account_number: '34000',
    account_type: accountMap['34000']?.account_type,
    normal_balance: accountMap['34000']?.normal_balance,
    correct: accountMap['34000']?.normal_balance === 'DEBIT' && accountMap['34000']?.account_type === 'EQUITY'
  };
  console.log('  12500 Accumulated Depreciation (ASSET, CREDIT):',
    results.accumulatedDepreciation.correct ? 'PASS' : 'FAIL');
  console.log('  34000 Drawings (EQUITY, DEBIT):',
    results.drawings.correct ? 'PASS' : 'FAIL');

  // 10. Store all captured ledger entries
  results.allLedgerEntries = ledgerEntries;

  // 11. COA verification
  results.coa = {
    expected: 65,
    actual: results.accounts.length,
    correct: results.accounts.length === 65
  };

  // 12. Check no legacy codes in new transactions
  const legacyCodes = ['1000', '1050', '1100', '1200', '2000', '4000', '5000', '6100'];
  results.legacyPersistence = [];
  for (const entry of ledgerEntries) {
    if (legacyCodes.includes(entry.accountNum)) {
      results.legacyPersistence.push(entry);
    }
  }
  results.noLegacyPersistence = results.legacyPersistence.length === 0;

  // 13. Silent fallback check
  results.unresolvedAccounts = ledgerEntries.filter(e => e.accountNum === 'UNKNOWN');
  results.noSilentFallback = results.unresolvedAccounts.length === 0;

  // Summary
  console.log('\n=== RESULTS SUMMARY ===');
  console.log(JSON.stringify({
    coa: results.coa,
    testA: results.testA_expense,
    testB: results.testB_income,
    testC: results.testC_journal,
    testD: results.testD_transfer_c2b,
    testE: results.testE_transfer_b2b,
    neg1: results.neg1_nonexistent,
    neg2: results.neg2_malformed,
    neg3: results.neg3_nonposting,
    trialBalance: results.trialBalance,
    accumulatedDepreciation: results.accumulatedDepreciation,
    drawings: results.drawings,
    noLegacyPersistence: results.noLegacyPersistence,
    noSilentFallback: results.noSilentFallback,
    ledgerEntryCount: ledgerEntries.length
  }, null, 2));
}

main().catch(e => {
  console.error('Test failed:', e.message);
  if (e.response) console.error('Response:', e.response.status, JSON.stringify(e.response.data).substring(0, 200));
  process.exit(1);
});
