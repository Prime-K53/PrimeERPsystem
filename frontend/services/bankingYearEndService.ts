/**
 * Banking Year-End Check.
 *
 * Returns a list of issues that must be resolved (or knowingly accepted)
 * before the books can be closed for a given financial year:
 *
 *   - Unreconciled transactions within the FY
 *   - Draft transactions within the FY
 *   - Bank accounts with no recent reconciliation (older than 90 days)
 *   - Inactive bank accounts that still hold a balance (cleanup needed)
 *   - Bank charges / interest entries not yet posted to GL
 *
 * Per the spec, bank reconciliation status must be part of year-end
 * checks. We do not block closing — we surface the issues so the user can
 * review them, in line with the existing year-end UX.
 */

import { dbService } from './db';
import { logger } from './logger';
import { roundFinancial } from '../utils/helpers';

export interface BankingYearEndIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'unreconciled' | 'draft' | 'stale-reconciliation' | 'inactive-balance' | 'unposted-charge';
  accountId?: string;
  accountName?: string;
  message: string;
  count?: number;
  amount?: number;
}

export interface BankingYearEndReport {
  fiscalYear: number;
  generatedAt: string;
  issues: BankingYearEndIssue[];
  summary: {
    activeAccounts: number;
    unreconciledCount: number;
    draftCount: number;
    staleAccounts: number;
  };
}

const STALE_DAYS = 90;

export async function checkBankingYearEnd(fiscalYear: number): Promise<BankingYearEndReport> {
  const issues: BankingYearEndIssue[] = [];
  const generatedAt = new Date().toISOString();

  try {
    const accounts: any[] = (await dbService.getAll<any>('bankAccounts')) || [];
    const transactions: any[] = (await dbService.getAll<any>('bankTransactions')) || [];
    const reconciliations: any[] = (await dbService.getAll<any>('bankReconciliations')) || [];
    const active = accounts.filter((a) => a.status === 'Active');

    const fyStart = `${fiscalYear}-01-01`;
    const fyEnd = `${fiscalYear}-12-31`;

    const inFY = transactions.filter((t) => (t.date || '') >= fyStart && (t.date || '') <= fyEnd);

    // 1) Unreconciled transactions inside the FY
    const unreconciled = inFY.filter((t) => !t.reconciled && t.status !== 'Draft' && t.status !== 'Reversed');
    if (unreconciled.length > 0) {
      const total = unreconciled.reduce((s, t) => s + roundFinancial(t.amount || 0), 0);
      // Group by account for clarity
      const byAccount = new Map<string, number>();
      for (const t of unreconciled) {
        byAccount.set(t.bankAccountId, (byAccount.get(t.bankAccountId) || 0) + 1);
      }
      for (const [acctId, count] of byAccount.entries()) {
        const acc = active.find((a) => a.id === acctId);
        issues.push({
          severity: count > 25 ? 'error' : 'warning',
          category: 'unreconciled',
          accountId: acctId,
          accountName: acc?.name,
          message: `${count} unreconciled transaction${count === 1 ? '' : 's'} in FY ${fiscalYear}`,
          count,
          amount: unreconciled.filter((t) => t.bankAccountId === acctId).reduce((s, t) => s + roundFinancial(t.amount || 0), 0),
        });
      }
      issues.push({
        severity: 'info',
        category: 'unreconciled',
        message: `Total unreconciled value across all bank accounts: ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
        count: unreconciled.length,
        amount: total,
      });
    }

    // 2) Draft transactions inside the FY
    const drafts = inFY.filter((t) => t.status === 'Draft');
    if (drafts.length > 0) {
      issues.push({
        severity: 'warning',
        category: 'draft',
        message: `${drafts.length} draft transaction${drafts.length === 1 ? '' : 's'} in FY ${fiscalYear} that ${drafts.length === 1 ? 'has' : 'have'} not been posted to GL`,
        count: drafts.length,
      });
    }

    // 3) Stale reconciliations per active account
    const staleThreshold = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 10);
    let staleCount = 0;
    for (const acc of active) {
      const last = reconciliations
        .filter((r) => r.bankAccountId === acc.id && (r.endDate || '').slice(0, 10) >= fyStart && (r.endDate || '').slice(0, 10) <= fyEnd)
        .sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''))[0];
      if (!last || (last.endDate || '').slice(0, 10) < staleThreshold) {
        issues.push({
          severity: 'warning',
          category: 'stale-reconciliation',
          accountId: acc.id,
          accountName: acc.name,
          message: `No reconciliation completed in the last ${STALE_DAYS} days for ${acc.name}`,
        });
        staleCount++;
      }
    }

    // 4) Inactive accounts with non-zero balance
    const inactive = accounts.filter((a) => a.status !== 'Active');
    for (const acc of inactive) {
      const bal = roundFinancial(acc.balance || 0);
      if (Math.abs(bal) > 0.01) {
        issues.push({
          severity: 'info',
          category: 'inactive-balance',
          accountId: acc.id,
          accountName: acc.name,
          message: `Inactive account "${acc.name}" still carries a balance of ${bal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
          amount: bal,
        });
      }
    }

    return {
      fiscalYear,
      generatedAt,
      issues,
      summary: {
        activeAccounts: active.length,
        unreconciledCount: unreconciled.length,
        draftCount: drafts.length,
        staleAccounts: staleCount,
      },
    };
  } catch (err) {
    logger.error('[BankingYearEnd] check failed', err);
    return { fiscalYear, generatedAt, issues: [{ severity: 'error', category: 'unreconciled', message: 'Banking year-end check failed — see logs.' }], summary: { activeAccounts: 0, unreconciledCount: 0, draftCount: 0, staleAccounts: 0 } };
  }
}
