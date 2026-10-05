/**
 * examinationInvoicesTab.test.ts — Examination → Invoices tab contract.
 *
 * The tab is a specialized VIEW over canonical invoice records: it must
 * select exactly the examination invoices (same predicate the general list
 * exclusion uses), join each row to its owning batch, and never duplicate
 * records into a second store.
 */
import { describe, it, expect } from 'vitest';
import {
  selectExaminationInvoices,
  resolveExamInvoiceBatch,
  examInvoiceMenuItems,
} from '../../views/examination/ExaminationInvoices';
import { isExaminationInvoiceRecord, applyGeneralInvoiceScope } from '../../utils/invoiceIdentity';

const ORDINARY = { id: 'INV-001', invoiceNumber: 'INV-001', customerName: 'Shop', totalAmount: 500 };
const EXAM_BATCH = {
  id: 'EXM-100',
  invoiceNumber: 'EXM-100',
  customerName: 'Demo School',
  batchId: 'BTC-1',
  origin_module: 'examination',
  origin_batch_id: 'BTC-1',
  date: '2026-09-01T00:00:00.000Z',
  totalAmount: 8000,
  status: 'Unpaid',
  verificationToken: 'a'.repeat(64),
};
const LEGACY_JOB = {
  id: 'INV-900',
  invoiceNumber: 'INV-900',
  customerName: 'Old School',
  originModule: 'examination',
  category: 'Examination',
  totalAmount: 25000,
  status: 'Paid',
};

describe('Examination invoices tab selection', () => {
  it('selects examination invoices only (batch + legacy job)', () => {
    const rows = selectExaminationInvoices([ORDINARY, EXAM_BATCH, LEGACY_JOB] as any);
    expect(rows.map((row) => row.id).sort()).toEqual(['EXM-100', 'INV-900']);
  });

  it('returns the same canonical record (no duplication, no second store)', () => {
    const rows = selectExaminationInvoices([EXAM_BATCH] as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].invoiceNumber).toBe('EXM-100');
    expect(rows[0].totalAmount).toBe(8000);
    expect(rows[0].verificationToken).toBe('a'.repeat(64));
  });

  it('matches the general-list exclusion predicate exactly', () => {
    const all = [ORDINARY, EXAM_BATCH, LEGACY_JOB] as any[];
    const inTab = new Set(selectExaminationInvoices(all).map((row) => row.id));
    const excludedFromGeneral = all.filter((invoice) => isExaminationInvoiceRecord(invoice)).map((invoice) => invoice.id);
    expect(Array.from(inTab).sort()).toEqual(excludedFromGeneral.sort());
  });

  it('joins rows to their owning batch', () => {
    const batches = [
      { id: 'batch-1', batch_number: 'BTC-1', name: 'Batch One', invoice_id: 'EXM-100' },
      { id: 'batch-2', batch_number: 'BTC-2', name: 'Batch Two' },
    ];
    const rows = selectExaminationInvoices([EXAM_BATCH] as any);
    expect(resolveExamInvoiceBatch(rows[0] as any, batches as any)?.id).toBe('batch-1');
    expect(resolveExamInvoiceBatch(rows[0] as any, [{ id: 'batch-9', batch_number: 'BTC-9' }] as any)).toBeNull();
  });

  it('ordinary invoices never match the examination predicate', () => {
    expect(isExaminationInvoiceRecord(ORDINARY as any)).toBe(false);
    expect(isExaminationInvoiceRecord(null)).toBe(false);
    expect(isExaminationInvoiceRecord({ id: 'INV-2', notes: 'examination of goods' } as any)).toBe(false);
  });

  it('general list keeps ordinary invoices and bypasses exact id searches', () => {    const all = [ORDINARY, EXAM_BATCH, LEGACY_JOB] as any[];
    expect(applyGeneralInvoiceScope(all).map((invoice) => invoice.id)).toEqual(['INV-001']);
    // Exact id/number search surfaces the record alongside ordinary rows.
    expect(applyGeneralInvoiceScope(all, 'EXM-100').map((invoice) => invoice.id)).toEqual(['INV-001', 'EXM-100']);
    expect(applyGeneralInvoiceScope(all, 'exm-100').map((invoice) => invoice.id)).toEqual(['INV-001', 'EXM-100']);
    expect(applyGeneralInvoiceScope(all, 'partial-match').map((invoice) => invoice.id)).toEqual(['INV-001']);
    expect(applyGeneralInvoiceScope(null)).toEqual([]);
  });

  it('menu offers full actions with void/purge gated by status', () => {
    expect(examInvoiceMenuItems({ status: 'Unpaid', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'void']
    );
    expect(examInvoiceMenuItems({ status: 'Paid', paidAmount: 8000, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'ledger']
    );
    expect(examInvoiceMenuItems({ status: 'Voided', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'purge']
    );
    expect(examInvoiceMenuItems({ status: 'Cancelled', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'purge']
    );
  });
});
