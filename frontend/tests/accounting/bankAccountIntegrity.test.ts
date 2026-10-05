/**
 * bankAccountIntegrity.test.ts
 *
 * Locks the bank-balance integrity contract behind the K-3,413,300 COA
 * investigation (single-company, 5-digit COA, no tenant fields):
 *
 *  1. Display fidelity — the Dashboard/COA "Bank Account" figure is the
 *     normal-positive rollup of BANK-subtype asset accounts (debits minus
 *     credits). A credit excess renders negative (e.g. K-3,413,300); the
 *     display never inverts the sign and never drops BANK-subtype postings.
 *  2. Engine trial balance — every bank movement used here is a balanced
 *     debit/credit pair, so the trial balance stays balanced regardless of
 *     the bank total's sign.
 *  3. COA guardrails — 11200 "Bank Accounts" is a non-postable GROUP parent,
 *     11210/11220/11230 are postable leaves, 54000 is a non-postable group
 *     (no rounding contamination route), legacy 1050 stays outside the
 *     canonical 11200 hierarchy.
 *  4. No silent sign flip — asset/bank legs keep debit-positive math even
 *     when the resulting balance is negative (a negative bank total is a
 *     data state, never a display artefact).
 */
import { describe, it, expect } from 'vitest';
import {
  computeOwnBalances,
  computeHierarchicalRollup,
  computeTrialBalance,
  computeTypeTotals,
  getNormalBalance,
  getCanonicalAccountType,
  isPostingAccount,
  classifyAccount,
  isPostedLedgerEntry,
} from '../../services/accountingEngine';

const bankParent = {
  id: 'ACC-11200',
  code: '11200',
  account_number: '11200',
  name: 'Bank Accounts',
  account_type: 'ASSET',
  type: 'Asset',
  subtype: 'BANK',
  parent_account_id: 'ACC-11000',
  allow_posting: false,
  normal_balance: 'DEBIT',
  is_active: true,
  opening_balance: 0,
};

const nationalBank = {
  id: 'ACC-11210',
  code: '11210',
  account_number: '11210',
  name: 'National Bank',
  account_type: 'ASSET',
  type: 'Asset',
  subtype: 'BANK',
  parent_account_id: 'ACC-11200',
  allow_posting: true,
  normal_balance: 'DEBIT',
  is_active: true,
  opening_balance: 0,
};

const fdhBank = {
  id: 'ACC-11220',
  code: '11220',
  account_number: '11220',
  name: 'FDH Bank',
  account_type: 'ASSET',
  type: 'Asset',
  subtype: 'BANK',
  parent_account_id: 'ACC-11200',
  allow_posting: true,
  normal_balance: 'DEBIT',
  is_active: true,
  opening_balance: 0,
};

const roundingGroup = {
  id: 'ACC-54000',
  code: '54000',
  account_number: '54000',
  name: 'Other Expenses',
  account_type: 'EXPENSE',
  type: 'Expense',
  parent_account_id: 'ACC-50000',
  allow_posting: false,
  normal_balance: 'DEBIT',
  is_active: true,
  opening_balance: 0,
};

const accounts = [bankParent, nationalBank, fdhBank, roundingGroup] as any[];

/** Mirror of the Dashboard bank widget math (views/Dashboard.tsx:919-954). */
const dashboardBankBalance = (accs: any[], ledger: any[]): number => {
  const ledgerBalances: Record<string, number> = {};
  accs.forEach((acc: any) => { ledgerBalances[acc.id] = 0; });
  (ledger || []).forEach((entry: any) => {
    if (entry.amount == null) return;
    const debitAcc = accs.find((a: any) => a.id === entry.debitAccountId || a.code === entry.debitAccountId);
    const creditAcc = accs.find((a: any) => a.id === entry.creditAccountId || a.code === entry.creditAccountId);
    const isAssetOrExpense = (acc: any) => {
      const t = acc.type || acc.account_type || '';
      return t === 'Asset' || t === 'ASSET' || t === 'Expense' || t === 'EXPENSE';
    };
    if (debitAcc) ledgerBalances[debitAcc.id] += entry.amount * (isAssetOrExpense(debitAcc) ? 1 : -1);
    if (creditAcc) ledgerBalances[creditAcc.id] += entry.amount * (isAssetOrExpense(creditAcc) ? -1 : 1);
  });
  let bank = 0;
  accs.forEach((acc: any) => {
    if (acc.type !== 'Asset' && acc.account_type !== 'ASSET') return;
    const name = String(acc.name || '').toLowerCase();
    const subtype = String(acc.subtype || '').toUpperCase();
    const bal = ledgerBalances[acc.id] ?? 0;
    if (subtype === 'BANK' || (!subtype && (name.includes('bank') || name.includes('mobile')))) bank += bal;
  });
  return bank;
};

const leg = (debitAccountId: string, creditAccountId: string, amount: number, ref: string, description: string) => ({
  id: `LG-TEST-${ref}`,
  date: '2026-09-20T00:00:00.000Z',
  description,
  debitAccountId,
  creditAccountId,
  amount,
  referenceId: ref,
  reconciled: false,
});

