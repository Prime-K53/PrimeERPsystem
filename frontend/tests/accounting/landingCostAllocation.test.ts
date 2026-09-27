/**
 * landingCostAllocation.test.ts
 *
 * Authoritative allocation foundation: one deterministic result per
 * landing line per GRN, persisted on the GRN snapshot, VALUE/QUANTITY
 * only, exact-cent totals, multi-account debits, bill/GRN single
 * capitalization. No VAT behavior assumed.
 *
 * Covers: A (VALUE exactness), B (QUANTITY exactness), C (non-stock
 * excluded), D (zero eligible fails), E (zero quantity fails, no VALUE
 * fallback), F (rounding exactness), G (persisted method), H (stored
 * allocation beats later PO edits), I (multi-account 11410/11420 +
 * engine-level 11430), J (unresolved account fails pre-mutation),
 * K (bill-first), L (GRN-first), M (idempotent retry), N (no-landing
 * unchanged).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const memStores = vi.hoisted(() => ({
  tables: new Map<string, Map<string, any>>(),
}));

vi.mock('../../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      getTable(name).set(String(obj.id), obj);
    },
    delete: async (id: string) => {
      getTable(name).delete(String(id));
    },
  });
  return {
    dbService: {
      getAll: async (table: string) => [...getTable(table).values()],
      get: async (table: string, id: string) => getTable(table).get(String(id)),
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id), obj);
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

import { transactionService } from '../../services/transactionService';
import { dbService } from '../../services/db';
import { allocateLandingCosts } from '../../services/landingAllocation';

const ACC = {
  inventoryGroup: 'ACC-11400',
  merchandise: 'ACC-11410',
  rawMaterials: 'ACC-11420',
  accountsPayable: 'ACC-21110',
  purchases: 'ACC-51100',
};

function coaFixture(): any[] {
  const acc = (code: string, name: string, account_type: string, extra: any = {}) => ({
    id: `ACC-${code}`,
    code,
    account_number: code,
    name,
    account_type,
    type: account_type === 'ASSET' ? 'Asset' : account_type === 'EXPENSE' ? 'Expense' : 'Liability',
    normal_balance: account_type === 'ASSET' || account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    parent_account_id: null,
    is_active: true,
    allow_posting: true,
    ...extra,
  });
  return [
    acc('11400', 'Inventory', 'ASSET', { allow_posting: false }),
    acc('11410', 'Merchandise Inventory', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('11420', 'Raw Materials', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('11430', 'Finished Goods', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('21110', 'Trade Creditors', 'LIABILITY'),
    acc('51100', 'Purchases', 'EXPENSE'),
  ];
}

const SUPPLIERS = {
  goods: { id: 'SUP-GOODS', name: 'Goods Supplier', balance: 0 },
  freight: { id: 'SUP-FREIGHT', name: 'Speedy Freight Ltd', balance: 0 },
};

function rmItem(over: any = {}) {
  return {
    id: 'RM-1', name: 'A4 Paper', type: 'Raw Material', stock: 0,
    cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000,
    ...over,
  };
}

function sellableStationery() {
  return {
    id: 'ST-1', name: 'Branded Pens', type: 'Stationery', inventoryRole: 'sellable', stock: 0,
    cost: 500, cost_price: 500, cost_per_unit: 500, costPrice: 500, normalizedCP: 500,
  };
}

function productItem() {
  return { id: 'PROD-1', name: 'Printed Flyers', type: 'Product', stock: 0, cost: 50000 };
}

function grnLine(itemId: string, qty: number, unitCost: number, type = 'Raw Material') {
  return {
    itemId, name: itemId, type, orderedQty: qty, quantityReceived: qty, quantityRejected: 0,
    warehouseId: 'WH-MAIN', cost: unitCost, cost_price: unitCost, unitPrice: unitCost, price: unitCost,
  };
}

function grnFixture(over: any = {}) {
  return {
    id: 'GRN-ALLOC1',
    purchaseOrderId: 'PO-ALLOC1',
    date: '2026-03-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    landingAllocationMethod: 'VALUE',
    items: [grnLine('RM-1', 80, 10000), grnLine('RM-1', 200, 1000, 'Raw Material')],
    landingCosts: [{ id: 'LC-A1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    ...over,
  };
}

function poLine(itemId: string, qty: number, unitCost: number, type = 'Raw Material', name?: string) {
  return { itemId, name: name || itemId, type, quantity: qty, cost: unitCost };
}

function poFixture(over: any = {}) {
  return {
    id: 'PO-ALLOC1',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Ordered',
    total: 1000000,
    totalAmount: 1000000,
    // PO lines back the cross-GRN entitlement basis; PO landing lines back
    // canonical line identity (GRN lines must exist on the source PO).
    // Tests needing full single-GRN consumption mirror the GRN items and
    // landing lines one-to-one here.
    items: [poLine('RM-1', 80, 10000, 'Raw Material', 'A4 Paper'), poLine('RM-1', 200, 1000, 'Raw Material', 'A4 Paper')],
    landingCosts: [{ id: 'LC-A1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    ...over,
  };
}

function seed(opts: { items?: any[]; accounts?: any[]; po?: any | null } = {}) {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', opts.items ?? [rmItem(), sellableStationery(), productItem()]);
  putAll('accounts', opts.accounts ?? coaFixture());
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('purchases', opts.po === null ? [] : [poFixture(opts.po)]);
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'supplierPayments', 'expenses', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'vatTransactions']) {
    memStores.tables.set(t, new Map());
  }
}

const ledger = () => [...memStores.tables.get('ledger')!.values()];
const txnsFor = (itemId: string) =>
  [...memStores.tables.get('inventoryTransactions')!.values()].filter((t: any) => t.itemId === itemId);
const balanceOf = (id: string) => memStores.tables.get('suppliers')!.get(id)?.balance ?? null;

beforeEach(() => {
  memStores.tables.clear();
});

describe('A. VALUE allocation exactness (80/20 basis)', () => {
  it('allocates K80,000 / K20,000 across an 800k/200k basis', async () => {
    seed({
      po: {
        items: [poLine('RM-1', 80, 10000, 'Raw Material', 'A4 Paper'), poLine('RM-2', 200, 1000, 'Raw Material', 'Toner')],
      },
    });
    // Two distinct items so per-item IN rows are separable.
    memStores.tables.get('inventory')!.set('RM-2', rmItem({ id: 'RM-2', name: 'Toner' }));
    const grn = grnFixture({
      items: [grnLine('RM-1', 80, 10000), { ...grnLine('RM-2', 200, 1000), itemId: 'RM-2', name: 'Toner' }],
    });
    await transactionService.processGoodsReceipt(grn);

    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(80000);
    expect(txnsFor('RM-2')[0].landedCostTotal).toBe(20000);
    const lcTotal = ledger()
      .filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))
      .reduce((s: number, e: any) => s + e.amount, 0);
    expect(lcTotal).toBe(100000);
  });
});

describe('B. QUANTITY allocation exactness (100/300 units)', () => {
  it('allocates K10,000 / K30,000 of K40,000', async () => {
    seed({
      po: {
        landingAllocationMethod: 'QUANTITY',
        items: [poLine('RM-1', 100, 10000, 'Raw Material', 'A4 Paper'), poLine('RM-2', 300, 1000, 'Raw Material', 'Toner')],
        landingCosts: [{ id: 'LC-B1', category: 'Freight', amount: 40000, providerId: SUPPLIERS.freight.id }],
      },
    });
    memStores.tables.get('inventory')!.set('RM-2', rmItem({ id: 'RM-2', name: 'Toner' }));
    const grn = grnFixture({
      landingAllocationMethod: 'QUANTITY',
      items: [grnLine('RM-1', 100, 10000), { ...grnLine('RM-2', 300, 1000), itemId: 'RM-2', name: 'Toner' }],
      landingCosts: [{ id: 'LC-B1', category: 'Freight', amount: 40000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(grn);

    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(10000);
    expect(txnsFor('RM-2')[0].landedCostTotal).toBe(30000);
    // Per-unit burden follows quantity basis, not value.
    expect(txnsFor('RM-1')[0].landedCostPerUnit).toBe(100);
    expect(txnsFor('RM-2')[0].landedCostPerUnit).toBe(100);
  });
});

describe('C. Non-stock lines excluded from basis and allocation', () => {
  it('service line receives zero and consumes zero denominator', async () => {
    seed({
      po: { items: [poLine('RM-1', 80, 10000, 'Raw Material', 'A4 Paper')] },
    });
    const grn = grnFixture({
      items: [
        grnLine('RM-1', 80, 10000),
        { ...grnLine('PROD-1', 10, 50000), itemId: 'PROD-1', name: 'Printed Flyers', type: 'Product' },
      ],
    });
    await transactionService.processGoodsReceipt(grn);

    // Entire K100,000 lands on the single stock line (not 800/1300 pro-rata).
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(100000);
    expect(txnsFor('PROD-1')).toHaveLength(0);
    const lcTotal = ledger()
      .filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))
      .reduce((s: number, e: any) => s + e.amount, 0);
    expect(lcTotal).toBe(100000);
  });
});

describe('D. Zero eligible stock lines fails closed', () => {
  it('rejects with nothing posted when only non-stock lines exist', async () => {
    seed({
      po: { items: [{ itemId: 'PROD-1', name: 'Printed Flyers', type: 'Product', quantity: 10, cost: 50000 }] },
    });
    const grn = grnFixture({
      items: [{ ...grnLine('PROD-1', 10, 50000), itemId: 'PROD-1', name: 'Printed Flyers', type: 'Product' }],
    });
    await expect(transactionService.processGoodsReceipt(grn)).rejects.toThrow(/eligible|stock-bearing/i);
    expect(ledger()).toHaveLength(0);
    expect(memStores.tables.get('inventoryTransactions')!.size).toBe(0);
  });
});

describe('E. Zero quantity under QUANTITY fails closed without VALUE fallback', () => {
  it('rejects when eligible received quantity totals zero', async () => {
    seed({
      po: { landingAllocationMethod: 'QUANTITY', items: [poLine('RM-1', 0, 10000, 'Raw Material', 'A4 Paper')] },
    });
    const grn = grnFixture({
      landingAllocationMethod: 'QUANTITY',
      items: [grnLine('RM-1', 0, 10000)],
    });
    await expect(transactionService.processGoodsReceipt(grn)).rejects.toThrow(/quantity/i);
    expect(ledger()).toHaveLength(0);
    // Must not silently fall back: no VALUE-proportioned journals exist.
    expect(ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))).toHaveLength(0);
  });
});

describe('F. Currency rounding exactness', () => {
  it('engine splits K100.00 three ways with an exact total', () => {
    const result = allocateLandingCosts({
      receiptLines: [
        { itemId: 'A', quantityReceived: 1, unitCost: 100 },
        { itemId: 'B', quantityReceived: 1, unitCost: 100 },
        { itemId: 'C', quantityReceived: 1, unitCost: 100 },
      ],
      isEligible: () => true,
      landingLines: [{ id: 'LC-R1', amount: 100 }],
      method: 'VALUE',
    });
    const amounts = result.shares.map((s) => s.amount);
    expect(amounts.reduce((s, v) => s + v, 0)).toBe(100);
    expect(amounts).toEqual([33.33, 33.33, 33.34]);
  });

  it('integration: fractional shares still sum to the source exactly', async () => {
    seed({
      po: {
        items: [
          poLine('RM-1', 1, 100, 'Raw Material', 'A4 Paper'),
          poLine('RM-2', 1, 100, 'Raw Material', 'Toner'),
          poLine('RM-3', 1, 100, 'Raw Material', 'RM-3'),
        ],
        landingCosts: [{ id: 'LC-R2', category: 'Freight', amount: 100, providerId: SUPPLIERS.freight.id }],
      },
    });
    for (const id of ['RM-2', 'RM-3']) {
      memStores.tables.get('inventory')!.set(id, rmItem({ id, name: id }));
    }
    const grn = grnFixture({
      items: [grnLine('RM-1', 1, 100), { ...grnLine('RM-2', 1, 100), itemId: 'RM-2' }, { ...grnLine('RM-3', 1, 100), itemId: 'RM-3' }],
      landingCosts: [{ id: 'LC-R2', category: 'Freight', amount: 100, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(grn);
    const perItem = ['RM-1', 'RM-2', 'RM-3'].map((id) => txnsFor(id)[0].landedCostTotal);
    for (const v of perItem) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(perItem.reduce((s, v) => s + v, 0)).toBe(100);
  });
});

describe('G. Persisted allocation method', () => {
  it('GRN snapshot retains QUANTITY vs VALUE', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture({ landingAllocationMethod: 'QUANTITY' }));
    const stored: any = await dbService.get('goodsReceipts', 'GRN-ALLOC1');
    expect(stored.landingAllocationMethod).toBe('QUANTITY');
    expect(Array.isArray(stored.landingAllocations)).toBe(true);
    expect(stored.landingAllocations.length).toBeGreaterThan(0);
    for (const share of stored.landingAllocations) {
      expect(share.basis).toBe('QUANTITY');
      expect(share.landingCostId).toBeTruthy();
      expect(share.receiptLineKey).toBeTruthy();
    }
  });
});

describe('H. Stored allocation beats later PO edits', () => {
  it('post-verify PO edits do not rewrite history; stored snapshot is the record', async () => {
    seed({
      po: {
        items: [poLine('RM-1', 80, 10000, 'Raw Material', 'A4 Paper')],
        landingCosts: [{ id: 'LC-H1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
      },
    });
    const grn = grnFixture({
      items: [grnLine('RM-1', 80, 10000)],
      landingCosts: [{ id: 'LC-H1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(grn);
    const storedBefore = JSON.stringify(await dbService.get('goodsReceipts', 'GRN-ALLOC1'));
    const txnsBefore = JSON.stringify(txnsFor('RM-1'));

    // Later PO price edits (non-landing fields remain editable).
    const po: any = await dbService.get('purchases', 'PO-ALLOC1');
    await transactionService.processPurchaseOrder({ ...po, total: 9999999 } as any);

    // History is untouched: no recomputation, no new events, no new journals.
    expect(JSON.stringify(await dbService.get('goodsReceipts', 'GRN-ALLOC1'))).toBe(storedBefore);
    expect(JSON.stringify(txnsFor('RM-1'))).toBe(txnsBefore);
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(100000);
  });
});

describe('I. Multiple inventory accounts', () => {
  it('one GRN distributes debits across 11410 and 11420 with exact provider credit', async () => {
    seed({
      po: {
        items: [
          poLine('ST-1', 100, 5000, 'Stationery', 'Branded Pens'),
          poLine('RM-1', 100, 10000, 'Raw Material', 'A4 Paper'),
        ],
        landingCosts: [{ id: 'LC-I1', category: 'Freight', amount: 150000, providerId: SUPPLIERS.freight.id }],
      },
    });
    const grn = grnFixture({
      items: [
        { ...grnLine('ST-1', 100, 5000), itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery' },
        grnLine('RM-1', 100, 10000),
      ],
      // 500k merchandise + 1,000k raw = 1,500k basis; 150k landing → 50k / 100k.
      landingCosts: [{ id: 'LC-I1', category: 'Freight', amount: 150000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(grn);

    const lc = ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'));
    expect(lc).toHaveLength(2);
    const byDebit = new Map(lc.map((e: any) => [e.debitAccountId, e.amount]));
    expect(byDebit.get(ACC.merchandise)).toBe(50000);
    expect(byDebit.get(ACC.rawMaterials)).toBe(100000);
    for (const e of lc) {
      expect(e.creditAccountId).toBe(ACC.accountsPayable);
      expect(e.supplierId).toBe(SUPPLIERS.freight.id);
    }
    expect(txnsFor('ST-1')[0].landedCostTotal).toBe(50000);
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(100000);
  });

  it('engine distributes across three stubbed accounts exactly', () => {
    const result = allocateLandingCosts({
      receiptLines: [
        { itemId: 'A', quantityReceived: 6, unitCost: 100000 },
        { itemId: 'B', quantityReceived: 4, unitCost: 100000 },
        { itemId: 'C', quantityReceived: 2, unitCost: 50000 },
      ],
      isEligible: () => true,
      landingLines: [{ id: 'LC-I2', amount: 100000 }],
      method: 'VALUE',
      resolveAccount: (i) => ['ACC-11410', 'ACC-11420', 'ACC-11430'][i],
    });
    const byAccount = new Map<string, number>();
    for (const s of result.shares) {
      byAccount.set(s.inventoryAccount!, (byAccount.get(s.inventoryAccount!) || 0) + s.amount);
    }
    // 600k / 400k / 100k of 1,100k, floored to cents with the 2-cent
    // remainder on the final line: 54545.45 / 36363.63 / 9090.92.
    expect(byAccount.get('ACC-11410')).toBeCloseTo(54545.45, 2);
    expect(byAccount.get('ACC-11420')).toBeCloseTo(36363.63, 2);
    expect(byAccount.get('ACC-11430')).toBeCloseTo(9090.92, 2);
    // Cent-exact by construction (engine enforces integer-cent equality);
    // float summation dust is compared at cent precision.
    expect(result.shares.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(100000, 2);
  });
});

describe('J. Unresolved inventory account fails before mutation', () => {
  it('rejects with no journals, no stock movement, no idempotency block', async () => {
    seed({ accounts: coaFixture().filter((a) => a.code !== '11420' && a.code !== '11400') });
    const before = await dbService.get<any>('inventory', 'RM-1');
    await expect(transactionService.processGoodsReceipt(grnFixture())).rejects.toThrow(/inventory account/i);
    expect(ledger()).toHaveLength(0);
    const after = await dbService.get<any>('inventory', 'RM-1');
    expect(after.stock).toBe(before.stock);
    expect(after.cost).toBe(before.cost);
    // Retry stays possible after fixing configuration.
    memStores.tables.get('accounts')!.set('ACC-11420', coaFixture().find((a) => a.code === '11420')!);
    const res: any = await transactionService.processGoodsReceipt(grnFixture({ id: 'GRN-ALLOC1' }));
    expect(res.success).toBe(true);
  });
});

describe('K. Bill-first: WAC impact without a second capitalization journal', () => {
  it('billed line allocates into WAC; GRN posts no duplicate provider journal', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-LCB1', {
      id: 'PO-LCB1',
      supplierId: SUPPLIERS.goods.id,
      status: 'Ordered',
      total: 800000,
      totalAmount: 800000,
      items: [{ itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 80, cost: 10000 }],
      landingCosts: [{ id: 'LC-K1', category: 'Freight', amount: 80000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-K1' });

    const grn = grnFixture({
      purchaseOrderId: 'PO-LCB1',
      items: [grnLine('RM-1', 80, 10000)],
      landingCosts: [{ id: 'LC-K1', category: 'Freight', amount: 80000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(grn);

    // No second provider journal for the billed line.
    expect(ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))).toHaveLength(0);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(80000);

    // WAC still carries the full landed amount (bill debit + WAC agree).
    const item = await dbService.get<any>('inventory', 'RM-1');
    // (0 + 80 x (10000 + 1000)) / 80 = 11000
    expect(item.cost).toBe(11000);
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(80000);
  });
});

describe('L. GRN-first: later bill stays rejected', () => {
  it('billing a GRN-capitalized line fails with no new postings', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-LCB1', {
      id: 'PO-LCB1',
      supplierId: SUPPLIERS.goods.id,
      status: 'Ordered',
      total: 800000,
      totalAmount: 800000,
      items: [{ itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 80, cost: 10000 }],
      landingCosts: [{ id: 'LC-L1', category: 'Freight', amount: 80000, providerId: SUPPLIERS.freight.id }],
    });
    await transactionService.processGoodsReceipt(
      grnFixture({
        purchaseOrderId: 'PO-LCB1',
        items: [grnLine('RM-1', 80, 10000)],
        landingCosts: [{ id: 'LC-L1', category: 'Freight', amount: 80000, providerId: SUPPLIERS.freight.id }],
      })
    );

    const before = ledger().length;
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-L1' })
    ).rejects.toThrow(/already capitalized/i);
    expect(ledger()).toHaveLength(before);
  });
});

describe('M. Idempotent retry leaves everything unchanged', () => {
  it('second verify throws duplicate with identical ledger/inventory/allocation', async () => {
    seed();
    const grn = grnFixture();
    await transactionService.processGoodsReceipt(grn);
    const snapshot = JSON.stringify({
      ledger: ledger(),
      inventory: [...memStores.tables.get('inventory')!.values()],
      txns: [...memStores.tables.get('inventoryTransactions')!.values()],
      stored: await dbService.get('goodsReceipts', 'GRN-ALLOC1'),
    });

    await expect(transactionService.processGoodsReceipt(grn)).rejects.toThrow(/duplicate financial request/i);
    const after = JSON.stringify({
      ledger: ledger(),
      inventory: [...memStores.tables.get('inventory')!.values()],
      txns: [...memStores.tables.get('inventoryTransactions')!.values()],
      stored: await dbService.get('goodsReceipts', 'GRN-ALLOC1'),
    });
    expect(after).toBe(snapshot);
  });
});

describe('N. Ordinary receipt without landing cost is unchanged', () => {
  it('posts goods-only journals with base WAC and no allocation fields', async () => {
    seed();
    const grn = grnFixture({ landingCosts: [] });
    const res: any = await transactionService.processGoodsReceipt(grn);
    expect(res.success).toBe(true);

    const inv = ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-INV'));
    expect(inv).toHaveLength(1);
    expect(inv[0].amount).toBe(1000000);
    expect(ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))).toHaveLength(0);

    const item = await dbService.get<any>('inventory', 'RM-1');
    // (80 x 10000 + 200 x 1000) / 280 — base cost only, no landing.
    expect(item.cost).toBe(1000000 / 280);
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(0);

    const stored: any = await dbService.get('goodsReceipts', 'GRN-ALLOC1');
    expect(stored.landingAllocations ?? []).toEqual([]);
  });
});
