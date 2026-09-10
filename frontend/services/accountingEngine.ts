/**
 * Canonical Accounting Engine — single source of truth for balance math.
 *
 * Every reporting surface (Chart of Accounts, Trial Balance, Balance Sheet,
 * P&L, Banking book balances, dashboard widgets) must derive its numbers
 * from these pure functions so that:
 *
 *   SALE → JOURNAL → JOURNAL LINES → OWN BALANCES → HIERARCHY → REPORTS
 *
 * produces one authoritative mathematical result.
 *
 * Conventions (preserved from the established codebase behaviour):
 * - Balances are "normal-positive": Asset/Expense accounts report
 *   (debits − credits); Liability/Equity/Income report (credits − debits).
 * - A posting account's OWN balance = opening_balance + posted ledger.
 * - Parent accounts are DISPLAY rollups (own + descendants) only.
 * - Type totals and trial-balance validation use OWN balances so that a
 *   balance counted at a leaf is never counted again at its ancestors,
 *   regardless of hierarchy depth.
 * - Offsetting reversal/void entries are ordinary posted entries (they net
 *   to zero). Only explicitly marked draft/void/reversal records are
 *   excluded from reports.
 *
 * All functions are pure (no IndexedDB / network access) so they are fully
 * unit-testable. Callers pass in the accounts + ledger slices they already
 * hold (Zustand store, FinanceContext, dbService results).
 */

import type { Account, LedgerEntry } from '../types';

export type CanonicalAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

/** Currency tolerance for balance comparisons (matches existing 0.01 usage). */
export const BALANCE_TOLERANCE = 0.01;

export function round2(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Normalise any legacy/display account-type value to the canonical form. */
export function getCanonicalAccountType(account: Partial<Account> | null | undefined): CanonicalAccountType {
  const raw = String(
    (account as { account_type?: unknown })?.account_type ??
    (account as { type?: unknown })?.type ??
    ''
  ).trim().toUpperCase();
  switch (raw) {
    case 'ASSET':
      return 'ASSET';
    case 'LIABILITY':
      return 'LIABILITY';
    case 'EQUITY':
      return 'EQUITY';
    case 'INCOME':
    case 'REVENUE':
      return 'INCOME';
    case 'EXPENSE':
      return 'EXPENSE';
    default:
      return 'ASSET';
  }
}

export function isDebitNormalType(type: CanonicalAccountType): boolean {
  return type === 'ASSET' || type === 'EXPENSE';
}

/** Normal balance for an account; an explicit valid normal_balance wins. */
export function getNormalBalance(account: Partial<Account> | null | undefined): 'DEBIT' | 'CREDIT' {
  const explicit = String(
    (account as { normal_balance?: unknown })?.normal_balance ?? ''
  ).trim().toUpperCase();
  if (explicit === 'DEBIT' || explicit === 'CREDIT') return explicit;
  return isDebitNormalType(getCanonicalAccountType(account)) ? 'DEBIT' : 'CREDIT';
}

/**
 * A posting account is any account not explicitly closed to posting.
 * (Matches resolveAccountForPosting: only allow_posting === false | 0 blocks.)
 */
export function isPostingAccount(account: Partial<Account> | null | undefined): boolean {
  const flag = (account as { allow_posting?: unknown })?.allow_posting;
  return flag !== false && flag !== 0;
}

const EXCLUDED_ENTRY_STATUSES = new Set(['DRAFT', 'VOID', 'VOIDED', 'DELETED', 'CANCELLED']);

/**
 * Whether a ledger row participates in posted accounting reports.
 * Preserves existing semantics: rows explicitly marked as reversals
 * (entryType / referenceType) or as draft/void/deleted are excluded.
 * Valid posted entries — including offsetting reversal/void entries written
 * with swapped sides — are included so that they net against the original.
 */
export function isPostedLedgerEntry(entry: Partial<LedgerEntry> | null | undefined): boolean {
  if (!entry) return false;
  if (entry.entryType === 'Reversal' || (entry as { referenceType?: unknown }).referenceType === 'reversal') return false;
  const status = String((entry as { status?: unknown }).status ?? '').trim().toUpperCase();
  if (status && EXCLUDED_ENTRY_STATUSES.has(status)) return false;
  return true;
}

/** All identifiers under which an account can be referenced by a ledger row. */
export function accountIdentifiers(account: Partial<Account>): string[] {
  const ids = new Set<string>();
  const push = (v: unknown) => {
    const s = String(v ?? '').trim();
    if (s) ids.add(s);
  };
  push((account as { id?: unknown }).id);
  push((account as { code?: unknown }).code);
  push((account as { account_number?: unknown }).account_number);
  return [...ids];
}

function entryRef(entry: Partial<LedgerEntry>, side: 'debit' | 'credit'): string {
  return String(side === 'debit' ? entry.debitAccountId ?? '' : entry.creditAccountId ?? '').trim();
}

/** True when a ledger row touches the account on the given side (id/code/number). */
export function entryTouchesAccount(
  entry: Partial<LedgerEntry>,
  account: Partial<Account>,
  side: 'debit' | 'credit'
): boolean {
  const ref = entryRef(entry, side);
  if (!ref) return false;
  return accountIdentifiers(account).includes(ref);
}

/**
 * Resolve a parent_account_id reference (which may be stored as an id, a
 * code, or an account_number) to the parent's canonical account id.
 * Returns null for roots, dangling references, and self-references.
 */
export function resolveParentAccountId(
  account: Partial<Account> & { id?: unknown },
  accounts: Array<Partial<Account> & { id?: unknown }>
): string | null {
  const parentRef = String(
    (account as { parent_account_id?: unknown }).parent_account_id ?? ''
  ).trim();
  if (!parentRef) return null;
  const selfId = String(account.id ?? '').trim();
  if (parentRef === selfId) return null; // self-parent guard (legacy data)
  const parent = accounts.find((a) => accountIdentifiers(a).includes(parentRef));
  if (!parent) return null; // dangling reference — treat as root
  const parentId = String(parent.id ?? '').trim();
  if (!parentId || parentId === selfId) return null;
  return parentId;
}

/** Children of a parent id, honouring id/code/number parent references. */
export function getChildAccounts(
  parentId: string,
  accounts: Array<Partial<Account> & { id?: unknown }>
): Array<Partial<Account> & { id?: unknown }> {
  return accounts.filter((a) => {
    if (String(a.id ?? '') === parentId) return false;
    return resolveParentAccountId(a, accounts) === parentId;
  });
}

/**
 * Compute OWN (pre-rollup) balances for every account, keyed by account id.
 * Normal-positive convention: DEBIT-normal accounts accumulate
 * (debits − credits); CREDIT-normal accumulate (credits − debits).
 * opening_balance is an additive starting point for every account.
 */
export function computeOwnBalances(
  accounts: Array<Partial<Account> & { id?: unknown }>,
  ledger: Array<Partial<LedgerEntry>>
): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (!id) continue;
    balances[id] = round2((acc as { opening_balance?: unknown }).opening_balance ?? 0);
  }
  for (const entry of ledger || []) {
    if (!isPostedLedgerEntry(entry)) continue;
    const amount = Number((entry as { amount?: unknown }).amount);
    if (!Number.isFinite(amount)) continue;
    for (const acc of accounts) {
      const id = String(acc.id ?? '').trim();
      if (!id || balances[id] === undefined) continue;
      const debitNormal = getNormalBalance(acc) === 'DEBIT';
      if (entryTouchesAccount(entry, acc, 'debit')) {
        balances[id] = round2(balances[id] + (debitNormal ? amount : -amount));
      }
      if (entryTouchesAccount(entry, acc, 'credit')) {
        balances[id] = round2(balances[id] + (debitNormal ? -amount : amount));
      }
    }
  }
  return balances;
}

