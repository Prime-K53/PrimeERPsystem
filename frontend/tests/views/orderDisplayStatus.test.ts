import { describe, expect, it } from 'vitest';
import {
  getOrderDisplayStatus,
  isOrderInvoiced,
} from '../../views/sales/components/orderStatusUtils';

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
