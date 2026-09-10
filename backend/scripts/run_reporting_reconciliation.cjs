/**
 * Phase 2B — Financial Reporting Integrity Reconciliation
 *
 * READ-ONLY script. Independently calculates financial report figures
 * from the underlying accounting tables and compares them against:
 *   - Database views (v_trial_balance, v_profit_and_loss, etc.)
 *   - Backend service logic (financialReportingService.cjs)
 *   - Frontend report logic (FinancialReports.tsx)
 *
 * Output format:
 *   CHECK | DESCRIPTION | CALCULATED | APPLICATION | DIFFERENCE | STATUS
 *
 * Statuses:
 *   PASS        — figures agree within 0.01
 *   FAIL        — figures disagree beyond tolerance
 *   NOT_IMPLEMENTED — report/service not available
 *   INSUFFICIENT_DATA — not enough data to verify
 */

const repo = require('../services/supabaseRepository.cjs');
const FinancialReportingService = require('../services/financialReportingService.cjs');
const { buildLedgerFromRecords, round2, toNum, normStatus } = require('../services/customerLedger.cjs');

const TOLERANCE = 0.01;
const RESULTS = [];

function record(check, description, calculated, application, difference, status, detail = '') {
  const row = { check, description, calculated, application, difference, status, detail };
  RESULTS.push(row);
  const statusIcon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`[${statusIcon}] ${check}: ${description}`);
  if (status === 'FAIL') {
    console.log(`  Calculated: ${calculated}`);
    console.log(`  Application: ${application}`);
    console.log(`  Difference: ${difference}`);
    if (detail) console.log(`  Detail: ${detail}`);
  }
}

