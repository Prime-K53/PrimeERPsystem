import { describe, expect, it } from 'vitest';
import {
  getOrderCanonicalStatus,
  getOrderOutstanding,
  isOrderPaymentEligible,
} from '../../views/sales/components/orderStatusUtils';
import { toLegacyOrder } from '../../context/OrdersContext';

/**
 * Regression: sales orders with 'Processing' status disappeared from the
 * Record Customer Payment modal.
 *
 * `useOrders()` serves the legacy projection produced by `toLegacyOrder()`,
 * which folds payment/invoice state INTO the `status` field. An order whose
 * canonical status is 'Processing' therefore arrives at the modal as
 * 'Partially Paid', 'Paid' or 'Converted' as soon as it is touched. The modal
 * filtered on the literal `status === 'Processing'`, so only the narrow slice
 * of orders with no payment and no invoice at all was ever shown.
 */

/** Reproduce the exact filter the modal used before the fix. */
const legacyModalFilter = (order: any) => order?.status === 'Processing';

const project = (o: any) => toLegacyOrder(o as any) as any;

describe('Record Customer Payment — payable orders survive the legacy projection', () => {
  it('keeps a partially-paid Processing order visible (the reported regression)', () => {
    const canonical = {
      id: 'SO-1',
      status: 'Processing',
      total: 500,
      totalAmount: 500,
      paidAmount: 200,
      paymentStatus: 'Partially Paid',
    };

    // The projection is what destroyed the match: status became 'Partially Paid'.
    const legacy = project(canonical);
    expect(legacy.status).toBe('Partially Paid');
    expect(legacyModalFilter(legacy)).toBe(false); // old behaviour: hidden

    // New behaviour: still payable, because the canonical status is Processing
    // and there is an outstanding balance.
    expect(isOrderPaymentEligible(legacy)).toBe(true);
    expect(getOrderOutstanding(legacy)).toBe(300);
  });

  it('keeps a Confirmed order visible — the common case for a new order', () => {
    const legacy = project({
      id: 'SO-2',
      status: 'Confirmed',
      total: 250,
      totalAmount: 250,
      paidAmount: 0,
    });
    expect(legacy.status).toBe('Confirmed');
    expect(legacyModalFilter(legacy)).toBe(false); // old behaviour: hidden
    expect(isOrderPaymentEligible(legacy)).toBe(true);
  });

  it('still hides orders that must not be paid at the order level', () => {
    const hidden = [
      { id: 'a', status: 'Cancelled', totalAmount: 100, paidAmount: 0 },
      { id: 'b', status: 'Draft', totalAmount: 100, paidAmount: 0 },
      { id: 'c', status: 'Fulfilled', totalAmount: 100, paidAmount: 0 },
      { id: 'd', status: 'Converted', totalAmount: 100, paidAmount: 0 },
      // Invoiced: the invoice carries the receivable, so the order must not
      // also be offered or the customer would be billed twice.
      { id: 'e', status: 'Processing', invoiceStatus: 'Invoiced', totalAmount: 100, paidAmount: 0 },
      { id: 'f', status: 'Processing', invoiceId: 'INV-9', totalAmount: 100, paidAmount: 0 },
      // Fully settled: nothing left to allocate.
      { id: 'g', status: 'Processing', paymentStatus: 'Paid', totalAmount: 100, paidAmount: 100 },
      { id: 'h', status: 'Processing', totalAmount: 0, paidAmount: 0 },
    ];

    for (const order of hidden) {
      expect(isOrderPaymentEligible(project(order)), `expected ${order.id} to be ineligible`).toBe(false);
    }
  });

  it('reads canonical status, not the lossy legacy string', () => {
    const legacy = project({
      id: 'SO-3',
      status: 'Processing',
      invoiceStatus: 'Invoiced',
      totalAmount: 100,
      paidAmount: 0,
    });
    // Legacy string says Converted, canonical says Processing.
    expect(legacy.status).toBe('Converted');
    expect(getOrderCanonicalStatus(legacy)).toBe('Processing');
    expect(isOrderPaymentEligible(legacy)).toBe(false); // invoiced → not order-payable
  });

  it('falls back to canonicalizing the raw status for records without the projection field', () => {
    expect(getOrderCanonicalStatus({ status: 'Pending' })).toBe('Confirmed');
    expect(getOrderCanonicalStatus({ status: 'Completed' })).toBe('Fulfilled');
    expect(getOrderCanonicalStatus({ status: 'Processing' })).toBe('Processing');
    expect(getOrderCanonicalStatus(null)).toBe('Confirmed');
  });

  it('handles a missing/legacy-shaped order without producing NaN balances', () => {
    expect(getOrderOutstanding(null)).toBe(0);
    expect(getOrderOutstanding({})).toBe(0);
    expect(getOrderOutstanding({ total: 100, paidAmount: 40 })).toBe(60);
    // `total` is the canonical field; `totalAmount` may be absent.
    expect(getOrderOutstanding({ total: 100, paidAmount: 40 })).toBe(60);
    // Never negative: an overpaid order owes nothing.
    expect(getOrderOutstanding({ totalAmount: 100, paidAmount: 150 })).toBe(0);
  });
});
