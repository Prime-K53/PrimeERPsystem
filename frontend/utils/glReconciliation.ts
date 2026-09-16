import { isPostedLedgerEntry } from '../services/accountingEngine';
import { isIncomeAccount } from './accountType';
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

const toNumber = (value: unknown): number => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

export const sumPostedIncomeCredits = (
  ledger: Array<Partial<LedgerEntry>> = [],
  accounts: Array<Partial<Account>> = [],
  isInRange?: (date: unknown) => boolean
): GlRevenueSummary => {
  const byId = new Map<string, Partial<Account>>();
  for (const account of accounts || []) {
    if (!account) continue;
    for (const key of [account.id, (account as any).code, (account as any).account_number]) {
      const k = String(key || '').trim();
      if (k) byId.set(k, account);
    }
  }
  const isIncomeCredit = (entry: Partial<LedgerEntry>): boolean => {
    const ref = String(entry.creditAccountId || '').trim();
    if (!ref) return false;
    const account = byId.get(ref);
    if (account) return isIncomeAccount(account);
    // Fallback for ledgers whose account registry is unavailable.
    return ref.startsWith('4');
  };

  let glRevenue = 0;
  let entryCount = 0;
  const transactions = new Set<string>();
  for (const entry of ledger || []) {
    if (!isPostedLedgerEntry(entry)) continue;
    if (isInRange && !isInRange((entry as any).date)) continue;
    if (!isIncomeCredit(entry)) continue;
    glRevenue += toNumber((entry as any).amount);
    entryCount += 1;
    transactions.add(String((entry as any).referenceId || (entry as any).id || entryCount));
  }
  return {
    glRevenue: Math.round((glRevenue + Number.EPSILON) * 100) / 100,
    entryCount,
    transactionCount: transactions.size,
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
  const tolerance = Math.max(1, Math.abs(documentRevenue) * 0.005);
  const delta = Math.round(((glRevenue - documentRevenue + Number.EPSILON)) * 100) / 100;
  return {
    documentRevenue,
    glRevenue,
    delta,
    tolerance: Math.round((tolerance + Number.EPSILON) * 100) / 100,
    withinTolerance: Math.abs(delta) <= tolerance,
  };
};
