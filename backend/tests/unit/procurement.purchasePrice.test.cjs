// NOTE (.cjs): jest.mock() is NOT hoisted without a babel transform, so all
// mocks are registered textually BEFORE any require() below.
jest.mock('../../services/supabaseRepository.cjs', () => ({
  purchaseOrders: { upsert: jest.fn(), getById: jest.fn() },
  purchaseOrderItems: { upsert: jest.fn(), getAll: jest.fn() },
  goodsReceipts: { upsert: jest.fn(), getById: jest.fn(), getAll: jest.fn() },
  suppliers: { getById: jest.fn() },
  accounts: { getAll: jest.fn() },
  ledger_entries: { upsert: jest.fn() },
}));

const ProcurementService = require('../../services/procurementService.cjs');
const repo = require('../../services/supabaseRepository.cjs');

describe('procurementService.createPurchase — PO actual purchase price', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProcurementService();
    repo.purchaseOrders.getById.mockImplementation(async (id) => ({
      id,
      data: { supplier_id: 'SUP-B', status: 'Draft', currency: 'K' },
    }));
    repo.suppliers.getById.mockResolvedValue(null);
  });

  it('stores a manually entered K20,000 line cost as the PO unit price', async () => {
    await service.createPurchase(
      {
        id: 'PO-0001',
        supplier_id: 'SUP-B',
        items: [
          { item_id: 'RM-A4-REAM', item_name: 'A4 Paper Ream', quantity: 10, cost: 20000 },
        ],
      },
      'user-1'
    );

    expect(repo.purchaseOrderItems.upsert).toHaveBeenCalledTimes(1);
    const record = repo.purchaseOrderItems.upsert.mock.calls[0][0];
    expect(record.data.purchase_order_id).toBe('PO-0001');
    expect(record.data.quantity).toBe(10);
    expect(record.data.unit_price).toBe(20000);
    expect(record.data.total_price).toBe(200000);
  });

  it('never stores a zero unit price when the price arrives under another alias', async () => {
    await service.createPurchase(
      {
        id: 'PO-0002',
        supplier_id: 'SUP-B',
        items: [{ item_id: 'RM-A4-REAM', item_name: 'A4 Paper Ream', quantity: 10, price: 20000 }],
      },
      'user-1'
    );

    const record = repo.purchaseOrderItems.upsert.mock.calls[0][0];
    expect(record.data.unit_price).toBe(20000);
    expect(record.data.total_price).toBe(200000);
  });

  it('keeps an explicit unit_price when the caller provides one', async () => {
    await service.createPurchase(
      {
        id: 'PO-0003',
        supplier_id: 'SUP-A',
        items: [{ item_id: 'RM-A4-REAM', item_name: 'A4 Paper Ream', quantity: 5, unit_price: 17000 }],
      },
      'user-1'
    );

    const record = repo.purchaseOrderItems.upsert.mock.calls[0][0];
    expect(record.data.unit_price).toBe(17000);
    expect(record.data.total_price).toBe(85000);
  });
});
