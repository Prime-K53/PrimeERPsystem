import { describe, expect, it } from 'vitest';
import {
  getOrderDisplayStatus,
  isOrderInvoiced,
} from '../../views/sales/components/orderStatusUtils';
import { toLegacyOrder } from '../../context/OrdersContext';

/** The exact shape consumers see: canonical record put through the legacy projection. */
const projected = (status: string, extra: Record<string, any> = {}) =>
  toLegacyOrder({ id: `o-${status}`, status, items: [], subtotal: 0, total: 0, ...extra } as any) as any;

describe('Sales Order display status — invoice existence is not Done', () => {
  it('ERP manual Draft displays as Processing, not Done', () => {
    expect(getOrderDisplayStatus({ status: 'Draft' } as any)).toBe('Processing');
    expect(getOrderDisplayStatus({ status: 'Draft' } as any)).not.toBe('Done');
  });

  it('invoice-derived Confirmed with invoiceId/invoiceNumber is NOT Done', () => {
    const order: any = {
      status: 'Confirmed',
      creation_source: 'INVOICE_DERIVED',
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-001',
      invoiceStatus: 'Invoiced',
    };
    expect(order.invoiceId).toBeTruthy();
    expect(getOrderDisplayStatus(order)).toBe('Processing');
    expect(getOrderDisplayStatus(order)).not.toBe('Done');
    expect(isOrderInvoiced(order)).toBe(false);
  });

  it('explicit Order → Invoice conversion (Converted) still displays Done', () => {
    expect(getOrderDisplayStatus({ status: 'Converted' } as any)).toBe('Done');
    expect(isOrderInvoiced({ status: 'Converted' } as any)).toBe(true);
  });

  it('Fulfilled terminal state displays Done', () => {
    expect(getOrderDisplayStatus({ status: 'Fulfilled' } as any)).toBe('Done');
  });

  it('Cancelled stays Cancelled', () => {
    expect(getOrderDisplayStatus({ status: 'Cancelled' } as any)).toBe('Cancelled');
  });

  it('Confirmed without conversion displays Processing', () => {
    expect(getOrderDisplayStatus({ status: 'Confirmed' } as any)).toBe('Processing');
  });
});

describe('Fulfilled orders display Done after the legacy projection', () => {
  it('the projection rewrites Fulfilled to legacy Completed, so the old string test never fired', () => {
    // Guards the assumption this fix rests on: if toLegacyOrder ever stops
    // rewriting Fulfilled, the canonical read below is still correct.
    expect(projected('Fulfilled').status).toBe('Completed');
    expect(projected('Fulfilled').canonicalStatus).toBe('Fulfilled');
  });

  it('a fulfilled order reads as Done, not Processing', () => {
    const order = projected('Fulfilled');
    expect(isOrderInvoiced(order)).toBe(true);
    expect(getOrderDisplayStatus(order)).toBe('Done');
  });

  it('stays Done once the fulfilled order is also invoiced and paid', () => {
    const order = projected('Fulfilled', { invoiceStatus: 'Invoiced', paymentStatus: 'Paid', paidAmount: 500 });
    expect(order.status).toBe('Completed'); // Fulfilled outranks payment in the legacy fold
    expect(getOrderDisplayStatus(order)).toBe('Done');
  });

  it('a converted order is still Done', () => {
    const order = projected('Converted');
    expect(order.status).toBe('Converted');
    expect(getOrderDisplayStatus(order)).toBe('Done');
  });

  it('a cancelled order stays Cancelled even with an invoice attached', () => {
    const order = projected('Cancelled', { invoiceId: 'inv-9', invoiceNumber: 'INV-009' });
    expect(getOrderDisplayStatus(order)).toBe('Cancelled');
  });

  it('in-flight orders remain Processing, so Fulfilled is not reported by accident', () => {
    for (const status of ['Draft', 'Confirmed', 'Processing', 'Pending']) {
      expect(getOrderDisplayStatus(projected(status))).toBe('Processing');
    }
  });

  it('a paid but unfulfilled order is still Processing', () => {
    const order = projected('Processing', { paymentStatus: 'Paid', paidAmount: 500 });
    expect(order.status).toBe('Paid');
    expect(getOrderDisplayStatus(order)).toBe('Processing');
  });
});
