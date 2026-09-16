/**
 * Phase 4 — Single recognition + posting (C2 + C5 + C6, backend leg).
 *
 * - revenueRecognition: excluded/credit-note/sale statuses mirror the P&L rule.
 * - splitSaleLedgerAmounts: debits === credits for every input.
 * - resolveSaleRevenueCode: explicit wins, service-only -> 41200, else 41100.
 * - index.cjs: balanced dated currency-aware sale posting; dashboard counts
 *   recognized sales only; sales schema keeps Phase 4 fields.
 */
const { describe, it, expect } = require('@jest/globals');
const fs = require('node:fs');
const path = require('node:path');
const recognition = require('../services/revenueRecognition.cjs');
const {
  splitSaleLedgerAmounts,
  resolveSaleRevenueCode,
} = require('../services/marketLedgerSplit.cjs');

describe('recognition statuses (C2)', () => {
  it.each([['Draft'], ['draft'], ['CANCELLED'], ['cancelled'], ['Void'], ['voided'], ['VOIDED']])(
    'excludes %p',
    (status) => {
      expect(recognition.isRecognizedInvoiceStatus(status)).toBe(false);
      expect(recognition.isPostedInvoiceStatus(status)).toBe(false);
    }
  );

  it.each([['unpaid'], ['Unpaid'], ['Paid'], ['Partial'], ['Sent']])(
    'recognizes %p',
    (status) => {
      expect(recognition.isRecognizedInvoiceStatus(status)).toBe(true);
    }
  );

  it.each([['credit_note'], ['Credit_Note'], ['credit-note']])(
    'credit note %p passes the gate with a -1 sign',
    (status) => {
      expect(recognition.isRecognizedInvoiceStatus(status)).toBe(true);
      expect(recognition.invoiceRevenueSign({ status })).toBe(-1);
    }
  );

  it('ordinary invoices carry a +1 sign', () => {
    expect(recognition.invoiceRevenueSign({ status: 'Paid' })).toBe(1);
  });

  it.each([
    ['Paid', true], ['Completed', true], ['Partial', true],
    ['Partially Paid', true], ['Overpaid', true],
    ['Draft', false], ['Pending', false], ['Voided', false], ['Refunded', false],
  ])('sale status %p recognized=%p', (status, expected) => {
    expect(recognition.isRecognizedSale({ status })).toBe(expected);
  });
});

describe('splitSaleLedgerAmounts (C5)', () => {
  it('balances debits and credits', () => {
    const s = splitSaleLedgerAmounts({
      totalAmount: 1000, taxAmount: 100, marketAmount: 200, materialTotal: 300,
    });
    expect(s).toEqual({
      total: 1000, tax: 100, market: 200, revenue: 700, cogs: 300, inventory: 300,
    });
    expect(s.total + s.cogs).toBe(s.revenue + s.market + s.tax + s.inventory);
  });

  it('clamps market+tax to the total and tolerates missing inputs', () => {
    const s = splitSaleLedgerAmounts({ totalAmount: 100, taxAmount: 90, marketAmount: 50 });
    expect(s.revenue).toBe(0);
    expect(s.total + s.cogs).toBe(s.revenue + s.market + s.tax + s.inventory);
    const empty = splitSaleLedgerAmounts({});
    expect(empty).toEqual({ total: 0, tax: 0, market: 0, revenue: 0, cogs: 0, inventory: 0 });
  });
});

describe('resolveSaleRevenueCode (C6)', () => {
  it('explicit salesAccountId always wins', () => {
    expect(resolveSaleRevenueCode({
      salesAccountId: '42200',
      items: [{ type: 'Service' }],
    })).toBe('42200');
  });

  it('service-only items fall back to 41200, else 41100', () => {
    expect(resolveSaleRevenueCode({ items: [{ type: 'Service' }] })).toBe('41200');
    expect(resolveSaleRevenueCode({ items: [{ type: 'Product' }] })).toBe('41100');
    expect(resolveSaleRevenueCode({})).toBe('41100');
  });
});

describe('index.cjs sale posting + dashboard (C2+C5+C6)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');

  it('posts balanced dated legs with inventory credit', () => {
    expect(src).toMatch(/splitSaleLedgerAmounts/);
    expect(src).toMatch(/entry_date: entryDate/);
    expect(src).toMatch(/Inventory/);
  });

  it('dashboard revenue counts recognized sales only', () => {
    expect(src).toMatch(/isRecognizedSale\(s\)/);
  });

  it('sales schema keeps Phase 4 fields (currency/tax/account)', () => {
    const validation = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'validation.cjs'), 'utf8'
    );
    expect(validation).toMatch(/salesAccountId/);
    expect(validation).toMatch(/taxTotal/);
    expect(validation).toMatch(/currency/);
  });
});