/**
 * Recursive hierarchical rollup for DISPLAY purposes only.
 * parent balance = own balance + sum of descendant balances, at arbitrary
 * depth. Handles id/code/number parent links, treats dangling references as
 * roots, and is immune to parent/child cycles (visited-set guard).
 * Never mutates its inputs.
 */
export function computeHierarchicalRollup(
  accounts: Array<Partial<Account> & { id?: unknown }>,
  ownBalances: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = { ...ownBalances };
  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (id && result[id] === undefined) result[id] = 0;
  }

  const childrenByParent = new Map<string, string[]>();
  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (!id) continue;
    const parentId = resolveParentAccountId(acc, accounts);
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(id);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();

  const rollup = (accountId: string): number => {
    if (done.has(accountId)) return result[accountId] ?? 0;
    if (visiting.has(accountId)) {
      // Cycle detected (e.g. A→B→A): stop descending; keep own balance.
      return 0;
    }
    visiting.add(accountId);
    let total = result[accountId] ?? 0;
    for (const childId of childrenByParent.get(accountId) ?? []) {
      total = round2(total + rollup(childId));
    }
    visiting.delete(accountId);
    done.add(accountId);
    result[accountId] = total;
    return total;
  };

  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (id) rollup(id);
  }
  return result;
}

export interface TypeTotals {
  assets: number;
  liabilities: number;
  equity: number;
  income: number;
  expenses: number;
  netIncome: number;
}

/**
 * Canonical type totals. Sums OWN (pre-rollup) balances grouped by canonical
 * account type — each economic balance is therefore counted EXACTLY ONCE no
 * matter how deep the COA hierarchy is. Direct postings to non-posting
 * parents (legacy rows) are included via their own balance.
 */
