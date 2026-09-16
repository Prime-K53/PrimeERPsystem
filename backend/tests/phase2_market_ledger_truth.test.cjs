/**
 * Phase 2 — Market ledger truth (B2 + B3 + A8 backend leg).
 *
 * Covers backend/services/marketLedgerSplit.cjs:
 *  - splitInvoiceLedgerAmounts keeps total === market + tax + revenue
 *  - resolveMarketLedgerAccount rejects unset/unknown/inactive/non-posting/non-income
 *  - postInvoiceLedger splits the market leg (source check)
 */
const { describe, it, expect } = require('@jest/globals');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveMarketLedgerAccount,
  splitInvoiceLedgerAmounts,
} = require('../services/marketLedgerSplit.cjs');

const incomeActive = {
  id: 'mkt-1', code: '42000', account_number: '42000',
  account_type: 'INCOME', is_active: 1, allow_posting: 1,
};

describe('splitInvoiceLedgerAmounts', () => {
  it('splits market+tax out of revenue and preserves the total', () => {
    const s = splitInvoiceLedgerAmounts({ totalAmount: 1000, taxAmount: 100, marketAmount: 200 });
    expect(s).toEqual({ total: 1000, tax: 100, market: 200, revenue: 700 });
  });

  it('clamps market+tax to the total (never negative revenue)', () => {
    const s = splitInvoiceLedgerAmounts({ totalAmount: 100, taxAmount: 90, marketAmount: 50 });
    expect(s.revenue).toBe(0);
    expect(s.market + s.tax + s.revenue).toBeLessThanOrEqual(100.01);
  });

  it('treats non-numeric/negative inputs as zero', () => {
    const s = splitInvoiceLedgerAmounts({ totalAmount: 500, taxAmount: -5, marketAmount: 'x' });
    expect(s).toEqual({ total: 500, tax: 0, market: 0, revenue: 500 });
  });
});

describe('resolveMarketLedgerAccount', () => {
  const all = [incomeActive];

  it('resolves by id, code, or account_number', () => {
    expect(resolveMarketLedgerAccount(all, 'mkt-1')).toBe(incomeActive);
    expect(resolveMarketLedgerAccount(all, '42000')).toBe(incomeActive);
  });

  it.each([[null], [undefined], [''], ['nope']])('returns null for %p', (id) => {
    expect(resolveMarketLedgerAccount(all, id)).toBeNull();
  });

  it('rejects inactive, non-posting, and non-income accounts', () => {
    expect(resolveMarketLedgerAccount(
      [{ ...incomeActive, is_active: 0 }], 'mkt-1'
    )).toBeNull();
    expect(resolveMarketLedgerAccount(
      [{ ...incomeActive, allow_posting: 0 }], 'mkt-1'
    )).toBeNull();
    expect(resolveMarketLedgerAccount(
      [{ ...incomeActive, account_type: 'ASSET' }], 'mkt-1'
    )).toBeNull();
    // Legacy display type 'Revenue' is accepted as income.
    expect(resolveMarketLedgerAccount(
      [{ ...incomeActive, account_type: undefined, type: 'Revenue' }], 'mkt-1'
    )?.id).toBe('mkt-1');
  });
});

describe('postInvoiceLedger posts the market leg', () => {
  it('uses the split helper and the configured market account', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'examinationService.cjs'),
      'utf8'
    );
    expect(src).toMatch(/splitInvoiceLedgerAmounts/);
    expect(src).toMatch(/resolveMarketLedgerAccount/);
    expect(src).toMatch(/Market Adjustment/);
  });
});
