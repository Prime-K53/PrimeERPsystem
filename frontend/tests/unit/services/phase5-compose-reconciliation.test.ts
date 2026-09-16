import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../services/db', () => ({
  dbService: {
    getAll: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve(null)),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    add: vi.fn(() => Promise.resolve('new-id')),
  },
}));

import { derivePricingMode, isMarketPostingActive, isVatPostingActive } from '../../../utils/pricingMode';
import { reconcileRevenueToGl, sumPostedIncomeCredits } from '../../../utils/glReconciliation';

describe('Phase 5 — independent VAT/market switches (B10)', () => {
  it('falls back to legacy pricingMode when flags are unset', () => {
    expect(isVatPostingActive({ enabled: true, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'VAT' })).toBe(true);
    expect(isMarketPostingActive({ enabled: true, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'VAT' })).toBe(false);
    expect(isVatPostingActive({ enabled: true, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'MarketAdjustment' })).toBe(false);
    expect(isMarketPostingActive({ enabled: true, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'MarketAdjustment' })).toBe(true);
  });

  it('explicit flags compose and override the legacy mode', () => {
    const both = { enabled: true, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'VAT', applyVatOnSales: true, applyMarketAdjustmentsOnSales: true } as any;
    expect(isVatPostingActive(both)).toBe(true);
    expect(isMarketPostingActive(both)).toBe(true);
    const none = { ...both, applyVatOnSales: false, applyMarketAdjustmentsOnSales: false };
    expect(isVatPostingActive(none)).toBe(false);
    expect(isMarketPostingActive(none)).toBe(false);
  });

  it('master switch off disables VAT posting', () => {
    expect(isVatPostingActive({ enabled: false, rate: 17.5, filingFrequency: 'Monthly', pricingMode: 'VAT' })).toBe(false);
    expect(isVatPostingActive(undefined)).toBe(false);
    expect(isMarketPostingActive(undefined)).toBe(false);
  });

  it('derives a legacy pricingMode for old readers', () => {
    expect(derivePricingMode({ applyVatOnSales: true, applyMarketAdjustmentsOnSales: true })).toBe('VAT');
    expect(derivePricingMode({ applyVatOnSales: false, applyMarketAdjustmentsOnSales: true })).toBe('MarketAdjustment');
    expect(derivePricingMode({ pricingMode: 'MarketAdjustment' })).toBe('MarketAdjustment');
  });
});

describe('Phase 5 — GL reconciliation helper (C1)', () => {
  const accounts = [
    { id: 'acc-41100', code: '41100', account_number: '41100', account_type: 'INCOME' },
    { id: 'acc-11110', code: '11110', account_number: '11110', account_type: 'ASSET' },
  ];

  it('sums posted income credits, skipping reversals and non-income sides', () => {
    const summary = sumPostedIncomeCredits(
      [
        { id: 'e1', creditAccountId: 'acc-41100', amount: 700, date: '2026-01-01' },
        { id: 'e2', creditAccountId: 'acc-41100', amount: 200, date: '2026-01-02' },
        { id: 'e3', debitAccountId: 'acc-41100', creditAccountId: 'acc-11110', amount: 50, date: '2026-01-03' },
        { id: 'e4', creditAccountId: 'acc-41100', amount: 999, date: '2026-01-04', entryType: 'Reversal' },
      ] as any[],
      accounts as any[]
    );
    expect(summary.glRevenue).toBe(900);
    expect(summary.entryCount).toBe(2);
  });

  it('falls back to 4xxx codes and honors the date predicate', () => {
    const summary = sumPostedIncomeCredits(
      [
        { id: 'e1', creditAccountId: '41200', amount: 100, date: '2026-01-01' },
        { id: 'e2', creditAccountId: '41200', amount: 100, date: '2025-01-01' },
      ] as any[],
      [],
      (date) => String(date || '').startsWith('2026')
    );
    expect(summary.glRevenue).toBe(100);
  });

  it('flags out-of-tolerance drift', () => {
    expect(reconcileRevenueToGl(1000, 1000).withinTolerance).toBe(true);
    const drifted = reconcileRevenueToGl(1000, 900);
    expect(drifted.withinTolerance).toBe(false);
    expect(drifted.delta).toBe(-100);
  });
});