export function computeTypeTotals(
  accounts: Array<Partial<Account> & { id?: unknown }>,
  ownBalances: Record<string, number>
): TypeTotals {
  const totals: TypeTotals = {
    assets: 0,
    liabilities: 0,
    equity: 0,
    income: 0,
    expenses: 0,
    netIncome: 0,
  };
  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (!id) continue;
    const balance = round2(ownBalances[id] ?? 0);
    if (balance === 0) continue;
    switch (getCanonicalAccountType(acc)) {
      case 'ASSET':
        totals.assets = round2(totals.assets + balance);
        break;
      case 'LIABILITY':
        totals.liabilities = round2(totals.liabilities + balance);
        break;
      case 'EQUITY':
        totals.equity = round2(totals.equity + balance);
        break;
      case 'INCOME':
        totals.income = round2(totals.income + balance);
        break;
      case 'EXPENSE':
        totals.expenses = round2(totals.expenses + balance);
        break;
    }
  }
  totals.netIncome = round2(totals.income - totals.expenses);
  return totals;
}

export interface TrialBalanceLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: CanonicalAccountType;
  totalDebit: number;
  totalCredit: number;
  /** Normal-positive balance (debits−credits for DEBIT-normal, inverse otherwise). */
  balance: number;
}

export interface TrialBalanceResult {
  lines: TrialBalanceLine[];
  totalDebits: number;
  totalCredits: number;
  difference: number;
  isBalanced: boolean;
}

/**
 * Authoritative trial balance. The ONLY correct validation is
 * total posted debits === total posted credits (within currency tolerance).
 * An individual account with debit ≠ credit (e.g. Sales with only credits)
 * is normal and is NEVER "out of balance" by itself.
 */
export function computeTrialBalance(
  accounts: Array<Partial<Account> & { id?: unknown }>,
  ledger: Array<Partial<LedgerEntry>>,
  options: { includeZeroActivity?: boolean; asOfDate?: string } = {}
): TrialBalanceResult {
  const lines: TrialBalanceLine[] = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (const acc of accounts) {
    const id = String(acc.id ?? '').trim();
    if (!id) continue;
    let debit = 0;
    let credit = 0;
    for (const entry of ledger || []) {
      if (!isPostedLedgerEntry(entry)) continue;
      if (options.asOfDate) {
        const entryDay = String(entry.date ?? '').slice(0, 10);
        if (!entryDay || entryDay > options.asOfDate) continue;
      }
      const amount = Number((entry as { amount?: unknown }).amount);
      if (!Number.isFinite(amount)) continue;
      if (entryTouchesAccount(entry, acc, 'debit')) debit = round2(debit + amount);
      if (entryTouchesAccount(entry, acc, 'credit')) credit = round2(credit + amount);
    }
    const type = getCanonicalAccountType(acc);
    const balance = getNormalBalance(acc) === 'DEBIT' ? round2(debit - credit) : round2(credit - debit);
    if (!options.includeZeroActivity && debit === 0 && credit === 0 && balance === 0) continue;
    lines.push({
      accountId: id,
      accountCode: String(
        (acc as { account_number?: unknown }).account_number ??
        (acc as { code?: unknown }).code ??
        id
      ),
      accountName: String((acc as { name?: unknown }).name ?? id),
      accountType: type,
      totalDebit: debit,
      totalCredit: credit,
      balance,
    });
    totalDebits = round2(totalDebits + debit);
    totalCredits = round2(totalCredits + credit);
  }

  lines.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
  const difference = round2(totalDebits - totalCredits);
  return {
    lines,
    totalDebits,
    totalCredits,
    difference,
    isBalanced: Math.abs(difference) < BALANCE_TOLERANCE,
  };
}

export interface BalanceSheetCheck {
  balanced: boolean;
  difference: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  netIncome: number;
}

/**
 * Balance-sheet equation check that honours unclosed P&L:
 * Assets === Liabilities + Equity + (Income − Expenses).
 * Checking Assets === Liabilities + Equity while revenue sits unclosed in
 * Income accounts would report every profitable company as "out of balance".
 */
export function checkBalanceSheetEquation(totals: TypeTotals): BalanceSheetCheck {
  const rhs = round2(totals.liabilities + totals.equity + totals.netIncome);
  const difference = round2(totals.assets - rhs);
  return {
    balanced: Math.abs(difference) < BALANCE_TOLERANCE,
    difference,
    totalAssets: totals.assets,
    totalLiabilities: totals.liabilities,
    totalEquity: totals.equity,
    netIncome: totals.netIncome,
  };
}

