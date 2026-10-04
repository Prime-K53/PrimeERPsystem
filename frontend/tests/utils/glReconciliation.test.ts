import { describe, expect, it } from 'vitest';
import {
  mapPostedExpenseLegs,
  reconcileRevenueToGl,
  splitPostedExpenseDebits,
  sumPostedExpenseDebits,
  sumPostedIncomeCredits,
} from '../../utils/glReconciliation';

const accounts = [
  { id: 'ACC-41100', code: '41100', account_type: 'INCOME' },
  { id: 'ACC-51200', code: '51200', account_type: 'EXPENSE' },
  { id: 'ACC-11110', code: '11110', account_type: 'ASSET' },
];

const ledger = [
  { id: 'L1', date: '2026-04-10', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-41100', amount: 1000, referenceId: 'INV-1' },
  { id: 'L2', date: '2026-04-12', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11110', amount: 250, referenceId: 'EXP-1' },
  { id: 'L3', date: '2026-03-01', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-41100', amount: 9999, referenceId: 'INV-OLD' },
  { id: 'L4', date: '2026-04-15', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11110', amount: 75, referenceId: 'EXP-2', status: 'DRAFT' },
];

const inApril = (date: unknown) => String(date).startsWith('2026-04');

describe('sumPostedIncomeCredits', () => {
  it('counts only posted income credits inside the window', () => {
    const summary = sumPostedIncomeCredits(ledger as any, accounts as any, inApril);
    expect(summary.glRevenue).toBe(1000);
    expect(summary.entryCount).toBe(1);
  });

  it('never treats an expense debit as revenue', () => {
    const summary = sumPostedIncomeCredits(ledger as any, accounts as any, inApril);
    expect(summary.glRevenue).not.toBe(1250);
  });
});

describe('sumPostedExpenseDebits', () => {
  it('sums posted expense debits inside the window', () => {
    const summary = sumPostedExpenseDebits(ledger as any, accounts as any, inApril);
    expect(summary.glExpenses).toBe(250);
    expect(summary.entryCount).toBe(1);
  });

  it('excludes draft rows', () => {
    const summary = sumPostedExpenseDebits(ledger as any, accounts as any, inApril);
    expect(summary.glExpenses).not.toBe(325);
  });

  it('reads payroll-style wages from the ledger, which the expenses table never held', () => {
    const payrollLedger = [
      { id: 'P1', date: '2026-04-20', debitAccountId: 'ACC-52100', creditAccountId: 'ACC-11210', amount: 4000, referenceId: 'PAY-1' },
    ];
    const payrollAccounts = [
      ...accounts,
      { id: 'ACC-52100', code: '52100', account_type: 'EXPENSE' },
      { id: 'ACC-11210', code: '11210', account_type: 'ASSET' },
    ];
    expect(sumPostedExpenseDebits(payrollLedger as any, payrollAccounts as any, inApril).glExpenses).toBe(4000);
  });
});

describe('splitPostedExpenseDebits', () => {
  const cogsAccounts = [
    ...accounts,
    { id: 'ACC-52100', code: '52100', account_type: 'EXPENSE', account_group: 'OPERATING' },
    { id: 'ACC-51200-G', code: '51200', account_type: 'EXPENSE', account_group: 'COST_OF_SALES' },
  ];
  const mixedLedger = [
    ...ledger,
    { id: 'L5', date: '2026-04-18', debitAccountId: 'ACC-52100', creditAccountId: 'ACC-11110', amount: 4000, referenceId: 'PAY-1' },
    { id: 'L6', date: '2026-04-19', debitAccountId: 'ACC-51200-G', creditAccountId: 'ACC-11110', amount: 150, referenceId: 'SALE-COGS' },
  ];

  it('separates COGS (51200/COST_OF_SALES) from operating expenses', () => {
    const split = splitPostedExpenseDebits(mixedLedger as any, cogsAccounts as any, inApril);
    // Posted: L2 250 (51200, no group on fixture account -> code fallback) +
    // L6 150 (COST_OF_SALES group) = 400 COGS; L5 4000 operating.
    expect(split.cogs).toBe(400);
    expect(split.operating).toBe(4000);
    expect(split.total).toBe(4400);
    expect(split.entryCount).toBe(3);
  });

  it('agrees with sumPostedExpenseDebits on the total', () => {
    const split = splitPostedExpenseDebits(mixedLedger as any, cogsAccounts as any, inApril);
    const summary = sumPostedExpenseDebits(mixedLedger as any, cogsAccounts as any, inApril);
    expect(summary.glExpenses).toBe(split.total);
    expect(summary.entryCount).toBe(split.entryCount);
  });

  it('classifies 51200 by code when the account registry is missing', () => {
    const codeRefLedger = [
      { id: 'C1', date: '2026-04-10', debitAccountId: '51200', creditAccountId: '11110', amount: 250, referenceId: 'COGS-1' },
      { id: 'C2', date: '2026-04-11', debitAccountId: '52100', creditAccountId: '11110', amount: 4000, referenceId: 'PAY-1' },
    ];
    const split = splitPostedExpenseDebits(codeRefLedger as any, [], inApril);
    // Fallback: 5xxx range counts as expense; exact 51200 digits count as COGS.
    expect(split.total).toBe(4250);
    expect(split.cogs).toBe(250);
    expect(split.operating).toBe(4000);
  });

  it('excludes draft and reversal rows from both buckets', () => {
    const withReversal = [
      ...mixedLedger,
      { id: 'L7', date: '2026-04-20', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11110', amount: 1000, referenceId: 'REV-1', entryType: 'Reversal' },
    ];
    const split = splitPostedExpenseDebits(withReversal as any, cogsAccounts as any, inApril);
    expect(split.total).toBe(4400);
  });
});

describe('mapPostedExpenseLegs', () => {
  it('maps posted debits to dated, account-named records newest-first', () => {
    const rows = mapPostedExpenseLegs(ledger as any, accounts as any, inApril);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 250, date: '2026-04-12' });
  });

  it('returns an empty list when nothing is posted', () => {
    expect(mapPostedExpenseLegs([], accounts as any)).toEqual([]);
  });
});

describe('reconcileRevenueToGl', () => {
  it('keeps a meaningful tolerance when documents are understated', () => {
    // documents 269,500 vs ledger 462,000 — the reported failure.
    const result = reconcileRevenueToGl(269500, 462000);
    expect(result.delta).toBe(192500);
    expect(result.withinTolerance).toBe(false);
    // Tolerance must not collapse to the 0.5% of the smaller (wrong) side.
    expect(result.tolerance).toBe(2310);
  });

  it('agrees when both sides match', () => {
    const result = reconcileRevenueToGl(1000, 1000);
    expect(result.delta).toBe(0);
    expect(result.withinTolerance).toBe(true);
  });

  it('detects the ledger overstating revenue', () => {
    const result = reconcileRevenueToGl(1000, 4000);
    expect(result.delta).toBe(3000);
    expect(result.withinTolerance).toBe(false);
  });
});