describe('bank account integrity (K-3,413,300 investigation)', () => {
  it('COA guardrails: 11200 is a non-postable GROUP, leaves postable, 54000 non-postable', () => {
    expect(classifyAccount(bankParent as any)).toBe('GROUP');
    expect(isPostingAccount(bankParent as any)).toBe(false);
    expect(classifyAccount(nationalBank as any)).toBe('POSTING');
    expect(classifyAccount(fdhBank as any)).toBe('POSTING');
    expect(classifyAccount(roundingGroup as any)).toBe('GROUP');
    expect(getNormalBalance(nationalBank as any)).toBe('DEBIT');
    expect(getCanonicalAccountType(nationalBank as any)).toBe('ASSET');
    expect(getNormalBalance(roundingGroup as any)).toBe('DEBIT');
  });

  it('display fidelity: credit excess on BANK-subtype assets renders exactly negative', () => {
    // Receipt Dr bank 1,000,000 / supplier+expense outs Cr bank 4,413,300.
    const ledger = [
      leg('ACC-11210', 'ACC-11310', 1000000, 'RCPT-1', 'Customer receipt'),
      leg('ACC-21110', 'ACC-11210', 3000000, 'SPAY-1', 'Supplier payment'),
      leg('ACC-52000', 'ACC-11210', 1413300, 'EXP-1', 'Expense payment'),
    ];
    expect(dashboardBankBalance(accounts, ledger)).toBe(-3413300);
    const own = computeOwnBalances(accounts, ledger as any);
    expect(own['ACC-11210']).toBe(-3413300);
    // Hierarchical rollup carries the parent to the same total (own 0 + child).
    const rollup = computeHierarchicalRollup(accounts, own);
    expect(rollup['ACC-11200']).toBe(-3413300);
    expect(rollup['ACC-11210']).toBe(-3413300);
  });

  it('trial balance stays balanced when bank is negative (balanced pairs)', () => {
    const ledger = [
      leg('ACC-11210', 'ACC-11310', 1000000, 'RCPT-1', 'Customer receipt'),
      leg('ACC-21110', 'ACC-11210', 3000000, 'SPAY-1', 'Supplier payment'),
      leg('ACC-52000', 'ACC-11210', 1413300, 'EXP-1', 'Expense payment'),
    ];
    const trial = computeTrialBalance(
      [...accounts, { id: 'ACC-11310', code: '11310', name: 'AR', account_type: 'ASSET', normal_balance: 'DEBIT' }, { id: 'ACC-21110', code: '21110', name: 'AP', account_type: 'LIABILITY', normal_balance: 'CREDIT' }, { id: 'ACC-52000', code: '52000', name: 'Expenses', account_type: 'EXPENSE', normal_balance: 'DEBIT' }] as any,
      ledger as any
    );
    expect(trial.isBalanced).toBe(true);
    expect(trial.difference).toBe(0);
  });

  it('type totals count each bank posting exactly once (no parent double-count)', () => {
    const ledger = [leg('ACC-21110', 'ACC-11210', 500000, 'SPAY-9', 'Supplier payment')];
    const own = computeOwnBalances(
      [...accounts, { id: 'ACC-21110', code: '21110', name: 'AP', account_type: 'LIABILITY', normal_balance: 'CREDIT' }] as any,
      ledger as any
    );
    const totals = computeTypeTotals(
      [...accounts, { id: 'ACC-21110', code: '21110', name: 'AP', account_type: 'LIABILITY', normal_balance: 'CREDIT' }] as any,
      own
    );
    // 11210 own = -500000; parent 11200 own = 0 → assets total counts -500000 once.
    expect(own['ACC-11200']).toBe(0);
    expect(own['ACC-11210']).toBe(-500000);
    expect(totals.assets).toBe(-500000);
  });

  it('void/reversal rows are ordinary posted rows that net (not excluded)', () => {
    const ledger = [
      leg('ACC-21110', 'ACC-11210', 200000, 'SPAY-2', 'Supplier payment'),
      { ...leg('ACC-11210', 'ACC-21110', 200000, 'SPAY-2', 'REVERSAL: Supplier payment'), id: 'LG-REV-1' },
    ];
    expect(ledger.every(isPostedLedgerEntry)).toBe(true);
    const own = computeOwnBalances([nationalBank, { id: 'ACC-21110', code: '21110', name: 'AP', account_type: 'LIABILITY', normal_balance: 'CREDIT' }] as any, ledger as any);
    expect(own['ACC-11210']).toBe(0);
  });

  it('no tenant/company discriminator in bank balance inputs', () => {
    for (const acc of accounts) {
      expect('tenant_id' in (acc as any)).toBe(false);
      expect('organization_id' in (acc as any)).toBe(false);
      expect('company_id' in (acc as any)).toBe(false);
    }
  });
});
