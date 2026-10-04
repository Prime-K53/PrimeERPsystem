import { isPostedLedgerEntry } from '../services/accountingEngine';
import { isExpenseAccount, isIncomeAccount } from './accountType';
import type { Account, LedgerEntry } from '../types';

/**
 * GL-side revenue reconciliation (Phase 5 / C1).
 *
 * Compares recognized document revenue (revenueAnalysis dataset) against
 * posted ledger credits to income accounts — the same PL-01 identity the
 * backend `run_reporting_reconciliation.cjs` script checks, surfaced in the
 * RevenueDashboard so drift is visible without running scripts.
 */

export interface GlRevenueSummary {
  glRevenue: number;
  entryCount: number;
  transactionCount: number;
}

export interface GlExpenseSummary {
  glExpenses: number;
  entryCount: number;
  transactionCount: number;
}

const toNumber = (value: unknown): number => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const indexAccounts = (accounts: Array<Partial<Account>> = []) => {
  const byId = new Map<string, Partial<Account>>();
  for (const account of accounts || []) {
    if (!account) continue;
    for (const key of [account.id, (account as any).code, (account as any).account_number]) {
      const k = String(key || '').trim();
      if (k) byId.set(k, account);
    }
  }
  return byId;
};

/**
 * Sum one side of every posted ledger row, restricted to accounts of a given
 * kind. Shared by revenue (income credits) and expenses (expense debits) so
 * both KPIs are read from exactly the same population of rows.
 */
const sumPostedSide = (
  side: 'creditAccountId' | 'debitAccountId',
  ledger: Array<Partial<LedgerEntry>> = [],
  byAccountId: Map<string, Partial<Account>> = new Map(),
  isInRange?: (date: unknown) => boolean
) => {
  const isRevenueSide = side === 'creditAccountId';
  let total = 0;
  let entryCount = 0;
  const transactions = new Set<string>();

  for (const entry of ledger || []) {
    if (!isPostedLedgerEntry(entry)) continue;
    if (isInRange && !isInRange((entry as any).date)) continue;

    const ref = String((entry as any)[side] || '').trim();
    if (!ref) continue;

    const account = byAccountId.get(ref);
    let qualifies: boolean;
    if (account) {
      qualifies = isRevenueSide ? isIncomeAccount(account) : isExpenseAccount(account);
    } else {
      // Fallback for ledgers whose account registry is unavailable: income is the
      // 4xxx range, expenses the 5xxx range.
      qualifies = isRevenueSide ? ref.startsWith('4') : ref.startsWith('5');
    }
    if (!qualifies) continue;

    total += toNumber((entry as any).amount);
    entryCount += 1;
    transactions.add(String((entry as any).referenceId || (entry as any).id || entryCount));
  }

  return { total: roundMoney(total), entryCount, transactionCount: transactions.size };
};

export const sumPostedIncomeCredits = (
  ledger: Array<Partial<LedgerEntry>> = [],
  accounts: Array<Partial<Account>> = [],
  isInRange?: (date: unknown) => boolean
): GlRevenueSummary => {
  const byAccountId = indexAccounts(accounts);
  const summary = sumPostedSide('creditAccountId', ledger, byAccountId, isInRange);
  return {
    glRevenue: summary.total,
    entryCount: summary.entryCount,
    transactionCount: summary.transactionCount,
  };
};

/**
 * Posted operating expenses — debits to expense accounts.
 *
 * Operating expenses must come from the ledger, not from the `expenses` document
 * table: the table misses everything posted through other paths (payroll runs,
 * wages, supplier payments) and includes rows still awaiting approval that never
 * reached the GL. Reading the ledger keeps "Net Contribution" on the same basis as
 * the GL Reconciliation tile.
 */
export const sumPostedExpenseDebits = (
  ledger: Array<Partial<LedgerEntry>> = [],
  accounts: Array<Partial<Account>> = [],
  isInRange?: (date: unknown) => boolean
): GlExpenseSummary => {
  const byAccountId = indexAccounts(accounts);
  const summary = sumPostedSide('debitAccountId', ledger, byAccountId, isInRange);
  return {
    glExpenses: summary.total,
    entryCount: summary.entryCount,
    transactionCount: summary.transactionCount,
  };
};

export interface RevenueGlReconciliation {
  documentRevenue: number;
  glRevenue: number;
  delta: number;
  withinTolerance: boolean;
  tolerance: number;
}

export const reconcileRevenueToGl = (
  documentRevenue: number,
  glRevenue: number
): RevenueGlReconciliation => {
  // The tolerance must be sized against the LARGER side. Deriving it from the
  // document figure meant that whenever documents were wrong (truncated, missing,
  // mis-dated) the tolerance collapsed with them and the check could never pass —
  // the exact failure mode it exists to catch.
  const tolerance = Math.max(1, Math.abs(Math.max(documentRevenue, glRevenue)) * 0.005);
  const delta = roundMoney(glRevenue - documentRevenue);
  return {
    documentRevenue,
    glRevenue,
    delta,
    tolerance: roundMoney(tolerance),
    withinTolerance: Math.abs(delta) <= tolerance,
  };
};
