import { beforeEach, describe, expect, it, vi } from 'vitest';

// dbService is mocked: these tests prove the costing LOGIC (gates, WAC math,
// alias sync, CP sourcing) without touching real business records.
vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    put: vi.fn(),
    getAll: vi.fn(),
  },
}));

import { dbService } from '../../services/db';
import { inventoryResourceService } from '../../services/inventoryResourceService';
import { isInventoryBearingItem } from '../../utils/inventoryNormalization';
import { resolveStoredCost } from '../../utils/pricing';
import { calculateLineProfit, resolveSaleLineCostPrice } from '../../utils/saleProfit';
import { buildPricingBreakdownSnapshot } from '../../utils/pricingBreakdown';
import { costAliasValues, syncCostAliases } from '../../services/purchaseCosting';

const mockedDb = vi.mocked(dbService, true);

const stockStationery = () => ({
  id: 'ST-A4-REAM',
  name: 'A4 Paper Ream',
  type: 'Stationery',
  stock: 5,
  cost: 17000,
  cost_price: 17000,
  cost_per_unit: 17000,
  costPrice: 17000,
  normalizedCP: 17000,
});

const printedProduct = () => ({
  id: 'PROD-BCARD',
  name: 'Business Cards (500)',
  type: 'Product',
  stock: 0,
  cost: 35000,
  cost_price: 35000,
  costPrice: 35000,
  price: 50000,
});

const printingService = () => ({
  id: 'SVC-PRINT',
  name: 'A4 Full-Colour Print',
  type: 'Service',
  stock: 0,
  cost: 8000,
  cost_price: 8000,
  costPrice: 8000,
  price: 15000,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedDb.getAll.mockResolvedValue([]);
  mockedDb.put.mockResolvedValue('ok');
});

