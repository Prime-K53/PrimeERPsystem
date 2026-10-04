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

export interface GlExpenseSplit {
  /** Signed total of all posted expense debits (COGS + operating). */
  total: number;
  /** Posted debits to Cost of Goods Sold (account group COST_OF_SALES / 51200). */
  cogs: number;
  /** Posted debits to all other expense accounts. */
  operating: number;
  entryCount: number;
  transactionCount: number;
}

/** Canonical Cost of Goods Sold account code. */
export const COGS_ACCOUNT_CODE = '51200';

/**
 * True when the resolved account is the Cost of Goods Sold account.
 * Prefers the chart-of-accounts grouping (`account_group: COST_OF_SALES`);
 * falls back to the canonical 51200 code (including id-style refs such as
 * `ACC-51200`) when the account registry is unavailable.
 */
export const isCogsAccount = (
  account: Partial<Account> | null | undefined,
  ref: string,
): boolean => {
  if (account) {
    const group = String((account as any).account_group || '').trim().toUpperCase();
    if (group === 'COST_OF_SALES') return true;
    for (const key of [account.id, (account as any).code, (account as any).account_number]) {
      if (String(key || '').trim() === COGS_ACCOUNT_CODE) return true;
    }
    return false;
  }
  return String(ref || '').replace(/\D/g, '') === COGS_ACCOUNT_CODE;
};

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
  const split = splitPostedExpenseDebits(ledger, accounts, isInRange);
  return {
    glExpenses: split.total,
    entryCount: split.entryCount,
    transactionCount: split.transactionCount,
  };
};

/**
 * Posted expense debits split into Cost of Goods Sold vs operating expenses.
 *
 * Same authoritative population as `sumPostedExpenseDebits` (posted ledger
 * rows only, expense accounts only): COGS is the 51200 / COST_OF_SALES leg
 * posted automatically by sales, invoices, work orders and inventory
 * consumption — legitimate expense-side GL activity that never creates an
 * `expenses` document row. Everything else debited to an expense account is
 * reported as operating expenses. An empty manual-expense table therefore
 * never implies zero expenses.
 */
export const splitPostedExpenseDebits = (
  ledger: Array<Partial<LedgerEntry>> = [],
  accounts: Array<Partial<Account>> = [],
  isInRange?: (date: unknown) => boolean
): GlExpenseSplit => {
  const byAccountId = indexAccounts(accounts);
  let total = 0;
  let cogs = 0;
  let operating = 0;
  let entryCount = 0;
  const transactions = new Set<string>();

  for (const entry of ledger || []) {
    if (!isPostedLedgerEntry(entry)) continue;
    if (isInRange && !isInRange((entry as any).date)) continue;

    const ref = String((entry as any).debitAccountId || '').trim();
    if (!ref) continue;

    const account = byAccountId.get(ref);
    if (account) {
      if (!isExpenseAccount(account)) continue;
    } else if (!ref.startsWith('5')) {
      continue;
    }

    const amount = toNumber((entry as any).amount);
    total += amount;
    if (isCogsAccount(account || null, ref)) cogs += amount;
    else operating += amount;
    entryCount += 1;
    transactions.add(String((entry as any).referenceId || (entry as any).id || entryCount));
  }

  return {
    total: roundMoney(total),
    cogs: roundMoney(cogs),
    operating: roundMoney(operating),
    entryCount,
    transactionCount: transactions.size,
  };
};

export interface PostedExpenseRecord {
  amount: number;
  /** Ledger entry date (mirrors LedgerEntry.date). */
  date: string;
  category: string;
  accountCode: string;
  referenceId: string;
  description: string;
}

/**
 * Posted expense legs mapped to plain expense-like records for consumers
 * that summarize expense rows (category breakdowns, recent-activity lists).
 * Amounts, dates and categories come from posted GL debits — never from the
 * manual `expenses` document table. Sorted newest-first.
 */
export const mapPostedExpenseLegs = (
  ledger: Array<Partial<LedgerEntry>> = [],
  accounts: Array<Partial<Account>> = [],
  isInRange?: (date: unknown) => boolean
): PostedExpenseRecord[] => {
  const byAccountId = indexAccounts(accounts);
  const records: PostedExpenseRecord[] = [];

  for (const entry of ledger || []) {
    if (!isPostedLedgerEntry(entry)) continue;
    if (isInRange && !isInRange((entry as any).date)) continue;

    const ref = String((entry as any).debitAccountId || '').trim();
    if (!ref) continue;

    const account = byAccountId.get(ref);
    if (account) {
      if (!isExpenseAccount(account)) continue;
    } else if (!ref.startsWith('5')) {
      continue;
    }

    const name =
      String((account as any)?.name || '').trim() ||
      String((account as any)?.code || (account as any)?.account_number || ref).trim() ||
      'Expense';
    records.push({
      amount: toNumber((entry as any).amount),
      date: String((entry as any).date ?? ''),
      category: name,
      accountCode:
        String((account as any)?.code || (account as any)?.account_number || ref).trim(),
      referenceId: String((entry as any).referenceId || (entry as any).id || ''),
      description: String((entry as any).description || ''),
    });
  }

  records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return records;
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
