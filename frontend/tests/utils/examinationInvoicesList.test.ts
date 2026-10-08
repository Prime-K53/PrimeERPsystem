import { describe, expect, it } from 'vitest';
import {
    examInvoicesToCsv,
    filterExamInvoices,
    getExamInvoiceBalance,
    getExamInvoiceDaysOverdue,
    isExamInvoiceOverdue,
    paginateExamInvoices,
    sortExamInvoices,
    summarizeExamInvoices,
} from '../../utils/examinationInvoicesList';

const NOW = new Date('2026-10-08T12:00:00.000Z');

const rows = [
    {
        id: 'EXM-1', invoiceNumber: 'EXM-1', customerName: 'Demo School', batchNumber: 'BTC-1',
        date: '2026-09-01T00:00:00.000Z', dueDate: '2026-09-10T00:00:00.000Z',
        totalAmount: 8000, paidAmount: 8000, status: 'Paid', verificationToken: 'a'.repeat(64),
    },
    {
        id: 'EXM-2', invoiceNumber: 'EXM-2', customerName: 'Beta Academy', batchNumber: 'BTC-2',
        date: '2026-09-20T00:00:00.000Z', dueDate: '2026-09-25T00:00:00.000Z',
        totalAmount: 5000, paidAmount: 2000, status: 'Partial', verificationToken: 'b'.repeat(64),
    },
    {
        id: 'EXM-3', invoiceNumber: 'EXM-3', customerName: 'Gamma College', batchNumber: 'BTC-1',
        date: '2026-10-01T00:00:00.000Z', dueDate: '2026-11-01T00:00:00.000Z',
        totalAmount: 3000, paidAmount: 0, status: 'Unpaid', verificationToken: '',
    },
    {
        id: 'EXM-4', invoiceNumber: 'EXM-4', customerName: 'Delta School', batchNumber: 'BTC-9',
        date: '2026-08-01T00:00:00.000Z', dueDate: '2026-08-10T00:00:00.000Z',
        totalAmount: 4000, paidAmount: 0, status: 'Voided', verificationToken: 'c'.repeat(64),
    },
];

describe('balance + overdue', () => {
    it('computes balance due clamped at zero', () => {
        expect(getExamInvoiceBalance(rows[0])).toBe(0);
        expect(getExamInvoiceBalance(rows[1])).toBe(3000);
        expect(getExamInvoiceBalance({ ...rows[1], paidAmount: 9999 })).toBe(0);
    });

    it('flags overdue only when due, unpaid and non-terminal', () => {
        expect(isExamInvoiceOverdue(rows[1], NOW)).toBe(true);
        expect(getExamInvoiceDaysOverdue(rows[1], NOW)).toBe(13);
        // Paid in full is never overdue.
        expect(isExamInvoiceOverdue(rows[0], NOW)).toBe(false);
        // Not yet due is current.
        expect(isExamInvoiceOverdue(rows[2], NOW)).toBe(false);
        // Voided rows are excluded even when past due.
        expect(isExamInvoiceOverdue(rows[3], NOW)).toBe(false);
    });
});

describe('filterExamInvoices', () => {
    it('searches invoice, school and batch', () => {
        expect(filterExamInvoices(rows, { search: 'btc-1' }, [], NOW)).toHaveLength(2);
        expect(filterExamInvoices(rows, { search: 'gamma' }, [], NOW)[0].id).toBe('EXM-3');
    });

    it('filters by status, batch, overdue and readiness', () => {
        expect(filterExamInvoices(rows, { status: 'Partial' }, [], NOW)[0].id).toBe('EXM-2');
        expect(filterExamInvoices(rows, { batch: 'btc-9' }, [], NOW)[0].id).toBe('EXM-4');
        expect(filterExamInvoices(rows, { overdueOnly: true }, [], NOW).map((r) => r.id)).toEqual(['EXM-2']);
        expect(filterExamInvoices(rows, { readiness: 'verifiable' }, [], NOW).map((r) => r.id).sort()).toEqual(['EXM-1', 'EXM-2', 'EXM-4']);
        // Pending-sync tokened rows drop out of the verifiable bucket.
        expect(filterExamInvoices(rows, { readiness: 'verifiable' }, ['EXM-1'], NOW).map((r) => r.id).sort()).toEqual(['EXM-2', 'EXM-4']);
    });

    it('filters by date and amount ranges', () => {
        expect(filterExamInvoices(rows, { dateFrom: '2026-09-15', dateTo: '2026-09-30' }, [], NOW)[0].id).toBe('EXM-2');
        expect(filterExamInvoices(rows, { minAmount: 4000, maxAmount: 6000 }, [], NOW)[0].id).toBe('EXM-2');
    });
});

describe('sort + paginate + summarize + csv', () => {
    it('sorts by balance and due date', () => {
        expect(sortExamInvoices(rows, 'balance', 'desc')[0].id).toBe('EXM-4');
        expect(sortExamInvoices(rows, 'dueDate', 'asc')[0].id).toBe('EXM-4');
    });

    it('paginates deterministically', () => {
        const { rows: page1, total, totalPages } = paginateExamInvoices(rows, 1, 2);
        expect(page1).toHaveLength(2);
        expect(total).toBe(4);
        expect(totalPages).toBe(2);
    });

    it('summarizes billed/collected/overdue/aging', () => {
        const s = summarizeExamInvoices(rows, NOW);
        expect(s.count).toBe(4);
        expect(s.billed).toBe(20000);
        expect(s.collected).toBe(10000);
        expect(s.outstanding).toBe(10000);
        expect(s.collectionRate).toBe(0.5);
        expect(s.overdueCount).toBe(1);
        expect(s.overdueAmount).toBe(3000);
        expect(s.aging.days1to30).toBe(3000);
        expect(s.aging.current).toBe(3000);
    });

    it('exports a header + one row per invoice', () => {
        const csv = examInvoicesToCsv(rows, NOW);
        const lines = csv.split('\n');
        expect(lines[0]).toContain('Balance');
        expect(lines).toHaveLength(5);
    });
});
