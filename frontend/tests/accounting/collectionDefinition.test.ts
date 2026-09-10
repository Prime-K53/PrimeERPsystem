/**
 * Collection KPI definition regression tests.
 *
 * A "collection" is a POSTED receipt against a customer balance
 * (Dr collection account, Cr 11310/11300/21300). In particular these are
 * NEVER collections even though they debit cash/bank accounts:
 *  - cash-sale revenue (Dr 11110, Cr 41100 income)
 *  - opening cash (Dr 11110, Cr 31000/32000 equity)
 *  - bank/cash transfers (Dr asset, Cr asset)
 *  - drafts / voids / reversals
 */
import { describe, it, expect } from 'vitest';
import { isCustomerCollectionEntry } from '../../services/financialReportingService';

const ACCOUNTS = [
  { id: 'ACC-11110', code: '11110', account_number: '11110' },
  { id: 'ACC-11210', code: '11210', account_number: '11210' },
  { id: 'ACC-11310', code: '11310', account_number: '11310' },
  { id: 'ACC-21300', code: '21300', account_number: '21300' },
  { id: 'ACC-31000', code: '31000', account_number: '31000' },
  { id: 'ACC-41100', code: '41100', account_number: '41100' },
];

const codeOf = (ref: string | undefined): string => {
  const acc = ACCOUNTS.find((a) => a.id === ref);
  return acc ? acc.code : ref || '';
};

const day = (d: string) => `${d}T10:00:00.000Z`;

describe('collection definition (receipts only)', () => {
  it('cash-sale revenue is NOT a collection', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-REV', date: day('2026-09-11'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-41100', amount: 25500 } as any,
        codeOf
      )
    ).toBe(false);
  });

  it('opening cash is NOT a collection', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-OPEN', date: day('2026-09-10'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-31000', amount: 500, referenceId: 'OPENING_BALANCE' } as any,
        codeOf
      )
    ).toBe(false);
  });

  it('bank/cash transfers are NOT collections', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-T', date: day('2026-09-11'), debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11110', amount: 10000 } as any,
        codeOf
      )
    ).toBe(false);
  });

  it('genuine AR receipts ARE collections (id and code references)', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-PAY-1', date: day('2026-09-11'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 25500 } as any,
        codeOf
      )
    ).toBe(true);
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-PAY-2', date: day('2026-09-11'), debitAccountId: '11210', creditAccountId: '11310', amount: 4000 } as any,
        codeOf
      )
    ).toBe(true);
  });

  it('customer-deposit receipts ARE collections', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-DEP', date: day('2026-09-11'), debitAccountId: 'ACC-11210', creditAccountId: 'ACC-21300', amount: 7000 } as any,
        codeOf
      )
    ).toBe(true);
  });

  it('drafts, voids, and reversals are NEVER collections', () => {
    const base = { id: 'LG-X', date: day('2026-09-11'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 1000 };
    expect(isCustomerCollectionEntry({ ...base, status: 'Draft' } as any, codeOf)).toBe(false);
    expect(isCustomerCollectionEntry({ ...base, status: 'voided' } as any, codeOf)).toBe(false);
    expect(isCustomerCollectionEntry({ ...base, entryType: 'Reversal' } as any, codeOf)).toBe(false);
  });

  it('reported scenario replays to zero without receipts', () => {
    const entries = [
      // Yesterday: automatic opening cash 500.
      { id: 'LG-OPEN', date: day('2026-09-10'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-31000', amount: 500, referenceId: 'OPENING_BALANCE' },
      // Today: 25,500 cash sale, no receipt.
      { id: 'LG-REV', date: day('2026-09-11'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-41100', amount: 25500, referenceId: 'SALE-1' },
    ];
    const total = entries
      .filter((e) => isCustomerCollectionEntry(e as any, codeOf))
      .reduce((s, e) => s + (e.amount || 0), 0);
    // Old loose logic reported 25,500 today (+5000.0% vs yesterday's 500).
    expect(total).toBe(0);
  });

  it('a genuine 25,500 receipt IS collected', () => {
    expect(
      isCustomerCollectionEntry(
        { id: 'LG-PAY', date: day('2026-09-11'), debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 25500, referenceId: 'PAY-1' } as any,
        codeOf
      )
    ).toBe(true);
  });
});
