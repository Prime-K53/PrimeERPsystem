import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSaveSalesOrder, mockGetSalesOrders } = vi.hoisted(() => ({
  mockSaveSalesOrder: vi.fn(),
  mockGetSalesOrders: vi.fn(async () => []),
}));
const { mockCreateOrder } = vi.hoisted(() => ({
  mockCreateOrder: vi.fn(async () => undefined),
}));
const { mockClaimOnline } = vi.hoisted(() => ({
  mockClaimOnline: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  api: {
    sales: {
      saveSalesOrder: mockSaveSalesOrder,
      getSalesOrders: mockGetSalesOrders,
      deleteSalesOrder: vi.fn(async () => undefined),
    },
  },
}));

vi.mock('../../../services/transactionService', () => ({
  transactionService: {
    createOrder: mockCreateOrder,
  },
}));

vi.mock('../../../services/adminPortalClient', () => ({
  adminLifecycle: { requests: {} },
}));

vi.mock('../../../services/backgroundSyncService', () => ({
  backgroundSyncService: {
    claimOnlineSalesOrderNumber: mockClaimOnline,
  },
}));

import { useSalesOrderStore } from '../../../stores/salesOrderStore';
import { getSalesOrderDisplayNumber, PENDING_SALES_ORDER_NUMBER } from '../../../services/salesOrderService';

const validOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'local-1',
  orderNumber: null,
  orderNumberProvisional: false,
  creation_source: 'DIRECT_ERP',
  creationSource: 'DIRECT_ERP',
  customerId: 'cust-1',
  customerName: 'Acme',
  status: 'Draft',
  items: [{ id: 'i1', productId: 'p1', description: 'Flyers', quantity: 2, unitPrice: 100, lineTotal: 200 }],
  total: 200,
  totalAmount: 200,
  ...overrides,
});

describe('salesOrderStore online creation contract', () => {
  beforeEach(() => {
    mockSaveSalesOrder.mockReset();
    mockGetSalesOrders.mockReset().mockResolvedValue([]);
    mockCreateOrder.mockReset().mockResolvedValue(undefined);
    mockClaimOnline.mockReset();
    useSalesOrderStore.setState({ salesOrders: [], isLoading: false, error: null });
  });

  it('online createSalesOrder resolves with the official ORD number (no Pending)', async () => {
    mockSaveSalesOrder.mockResolvedValueOnce({
      success: true,
      id: 'local-1',
      order_number: 'ORD-P726/026',
      version: 1,
      synced: true,
    });

    const created = await useSalesOrderStore.getState().createSalesOrder(validOrder() as never);

    expect((created as unknown as Record<string, unknown>).order_number).toBe('ORD-P726/026');
    expect((created as unknown as Record<string, unknown>).orderNumber).toBe('ORD-P726/026');
    expect(getSalesOrderDisplayNumber(created)).toBe('ORD-P726/026');
    const state = useSalesOrderStore.getState().salesOrders;
    expect(state).toHaveLength(1);
    expect(getSalesOrderDisplayNumber(state[0])).toBe('ORD-P726/026');
  });

  it('offline/failed fast-path keeps a durable pending order for background convergence', async () => {
    mockSaveSalesOrder.mockResolvedValueOnce({
      success: true,
      id: 'local-1',
      order_number: null,
      synced: false,
      pending: true,
    });

    const created = await useSalesOrderStore.getState().createSalesOrder(validOrder() as never);

    expect((created as unknown as Record<string, unknown>).order_number ?? null).toBeNull();
    expect(getSalesOrderDisplayNumber(created)).toBe(PENDING_SALES_ORDER_NUMBER);
    // Durable: still in state, healable by the next sync.
    expect(useSalesOrderStore.getState().salesOrders).toHaveLength(1);
  });

  it('double submit of the same order is blocked to one creation', async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((resolve) => { release = () => resolve({ success: true, id: 'local-1', order_number: 'ORD-P726/026', synced: true }); });
    mockSaveSalesOrder.mockReturnValueOnce(gate);

    const first = useSalesOrderStore.getState().createSalesOrder(validOrder() as never);
    await expect(useSalesOrderStore.getState().createSalesOrder(validOrder() as never)).rejects.toThrow(
      /Duplicate submit blocked/,
    );
    release();
    const created = await first;
    expect((created as unknown as Record<string, unknown>).orderNumber).toBe('ORD-P726/026');
    expect(useSalesOrderStore.getState().salesOrders).toHaveLength(1);
  });

  it('createFinancialOrder claims the authoritative number before refreshing the list', async () => {
    const numbered = {
      ...validOrder(),
      order_number: 'ORD-P726/027',
      orderNumber: 'ORD-P726/027',
      version: 1,
    };
    mockClaimOnline.mockResolvedValueOnce({ adopted: numbered, order_number: 'ORD-P726/027', version: 1 });
    mockGetSalesOrders.mockResolvedValueOnce([numbered]);

    await useSalesOrderStore.getState().createFinancialOrder(validOrder() as never);

    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(mockClaimOnline).toHaveBeenCalledTimes(1);
    const [claimedArg] = mockClaimOnline.mock.calls[0];
    expect(String((claimedArg as Record<string, unknown>).id)).toBe('local-1');
    const state = useSalesOrderStore.getState().salesOrders;
    expect(state).toHaveLength(1);
    expect(getSalesOrderDisplayNumber(state[0])).toBe('ORD-P726/027');
  });
});
