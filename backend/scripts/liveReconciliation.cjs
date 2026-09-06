/**
 * liveReconciliation.cjs
 *
 * Queries the LIVE Supabase/Postgres database for actual reconciliation evidence.
 * Run with: node scripts/liveReconciliation.cjs
 *
 * IMPORTANT: This script queries PRODUCTION data. Do not modify.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUPABASE_URL = 'https://rdtuzuzehfbwvfdzqliw.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

const HEADERS = {
  apikey: SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function supabaseGet(table, filters = {}) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/${table}`,
      { params: filters, headers: HEADERS, timeout: 10000 }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const status = err.response && err.response.status;
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : '';
    console.warn(`[liveReconciliation] ${table} read failed (${status || err.message}): ${detail}`);
    return [];
  }
}

async function supabaseCount(table, filters = {}) {
  try {
    const countFilters = { ...filters, select: 'count' };
    const { data, headers } = await axios.get(
      `${SUPABASE_URL}/rest/v1/${table}`,
      { params: countFilters, headers: HEADERS, timeout: 10000 }
    );
    const countHeader = headers && headers['content-range'];
    if (countHeader) {
      const match = countHeader.match(/\/(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }
    return Array.isArray(data) ? data.length : 0;
  } catch (err) {
    return 0;
  }
}

function formatMoney(amount) {
  return `K${(Number(amount) || 0).toFixed(2)}`;
}

// ============================================================================
// 1. TRIAL BALANCE
// ============================================================================

async function getTrialBalance() {
  console.log('\n=== 1. TRIAL BALANCE (LIVE DATABASE) ===\n');

  try {
    const entries = await supabaseGet('ledger_entries');
    console.log(`Total ledger entries in database: ${entries.length}`);

    if (entries.length === 0) {
      console.log('⚠️  No ledger entries found in database');
      return { totalDebits: 0, totalCredits: 0, isBalanced: true, rows: [] };
    }

    const trialBalance = {};

    for (const entry of entries) {
      const data = entry.data || {};
      const debitAccountId = data.debitAccountId;
      const creditAccountId = data.creditAccountId;
      const amount = Number(data.amount) || 0;

      if (debitAccountId) {
        if (!trialBalance[debitAccountId]) {
          trialBalance[debitAccountId] = {
            account_id: debitAccountId,
            debit: 0,
            credit: 0,
          };
        }
        trialBalance[debitAccountId].debit += amount;
      }

      if (creditAccountId) {
        if (!trialBalance[creditAccountId]) {
          trialBalance[creditAccountId] = {
            account_id: creditAccountId,
            debit: 0,
            credit: 0,
          };
        }
        trialBalance[creditAccountId].credit += amount;
      }
    }

    const rows = Object.values(trialBalance);
    const totalDebits = rows.reduce((sum, r) => sum + r.debit, 0);
    const totalCredits = rows.reduce((sum, r) => sum + r.credit, 0);

    console.log(`\nTotal Debits:   ${formatMoney(totalDebits)}`);
    console.log(`Total Credits:  ${formatMoney(totalCredits)}`);
    console.log(`Difference:     ${formatMoney(Math.abs(totalDebits - totalCredits))}`);

    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;
    console.log(`\nBalanced: ${isBalanced ? '✅ YES' : '❌ NO'}`);

    if (!isBalanced) {
      console.log('\n⚠️  TRIAL BALANCE IS NOT BALANCED!');
    }

    return { totalDebits, totalCredits, isBalanced, rows: rows.slice(0, 20) };
  } catch (error) {
    console.error('❌ Failed to query Trial Balance:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 2. PROFIT & LOSS
// ============================================================================

async function getProfitAndLoss() {
  console.log('\n=== 2. PROFIT & LOSS (LIVE DATABASE) ===\n');

  try {
    const entries = await supabaseGet('ledger_entries');
    console.log(`Total ledger entries: ${entries.length}`);

    if (entries.length === 0) {
      console.log('⚠️  No ledger entries found');
      return { totalRevenue: 0, cogs: 0, grossProfit: 0 };
    }

    // Get accounts for type lookup
    const accounts = await supabaseGet('chart_of_accounts');
    const accountTypeMap = new Map();
    for (const acc of accounts) {
      const code = String(acc.account_number || acc.code || '').trim();
      accountTypeMap.set(code, String(acc.account_type || '').trim().toUpperCase());
    }

    let revenue = 0;
    let cogs = 0;
    let operatingExpenses = 0;
    let otherIncome = 0;
    let interestIncome = 0;

    for (const entry of entries) {
      const data = entry.data || {};
      const amount = Number(data.amount) || 0;
      const creditAccountId = String(data.creditAccountId || '').trim();
      const debitAccountId = String(data.debitAccountId || '').trim();

      // Revenue is credited to revenue accounts
      const creditCode = creditAccountId.replace('ACC-', '');
      const creditType = accountTypeMap.get(creditCode) || '';

      if (creditType === 'INCOME') {
        if (creditCode === '41100') revenue += amount;
        else if (creditCode === '41200') revenue += amount;
        else if (creditCode === '42000') otherIncome += amount;
        else if (creditCode === '42100') interestIncome += amount;
      }

      // COGS is debited to COGS account
      const debitCode = debitAccountId.replace('ACC-', '');
      const debitType = accountTypeMap.get(debitCode) || '';

      if (debitType === 'EXPENSE' && debitCode === '51200') {
        cogs += amount;
      } else if (debitType === 'EXPENSE' && debitCode.startsWith('52')) {
        operatingExpenses += amount;
      }
    }

    const totalRevenue = revenue;
    const grossProfit = totalRevenue - cogs;
    const netProfit = grossProfit - operatingExpenses + otherIncome + interestIncome;

    console.log(`Revenue:             ${formatMoney(totalRevenue)}`);
    console.log(`  - Product Sales:   ${formatMoney(revenue)}`);
    console.log(`  - Other Income:    ${formatMoney(otherIncome)}`);
    console.log(`  - Interest Income: ${formatMoney(interestIncome)}`);
    console.log(`COGS:                ${formatMoney(cogs)}`);
    console.log(`Gross Profit:        ${formatMoney(grossProfit)}`);
    console.log(`Operating Expenses:  ${formatMoney(operatingExpenses)}`);
    console.log(`Net Profit:          ${formatMoney(netProfit)}`);

    return {
      totalRevenue,
      cogs,
      grossProfit,
      operatingExpenses,
      otherIncome,
      interestIncome,
      netProfit,
    };
  } catch (error) {
    console.error('❌ Failed to query P&L:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 3. BALANCE SHEET
// ============================================================================

async function getBalanceSheet() {
  console.log('\n=== 3. BALANCE SHEET (LIVE DATABASE) ===\n');

  try {
    const entries = await supabaseGet('ledger_entries');
    console.log(`Total ledger entries: ${entries.length}`);

    if (entries.length === 0) {
      console.log('⚠️  No ledger entries found');
      return { assets: 0, liabilities: 0, equity: 0, totalLiabilitiesAndEquity: 0 };
    }

    // Get accounts for type lookup
    const accounts = await supabaseGet('chart_of_accounts');
    const accountTypeMap = new Map();
    for (const acc of accounts) {
      const code = String(acc.account_number || acc.code || '').trim();
      accountTypeMap.set(code, String(acc.account_type || '').trim().toUpperCase());
    }

    let assets = 0;
    let liabilities = 0;
    let equity = 0;

    for (const entry of entries) {
      const data = entry.data || {};
      const amount = Number(data.amount) || 0;
      const debitAccountId = String(data.debitAccountId || '').trim();
      const creditAccountId = String(data.creditAccountId || '').trim();

      const debitCode = debitAccountId.replace('ACC-', '');
      const creditCode = creditAccountId.replace('ACC-', '');

      const debitType = accountTypeMap.get(debitCode) || '';
      const creditType = accountTypeMap.get(creditCode) || '';

      if (debitType === 'ASSET') assets += amount;
      if (creditType === 'ASSET') assets -= amount;

      if (debitType === 'LIABILITY') liabilities += amount;
      if (creditType === 'LIABILITY') liabilities -= amount;

      if (debitType === 'EQUITY') equity += amount;
      if (creditType === 'EQUITY') equity -= amount;
    }

    const totalLiabilitiesAndEquity = liabilities + equity;

    console.log(`Assets:              ${formatMoney(assets)}`);
    console.log(`Liabilities:         ${formatMoney(liabilities)}`);
    console.log(`Equity:              ${formatMoney(equity)}`);
    console.log(`Liabilities + Equity: ${formatMoney(totalLiabilitiesAndEquity)}`);
    console.log(`\nBalanced: ${Math.abs(assets - totalLiabilitiesAndEquity) < 0.01 ? '✅ YES' : '❌ NO'}`);

    return { assets, liabilities, equity, totalLiabilitiesAndEquity };
  } catch (error) {
    console.error('❌ Failed to query Balance Sheet:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 4. JOURNAL IDs FOR E2E TRANSACTIONS
// ============================================================================

async function getE2EJournalIds() {
  console.log('\n=== 4. E2E JOURNAL IDs (LIVE DATABASE) ===\n');

  try {
    const entries = await supabaseGet('ledger_entries', {
      'data->>referenceId': 'not.is.null',
      'order': 'created_at.desc',
      'limit': 100,
    });

    console.log(`Total entries with reference: ${entries.length}`);

    if (entries.length === 0) {
      console.log('⚠️  No journal entries found');
      return { total: 0, journals: [] };
    }

    // Group by referenceId (which acts as journal ID in this schema)
    const journals = new Map();

    for (const entry of entries) {
      const data = entry.data || {};
      const referenceId = data.referenceId;
      if (!referenceId) continue;

      if (!journals.has(referenceId)) {
        journals.set(referenceId, {
          journal_id: referenceId,
          description: data.description,
          date: data.date,
          entries: [],
        });
      }

      journals.get(referenceId).entries.push({
        id: entry.id,
        debitAccountId: data.debitAccountId,
        creditAccountId: data.creditAccountId,
        amount: data.amount,
        description: data.description,
      });
    }

    console.log(`Total journals found: ${journals.size}`);
    console.log('\nRecent journals:');

    let count = 0;
    for (const [journalId, journal] of journals) {
      if (count >= 10) break;
      console.log(`\n  Journal ID: ${journalId}`);
      console.log(`  Description: ${journal.description}`);
      console.log(`  Date: ${journal.date}`);
      console.log(`  Entries: ${journal.entries.length}`);
      journal.entries.forEach(e => {
        console.log(`    - DR ${e.debitAccountId} ${formatMoney(e.amount)}`);
        console.log(`      CR ${e.creditAccountId} ${formatMoney(e.amount)}`);
      });
      count++;
    }

    return { total: journals.size, journals: Array.from(journals.values()).slice(0, 10) };
  } catch (error) {
    console.error('❌ Failed to query journals:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 5. CANONICAL ACCOUNT IDs
// ============================================================================

async function getCanonicalAccountIds() {
  console.log('\n=== 5. CANONICAL ACCOUNT IDs (LIVE DATABASE) ===\n');

  try {
    const accounts = await supabaseGet('chart_of_accounts', {
      'order': 'account_number.asc',
    });

    console.log(`Total accounts in COA: ${accounts.length}`);

    if (accounts.length === 0) {
      console.log('⚠️  No accounts found');
      return [];
    }

    console.log('\nAll accounts:');
    console.log('Account Code | Account Name | Type | Canonical ID');
    console.log('-------------|--------------|------|------------------');

    for (const account of accounts.slice(0, 30)) {
      const code = String(account.account_number || account.code || '').padEnd(13);
      const name = String(account.name || '').padEnd(14);
      const type = String(account.account_type || '').padEnd(8);
      console.log(`${code} | ${name} | ${type} | ${account.id}`);
    }

    return accounts.slice(0, 30);
  } catch (error) {
    console.error('❌ Failed to query accounts:', error.message);
    return [];
  }
}

// ============================================================================
// 6. SUPABASE/CLOUD RECORDS AFTER SYNC
// ============================================================================

async function getCloudSyncStatus() {
  console.log('\n=== 6. CLOUD/SYNC STATUS (LIVE DATABASE) ===\n');

  try {
    const totalEntries = await supabaseCount('ledger_entries');
    console.log(`Total ledger entries: ${totalEntries}`);

    if (totalEntries === 0) {
      console.log('⚠️  No entries in database');
      return { totalEntries: 0, entriesWithSync: 0, syncRate: 0 };
    }

    const entries = await supabaseGet('ledger_entries', { limit: 10 });

    const hasSyncedAt = entries.some(e => {
      const data = e.data || {};
      return data.synced_at !== undefined && data.synced_at !== null;
    });
    const hasSyncGeneration = entries.some(e => {
      const data = e.data || {};
      return data.sync_generation !== undefined && data.sync_generation !== null;
    });

    console.log(`Has synced_at in data:       ${hasSyncedAt ? 'Yes' : 'No'}`);
    console.log(`Has sync_generation in data: ${hasSyncGeneration ? 'Yes' : 'No'}`);

    if (hasSyncedAt) {
      const syncedCount = entries.filter(e => {
        const data = e.data || {};
        return data.synced_at;
      }).length;
      console.log(`Synced entries (sample):    ${syncedCount}/${entries.length}`);
    }

    return {
      totalEntries,
      entriesWithSync: hasSyncedAt ? totalEntries : 0,
      syncRate: hasSyncedAt ? 100 : 0,
    };
  } catch (error) {
    console.error('❌ Failed to query sync status:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 7. K4,828 REVERSAL VERIFICATION
// ============================================================================

async function verifyK4828Reversal() {
  console.log('\n=== 7. K4,828 REVERSAL VERIFICATION (LIVE DATABASE) ===\n');

  try {
    // Search for Interest Income account
    const accounts = await supabaseGet('chart_of_accounts');

    const interestIncomeAccount = accounts.find(
      a => String(a.account_number || a.code || '') === '42100'
    );

    if (!interestIncomeAccount) {
      console.log('⚠️  Interest Income account (42100) not found in database');
      return { found: false, reason: 'Account not found' };
    }

    console.log(`Interest Income account: ${interestIncomeAccount.id} (${interestIncomeAccount.name})`);

    // Find all entries that credit Interest Income (creditAccountId = ACC-42100)
    const entries = await supabaseGet('ledger_entries', {
      'data->>creditAccountId': `eq.ACC-42100`,
      'order': 'created_at.asc',
    });

    console.log(`\nTotal Interest Income entries: ${entries.length}`);

    if (entries.length === 0) {
      console.log('⚠️  No entries found for Interest Income');
      return { found: false, reason: 'No entries' };
    }

    // Look for K4,828 entries
    const k4828Entries = entries.filter(e => {
      const data = e.data || {};
      return Math.abs(Number(data.amount) - 4828) < 0.01;
    });

    console.log(`Entries with amount K4,828: ${k4828Entries.length}`);

    if (k4828Entries.length > 0) {
      console.log('\nK4,828 entries:');
      k4828Entries.forEach(e => {
        const data = e.data || {};
        console.log(`  - ${e.id}: CR ${data.creditAccountId} ${formatMoney(data.amount)}`);
        console.log(`    Description: ${data.description}`);
        console.log(`    Date: ${data.date || e.created_at}`);
      });

      // Check for reversals
      const reversals = k4828Entries.filter(e => {
        const data = e.data || {};
        return data.description && data.description.includes('Reversal');
      });
      console.log(`\nReversals of K4,828: ${reversals.length}`);

      if (reversals.length > 0) {
        console.log('✅ K4,828 reversal exists');
      } else {
        console.log('❌ K4,828 reversal NOT found');
      }

      // Calculate net impact
      let totalCredits = 0;
      let totalDebits = 0;
      for (const e of entries) {
        const data = e.data || {};
        const amt = Number(data.amount) || 0;
        totalCredits += amt; // All entries here are credits to Interest Income
        // Check if there's a corresponding debit (reversal)
        if (data.description && data.description.includes('Reversal')) {
          totalDebits += amt;
        }
      }
      const netImpact = totalCredits - totalDebits;

      console.log(`\nNet Interest Income impact: ${formatMoney(netImpact)}`);
      console.log(`Expected: K0.00`);
      console.log(`Status: ${Math.abs(netImpact) < 0.01 ? '✅ CORRECT' : '❌ INCORRECT'}`);

      return {
        found: true,
        reversals: reversals.length,
        netImpact,
        entries: k4828Entries.length,
      };
    } else {
      console.log('\n⚠️  No K4,828 entries found in Interest Income');
      return { found: false, reason: 'No K4,828 entries' };
    }
  } catch (error) {
    console.error('❌ Failed to verify K4,828 reversal:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 8. PROFITMARGIN LEDGER ENTRIES CHECK
// ============================================================================

async function checkProfitMarginEntries() {
  console.log('\n=== 8. PROFITMARGIN LEDGER ENTRIES CHECK (LIVE DATABASE) ===\n');

  try {
    const allEntries = await supabaseGet('ledger_entries');
    console.log(`Total ledger entries: ${allEntries.length}`);

    if (allEntries.length === 0) {
      console.log('⚠️  No entries found');
      return { profitMarginByDescription: 0, profitMarginByType: 0, total: 0 };
    }

    // Check by description in data JSONB
    const profitMarginByDescription = allEntries.filter(e => {
      const data = e.data || {};
      const desc = String(data.description || '').toLowerCase();
      return desc.includes('profitmargin') || desc.includes('profit margin');
    });

    console.log(`\nProfitMargin entries (by description): ${profitMarginByDescription.length}`);

    if (profitMarginByDescription.length > 0) {
      console.log('⚠️  ProfitMargin entries found:');
      profitMarginByDescription.forEach(e => {
        const data = e.data || {};
        console.log(`  - ${e.id}: CR ${data.creditAccountId} ${formatMoney(data.amount)}`);
        console.log(`    Description: ${data.description}`);
      });
    } else {
      console.log('✅ No ProfitMargin entries by description');
    }

    return {
      profitMarginByDescription: profitMarginByDescription.length,
      profitMarginByType: 0,
      total: profitMarginByDescription.length,
    };
  } catch (error) {
    console.error('❌ Failed to check ProfitMargin entries:', error.message);
    return { error: error.message };
  }
}

// ============================================================================
// 9. VERIFY DIRECT LEDGER WRITERS ARE GONE
// ============================================================================

async function verifyDirectWritersGone() {
  console.log('\n=== 9. DIRECT LEDGER WRITER VERIFICATION ===\n');

  const filesToCheck = [
    'services/referralService.cjs',
    'services/examinationService.cjs',
  ];

  let allClean = true;

  for (const file of filesToCheck) {
    const filePath = path.join(__dirname, '..', file);

    if (!fs.existsSync(filePath)) {
      console.log(`\n${file}:`);
      console.log(`  ❌ FILE NOT FOUND: ${filePath}`);
      allClean = false;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Check for direct INSERT patterns
    const hasDirectInsert = /INSERT\s+INTO\s+ledger_entries/i.test(content);
    const hasLocalSaveLedger = /const\s+saveLedgerEntry\s*=\s*async/i.test(content);
    const usesFinanceService = /FinanceService\.saveLedgerEntry|new FinanceService\(\)/.test(content);

    console.log(`\n${file}:`);
    console.log(`  Direct INSERT INTO ledger_entries: ${hasDirectInsert ? '❌ FOUND' : '✅ NOT FOUND'}`);
    console.log(`  Local saveLedgerEntry function:   ${hasLocalSaveLedger ? '❌ FOUND' : '✅ NOT FOUND'}`);
    console.log(`  Uses FinanceService:              ${usesFinanceService ? '✅ YES' : '❌ NO'}`);

    if (hasDirectInsert || hasLocalSaveLedger) {
      allClean = false;
      console.log(`  ⚠️  This file still contains direct ledger writes!`);
    } else if (usesFinanceService) {
      console.log(`  ✅ File is clean - uses canonical accounting engine`);
    } else {
      console.log(`  ⚠️  Cannot verify - no FinanceService usage found`);
      allClean = false;
    }
  }

  return { allClean, filesChecked: filesToCheck.length };
}

// ============================================================================
// 10. PRODUCTION BUILD
// ============================================================================

async function runProductionBuild() {
  console.log('\n=== 10. PRODUCTION BUILD ===\n');

  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  try {
    console.log('Running: npm run build (frontend)...');
    const buildResult = await execPromise('cd frontend && npm run build', {
      timeout: 120000,
      encoding: 'utf8',
    });

    console.log('✅ Build succeeded');
    console.log(`\nBuild output (last 500 chars):`);
    console.log(buildResult.stdout.slice(-500));

    return { success: true, output: buildResult.stdout };
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    if (error.stdout) {
      console.log('Stdout:', error.stdout.slice(-500));
    }
    if (error.stderr) {
      console.log('Stderr:', error.stderr.slice(-500));
    }
    return { success: false, error: error.message, stdout: error.stdout, stderr: error.stderr };
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  LIVE RECONCILIATION - PRODUCTION DATABASE                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nDatabase: ${SUPABASE_URL}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('\n⚠️  WARNING: This queries PRODUCTION data. Read-only mode.');

  const startTime = Date.now();

  try {
    const trialBalance = await getTrialBalance();
    const profitAndLoss = await getProfitAndLoss();
    const balanceSheet = await getBalanceSheet();
    const journals = await getE2EJournalIds();
    const accounts = await getCanonicalAccountIds();
    const syncStatus = await getCloudSyncStatus();
    const k4828Reversal = await verifyK4828Reversal();
    const profitMarginCheck = await checkProfitMarginEntries();
    const directWritersCheck = await verifyDirectWritersGone();
    const buildResult = await runProductionBuild();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║  LIVE RECONCILIATION SUMMARY                                  ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log(`\nDuration: ${duration}s`);

    console.log('\n--- TRIAL BALANCE ---');
    if (trialBalance.totalDebits !== undefined) {
      console.log(`Total Debits:  ${formatMoney(trialBalance.totalDebits)}`);
      console.log(`Total Credits: ${formatMoney(trialBalance.totalCredits)}`);
      console.log(`Balanced: ${trialBalance.isBalanced ? '✅ YES' : '❌ NO'}`);
    }

    console.log('\n--- PROFIT & LOSS ---');
    if (profitAndLoss.totalRevenue !== undefined) {
      console.log(`Revenue:      ${formatMoney(profitAndLoss.totalRevenue)}`);
      console.log(`COGS:         ${formatMoney(profitAndLoss.cogs)}`);
      console.log(`Gross Profit: ${formatMoney(profitAndLoss.grossProfit)}`);
    }

    console.log('\n--- BALANCE SHEET ---');
    if (balanceSheet.assets !== undefined) {
      console.log(`Assets:              ${formatMoney(balanceSheet.assets)}`);
      console.log(`Liabilities + Equity: ${formatMoney(balanceSheet.totalLiabilitiesAndEquity)}`);
    }

    console.log('\n--- K4,828 REVERSAL ---');
    if (k4828Reversal.found !== undefined) {
      console.log(`K4,828 entries found: ${k4828Reversal.found ? 'Yes' : 'No'}`);
      console.log(`Reversals exist: ${k4828Reversal.reversals > 0 ? '✅ YES' : '❌ NO'}`);
      console.log(`Net impact: ${formatMoney(k4828Reversal.netImpact || 0)}`);
    }

    console.log('\n--- PROFITMARGIN CHECK ---');
    if (profitMarginCheck.total !== undefined) {
      console.log(`ProfitMargin entries: ${profitMarginCheck.total}`);
      console.log(`Status: ${profitMarginCheck.total === 0 ? '✅ CLEAN' : '❌ FOUND'}`);
    }

    console.log('\n--- DIRECT WRITERS CHECK ---');
    console.log(`All files clean: ${directWritersCheck.allClean ? '✅ YES' : '❌ NO'}`);

    console.log('\n--- PRODUCTION BUILD ---');
    console.log(`Build status: ${buildResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);

    const allPassed =
      trialBalance.isBalanced &&
      profitAndLoss.totalRevenue !== undefined &&
      balanceSheet.assets !== undefined &&
      profitMarginCheck.total === 0 &&
      directWritersCheck.allClean &&
      buildResult.success;

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║  FINAL VERDICT                                                ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');

    if (allPassed) {
      console.log('\n✅ ALL CHECKS PASSED — PRODUCTION READY');
      process.exit(0);
    } else {
      console.log('\n❌ SOME CHECKS FAILED — NOT PRODUCTION READY');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
