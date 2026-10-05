/**
 * examinationInvoiceNotificationDate.test.ts — the "Invalid Date"
 * notification regression suite.
 *
 * Root cause: notification call sites formatted possibly-undefined dueDate
 * with a bare `new Date(x).toLocaleDateString()` (FinanceContext) or masked
 * it with today (ExaminationContext `|| Date.now()`). The fix consumes the
 * canonical persisted invoice date via formatInvoiceDueDateForNotification,
 * which never emits "Invalid Date" and never substitutes today.
 */
import { describe, it, expect } from 'vitest';
import { formatInvoiceDueDateForNotification } from '../../services/customerNotificationService';
import { mapExaminationPayloadToInvoice } from '../../services/examinationInvoiceSyncService';

describe('formatInvoiceDueDateForNotification', () => {
  it('formats a valid ISO due date', () => {
    expect(formatInvoiceDueDateForNotification({ dueDate: '2026-09-15T00:00:00.000Z', date: '2026-08-16T00:00:00.000Z' }))
      .toBe(new Date('2026-09-15T00:00:00.000Z').toLocaleDateString());
  });

  it('falls back to the canonical invoice date when dueDate is missing', () => {
    expect(formatInvoiceDueDateForNotification({ date: '2026-08-16T00:00:00.000Z' }))
      .toBe(new Date('2026-08-16T00:00:00.000Z').toLocaleDateString());
  });

  it('ignores malformed dueDate and uses the invoice date instead of today', () => {
    const result = formatInvoiceDueDateForNotification({ dueDate: 'not-a-date', date: '2026-08-16T00:00:00.000Z' });
    expect(result).toBe(new Date('2026-08-16T00:00:00.000Z').toLocaleDateString());
    expect(result).not.toBe('Invalid Date');
  });

  it('returns empty string (never "Invalid Date") when both are missing', () => {
    expect(formatInvoiceDueDateForNotification({})).toBe('');
    expect(formatInvoiceDueDateForNotification(null)).toBe('');
    expect(formatInvoiceDueDateForNotification(undefined)).toBe('');
    expect(formatInvoiceDueDateForNotification({ dueDate: undefined, date: undefined })).toBe('');
  });

  it('accepts Date instances', () => {
    const due = new Date('2026-10-05T12:00:00.000Z');
    expect(formatInvoiceDueDateForNotification({ dueDate: due })).toBe(due.toLocaleDateString());
  });
});

describe('examination invoice date survival', () => {
  const payload: any = {
    id: 'EXM-DATE-001',
    invoiceNumber: 'EXM-DATE-001',
    date: '2026-09-01T10:00:00.000Z',
    dueDate: '2026-10-01T10:00:00.000Z',
    customerId: 'SCH-1',
    customerName: 'Date School',
    schoolName: 'Date School',
    totalAmount: 8000,
    paidAmount: 0,
    status: 'Unpaid',
    items: [],
    batchId: 'BTC-DATE-1',
    origin_module: 'examination',
    origin_batch_id: 'BTC-DATE-1',
    currency: 'MWK',
  };

  it('mapping preserves canonical date and dueDate', () => {
    const invoice = mapExaminationPayloadToInvoice(payload) as Record<string, any>;
    expect(invoice.date).toBe('2026-09-01T10:00:00.000Z');
    expect(formatInvoiceDueDateForNotification(invoice))
      .toBe(new Date('2026-10-01T10:00:00.000Z').toLocaleDateString());
  });

  it('dates survive JSON sync-envelope round-trips byte-identically', () => {
    const invoice = mapExaminationPayloadToInvoice(payload) as Record<string, any>;
    const revived = JSON.parse(JSON.stringify(invoice));
    expect(revived.date).toBe(invoice.date);
    expect(formatInvoiceDueDateForNotification(revived)).toBe(formatInvoiceDueDateForNotification(invoice));
  });

  it('mapped invoice carries no tax fields', () => {
    const invoice = mapExaminationPayloadToInvoice(payload) as Record<string, any>;
    expect(Object.keys(invoice).filter((key) => /tax|vat/i.test(key))).toEqual([]);
  });
});
