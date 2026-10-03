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

describe('ensureOrderFromInvoice — chain preserved, never auto-Done, ORD on sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dbService.getAll).mockResolvedValue([]);
    vi.mocked(dbService.put).mockResolvedValue(undefined as any);
  });

  it('creates an INVOICE_DERIVED order linked to the invoice, stored Confirmed, unnumbered', async () => {
    const order: any = await transactionService.ensureOrderFromInvoice(directInvoice() as any);

    expect(order).not.toBeNull();
    // Explicit origin (never portal/SO by fallback).
    expect(order.creation_source).toBe('INVOICE_DERIVED');
    expect(order.creationSource).toBe('INVOICE_DERIVED');
    // Linkage intact.
    expect(order.invoiceId).toBe('INV-100');
    expect(order.invoiceNumber).toBe('INV-100');
    // Stored workflow status stays Confirmed (existing appropriate status).
    expect(order.status).toBe('Confirmed');
    // No fabricated number: opaque local id, null number, flag false.
    expect(String(order.id).startsWith('local-')).toBe(true);
    expect(order.orderNumber).toBeNull();
    expect(order.orderNumberProvisional).toBe(false);
    expect(dbService.put).toHaveBeenCalledWith('salesOrders', expect.objectContaining({ id: order.id }));
  });

  it('created order shows pending state, NOT Done and never an SO/TMP number', async () => {
    const order: any = await transactionService.ensureOrderFromInvoice(directInvoice() as any);
    const canonical = canonicalizeOrder(order);
    expect(canonical.status).toBe('Confirmed');
    expect(canonical.orderNumber).toBeNull();
    expect(getSalesOrderDisplayNumber(canonical as any)).toBe('Pending number');
    expect(getOrderDisplayStatus(canonical as any)).toBe('Processing');
    expect(getOrderDisplayStatus(canonical as any)).not.toBe('Done');
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
