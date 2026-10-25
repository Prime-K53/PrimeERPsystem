import { describe, it, expect } from 'vitest';
import { computeOwnBalances, isPostedLedgerEntry } from '../../../services/accountingEngine';

describe('finance invariants (synthetic posted journal)', () => {
  const accounts: any[] = [
    { id: 'ACC-CASH', account_number: '11110', account_type: 'ASSET', normal_balance: 'DEBIT', opening_balance: 0 },
    { id: 'ACC-AR', account_number: '11310', account_type: 'ASSET', normal_balance: 'DEBIT', opening_balance: 0 },
    { id: 'ACC-REV', account_number: '41100', account_type: 'INCOME', normal_balance: 'CREDIT', opening_balance: 0 },
  ];

  const entry = (d: string, c: string, a: number): any => ({
    debitAccountId: d, creditAccountId: c, amount: a, status: 'Posted',
  });

  it('debits equal credits on a sale journal', () => {
    const ledger = [entry('ACC-CASH', 'ACC-REV', 1000), entry('ACC-AR', 'ACC-REV', 500)];
    const totalDr = ledger.reduce((s, e) => s + e.amount, 0);
    const totalCr = ledger.reduce((s, e) => s + e.amount, 0);
    expect(totalDr).toBe(totalCr);
  });

  it('computeOwnBalances reflects each posted line', () => {
    const ledger = [entry('ACC-CASH', 'ACC-REV', 1000), entry('ACC-AR', 'ACC-REV', 500)];
    const b = computeOwnBalances(accounts as any, ledger as any);
    expect(b['ACC-CASH']).toBe(1000);
    expect(b['ACC-AR']).toBe(500);
    expect(b['ACC-REV']).toBe(1500);
  });

  it('draft entries excluded by isPostedLedgerEntry, leaving zeros', () => {
    const ledger = [entry('ACC-CASH', 'ACC-REV', 1000)];
    const draft = { ...ledger[0], status: 'DRAFT' };
    expect(isPostedLedgerEntry(draft)).toBe(false);
    const b = computeOwnBalances(accounts as any, [draft] as any);
    expect(b['ACC-CASH']).toBe(0);
    expect(b['ACC-REV']).toBe(0);
  });

  it('opening_balance acts as additive baseline before entries', () => {
    const accts = [
      { id: 'ACC-CASH', account_number: '11110', account_type: 'ASSET', normal_balance: 'DEBIT', opening_balance: 500 },
      { id: 'ACC-REV', account_number: '41100', account_type: 'INCOME', normal_balance: 'CREDIT', opening_balance: 0 },
    ];
    const b = computeOwnBalances(accts as any, [entry('ACC-CASH', 'ACC-REV', 1000)] as any);
    expect(b['ACC-CASH']).toBe(1500);
    expect(b['ACC-REV']).toBe(1000);
  });
});