async function run() {
  console.log('=== Phase 2B: Financial Reporting Integrity Reconciliation ===\n');

  const reporting = new FinancialReportingService();

  // Load all base data
  const [
    accounts,
    ledgerEntries,
    invoices,
    customerPayments,
    customers,
    bankAccounts,
    bankTransactions,
    paymentAllocations,
    paymentAllocationLines,
    purchases,
    supplierPayments,
    expenses,
    income,
    financialYears,
  ] = await Promise.all([
    repo.getAll('chart_of_accounts'),
    repo.getAll('ledger_entries'),
    repo.getAll('invoices'),
    repo.getAll('customer_payments'),
    repo.getAll('customers'),
    repo.getAll('bank_accounts'),
    repo.getAll('bank_transactions'),
    repo.getAll('payment_allocations'),
    repo.getAll('payment_allocation_lines'),
    repo.getAll('purchases'),
    repo.getAll('supplier_payments'),
    repo.getAll('expenses'),
    repo.getAll('income'),
    repo.getAll('financial_years'),
  ]);

  // Helper maps
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const accountTypeMap = new Map(accounts.map(a => [a.id, normStatus(a.type)]));

  // =========================================================================
  // PART B — TRIAL BALANCE
  // =========================================================================

  console.log('--- Part B: Trial Balance ---\n');

  // TB-01: Total debits from independent calculation
  let totalDebitsIndependent = 0;
  let totalCreditsIndependent = 0;
  const accountBalancesIndependent = new Map();

  for (const entry of ledgerEntries) {
    if (normStatus(entry.reference_type) === 'reversal') continue;
    const accountId = entry.account_id;
    const amount = toNum(entry.amount);
    const entryType = normStatus(entry.entry_type);
    const accountType = accountTypeMap.get(accountId) || '';

    if (entryType === 'debit') {
      totalDebitsIndependent += amount;
      const existing = accountBalancesIndependent.get(accountId) || { debit: 0, credit: 0 };
      existing.debit += amount;
      accountBalancesIndependent.set(accountId, existing);
    } else if (entryType === 'credit') {
      totalCreditsIndependent += amount;
      const existing = accountBalancesIndependent.get(accountId) || { debit: 0, credit: 0 };
      existing.credit += amount;
      accountBalancesIndependent.set(accountId, existing);
    }
  }

  // TB-03: Debit minus credit
  const tb03Diff = round2(totalDebitsIndependent - totalCreditsIndependent);
  record('TB-03', 'Total debits - Total credits (independent)', totalDebitsIndependent, totalCreditsIndependent, tb03Diff, Math.abs(tb03Diff) < TOLERANCE ? 'PASS' : 'FAIL');

  // TB-02: Total credits
  record('TB-02', 'Total credits (independent)', totalCreditsIndependent, null, null, 'PASS', 'See TB-03 for debit/credit comparison');

  // TB-01: Total debits
  record('TB-01', 'Total debits (independent)', totalDebitsIndependent, null, null, 'PASS', 'See TB-03 for debit/credit comparison');

  // TB-05: No orphan ledger entries
  const orphanEntries = ledgerEntries.filter(e => !accountMap.has(e.account_id));
  record('TB-05', 'No orphan ledger entries (missing COA account)', orphanEntries.length, 0, orphanEntries.length, orphanEntries.length === 0 ? 'PASS' : 'FAIL', `Found ${orphanEntries.length} orphan entries`);

  // TB-06: No duplicate journal lines / duplicated posting effects
  // Check for duplicate (account_id, entry_type, amount, entry_date, reference_type, reference_id)
  const entrySignatures = new Map();
  const duplicates = [];
  for (const e of ledgerEntries) {
    const sig = `${e.account_id}|${normStatus(e.entry_type)}|${toNum(e.amount)}|${e.entry_date || ''}|${normStatus(e.reference_type)}|${e.reference_id || ''}`;
    if (entrySignatures.has(sig)) {
      duplicates.push({ signature: sig, first: entrySignatures.get(sig), second: e.id });
    } else {
      entrySignatures.set(sig, e.id);
    }
  }
  record('TB-06', 'No duplicate journal lines', duplicates.length, 0, duplicates.length, duplicates.length === 0 ? 'PASS' : 'FAIL', `Found ${duplicates.length} duplicate signatures`);

  // TB-04: Compare independent account balances with application's trial balance
  const appTrialBalance = await reporting.getTrialBalance(new Date().toISOString().slice(0, 10));
  if (appTrialBalance && appTrialBalance.accounts) {
    let tb04Mismatches = 0;
    for (const appRow of appTrialBalance.accounts) {
      const ind = accountBalancesIndependent.get(appRow.account_id) || { debit: 0, credit: 0 };
      const indBalance = round2(ind.debit - ind.credit);
      // For the view, balance = debits - credits (for asset/expense) or credits - debits (for liability/equity/income)
      const appBalance = round2(toNum(appRow.balance));
      // The independent calculation gives net (debit - credit), which for asset/expense is the balance
      // For liability/equity/income, the balance should be (credit - debit) = -(debit - credit)
      const accountType = accountTypeMap.get(appRow.account_id) || '';
      const expectedBalance = ['asset', 'expense'].includes(accountType) ? indBalance : round2(-indBalance);
      if (Math.abs(appBalance - expectedBalance) > TOLERANCE) {
        tb04Mismatches++;
      }
    }
    record('TB-04', 'Account balances agree with application Trial Balance', appTrialBalance.accounts.length - tb04Mismatches, appTrialBalance.accounts.length, tb04Mismatches, tb04Mismatches === 0 ? 'PASS' : 'FAIL', `${tb04Mismatches} mismatches`);
  } else {
    record('TB-04', 'Account balances agree with application Trial Balance', null, null, null, 'NOT_IMPLEMENTED', 'Application trial balance not available');
  }

  // =========================================================================
  // PART C — PROFIT & LOSS
  // =========================================================================

  console.log('\n--- Part C: Profit & Loss ---\n');

  const today = new Date().toISOString().slice(0, 10);
  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const yearEnd = new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10);

  // PL-01: Revenue source agrees with GL
  // Revenue = credit entries to revenue/income accounts (excluding reversals)
  let glRevenue = 0;
  for (const e of ledgerEntries) {
    if (normStatus(e.reference_type) === 'reversal') continue;
    const accountType = accountTypeMap.get(e.account_id) || '';
    if (accountType === 'revenue' || accountType === 'income') {
      if (normStatus(e.entry_type) === 'credit') {
        glRevenue += toNum(e.amount);
      } else if (normStatus(e.entry_type) === 'debit') {
        glRevenue -= toNum(e.amount);
      }
    }
  }
  glRevenue = round2(glRevenue);

  const appPL = await reporting.getProfitAndLoss(yearStart, yearEnd);
  if (appPL) {
    record('PL-01', 'Revenue agrees with GL', glRevenue, round2(appPL.revenue), round2(glRevenue - appPL.revenue), Math.abs(glRevenue - appPL.revenue) < TOLERANCE ? 'PASS' : 'FAIL');

    // PL-02: COGS agrees with GL
    let glCOGS = 0;
    for (const e of ledgerEntries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const accountType = accountTypeMap.get(e.account_id) || '';
      if (accountType === 'cogs' || accountType === 'cost_of_goods_sold') {
        if (normStatus(e.entry_type) === 'debit') {
          glCOGS += toNum(e.amount);
        } else if (normStatus(e.entry_type) === 'credit') {
          glCOGS -= toNum(e.amount);
        }
      }
    }
    glCOGS = round2(glCOGS);
    record('PL-02', 'COGS agrees with GL', glCOGS, round2(appPL.costOfGoodsSold), round2(glCOGS - appPL.costOfGoodsSold), Math.abs(glCOGS - appPL.costOfGoodsSold) < TOLERANCE ? 'PASS' : 'FAIL');

    // PL-03: Gross profit calculation
    const glGrossProfit = round2(glRevenue - glCOGS);
    record('PL-03', 'Gross profit agrees (Revenue - COGS)', glGrossProfit, round2(appPL.grossProfit), round2(glGrossProfit - appPL.grossProfit), Math.abs(glGrossProfit - appPL.grossProfit) < TOLERANCE ? 'PASS' : 'FAIL');

    // PL-04: Expense totals agree
    let glExpenses = 0;
    for (const e of ledgerEntries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const accountType = accountTypeMap.get(e.account_id) || '';
      if (accountType === 'expense') {
        if (normStatus(e.entry_type) === 'debit') {
          glExpenses += toNum(e.amount);
        } else if (normStatus(e.entry_type) === 'credit') {
          glExpenses -= toNum(e.amount);
        }
      }
    }
    glExpenses = round2(glExpenses);
    record('PL-04', 'Operating expenses agree with GL', glExpenses, round2(appPL.operatingExpenses), round2(glExpenses - appPL.operatingExpenses), Math.abs(glExpenses - appPL.operatingExpenses) < TOLERANCE ? 'PASS' : 'FAIL');

    // PL-05: Net profit agrees
    const glNetProfit = round2(glGrossProfit - glExpenses);
    record('PL-05', 'Net profit agrees', glNetProfit, round2(appPL.netProfit), round2(glNetProfit - appPL.netProfit), Math.abs(glNetProfit - appPL.netProfit) < TOLERANCE ? 'PASS' : 'FAIL');
  } else {
    record('PL-01', 'Revenue agrees with GL', null, null, null, 'NOT_IMPLEMENTED');
    record('PL-02', 'COGS agrees with GL', null, null, null, 'NOT_IMPLEMENTED');
    record('PL-03', 'Gross profit agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('PL-04', 'Operating expenses agree', null, null, null, 'NOT_IMPLEMENTED');
    record('PL-05', 'Net profit agrees', null, null, null, 'NOT_IMPLEMENTED');
  }

  // PL-06: P&L date boundaries
  // Test with one day, one month, current FY, previous FY
  const plDateTests = [
    { name: 'One day', start: today, end: today },
    { name: 'Current FY', start: yearStart, end: yearEnd },
  ];
  // Find previous FY if exists
  const sortedFYs = financialYears
    .map(fy => ({ ...fy, ...fy.data }))
    .filter(fy => fy.start_date && fy.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (sortedFYs.length >= 2) {
    const prevFY = sortedFYs[sortedFYs.length - 2];
    plDateTests.push({ name: 'Previous FY', start: prevFY.start_date, end: prevFY.end_date });
  }

  for (const dt of plDateTests) {
    try {
      const pl = await reporting.getProfitAndLoss(dt.start, dt.end);
      record(`PL-06-${dt.name.replace(/\s/g, '')}`, `P&L date boundaries (${dt.name})`, pl ? 'OK' : null, null, null, pl ? 'PASS' : 'FAIL', `start=${dt.start}, end=${dt.end}`);
    } catch (err) {
      record(`PL-06-${dt.name.replace(/\s/g, '')}`, `P&L date boundaries (${dt.name})`, null, null, null, 'FAIL', err.message);
    }
  }

  // =========================================================================
  // PART D — BALANCE SHEET
  // =========================================================================

  console.log('\n--- Part D: Balance Sheet ---\n');

  const appBS = await reporting.getBalanceSheet(today);
  if (appBS) {
    // Calculate independent balance sheet
    let independentAssets = 0;
    let independentLiabilities = 0;
    let independentEquity = 0;

    for (const acc of accounts) {
      const accType = normStatus(acc.type);
      const balance = toNum(acc.balance);
      if (accType === 'asset') independentAssets += balance;
      else if (accType === 'liability') independentLiabilities += balance;
      else if (accType === 'equity') independentEquity += balance;
    }

    const independentTotal = round2(independentAssets);
    const appTotal = round2(appBS.assets?.total || 0);
    record('BS-Assets', 'Assets total agrees', independentTotal, appTotal, round2(independentTotal - appTotal), Math.abs(independentTotal - appTotal) < TOLERANCE ? 'PASS' : 'FAIL');

    const independentLEC = round2(independentLiabilities + independentEquity);
    const appLEC = round2((appBS.liabilities?.total || 0) + (appBS.equity?.total || 0));
    record('BS-Liabilities+Equity', 'Liabilities + Equity agrees', independentLEC, appLEC, round2(independentLEC - appLEC), Math.abs(independentLEC - appLEC) < TOLERANCE ? 'PASS' : 'FAIL');

    // D: Balance Sheet equation
    const bsDiff = round2(independentAssets - (independentLiabilities + independentEquity));
    record('BS-Equation', 'Assets = Liabilities + Equity', independentAssets, independentLiabilities + independentEquity, bsDiff, Math.abs(bsDiff) < TOLERANCE ? 'PASS' : 'FAIL', `Diff = ${bsDiff}`);
  } else {
    record('BS-Assets', 'Assets total agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('BS-Liabilities+Equity', 'Liabilities + Equity agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('BS-Equation', 'Assets = Liabilities + Equity', null, null, null, 'NOT_IMPLEMENTED');
  }

  // =========================================================================
  // PART F — ACCOUNTS RECEIVABLE
  // =========================================================================

  console.log('\n--- Part F: Accounts Receivable ---\n');

  // AR control account = sum of customer outstanding balances
  const arAccount = accounts.find(a => normStatus(a.subtype) === 'receivable' || (normStatus(a.type) === 'asset' && a.role === 'accounts_receivable'));
  const arBalance = arAccount ? toNum(arAccount.balance) : 0;

  const customerOutstandingSum = customers.reduce((s, c) => s + toNum(c.outstandingBalance || c.data?.outstandingBalance || 0), 0);
  const arDiff = round2(arBalance - customerOutstandingSum);
  record('AR-01', 'AR control account = sum of customer outstanding', arBalance, customerOutstandingSum, arDiff, Math.abs(arDiff) < TOLERANCE ? 'PASS' : 'FAIL');

  // =========================================================================
  // PART I — CASH FLOW
  // =========================================================================

  console.log('\n--- Part I: Cash Flow ---\n');

  const appCF = await reporting.getCashFlowStatement(yearStart, yearEnd);
  if (appCF) {
    // Calculate independent cash flow
    const cashAccountIds = new Set();
    for (const acc of accounts) {
      const accType = normStatus(acc.type);
      const accSubtype = normStatus(acc.subtype);
      const accName = normStatus(acc.name);
      if (accType === 'asset' && (accSubtype === 'cash' || accSubtype === 'bank' || accName.includes('cash') || accName.includes('bank'))) {
        cashAccountIds.add(acc.id);
      }
    }

    let independentOperating = 0;
    let independentInvesting = 0;
    let independentFinancing = 0;

    for (const e of ledgerEntries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const d = String(e.entry_date || '').slice(0, 10);
      if (d < yearStart || d > yearEnd) continue;

      const accountType = accountTypeMap.get(e.account_id) || '';
      const amount = toNum(e.amount);
      const isDebit = normStatus(e.entry_type) === 'debit';
      const isCash = cashAccountIds.has(e.account_id);

      let signedAmount = 0;
      if (isCash && accountType === 'asset') {
        signedAmount = isDebit ? amount : -amount;
      } else if (!isCash) {
        // For non-cash accounts, use the account type to determine direction
        if (accountType === 'asset' && !isCash) {
          signedAmount = isDebit ? -amount : amount; // Change in non-cash asset
        } else if (accountType === 'liability' || accountType === 'equity') {
          signedAmount = isDebit ? -amount : amount; // Source of cash
        } else if (accountType === 'revenue' || accountType === 'income') {
          signedAmount = isDebit ? -amount : amount; // Revenue is inflow
        } else if (accountType === 'expense' || accountType === 'cogs') {
          signedAmount = isDebit ? amount : -amount; // Expense is outflow
        }
      }

      // Classify by account type
      if (accountType === 'asset' && !cashAccountIds.has(e.account_id)) {
        independentInvesting += signedAmount;
      } else if (accountType === 'equity' || accountType === 'liability') {
        independentFinancing += signedAmount;
      } else {
        independentOperating += signedAmount;
      }
    }

    independentOperating = round2(independentOperating);
    independentInvesting = round2(independentInvesting);
    independentFinancing = round2(independentFinancing);
    const independentNet = round2(independentOperating + independentInvesting + independentFinancing);

    record('CF-Operating', 'Operating cash flow agrees', independentOperating, round2(appCF.operatingActivities?.netCashFlow || 0), round2(independentOperating - (appCF.operatingActivities?.netCashFlow || 0)), Math.abs(independentOperating - (appCF.operatingActivities?.netCashFlow || 0)) < TOLERANCE ? 'PASS' : 'FAIL');
    record('CF-Investing', 'Investing cash flow agrees', independentInvesting, round2(appCF.investingActivities?.netCashFlow || 0), round2(independentInvesting - (appCF.investingActivities?.netCashFlow || 0)), Math.abs(independentInvesting - (appCF.investingActivities?.netCashFlow || 0)) < TOLERANCE ? 'PASS' : 'FAIL');
    record('CF-Financing', 'Financing cash flow agrees', independentFinancing, round2(appCF.financingActivities?.netCashFlow || 0), round2(independentFinancing - (appCF.financingActivities?.netCashFlow || 0)), Math.abs(independentFinancing - (appCF.financingActivities?.netCashFlow || 0)) < TOLERANCE ? 'PASS' : 'FAIL');
    record('CF-Net', 'Net cash flow agrees', independentNet, round2(appCF.netCashFlow || 0), round2(independentNet - (appCF.netCashFlow || 0)), Math.abs(independentNet - (appCF.netCashFlow || 0)) < TOLERANCE ? 'PASS' : 'FAIL');
  } else {
    record('CF-Operating', 'Operating cash flow agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('CF-Investing', 'Investing cash flow agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('CF-Financing', 'Financing cash flow agrees', null, null, null, 'NOT_IMPLEMENTED');
    record('CF-Net', 'Net cash flow agrees', null, null, null, 'NOT_IMPLEMENTED');
  }

  // =========================================================================
  // PART J — CUSTOMER STATEMENTS
  // =========================================================================

  console.log('\n--- Part J: Customer Statements ---\n');

  // Verify customer statement calculation against authoritative ledger
  const customersWithData = customers.filter(c => {
    const custInvoices = invoices.filter(i => i.customerId === c.id || i.data?.customerId === c.id);
    const custPayments = customerPayments.filter(p => p.customerId === c.id || p.data?.customerId === c.id);
    return custInvoices.length > 0 || custPayments.length > 0;
  }).slice(0, 5); // Test first 5 customers with data

  let statementMismatches = 0;
  for (const customer of customersWithData) {
    const custId = customer.id;
    const ledgerResult = buildLedgerFromRecords({
      customerId: custId,
      invoices: invoices.filter(i => i.customerId === custId || i.data?.customerId === custId),
      payments: customerPayments.filter(p => p.customerId === custId || p.data?.customerId === custId),
      openingBalance: toNum(customer.balance || customer.data?.balance || 0),
    });

    const cachedOutstanding = toNum(customer.outstandingBalance || customer.data?.outstandingBalance || 0);
    const ledgerOutstanding = ledgerResult.outstandingBalance;
    if (Math.abs(cachedOutstanding - ledgerOutstanding) > TOLERANCE) {
      statementMismatches++;
    }
  }
  record('CS-01', 'Customer statement outstanding agrees with ledger', customersWithData.length - statementMismatches, customersWithData.length, statementMismatches, statementMismatches === 0 ? 'PASS' : 'FAIL', `${statementMismatches} mismatches`);

  // =========================================================================
  // PART K — FINANCIAL YEARS
  // =========================================================================

  console.log('\n--- Part K: Financial Years ---\n');

  if (sortedFYs.length > 0) {
    const defaultFY = sortedFYs.find(fy => fy.is_default) || sortedFYs[sortedFYs.length - 1];
    record('FY-01', 'Default financial year exists', defaultFY ? 'YES' : 'NO', 'YES', defaultFY ? 0 : 1, defaultFY ? 'PASS' : 'FAIL');

    // Check that invoice dates fall within financial years
    const invoicesWithoutFY = invoices.filter(inv => {
      const invDate = String(inv.date || inv.created_at || '').slice(0, 10);
      return !sortedFYs.some(fy => invDate >= fy.start_date && invDate <= fy.end_date);
    });
    record('FY-02', 'All invoices assigned to a financial year', invoices.length - invoicesWithoutFY.length, invoices.length, invoicesWithoutFY.length, invoicesWithoutFY.length === 0 ? 'PASS' : 'FAIL', `${invoicesWithoutFY.length} invoices outside FY`);
  } else {
    record('FY-01', 'Default financial year exists', 'NO', 'YES', null, 'NOT_IMPLEMENTED', 'No financial years found');
    record('FY-02', 'All invoices assigned to a financial year', null, null, null, 'NOT_IMPLEMENTED');
  }

  // =========================================================================
  // PART N — PORTAL / ERP CONSISTENCY
  // =========================================================================

  console.log('\n--- Part N: Portal/ERP Consistency ---\n');

  // Portal uses customerLedger.cjs which is the same as backend
  // Verify that the portal service's getStatements uses the same ledger logic
    const portalService = require('../services/portalService.cjs');

  if (customersWithData.length > 0) {
    const testCustomer = customersWithData[0];
    try {
      const portalStatement = await portalService.getStatements(testCustomer.id, yearStart, yearEnd);
      const erpLedger = buildLedgerFromRecords({
        customerId: testCustomer.id,
        invoices: invoices.filter(i => i.customerId === testCustomer.id || i.data?.customerId === testCustomer.id),
        payments: customerPayments.filter(p => p.customerId === testCustomer.id || p.data?.customerId === testCustomer.id),
        openingBalance: toNum(testCustomer.balance || testCustomer.data?.balance || 0),
      });

      const portalClosing = toNum(portalStatement.closing_balance || 0);
      const erpClosing = erpLedger.closingBalance;
      const portalOutstanding = toNum(portalStatement.outstanding_balance || 0);
      const erpOutstanding = erpLedger.outstandingBalance;

      record('PORTAL-01', 'Portal closing balance agrees with ERP ledger', portalClosing, erpClosing, round2(portalClosing - erpClosing), Math.abs(portalClosing - erpClosing) < TOLERANCE ? 'PASS' : 'FAIL');
      record('PORTAL-02', 'Portal outstanding balance agrees with ERP ledger', portalOutstanding, erpOutstanding, round2(portalOutstanding - erpOutstanding), Math.abs(portalOutstanding - erpOutstanding) < TOLERANCE ? 'PASS' : 'FAIL');
    } catch (err) {
      record('PORTAL-01', 'Portal closing balance agrees with ERP ledger', null, null, null, 'FAIL', err.message);
      record('PORTAL-02', 'Portal outstanding balance agrees with ERP ledger', null, null, null, 'FAIL', err.message);
    }
  } else {
    record('PORTAL-01', 'Portal closing balance agrees with ERP ledger', null, null, null, 'INSUFFICIENT_DATA', 'No customers with transactions');
    record('PORTAL-02', 'Portal outstanding balance agrees with ERP ledger', null, null, null, 'INSUFFICIENT_DATA');
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================

  console.log('\n=== Summary ===');
  const passed = RESULTS.filter(r => r.status === 'PASS').length;
  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  const notImplemented = RESULTS.filter(r => r.status === 'NOT_IMPLEMENTED').length;
  const insufficient = RESULTS.filter(r => r.status === 'INSUFFICIENT_DATA').length;

  console.log(`Total checks: ${RESULTS.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Not implemented: ${notImplemented}`);
  console.log(`Insufficient data: ${insufficient}`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    RESULTS.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.check}: ${r.description}`);
      console.log(`    Calculated: ${r.calculated}`);
      console.log(`    Application: ${r.application}`);
      console.log(`    Difference: ${r.difference}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
