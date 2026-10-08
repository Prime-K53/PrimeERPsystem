import { describe, expect, it } from 'vitest';
import {
    filterCustomerPayments,
    getAllocatedTotal,
    getAllocationStatus,
    getUnallocatedTotal,
    paginateList,
    paymentsToCsv,
    sortCustomerPayments,
    summarizePayments,
} from '../../utils/customerPaymentsList';

const rows = [
    { id: 'PAY-1', customerName: 'Acme', amount: 100, date: '2026-01-05', paymentMethod: 'Cash', status: 'Cleared', reference: 'R1', reconciled: true, allocations: [{ invoiceId: 'INV-1', amount: 100 }] },
    { id: 'PAY-2', customerName: 'Beta', amount: 200, date: '2026-02-10', paymentMethod: 'Bank', status: 'Pending', reference: 'R2', allocations: [{ invoiceId: 'INV-2', amount: 50 }] },
    { id: 'PAY-3', customerName: 'Acme Corp', amount: 300, date: '2026-03-15', paymentMethod: 'Cash', status: 'Voided', reference: 'R3', allocations: [] },
];

describe('getAllocationStatus', () => {
    it('classifies allocated / partial / unallocated', () => {
        expect(getAllocationStatus(rows[0])).toBe('allocated');
        expect(getAllocationStatus(rows[1])).toBe('partial');
        expect(getAllocationStatus(rows[2])).toBe('unallocated');
    });

    it('computes allocated and unallocated totals', () => {
        expect(getAllocatedTotal(rows[1])).toBe(50);
        expect(getUnallocatedTotal(rows[1])).toBe(150);
    });
});

describe('filterCustomerPayments', () => {
    it('searches id, customer, reference and invoice refs', () => {
        expect(filterCustomerPayments(rows, { search: 'acme' })).toHaveLength(2);
        expect(filterCustomerPayments(rows, { search: 'inv-2' })[0].id).toBe('PAY-2');
        expect(filterCustomerPayments(rows, { search: 'r3' })[0].id).toBe('PAY-3');
    });

    it('filters by method, status, allocation and reconciled', () => {
        expect(filterCustomerPayments(rows, { method: 'Cash' })).toHaveLength(2);
        expect(filterCustomerPayments(rows, { status: 'Pending' })[0].id).toBe('PAY-2');
        expect(filterCustomerPayments(rows, { allocation: 'partial' })[0].id).toBe('PAY-2');
        expect(filterCustomerPayments(rows, { reconciled: 'reconciled' })[0].id).toBe('PAY-1');
    });

    it('filters by date and amount ranges', () => {
        expect(filterCustomerPayments(rows, { dateFrom: '2026-02-01', dateTo: '2026-02-28' })[0].id).toBe('PAY-2');
        expect(filterCustomerPayments(rows, { minAmount: 250 })).toHaveLength(1);
        expect(filterCustomerPayments(rows, { maxAmount: 150 })[0].id).toBe('PAY-1');
    });
});

describe('sort + paginate + summarize + csv', () => {
    it('sorts by amount and date', () => {
        expect(sortCustomerPayments(rows, 'amount', 'asc')[0].id).toBe('PAY-1');
        expect(sortCustomerPayments(rows, 'date', 'desc')[0].id).toBe('PAY-3');
    });

    it('paginates deterministically', () => {
        const { rows: page1, total, totalPages } = paginateList(rows, 1, 2);
        expect(page1).toHaveLength(2);
        expect(total).toBe(3);
        expect(totalPages).toBe(2);
    });

    it('summarizes totals and buckets', () => {
        const s = summarizePayments(rows);
        expect(s.count).toBe(3);
        expect(s.totalAmount).toBe(600);
        expect(s.totalAllocated).toBe(150);
        expect(s.totalUnallocated).toBe(450);
        expect(s.byAllocation).toEqual({ unallocated: 1, partial: 1, allocated: 1 });
    });

    it('exports a header + one row per payment', () => {
        const csv = paymentsToCsv(rows);
        const lines = csv.split('\n');
        expect(lines[0]).toContain('Payment #');
        expect(lines).toHaveLength(4);
    });
});
