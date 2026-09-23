import { describe, expect, it } from 'vitest';
import { derivePurchasePaymentStatus, getPurchaseTotal } from '../../utils/paymentUtils';

describe('getPurchaseTotal', () => {
    it('prefers totalAmount when present', () => {
        expect(getPurchaseTotal({ totalAmount: 100, total: 90 })).toBe(100);
    });

    it('falls back to total when totalAmount is missing (merged bills)', () => {
        expect(getPurchaseTotal({ total: 250 })).toBe(250);
        expect(getPurchaseTotal({ totalAmount: undefined, total: 250 })).toBe(250);
    });

    it('returns 0 for empty/invalid input', () => {
        expect(getPurchaseTotal(undefined)).toBe(0);
        expect(getPurchaseTotal({})).toBe(0);
        expect(getPurchaseTotal({ totalAmount: 'abc' })).toBe(0);
    });
});

describe('derivePurchasePaymentStatus', () => {
    it('marks fully paid bills as Paid even when only totalAmount exists (PO-P726/021 bug)', () => {
        const bill = { totalAmount: 1000, paidAmount: 1000, paymentStatus: 'Partial' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Paid');
    });

    it('marks fully paid merged bills (total only) as Paid', () => {
        const bill = { total: 500, paidAmount: 500, paymentStatus: 'Partial' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Paid');
    });

    it('keeps Partial for underpaid bills', () => {
        const bill = { totalAmount: 1000, paidAmount: 400, paymentStatus: 'Unpaid' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Partial');
    });

    it('marks zero-paid bills as Unpaid', () => {
        const bill = { totalAmount: 1000, paidAmount: 0, paymentStatus: 'Partial' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Unpaid');
    });

    it('tolerates floating point residue (paid within half a cent)', () => {
        const bill = { totalAmount: 100, paidAmount: 99.999999999, paymentStatus: 'Partial' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Paid');
    });

    it('preserves Cancelled regardless of amounts', () => {
        const bill = { totalAmount: 1000, paidAmount: 1000, paymentStatus: 'Cancelled' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Cancelled');
    });

    it('preserves unpaid Approved workflow state', () => {
        const bill = { totalAmount: 1000, paidAmount: 0, paymentStatus: 'Approved' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Approved');
    });

    it('resolves Approved to Paid when fully paid (GRN normalization bug)', () => {
        const bill = { totalAmount: 1000, paidAmount: 1000, paymentStatus: 'Approved' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Paid');
    });

    it('trusts stored status when no total is known', () => {
        const bill = { paidAmount: 100, paymentStatus: 'Partial' };
        expect(derivePurchasePaymentStatus(bill)).toBe('Partial');
    });

    it('defaults to Unpaid when nothing is known', () => {
        expect(derivePurchasePaymentStatus({})).toBe('Unpaid');
        expect(derivePurchasePaymentStatus(null)).toBe('Unpaid');
    });
});
