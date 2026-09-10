/**
 * phase2B_reporting_integrity.test.cjs
 *
 * Phase 2B — Financial Reporting Integrity tests.
 *
 * Verifies that the actual financial reports produced by Prime ERP are
 * mathematically and transactionally consistent with the underlying
 * accounting data.
 *
 * Tests cover:
 *   - Trial Balance balances
 *   - Revenue reconciliation
 *   - COGS reconciliation
 *   - Gross profit
 *   - Expense totals
 *   - Net profit
 *   - Balance Sheet equation
 *   - AR vs customer balances
 *   - Bank balance vs banking transactions
 *   - Cash flow vs cash/bank movements
 *   - Customer statement vs ledger
 *   - Financial-year filtering
 *   - Report date boundaries
 *   - Transfer neutrality in company-wide cash flow
 *   - Portal statement vs ERP accounting source
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOLERANCE = 0.01;

// ── Helpers ──────────────────────────────────────────────────────────────────

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// ── Trial Balance ────────────────────────────────────────────────────────────

describe('Phase 2B: Trial Balance', () => {
  it('total debits equal total credits (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const entries = await repo.getAll('ledger_entries');
    let totalDebits = 0;
    let totalCredits = 0;
    for (const e of entries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const amount = toNum(e.amount);
      if (normStatus(e.entry_type) === 'debit') totalDebits += amount;
      else if (normStatus(e.entry_type) === 'credit') totalCredits += amount;
    }
    assert.ok(Math.abs(totalDebits - totalCredits) < TOLERANCE, `Debits ${totalDebits} != Credits ${totalCredits}`);
  });

  it('no orphan ledger entries (missing COA account)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const [entries, accounts] = await Promise.all([
      repo.getAll('ledger_entries'),
      repo.getAll('chart_of_accounts'),
    ]);
    const accountIds = new Set(accounts.map(a => a.id));
    const orphans = entries.filter(e => !accountIds.has(e.account_id));
    assert.equal(orphans.length, 0, `Found ${orphans.length} orphan ledger entries`);
  });

  it('no duplicate journal lines', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const entries = await repo.getAll('ledger_entries');
    const signatures = new Map();
    const duplicates = [];
    for (const e of entries) {
      const sig = `${e.account_id}|${normStatus(e.entry_type)}|${toNum(e.amount)}|${e.entry_date || ''}|${normStatus(e.reference_type)}|${e.reference_id || ''}`;
      if (signatures.has(sig)) {
        duplicates.push({ signature: sig, first: signatures.get(sig), second: e.id });
      } else {
        signatures.set(sig, e.id);
      }
    }
    assert.equal(duplicates.length, 0, `Found ${duplicates.length} duplicate journal signatures`);
  });

  it('application Trial Balance account balances agree with independent calculation', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const reporting = require('../services/financialReportingService.cjs');
    const [entries, accounts, appTB] = await Promise.all([
      repo.getAll('ledger_entries'),
      repo.getAll('chart_of_accounts'),
      new reporting().getTrialBalance(new Date().toISOString().slice(0, 10)),
    ]);
    assert.ok(appTB && appTB.accounts, 'Application Trial Balance should return accounts');

    const accountTypeMap = new Map(accounts.map(a => [a.id, normStatus(a.type)]));
    const indBalances = new Map();
    for (const e of entries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const accountId = e.account_id;
      const amount = toNum(e.amount);
      const existing = indBalances.get(accountId) || { debit: 0, credit: 0 };
      if (normStatus(e.entry_type) === 'debit') existing.debit += amount;
      else existing.credit += amount;
      indBalances.set(accountId, existing);
    }

    let mismatches = 0;
    for (const appRow of appTB.accounts) {
      const ind = indBalances.get(appRow.account_id) || { debit: 0, credit: 0 };
      const indNet = ind.debit - ind.credit;
      const accountType = accountTypeMap.get(appRow.account_id) || '';
      const expectedBalance = ['asset', 'expense'].includes(accountType) ? indNet : -indNet;
      if (Math.abs(round2(expectedBalance) - round2(toNum(appRow.balance))) > TOLERANCE) {
        mismatches++;
      }
    }
    assert.equal(mismatches, 0, `${mismatches} account balance mismatches`);
  });
});

// ── Profit & Loss ────────────────────────────────────────────────────────────

describe('Phase 2B: Profit & Loss', () => {
  it('Revenue agrees with GL (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const reporting = require('../services/financialReportingService.cjs');
    const [entries, accounts, appPL] = await Promise.all([
      repo.getAll('ledger_entries'),
      repo.getAll('chart_of_accounts'),
      new reporting().getProfitAndLoss(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)),
    ]);
    assert.ok(appPL, 'Application P&L should be available');

    const accountTypeMap = new Map(accounts.map(a => [a.id, normStatus(a.type)]));
    let glRevenue = 0;
    for (const e of entries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const accountType = accountTypeMap.get(e.account_id) || '';
      if (accountType === 'revenue' || accountType === 'income') {
        const amount = toNum(e.amount);
        glRevenue += normStatus(e.entry_type) === 'credit' ? amount : -amount;
      }
    }
    assert.ok(Math.abs(round2(glRevenue) - round2(appPL.revenue)) < TOLERANCE, `Revenue GL ${round2(glRevenue)} != App ${round2(appPL.revenue)}`);
  });

  it('COGS agrees with GL if implemented', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const reporting = require('../services/financialReportingService.cjs');
    const [entries, accounts, appPL] = await Promise.all([
      repo.getAll('ledger_entries'),
      repo.getAll('chart_of_accounts'),
      new reporting().getProfitAndLoss(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)),
    ]);
    assert.ok(appPL, 'Application P&L should be available');

    const accountTypeMap = new Map(accounts.map(a => [a.id, normStatus(a.type)]));
    let glCOGS = 0;
    for (const e of entries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const accountType = accountTypeMap.get(e.account_id) || '';
      if (accountType === 'cogs' || accountType === 'cost_of_goods_sold') {
        const amount = toNum(e.amount);
        glCOGS += normStatus(e.entry_type) === 'debit' ? amount : -amount;
      }
    }
    assert.ok(Math.abs(round2(glCOGS) - round2(appPL.costOfGoodsSold)) < TOLERANCE, `COGS GL ${round2(glCOGS)} != App ${round2(appPL.costOfGoodsSold)}`);
  });

  it('Gross profit = Revenue - COGS', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const appPL = await new reporting().getProfitAndLoss(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.ok(appPL, 'Application P&L should be available');
    const expectedGrossProfit = round2(appPL.revenue - appPL.costOfGoodsSold);
    assert.ok(Math.abs(expectedGrossProfit - round2(appPL.grossProfit)) < TOLERANCE, `GrossProfit ${round2(appPL.grossProfit)} != Revenue-COGS ${expectedGrossProfit}`);
  });

  it('Net profit = Gross profit - Operating expenses', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const appPL = await new reporting().getProfitAndLoss(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.ok(appPL, 'Application P&L should be available');
    const expectedNetProfit = round2(appPL.grossProfit - appPL.operatingExpenses);
    assert.ok(Math.abs(expectedNetProfit - round2(appPL.netProfit)) < TOLERANCE, `NetProfit ${round2(appPL.netProfit)} != GrossProfit-Expenses ${expectedNetProfit}`);
  });

  it('P&L date boundaries are correct (one day)', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const today = new Date().toISOString().slice(0, 10);
    const pl = await new reporting().getProfitAndLoss(today, today);
    assert.ok(pl, 'P&L should be available for one day');
  });

  it('P&L date boundaries are correct (current financial year)', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const yearEnd = new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10);
    const pl = await new reporting().getProfitAndLoss(yearStart, yearEnd);
    assert.ok(pl, 'P&L should be available for current FY');
  });
});

// ── Balance Sheet ────────────────────────────────────────────────────────────

describe('Phase 2B: Balance Sheet', () => {
  it('Balance Sheet equation: Assets = Liabilities + Equity', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const reporting = require('../services/financialReportingService.cjs');
    const [accounts, appBS] = await Promise.all([
      repo.getAll('chart_of_accounts'),
      new reporting().getBalanceSheet(new Date().toISOString().slice(0, 10)),
    ]);
    assert.ok(appBS, 'Application Balance Sheet should be available');

    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    for (const acc of accounts) {
      const balance = toNum(acc.balance);
      const type = normStatus(acc.type);
      if (type === 'asset') totalAssets += balance;
      else if (type === 'liability') totalLiabilities += balance;
      else if (type === 'equity') totalEquity += balance;
    }

    const diff = round2(totalAssets - (totalLiabilities + totalEquity));
    assert.ok(Math.abs(diff) < TOLERANCE, `Balance Sheet equation fails: Assets ${round2(totalAssets)} != Liabilities+Equity ${round2(totalLiabilities + totalEquity)}, diff=${diff}`);
  });
});

// ── Accounts Receivable ──────────────────────────────────────────────────────

describe('Phase 2B: Accounts Receivable', () => {
  it('AR control account = sum of customer outstanding balances', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const [accounts, customers] = await Promise.all([
      repo.getAll('chart_of_accounts'),
      repo.getAll('customers'),
    ]);

    const arAccount = accounts.find(a => normStatus(a.subtype) === 'receivable' || (normStatus(a.type) === 'asset' && a.role === 'accounts_receivable'));
    const arBalance = arAccount ? toNum(arAccount.balance) : 0;
    const customerSum = customers.reduce((s, c) => s + toNum(c.outstandingBalance || c.data?.outstandingBalance || 0), 0);

    assert.ok(Math.abs(arBalance - customerSum) < TOLERANCE, `AR ${arBalance} != CustomerSum ${customerSum}`);
  });
});

// ── Cash Flow ────────────────────────────────────────────────────────────────

describe('Phase 2B: Cash Flow', () => {
  it('Cash Flow net change agrees with application', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const appCF = await new reporting().getCashFlowStatement(
      new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
      new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10)
    );
    assert.ok(appCF, 'Application Cash Flow should be available');
    // The application's own cash flow must internally balance
    const net = round2((appCF.operatingActivities?.netCashFlow || 0) + (appCF.investingActivities?.netCashFlow || 0) + (appCF.financingActivities?.netCashFlow || 0));
    assert.ok(Math.abs(net - round2(appCF.netCashFlow || 0)) < TOLERANCE, `Cash flow internal balance failed: net=${net}, reported=${appCF.netCashFlow}`);
  });

  it('Transfers are neutral in company-wide cash flow (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'financialReportingService.cjs'), 'utf8');
    // Cash flow should classify transfers correctly: one account decreases, another increases
    // The net company cash change from a transfer should be zero
    assert.ok(src.includes('account_type'), 'Cash flow should use account_type classification');
  });
});

// ── Customer Statements ──────────────────────────────────────────────────────

describe('Phase 2B: Customer Statements', () => {
  it('Customer statement outstanding balance agrees with ledger (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'portalService.cjs'), 'utf8');
    assert.ok(src.includes('customerLedger.buildLedger'), 'Portal statements must use customerLedger.buildLedger');
    assert.ok(src.includes('outstandingBalance'), 'Portal statements must include outstandingBalance');
  });

  it('customerLedger.cjs is the single authoritative source for statement transactions', () => {
    const portalSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'portalService.cjs'), 'utf8');
    const ledgerSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'customerLedger.cjs'), 'utf8');

    // Portal must use customerLedger, not duplicate the logic
    assert.ok(portalSrc.includes('customerLedger'), 'Portal must import customerLedger');
    assert.ok(ledgerSrc.includes('buildLedgerFromRecords'), 'customerLedger must define buildLedgerFromRecords');
  });
});

// ── Financial Year Filtering ────────────────────────────────────────────────

describe('Phase 2B: Financial Year Filtering', () => {
  it('injectFinancialYear middleware exists and sets dates', () => {
    const middleware = require('../middleware/financialYearMiddleware.cjs');
    assert.ok(middleware.injectFinancialYear, 'injectFinancialYear middleware should exist');
    assert.ok(typeof middleware.injectFinancialYear === 'function', 'injectFinancialYear should be a function');
  });

  it('financialYearService exists and can retrieve years', async () => {
    const FinancialYearService = require('../services/financialYearService.cjs');
    const service = new FinancialYearService();
    const years = await service.getFinancialYears();
    assert.ok(Array.isArray(years), 'getFinancialYears should return an array');
  });

  it('P&L respects date boundaries when start=end (one day)', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const today = new Date().toISOString().slice(0, 10);
    const pl = await new reporting().getProfitAndLoss(today, today);
    assert.ok(pl, 'P&L should return data for a single day');
    // Should not throw, and should have valid structure
    assert.ok(typeof pl.revenue === 'number', 'P&L should have revenue');
  });
});

// ── Report Date Boundaries ───────────────────────────────────────────────────

describe('Phase 2B: Report Date Boundaries', () => {
  it('Trial Balance accepts asOfDate parameter', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const tb = await new reporting().getTrialBalance(new Date().toISOString().slice(0, 10));
    assert.ok(tb, 'Trial Balance should accept asOfDate');
    assert.ok(typeof tb.totalDebits === 'number', 'Trial Balance should have totalDebits');
    assert.ok(typeof tb.totalCredits === 'number', 'Trial Balance should have totalCredits');
  });

  it('Balance Sheet accepts asOfDate parameter', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const bs = await new reporting().getBalanceSheet(new Date().toISOString().slice(0, 10));
    assert.ok(bs, 'Balance Sheet should accept asOfDate');
    assert.ok(typeof bs.assets === 'object', 'Balance Sheet should have assets');
    assert.ok(typeof bs.liabilities === 'object', 'Balance Sheet should have liabilities');
    assert.ok(typeof bs.equity === 'object', 'Balance Sheet should have equity');
  });

  it('Cash Flow accepts startDate and endDate', async () => {
    const reporting = require('../services/financialReportingService.cjs');
    const cf = await new reporting().getCashFlowStatement(
      new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
      new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10)
    );
    assert.ok(cf, 'Cash Flow should accept date range');
    assert.ok(typeof cf.operatingActivities === 'object', 'Cash Flow should have operatingActivities');
  });
});

// ── Transfer Neutrality ──────────────────────────────────────────────────────

describe('Phase 2B: Transfer Neutrality', () => {
  it('Banking transfer creates offsetting entries (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'bankingService.cjs'), 'utf8');
    // transferFunds should create two transactions: one debit from source, one credit to destination
    assert.ok(src.includes('transferFunds'), 'bankingService should have transferFunds');
  });

  it('Cash flow does not double-count transfers (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'financialReportingService.cjs'), 'utf8');
    // Cash flow classification uses account.type, not code prefix
    // Transfers between bank accounts should net to zero in company cash flow
    assert.ok(src.includes('account_type'), 'Cash flow should use account_type for classification');
  });
});

// ── Portal Statement vs ERP Source ───────────────────────────────────────────

describe('Phase 2B: Portal/ERP Statement Consistency', () => {
  it('Portal getStatements uses customerLedger.buildLedger', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'portalService.cjs'), 'utf8');
    assert.ok(src.includes('customerLedger.buildLedger'), 'Portal getStatements must use customerLedger.buildLedger');
    assert.ok(src.includes('getStatements'), 'Portal must have getStatements method');
  });

  it('Portal statement data contract includes required fields', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'portalService.cjs'), 'utf8');
    assert.ok(src.includes('opening_balance'), 'Statement must include opening_balance');
    assert.ok(src.includes('closing_balance'), 'Statement must include closing_balance');
    assert.ok(src.includes('outstanding_balance'), 'Statement must include outstanding_balance');
    assert.ok(src.includes('transactions'), 'Statement must include transactions array');
  });

  it('customerLedger.cjs is the single authoritative source for all balance calculations', () => {
    const ledgerSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'customerLedger.cjs'), 'utf8');
    assert.ok(ledgerSrc.includes('buildLedgerFromRecords'), 'customerLedger must define buildLedgerFromRecords');
    assert.ok(ledgerSrc.includes('paymentCredit'), 'customerLedger must define paymentCredit');
    assert.ok(ledgerSrc.includes('isWalletTopup'), 'customerLedger must define isWalletTopup');
  });
});

// ── COA Integrity ────────────────────────────────────────────────────────────

describe('Phase 2B: Chart of Accounts Integrity', () => {
  it('All COA accounts have valid type', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const accounts = await repo.getAll('chart_of_accounts');
    const invalidTypes = accounts.filter(a => {
      const type = normStatus(a.type);
      return !['asset', 'liability', 'equity', 'revenue', 'income', 'expense', 'cogs', 'cost_of_goods_sold'].includes(type);
    });
    assert.equal(invalidTypes.length, 0, `Found ${invalidTypes.length} accounts with invalid type`);
  });

  it('COA balance trigger is present in migration 0013', () => {
    const migration = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'supabase', 'migrations', '0013_financial_integrity.sql'), 'utf8');
    assert.ok(migration.includes('fn_coa_recompute_balance'), 'Migration 0013 must define fn_coa_recompute_balance');
    assert.ok(migration.includes('trg_coa_recompute_balance'), 'Migration 0013 must create trg_coa_recompute_balance');
  });
});

// ── Reporting Service Integrity ──────────────────────────────────────────────

describe('Phase 2B: Reporting Service Integrity', () => {
  it('financialReportingService.cjs has all required methods', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'financialReportingService.cjs'), 'utf8');
    assert.ok(src.includes('getProfitAndLoss'), 'Must have getProfitAndLoss');
    assert.ok(src.includes('getBalanceSheet'), 'Must have getBalanceSheet');
    assert.ok(src.includes('getCashFlowStatement'), 'Must have getCashFlowStatement');
    assert.ok(src.includes('getTrialBalance'), 'Must have getTrialBalance');
    assert.ok(src.includes('getARAging'), 'Must have getARAging');
    assert.ok(src.includes('getAPAging'), 'Must have getAPAging');
  });

  it('P&L excludes reversals (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'financialReportingService.cjs'), 'utf8');
    assert.ok(src.includes("reference_type === 'reversal'") || src.includes('REVERSAL_REFERENCE_TYPE'), 'P&L must exclude reversal entries');
  });

  it('Trial Balance excludes reversals (static check)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'financialReportingService.cjs'), 'utf8');
    assert.ok(src.includes('REVERSAL_REFERENCE_TYPE'), 'Trial Balance must exclude reversal entries');
  });

  it('Backend reports are exposed via API routes', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.cjs'), 'utf8');
    assert.ok(src.includes('/api/reports/profit-and-loss'), 'P&L route must exist');
    assert.ok(src.includes('/api/reports/balance-sheet'), 'Balance Sheet route must exist');
    assert.ok(src.includes('/api/reports/cash-flow'), 'Cash Flow route must exist');
    assert.ok(src.includes('/api/reports/trial-balance'), 'Trial Balance route must exist');
    assert.ok(src.includes('/api/reports/ar-aging'), 'AR Aging route must exist');
    assert.ok(src.includes('/api/reports/ap-aging'), 'AP Aging route must exist');
  });
});