export interface ReconciliationReport {
  postedJournalCount: number;
  postedLineCount: number;
  totalDebits: number;
  totalCredits: number;
  difference: number;
  balanced: boolean;
  totals: TypeTotals;
  balanceSheet: BalanceSheetCheck;
  perType: Array<{
    type: CanonicalAccountType;
    ownTotal: number;
    rollupRootTotal: number;
    difference: number;
  }>;
  hierarchicalBalances: Record<string, number>;
  ownBalances: Record<string, number>;
}

/**
 * Full reconciliation diagnostic (development/test use): cross-checks
 * journal totals, own-balance type totals, and hierarchical rollups.
 * rollupRootTotal sums the DISPLAY rollup at hierarchy roots; it must equal
 * ownTotal — any difference pinpoints double counting or a broken rollup.
 */
export function buildReconciliation(
  accounts: Array<Partial<Account> & { id?: unknown }>,
  ledger: Array<Partial<LedgerEntry>>
): ReconciliationReport {
  const posted = (ledger || []).filter(isPostedLedgerEntry);
  const ownBalances = computeOwnBalances(accounts, ledger);
  const hierarchicalBalances = computeHierarchicalRollup(accounts, ownBalances);
  const totals = computeTypeTotals(accounts, ownBalances);
  const trial = computeTrialBalance(accounts, ledger);

  const rootIds = (accounts || [])
    .map((a) => String(a.id ?? '').trim())
    .filter((id) => {
      if (!id) return false;
      const acc = accounts.find((x) => String(x.id ?? '') === id);
      return acc ? resolveParentAccountId(acc, accounts) === null : true;
    });

  const rollupSumFor = (type: CanonicalAccountType): number => {
    let sum = 0;
    for (const id of rootIds) {
      const acc = accounts.find((x) => String(x.id ?? '') === id);
      if (acc && getCanonicalAccountType(acc) === type) {
        sum = round2(sum + (hierarchicalBalances[id] ?? 0));
      }
    }
    return sum;
  };

  const ownFor = (type: CanonicalAccountType): number => {
    switch (type) {
      case 'ASSET':
        return totals.assets;
      case 'LIABILITY':
        return totals.liabilities;
      case 'EQUITY':
        return totals.equity;
      case 'INCOME':
        return totals.income;
      case 'EXPENSE':
        return totals.expenses;
    }
  };

  const types: CanonicalAccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
  const perType = types.map((type) => {
    const ownTotal = ownFor(type);
    const rollupRootTotal = rollupSumFor(type);
    return { type, ownTotal, rollupRootTotal, difference: round2(ownTotal - rollupRootTotal) };
  });

  return {
    postedJournalCount: posted.length,
    postedLineCount: posted.length,
    totalDebits: trial.totalDebits,
    totalCredits: trial.totalCredits,
    difference: trial.difference,
    balanced: trial.isBalanced,
    totals,
    balanceSheet: checkBalanceSheetEquation(totals),
    perType,
    hierarchicalBalances,
    ownBalances,
  };
}

/** Human-readable rendering of buildReconciliation (dev/test diagnostics). */
export function formatReconciliation(report: ReconciliationReport, currencySymbol = 'K'): string {
  const money = (n: number) => `${currencySymbol}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const section = (label: string, ownTotal: number, rollupRootTotal: number) =>
    `--- ${label} ---\n` +
    `Leaf/posting accounts: ${money(ownTotal)}\n` +
    `Parent rollup:          ${money(rollupRootTotal)}\n` +
    `Difference:             ${money(ownTotal - rollupRootTotal)}\n`;
  const find = (t: CanonicalAccountType) => report.perType.find((p) => p.type === t)!;
  const lines = [
    '=== ACCOUNTING RECONCILIATION ===',
    '',
    `Posted journals: ${report.postedJournalCount}`,
    `Posted journal lines: ${report.postedLineCount}`,
    '',
    `Total Debits:  ${money(report.totalDebits)}`,
    `Total Credits: ${money(report.totalCredits)}`,
    `Difference:    ${money(report.difference)}`,
    `Balanced:      ${report.balanced ? 'YES' : 'NO'}`,
    '',
    section('ASSETS', find('ASSET').ownTotal, find('ASSET').rollupRootTotal),
    section('LIABILITIES', find('LIABILITY').ownTotal, find('LIABILITY').rollupRootTotal),
    section('EQUITY', find('EQUITY').ownTotal, find('EQUITY').rollupRootTotal),
    section('INCOME', find('INCOME').ownTotal, find('INCOME').rollupRootTotal),
    section('EXPENSES', find('EXPENSE').ownTotal, find('EXPENSE').rollupRootTotal),
    `Balance-sheet equation (A = L + E + P&L): ${report.balanceSheet.balanced ? 'BALANCED' : 'OUT OF BALANCE'} ` +
      `(diff ${money(report.balanceSheet.difference)})`,
  ];
  return lines.join('\n');
}