describe('stock vs non-stock eligibility gate', () => {
  it('tracks Stationery and Raw Material, never Product/Service', () => {
    expect(isInventoryBearingItem({ type: 'Stationery' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Raw Material' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Raw Material', classification: 'consumable' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Product' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'Service' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'service' })).toBe(false);
    expect(isInventoryBearingItem({})).toBe(false);
    expect(isInventoryBearingItem(null)).toBe(false);
  });
});

describe('TEST 1 — Stationery: 5 @ 17,000 + PO 10 @ 20,000 (mocked receipt)', () => {
  it('records the lot at actual cost and averages the master to 19,000', async () => {
    const item = stockStationery();
    mockedDb.get.mockResolvedValue({ ...item });
    mockedDb.getAll.mockResolvedValue([
      {
        id: 'LOT-OLD',
        itemId: item.id,
        purchaseQuantity: 5,
        totalCost: 85000,
        consumptionQuantity: 5,
        unitCostPerConsumption: 17000,
        remainingConsumption: 5,
      },
    ]);

    const { lot, updatedItem } = await inventoryResourceService.recordPurchase({
      itemId: item.id,
      purchaseQuantity: 10,
      purchaseUnit: 'ream',
      totalCost: 200000,
      supplierId: 'SUP-B',
      invoiceRef: 'PO-0001',
    });

    // Receipt keeps the actual K20,000 unit cost on the new lot.
    expect(lot.unitCostPerConsumption).toBe(20000);
    expect(lot.totalCost).toBe(200000);
    expect(lot.remainingConsumption).toBe(10);

    // Master carries the weighted average across every alias — no stale
    // alias may shadow it for PO defaults, POS snapshots, or sale CP.
    expect(updatedItem?.stock).toBe(15);
    expect(updatedItem?.cost).toBe(19000);
    expect(updatedItem?.cost_price).toBe(19000);
    expect(updatedItem?.cost_per_unit).toBe(19000);
    expect(updatedItem?.costPrice).toBe(19000);
    expect(updatedItem?.normalizedCP).toBe(19000);
  });

  it('does not drag consumed stock back into the average', async () => {
    // All 5 @ 17,000 were sold (stock 0); a stale lot row still exists.
    // The next receipt must average from the live carrying position (0),
    // not from long-consumed history.
    mockedDb.get.mockResolvedValue({ ...stockStationery(), stock: 0 });
    mockedDb.getAll.mockResolvedValue([
      { id: 'LOT-STALE', itemId: 'ST-A4-REAM', consumptionQuantity: 5, unitCostPerConsumption: 17000, remainingConsumption: 5 },
    ]);

    const { updatedItem } = await inventoryResourceService.recordPurchase({
      itemId: 'ST-A4-REAM',
      purchaseQuantity: 10,
      purchaseUnit: 'ream',
      totalCost: 200000,
      invoiceRef: 'PO-0002',
    });

    expect(updatedItem?.stock).toBe(10);
    expect(updatedItem?.cost).toBe(20000);
  });

  it('prices the follow-on sale off the average: 3 @ 25,000 → profit 18,000', () => {
    const saleLine = { type: 'Stationery', quantity: 3, price: 25000, cost: 19000, cost_price: 19000 };
    // Even a stale 17,000 fallback cannot leak in: the line CP wins.
    expect(resolveSaleLineCostPrice(saleLine, 17000)).toBe(19000);
    const profit = calculateLineProfit({ ...saleLine, subtotal: 75000 });
    expect(profit).toBe(18000);
  });
});

describe('TEST 2 — Raw material from a second supplier', () => {
  it('enters the new actual price into the average with correct math', async () => {
    mockedDb.get.mockResolvedValue({
      id: 'RM-TONER',
      name: 'Toner Powder',
      type: 'Raw Material',
      stock: 20,
      cost: 5000,
      cost_price: 5000,
      cost_per_unit: 5000,
      costPrice: 5000,
      normalizedCP: 5000,
    });

    const { lot, updatedItem } = await inventoryResourceService.recordPurchase({
      itemId: 'RM-TONER',
      purchaseQuantity: 10,
      purchaseUnit: 'kg',
      totalCost: 70000,
      supplierId: 'SUP-SECOND',
      invoiceRef: 'PO-0003',
    });

    expect(lot.unitCostPerConsumption).toBe(7000);
    expect(updatedItem?.stock).toBe(30);
    // (20 x 5,000 + 10 x 7,000) / 30 = 5,666.6667
    expect(updatedItem?.cost).toBeCloseTo(5666.6667, 4);
    expect(updatedItem?.cost_price).toBeCloseTo(5666.6667, 4);

    // The subsequent income transaction uses the resulting inventory CP.
    expect(resolveSaleLineCostPrice({ cost: updatedItem?.cost }, 5000)).toBeCloseTo(5666.6667, 4);
  });
});

describe('TEST 3 — Printed product (non-stock): CP 35,000 / SP 50,000', () => {
  it('keeps explicit CP/SP and profit with no inventory substitution', () => {
    const product = printedProduct();
    const saleLine = { type: 'Product', quantity: 2, price: 50000, cost: 35000, cost_price: 35000 };

    expect(isInventoryBearingItem(product)).toBe(false);
    expect(resolveSaleLineCostPrice(saleLine, 17000)).toBe(35000);
    expect(calculateLineProfit({ ...saleLine, subtotal: 100000 })).toBe(30000);

    const breakdown = buildPricingBreakdownSnapshot(saleLine);
    expect(breakdown?.baseMaterialCost).toBe(35000);
    expect(breakdown?.sellingPrice).toBe(50000);
    expect(breakdown?.profitAmount).toBe(15000);
  });

  it('refuses to run inventory receipt costing for the product', async () => {
    mockedDb.get.mockResolvedValue(printedProduct());
    await expect(
      inventoryResourceService.recordPurchase({
        itemId: 'PROD-BCARD',
        purchaseQuantity: 1,
        purchaseUnit: 'pcs',
        totalCost: 35000,
        invoiceRef: 'PO-X',
      })
    ).rejects.toThrow(/stock-tracked/);
    expect(mockedDb.put).not.toHaveBeenCalled();
  });
});

describe('TEST 4 — Printing service (non-stock): CP 8,000 / SP 15,000', () => {
  it('keeps explicit CP/SP and profit with no inventory substitution', () => {
    const service = printingService();
    const saleLine = {
      type: 'Service',
      quantity: 1,
      price: 15000,
      cost: 8000,
      cost_price: 8000,
      serviceDetails: { pages: 10, copies: 1, unitCostPerCopy: 8000, unitPricePerCopy: 15000 },
    };

    expect(isInventoryBearingItem(service)).toBe(false);
    expect(resolveSaleLineCostPrice(saleLine, 17000)).toBe(8000);
    expect(calculateLineProfit({ ...saleLine, subtotal: 15000 })).toBe(7000);

    const breakdown = buildPricingBreakdownSnapshot(saleLine);
    expect(breakdown?.baseMaterialCost).toBe(8000);
    expect(breakdown?.profitAmount).toBe(7000);
  });

  it('refuses to run inventory receipt costing for the service', async () => {
    mockedDb.get.mockResolvedValue(printingService());
    await expect(
      inventoryResourceService.recordPurchase({
        itemId: 'SVC-PRINT',
        purchaseQuantity: 1,
        purchaseUnit: 'job',
        totalCost: 8000,
        invoiceRef: 'PO-Y',
      })
    ).rejects.toThrow(/stock-tracked/);
    expect(mockedDb.put).not.toHaveBeenCalled();
  });
});

describe('TEST 5 — Cross-contamination: stationery PO never touches product/service CP', () => {
  it('leaves unrelated explicit CPs and their profits bit-identical', async () => {
    const product = Object.freeze(printedProduct());
    const service = Object.freeze(printingService());
    const before = {
      productCP: resolveStoredCost(product),
      serviceCP: resolveStoredCost(service),
      productProfit: calculateLineProfit({ price: 50000, cost: 35000, quantity: 1, subtotal: 50000 }),
      serviceProfit: calculateLineProfit({ price: 15000, cost: 8000, quantity: 1, subtotal: 15000 }),
    };

    // A stock-tracked stationery purchase at a changed price goes through.
    mockedDb.get.mockImplementation(async (_store: string, id: string) => {
      if (id === 'ST-A4-REAM') return { ...stockStationery() };
      throw new Error(`unexpected read ${_store}/${id}`);
    });
    await inventoryResourceService.recordPurchase({
      itemId: 'ST-A4-REAM',
      purchaseQuantity: 10,
      purchaseUnit: 'ream',
      totalCost: 200000,
      supplierId: 'SUP-B',
      invoiceRef: 'PO-0001',
    });

    // Nothing ever wrote to the product/service records: only the
    // stationery id was read, and only it was persisted.
    const reads = mockedDb.get.mock.calls.map((c) => c[1]);
    expect(reads).toEqual(['ST-A4-REAM']);
    const puts = mockedDb.put.mock.calls.map((c) => c[1]);
    expect(puts.length).toBeGreaterThan(0);
    for (const record of puts) {
      expect(String(record?.itemId || record?.id || '')).not.toMatch(/PROD-BCARD|SVC-PRINT/);
    }

    expect(resolveStoredCost(product)).toBe(before.productCP);
    expect(resolveStoredCost(service)).toBe(before.serviceCP);
    expect(before.productCP).toBe(35000);
    expect(before.serviceCP).toBe(8000);
    expect(calculateLineProfit({ price: 50000, cost: 35000, quantity: 1, subtotal: 50000 })).toBe(
      before.productProfit
    );
    expect(calculateLineProfit({ price: 15000, cost: 8000, quantity: 1, subtotal: 15000 })).toBe(
      before.serviceProfit
    );
  });
});

describe('cost-alias coherence (no stale alias shadows a fresh average)', () => {
  it('syncs every alias to one value', () => {
    expect(costAliasValues(19000)).toEqual({
      cost: 19000,
      cost_price: 19000,
      cost_per_unit: 19000,
      costPrice: 19000,
      normalizedCP: 19000,
    });
    const synced = syncCostAliases({ id: 'X', type: 'Stationery', name: 'Keep me' }, 19000);
    expect(synced.name).toBe('Keep me');
    expect(synced.cost).toBe(19000);
    expect(synced.cost_price).toBe(19000);
    expect(synced.cost_per_unit).toBe(19000);
    expect(synced.costPrice).toBe(19000);
    expect(synced.normalizedCP).toBe(19000);
  });
});
