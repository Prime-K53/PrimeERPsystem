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

import {
  invoiceRevenueSign,
  isCreditNoteStatus,
  isExcludedStatus,
  isRecognizedInvoiceStatus,
  isRecognizedSale,
  normalizeStatus,
} from '../../../utils/revenueRecognition';

describe('Phase 4 — revenue recognition helpers (C2)', () => {
  it('normalizes statuses case-insensitively', () => {
    expect(normalizeStatus('  Voided ')).toBe('voided');
    expect(isExcludedStatus('Draft')).toBe(true);
    expect(isExcludedStatus('CANCELLED')).toBe(true);
    expect(isExcludedStatus('void')).toBe(true);
    expect(isExcludedStatus('Unpaid')).toBe(false);
  });

  it('detects credit notes with a -1 sign', () => {
    expect(isCreditNoteStatus('credit_note')).toBe(true);
    expect(isCreditNoteStatus('Credit-Note')).toBe(true);
    expect(invoiceRevenueSign({ status: 'credit_note' })).toBe(-1);
    expect(invoiceRevenueSign({ status: 'Paid' })).toBe(1);
  });

  it('recognizes paid/completed/partial/overpaid sales only', () => {
    expect(isRecognizedSale({ status: 'Paid' })).toBe(true);
    expect(isRecognizedSale({ status: 'Completed' })).toBe(true);
    expect(isRecognizedSale({ status: 'Partially Paid' })).toBe(true);
    expect(isRecognizedSale({ status: 'Draft' })).toBe(false);
    expect(isRecognizedSale({ status: 'Pending' })).toBe(false);
    expect(isRecognizedSale({ status: 'Voided' })).toBe(false);
    expect(isRecognizedSale({ status: 'Refunded' })).toBe(false);
  });

  it('excludes void/voided invoices from recognition', () => {
    expect(isRecognizedInvoiceStatus('Voided')).toBe(false);
    expect(isRecognizedInvoiceStatus('void')).toBe(false);
    expect(isRecognizedInvoiceStatus('cancelled')).toBe(false);
    expect(isRecognizedInvoiceStatus('Unpaid')).toBe(true);
    expect(isRecognizedInvoiceStatus('credit_note')).toBe(true);
  });
});

describe('Phase 4 — invoice posting gate + revenue account (C2+C6)', () => {
  it('isPostedInvoiceStatus excludes void/voided in any case', async () => {
    const { isPostedInvoiceStatus } = await import(
      '../../../services/transactions/_internal'
    );
    expect(isPostedInvoiceStatus('Voided')).toBe(false);
    expect(isPostedInvoiceStatus('void')).toBe(false);
    expect(isPostedInvoiceStatus('cancelled')).toBe(false);
    expect(isPostedInvoiceStatus('Draft')).toBe(false);
    expect(isPostedInvoiceStatus('Unpaid')).toBe(true);
    expect(isPostedInvoiceStatus('Paid')).toBe(true);
  });

  it('resolveInvoiceRevenueAccount: explicit wins, service-only 41200, else default', async () => {
    const { resolveInvoiceRevenueAccount } = await import(
      '../../../services/transactions/_internal'
    );
    expect(
      resolveInvoiceRevenueAccount({ salesAccountId: '42200', items: [{ type: 'Service' }] }, '41100')
    ).toBe('42200');
    expect(resolveInvoiceRevenueAccount({ items: [{ type: 'Service' }] }, '41100')).toBe('41200');
    expect(resolveInvoiceRevenueAccount({ items: [{ type: 'Product' }] }, '41100')).toBe('41100');
  });
});

describe('Phase 4 — revenue analysis honors void + credit notes (C2)', () => {
  it('excludes voided invoices and negates credit notes', async () => {
    const { buildRevenueAnalysisDataset } = await import(
      '../../../services/revenueAnalysisService'
    );
    const items = [{ id: 'i1', name: 'Item', price: 100, quantity: 1 }];
    const dataset = buildRevenueAnalysisDataset({
      sales: [],
      invoices: [
        { id: 'inv-void', status: 'Voided', items, date: '2026-01-01' },
        { id: 'inv-cn', status: 'credit_note', items, date: '2026-01-02' },
        { id: 'inv-ok', status: 'Paid', items, date: '2026-01-03' },
      ],
      orders: [],
      batches: [],
    });
    const byId = new Map(dataset.transactions.map((t) => [t.transactionId, t]));
    expect(byId.has('inv-void')).toBe(false);
    expect(byId.get('inv-cn')?.revenue).toBe(-100);
    expect(byId.get('inv-ok')?.revenue).toBe(100);
  });
});
