import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    executeAtomicOperation: vi.fn(),
  },
}));

import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';
import { canonicalizeOrder, getSalesOrderDisplayNumber } from '../../services/salesOrderService';
import { getOrderDisplayStatus } from '../../views/sales/components/orderStatusUtils';

const directInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'INV-100',
  invoiceNumber: 'INV-100',
  customerId: 'CUST-1',
  customerName: 'Acme',
  date: '2026-09-01T10:00:00.000Z',
  dueDate: '2026-09-08T10:00:00.000Z',
  status: 'Unpaid',
  items: [{ id: 'it-1', quantity: 2, price: 100 }],
  totalAmount: 200,
  ...overrides,
});

describe('ensureOrderFromInvoice — chain preserved, done state, ORD on sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dbService.getAll).mockResolvedValue([]);
    vi.mocked(dbService.put).mockResolvedValue(undefined as any);
  });

  it('creates an INVOICE_DERIVED order linked to the invoice, stored Fulfilled, unnumbered', async () => {
    const order: any = await transactionService.ensureOrderFromInvoice(directInvoice() as any);

    expect(order).not.toBeNull();
    // Explicit origin (never portal/SO by fallback).
    expect(order.creation_source).toBe('INVOICE_DERIVED');
    expect(order.creationSource).toBe('INVOICE_DERIVED');
    // Linkage intact.
    expect(order.invoiceId).toBe('INV-100');
    expect(order.invoiceNumber).toBe('INV-100');
    // The mirrored invoice is already posted: the order is complete by
    // construction (terminal Fulfilled = done, never Processing).
    expect(order.status).toBe('Fulfilled');
    // Real amount on both total fields so every list/store reads it.
    expect(order.total).toBe(200);
    expect(order.totalAmount).toBe(200);
    // No fabricated number: opaque local id, null number, flag false.
    expect(String(order.id).startsWith('local-')).toBe(true);
    expect(order.orderNumber).toBeNull();
    expect(order.orderNumberProvisional).toBe(false);
    expect(dbService.put).toHaveBeenCalledWith('salesOrders', expect.objectContaining({ id: order.id }));
  });

  it('created order shows its amount with done state, never an SO/TMP number', async () => {
    const order: any = await transactionService.ensureOrderFromInvoice(directInvoice() as any);
    const canonical = canonicalizeOrder(order);
    expect(canonical.status).toBe('Fulfilled');
    expect(canonical.total).toBe(200);
    expect(canonical.totalAmount).toBe(200);
    expect(canonical.orderNumber).toBeNull();
    expect(getSalesOrderDisplayNumber(canonical as any)).toBe('Pending number');
    expect(getOrderDisplayStatus(canonical as any)).toBe('Done');
    expect(getOrderDisplayStatus(canonical as any)).not.toBe('Processing');
  });

  it('draft invoices keep Draft status until finalised', async () => {
    const order: any = await transactionService.ensureOrderFromInvoice(
      directInvoice({ status: 'Draft' }) as any,
    );
    expect(order).not.toBeNull();
    expect(order.status).toBe('Draft');
    expect(order.total).toBe(200);
    expect(order.totalAmount).toBe(200);
  });

  it('skips invoices that already descend from an order (no duplicate chain)', async () => {
    const skipped: any = await transactionService.ensureOrderFromInvoice(
      directInvoice({ sourceOrderId: 'ORD-P726/0001' }) as any,
    );
    expect(skipped).toBeNull();
    expect(dbService.put).not.toHaveBeenCalled();
  });

  it('skips POS/walk-in invoices', async () => {
    const skipped: any = await transactionService.ensureOrderFromInvoice(
      directInvoice({ notes: 'POS sale' }) as any,
    );
    expect(skipped).toBeNull();
    expect(dbService.put).not.toHaveBeenCalled();
  });
});
