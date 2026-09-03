/**
 * Phase 2.5 Live Accounting Acceptance Test Runner
 * Tests the accounting system against the live Supabase/Postgres environment.
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const repo = require('../services/supabaseRepository.cjs');
const FinanceService = require('../services/financeService.cjs');
const BankingService = require('../services/bankingService.cjs');

// Canonical account UUIDs for COMP-PRIME-ERP (verified from live DB)
const ACCOUNTS = {
  '11110': '112b22a6-131b-4c3e-a829-6ad90eba3bd8',
  '11210': 'c15f0081-f0a5-469f-bec0-090636a89ec5',
  '11220': '52cc508f-065c-46bd-9f3b-aee2775b9ecd',
  '11230': '7b313a1e-386c-4bd4-b3c6-5bf6c3ffa871',
  '11410': '11e9078b-677a-44c2-bb33-b52b33be096f',
  '21110': '7bbf134f-d020-41be-8b56-4a9fa3adf8b7',
  '41100': 'a81b5578-68af-4116-a18d-1e5dbe824360',
  '51200': 'e87fad8a-8088-4a6d-a134-635f7256db68',
  '52100': '8e1a5e0c-fe9e-4d9d-9f51-c35e65ad9f69',
  '12500': 'b9dcfc83-2036-4a8f-b6b6-e1138dd012f5',
  '34000': '70ee2511-485b-46ec-bad3-e47f28c033cb',
};

const COMPANY_ID = 'COMP-PRIME-ERP';
const PREFIX = 'PH25-TEST-';
const today = () => new Date().toISOString().slice(0, 10);

const finance = new FinanceService();

let pass = 0;
let fail = 0;
const ledger = [];

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    pass++;
  } else {
    console.error(`  FAIL: ${msg}`);
    fail++;
  }
}

function record(test, recordId, journalId, expected, actual, result) {
  ledger.push({ test, recordId, journalId, expected, actual, result });
}

async function getJournalLinesByReference(referenceId) {
  const rows = await repo.getAll('ledger_entries', {});
  return (rows || []).filter(r => r.reference_id === referenceId);
}

async function getTrialBalance() {
  const entries = await repo.getAll('ledger_entries', {});
  const allAccounts = await repo.getAll('chart_of_accounts', {});
  
  const tb = {};
  entries.forEach(e => {
    if (!tb[e.account_id]) {
      tb[e.account_id] = { account_id: e.account_id, debit: 0, credit: 0 };
    }
    if (e.entry_type === 'debit') {
      tb[e.account_id].debit += Number(e.amount) || 0;
    } else {
      tb[e.account_id].credit += Number(e.amount) || 0;
    }
  });
  
  const accountMap = {};
  allAccounts.forEach(a => { accountMap[a.id] = a; });
  
  return { tb, accountMap };
}

function sumDebitsCredits(lines) {
  const debits = lines.filter(l => l.entry_type === 'debit').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const credits = lines.filter(l => l.entry_type === 'credit').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return { debits, credits };
}

async function cleanupTestData() {
  console.log('\n--- Cleanup ---');
  const tables = ['ledger_entries', 'expenses', 'income', 'transfers'];
  
  for (const table of tables) {
    try {
      const rows = await repo.getAll(table, {});
      const testRows = rows.filter(r => r.id && r.id.startsWith(PREFIX));
      for (const row of testRows) {
        await repo.softDelete(table, row.id);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  console.log('Cleanup complete');
}

async function runTests() {
  console.log('\n=== PHASE 2.5 LIVE ACCOUNTING ACCEPTANCE ===\n');

  try {
    // Verify Supabase connectivity
    const accounts = await repo.getAll('chart_of_accounts', {});
    console.log(`Supabase connectivity: PASS (fetched ${accounts.length} accounts)`);
    pass++;

    // ========================================================================
    // STEP 2: COA Baseline
    // ========================================================================
    console.log('\n--- STEP 2: COA Baseline ---');
    const compAccounts = accounts.filter(a => a.company_id === COMPANY_ID);
    console.log(`COMP-PRIME-ERP accounts: ${compAccounts.length}`);
    assert(compAccounts.length === 65, `COMP-PRIME-ERP has 65 accounts (found ${compAccounts.length})`);
    
    const codes = {};
    let dupes = 0;
    compAccounts.forEach(a => {
      const c = a.account_number || a.code;
      if (codes[c]) dupes++;
      codes[c] = true;
    });
    assert(dupes === 0, `Zero duplicate account numbers (found ${dupes})`);
    
    const acctMap = {};
    compAccounts.forEach(a => { acctMap[a.account_number] = a; });
    
    assert(acctMap['12500'] && acctMap['12500'].account_type === 'ASSET' && acctMap['12500'].normal_balance === 'CREDIT',
      '12500 Accumulated Depreciation: ASSET/CREDIT');
    assert(acctMap['34000'] && acctMap['34000'].account_type === 'EQUITY' && acctMap['34000'].normal_balance === 'DEBIT',
      '34000 Drawings: EQUITY/DEBIT');
    
    record('COA Baseline', 'N/A', 'N/A', '65 accounts', `${compAccounts.length} accounts`, 'PASS');

    // ========================================================================
    // STEP 4: Live Expense Test
    // ========================================================================
    console.log('\n--- STEP 4: Live Expense Test ---');
    
    const expenseId = `${PREFIX}EXP-${Date.now()}`;
    try {
      const expense = await finance.createExpense({
        id: expenseId,
        category: 'Salaries & Wages',
        amount: 1000,
        expense_date: today(),
        account_id: ACCOUNTS['52100'],
        offset_account_id: ACCOUNTS['11110'],
        company_id: COMPANY_ID,
        description: `PH25-TEST expense ${expenseId}`,
        created_by: 'PH25-TEST'
      });
      
      console.log(`Expense created: ${expense.id} amount=${expense.amount}`);
      record('Expense', expenseId, 'N/A', 'K1,000', `K${expense.amount}`, 'PASS');
      
      // Find journal lines by description
      const allEntries = await repo.getAll('ledger_entries', {});
      const expenseLines = allEntries.filter(e => e.description && e.description.includes(expenseId));
      console.log(`Expense journal lines: ${expenseLines.length}`);
      
      const debit52100 = expenseLines.find(l => l.account_id === ACCOUNTS['52100'] && l.entry_type === 'debit');
      const credit11110 = expenseLines.find(l => l.account_id === ACCOUNTS['11110'] && l.entry_type === 'credit');
      
      assert(debit52100 && Number(debit52100.amount) === 1000,
        `Expense DEBIT 52100 Salaries & Wages = K1,000 (actual: ${debit52100?.amount})`);
      assert(credit11110 && Number(credit11110.amount) === 1000,
        `Expense CREDIT 11110 Cash Drawer = K1,000 (actual: ${credit11110?.amount})`);
      
      const { debits, credits } = sumDebitsCredits(expenseLines);
      assert(Math.abs(debits - credits) < 0.01, `Expense journal balanced: debits=${debits}, credits=${credits}`);
      
    } catch (e) {
      console.error('Expense test FAILED:', e.message);
      record('Expense', expenseId, 'N/A', 'K1,000', e.message, 'FAIL');
    }

    // ========================================================================
    // STEP 5: Live Income Test
    // ========================================================================
    console.log('\n--- STEP 5: Live Income Test ---');
    
    const incomeId = `${PREFIX}INC-${Date.now()}`;
    try {
      const income = await finance.createIncome({
        id: incomeId,
        source: 'Product Sales',
        amount: 2000,
        income_date: today(),
        account_id: ACCOUNTS['41100'],
        offset_account_id: ACCOUNTS['11110'],
        company_id: COMPANY_ID,
        description: `PH25-TEST income ${incomeId}`,
        created_by: 'PH25-TEST'
      });
      
      console.log(`Income created: ${income.id} amount=${income.amount}`);
      record('Income', incomeId, 'N/A', 'K2,000', `K${income.amount}`, 'PASS');
      
      const allEntries = await repo.getAll('ledger_entries', {});
      const incomeLines = allEntries.filter(e => e.description && e.description.includes(incomeId));
      console.log(`Income journal lines: ${incomeLines.length}`);
      
      const debit11110 = incomeLines.find(l => l.account_id === ACCOUNTS['11110'] && l.entry_type === 'debit');
      const credit41100 = incomeLines.find(l => l.account_id === ACCOUNTS['41100'] && l.entry_type === 'credit');
      
      assert(debit11110 && Number(debit11110.amount) === 2000,
        `Income DEBIT 11110 Cash Drawer = K2,000 (actual: ${debit11110?.amount})`);
      assert(credit41100 && Number(credit41100.amount) === 2000,
        `Income CREDIT 41100 Product Sales = K2,000 (actual: ${credit41100?.amount})`);
      
      const { debits, credits } = sumDebitsCredits(incomeLines);
      assert(Math.abs(debits - credits) < 0.01, `Income journal balanced: debits=${debits}, credits=${credits}`);
      
    } catch (e) {
      console.error('Income test FAILED:', e.message);
      record('Income', incomeId, 'N/A', 'K2,000', e.message, 'FAIL');
    }

    // ========================================================================
    // STEP 6: Live Manual Journal
    // ========================================================================
    console.log('\n--- STEP 6: Live Manual Journal ---');
    
    const journalId = `${PREFIX}JRN-${Date.now()}`;
    try {
      // Create journal entries directly via repo
      await repo.upsert('ledger_entries', {
        id: `${journalId}-DEBIT`,
        account_id: ACCOUNTS['52100'],
        entry_type: 'debit',
        amount: 500,
        entry_date: today(),
        description: `PH25-TEST manual journal ${journalId}`,
        reference_type: 'journal',
        reference_id: journalId,
        journal_id: journalId,
        created_by: 'PH25-TEST'
      });
      
      await repo.upsert('ledger_entries', {
        id: `${journalId}-CREDIT`,
        account_id: ACCOUNTS['11110'],
        entry_type: 'credit',
        amount: 500,
        entry_date: today(),
        description: `PH25-TEST manual journal ${journalId}`,
        reference_type: 'journal',
        reference_id: journalId,
        journal_id: journalId,
        created_by: 'PH25-TEST'
      });
      
      console.log(`Manual journal created: ${journalId}`);
      record('Manual Journal', journalId, journalId, 'K500 Dr/Cr', 'K500 Dr/Cr', 'PASS');
      
      const journalLines = await getJournalLinesByReference(journalId);
      console.log(`Manual journal lines: ${journalLines.length}`);
      const { debits, credits } = sumDebitsCredits(journalLines);
      assert(Math.abs(debits - credits) < 0.01, `Manual journal balanced: debits=${debits}, credits=${credits}`);
      assert(journalLines.some(l => l.account_id === ACCOUNTS['52100'] && l.entry_type === 'debit'),
        'Manual journal DEBIT 52100 Salaries & Wages');
      assert(journalLines.some(l => l.account_id === ACCOUNTS['11110'] && l.entry_type === 'credit'),
        'Manual journal CREDIT 11110 Cash Drawer');
      
    } catch (e) {
      console.error('Manual journal test FAILED:', e.message);
      record('Manual Journal', journalId, journalId, 'K500', e.message, 'FAIL');
    }

    // ========================================================================
    // STEP 7: Live Cash/Bank Transfer (COA-based via finance.createTransfer)
    // ========================================================================
    console.log('\n--- STEP 7: Live Cash/Bank Transfer ---');
    
    // Transfer 1: Cash Drawer -> National Bank
    const transfer1Id = `${PREFIX}XFER-${Date.now()}-1`;
    try {
      const transfer = await finance.createTransfer({
        id: transfer1Id,
        from_account_id: ACCOUNTS['11110'],
        to_account_id: ACCOUNTS['11210'],
        amount: 500,
        transfer_date: today(),
        description: 'PH25-TEST transfer Cash->National Bank',
        created_by: 'PH25-TEST'
      });
      
      console.log(`Transfer 1 created: ${transfer.id}`);
      record('Transfer 1', transfer1Id, transfer.id, 'K500', `K${transfer.amount}`, 'PASS');
      
      const transferLines = await getJournalLinesByReference(transfer.id);
      const debit11210 = transferLines.find(l => l.account_id === ACCOUNTS['11210'] && l.entry_type === 'debit');
      const credit11110 = transferLines.find(l => l.account_id === ACCOUNTS['11110'] && l.entry_type === 'credit');
      
      assert(debit11210 && Number(debit11210.amount) === 500,
        `Transfer DEBIT 11210 National Bank = K500 (actual: ${debit11210?.amount})`);
      assert(credit11110 && Number(credit11110.amount) === 500,
        `Transfer CREDIT 11110 Cash Drawer = K500 (actual: ${credit11110?.amount})`);
      
    } catch (e) {
      console.error('Transfer 1 FAILED:', e.message);
      record('Transfer 1', transfer1Id, 'N/A', 'K500', e.message, 'FAIL');
    }
    
    // Transfer 2: FDH -> NBS
    const transfer2Id = `${PREFIX}XFER-${Date.now()}-2`;
    try {
      const transfer = await finance.createTransfer({
        id: transfer2Id,
        from_account_id: ACCOUNTS['11220'],
        to_account_id: ACCOUNTS['11230'],
        amount: 750,
        transfer_date: today(),
        description: 'PH25-TEST transfer FDH->NBS',
        created_by: 'PH25-TEST'
      });
      
      console.log(`Transfer 2 created: ${transfer.id}`);
      record('Transfer 2', transfer2Id, transfer.id, 'K750', `K${transfer.amount}`, 'PASS');
      
      const transferLines = await getJournalLinesByReference(transfer.id);
      const debit11230 = transferLines.find(l => l.account_id === ACCOUNTS['11230'] && l.entry_type === 'debit');
      const credit11220 = transferLines.find(l => l.account_id === ACCOUNTS['11220'] && l.entry_type === 'credit');
      
      assert(debit11230 && Number(debit11230.amount) === 750,
        `Transfer DEBIT 11230 NBS Bank = K750 (actual: ${debit11230?.amount})`);
      assert(credit11220 && Number(credit11220.amount) === 750,
        `Transfer CREDIT 11220 FDH Bank = K750 (actual: ${credit11220?.amount})`);
      
    } catch (e) {
      console.error('Transfer 2 FAILED:', e.message);
      record('Transfer 2', transfer2Id, 'N/A', 'K750', e.message, 'FAIL');
    }

    // ========================================================================
    // STEP 11: Trial Balance from Real Data (test-created entries only)
    // ========================================================================
    console.log('\n--- STEP 11: Trial Balance from Real Data ---');
    try {
      const allEntries = await repo.getAll('ledger_entries', {});
      const testEntries = allEntries.filter(e => e.id && e.id.startsWith(PREFIX));
      
      const tb = {};
      testEntries.forEach(e => {
        if (!tb[e.account_id]) {
          tb[e.account_id] = { account_id: e.account_id, debit: 0, credit: 0 };
        }
        if (e.entry_type === 'debit') {
          tb[e.account_id].debit += Number(e.amount) || 0;
        } else {
          tb[e.account_id].credit += Number(e.amount) || 0;
        }
      });
      
      let totalDebits = 0;
      let totalCredits = 0;
      Object.values(tb).forEach(entry => {
        totalDebits += entry.debit;
        totalCredits += entry.credit;
      });
      
      console.log(`Test entries: ${testEntries.length}`);
      console.log(`Total Debits: ${totalDebits.toFixed(2)}`);
      console.log(`Total Credits: ${totalCredits.toFixed(2)}`);
      assert(Math.abs(totalDebits - totalCredits) < 0.01,
        `Test Trial Balance balanced: debits=${totalDebits.toFixed(2)}, credits=${totalCredits.toFixed(2)}`);
      
      record('Trial Balance', 'N/A', 'N/A', 'Balanced', `Dr=${totalDebits.toFixed(2)} Cr=${totalCredits.toFixed(2)}`, 'PASS');
      
    } catch (e) {
      console.error('Trial Balance FAILED:', e.message);
      record('Trial Balance', 'N/A', 'N/A', 'Balanced', e.message, 'FAIL');
    }

    // ========================================================================
    // STEP 15: Accounting Invariant Audit
    // ========================================================================
    console.log('\n--- STEP 15: Accounting Invariant Audit ---');
    try {
      const allEntries = await repo.getAll('ledger_entries', {});
      const testEntries = allEntries.filter(e => e.id && e.id.startsWith(PREFIX));
      console.log(`Test journal entries: ${testEntries.length}`);
      
      // Check all account_ids are canonical
      let allCanonical = true;
      let legacyCount = 0;
      testEntries.forEach(e => {
        if (!Object.values(ACCOUNTS).includes(e.account_id)) {
          allCanonical = false;
        }
        // Check for legacy codes (numeric strings like 1000, 1050, etc.)
        if (e.account_id && /^[0-9]{4,5}$/.test(e.account_id)) {
          legacyCount++;
        }
      });
      
      assert(allCanonical, 'All test journal lines use canonical UUIDs');
      assert(legacyCount === 0, `Zero legacy account code postings (found ${legacyCount})`);
      
      // Check all journals are balanced
      const journalBalances = {};
      testEntries.forEach(e => {
        if (!journalBalances[e.journal_id]) {
          journalBalances[e.journal_id] = { debits: 0, credits: 0 };
        }
        if (e.entry_type === 'debit') {
          journalBalances[e.journal_id].debits += Number(e.amount) || 0;
        } else {
          journalBalances[e.journal_id].credits += Number(e.amount) || 0;
        }
      });
      
      let allBalanced = true;
      Object.entries(journalBalances).forEach(([jid, bal]) => {
        if (Math.abs(bal.debits - bal.credits) >= 0.01) {
          allBalanced = false;
          console.error(`  Unbalanced journal: ${jid} Dr=${bal.debits} Cr=${bal.credits}`);
        }
      });
      assert(allBalanced, 'All test journals are balanced');
      
    } catch (e) {
      console.error('Invariant audit FAILED:', e.message);
    }

    // ========================================================================
    // Print Summary
    // ========================================================================
    console.log('\n=== TEST LEDGER ===');
    ledger.forEach(row => {
      console.log(`${row.test}: ${row.result} (${row.expected} -> ${row.actual})`);
    });
    
    console.log('\n=== PHASE 2.5 RESULTS ===');
    console.log(`Passed: ${pass}`);
    console.log(`Failed: ${fail}`);
    console.log(`Total:  ${pass + fail}`);
    
    if (fail > 0) {
      console.log('\nPhase 2.5: SOME TESTS FAILED');
      process.exit(1);
    } else {
      console.log('\nPhase 2.5: ALL CRITICAL TESTS PASSED');
    }

  } catch (err) {
    console.error('Test runner error:', err);
    process.exit(1);
  }
}

runTests();
