/**
 * landingCostConsumption.test.ts
 *
 * Consumption + multi-GRN accounting: one durable consumption model per
 * LandingCostItem.id with SOURCE = CONSUMED = CAPITALIZED = AP, remaining
 * tracked on the PO, bill/GRN mutual exclusion, PO/GRN edit protection,
 * same-tab serialization. No VAT behavior assumed.
 *
 * Covers: A (single GRN), B (bill-first one GRN), C (GRN-first bill),
 * D (bill-first two partials), E (GRN-first two partials), F (three GRNs),
 * G (multi-account multi-GRN), H (rounding multi-GRN), I (remaining zero),
 * J (remaining never negative), K (duplicate GRN), L (duplicate bill),
 * M (concurrent same-line capitalization), N (PO edit after bill),
 * O (GRN edit after consumption), P (method change after consumption),
 * Q (method change unconsumed), R (PO qty change after bill),
 * S (snapshot differs from PO), T (unresolved account), U (unresolved
 * provider), V (payment settles once), W (ordinary expense), X (no-landing
 * unchanged), Y (ledger balance per group), Z (WAC == consumed).
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
import { getLandingLineState, reconcileLandingCostLine } from '../../services/landingAllocation';

const ACC = {
  merchandise: 'ACC-11410',
  rawMaterials: 'ACC-11420',
  accountsPayable: 'ACC-21110',
  purchases: 'ACC-51100',
  bank: 'ACC-11210',
  defaultExpense: 'ACC-52000',
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
    acc('21110', 'Trade Creditors', 'LIABILITY'),
    acc('51100', 'Purchases', 'EXPENSE'),
    acc('52000', 'Other Expenses', 'EXPENSE'),
    acc('11210', 'Bank', 'ASSET'),
  ];
}

const SUPPLIERS = {
  goods: { id: 'SUP-GOODS', name: 'Goods Supplier', balance: 0 },
  freight: { id: 'SUP-FREIGHT', name: 'Speedy Freight Ltd', balance: 0 },
};

function stItem() {
  return {
    id: 'ST-1', name: 'Branded Pens', type: 'Stationery', inventoryRole: 'sellable', stock: 0,
    cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000,
  };
}

function rmItem() {
  return {
    id: 'RM-1', name: 'A4 Paper', type: 'Raw Material', stock: 0,
    cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000,
  };
}

function poFixture(over: any = {}) {
  return {
    id: 'PO-MC1',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Ordered',
    total: 3000000,
    totalAmount: 3000000,
    items: [
      { itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 },
      { itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 100, cost: 20000 },
    ],
    landingCosts: [
      { id: 'LC-M1', category: 'Freight', description: 'Inbound freight', amount: 300000, providerId: SUPPLIERS.freight.id },
    ],
    ...over,
  };
}

function grnLine(itemId: string, qty: number, unitCost: number, type: string) {
  return {
    itemId, name: itemId, type, orderedQty: qty, quantityReceived: qty, quantityRejected: 0,
    warehouseId: 'WH-MAIN', cost: unitCost, cost_price: unitCost, unitPrice: unitCost, price: unitCost,
  };
}

function grnFixture(over: any = {}) {
  return {
    id: 'GRN-MC1',
    purchaseOrderId: 'PO-MC1',
    date: '2026-03-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    landingAllocationMethod: 'VALUE',
    items: [
      grnLine('ST-1', 100, 10000, 'Stationery'),
      grnLine('RM-1', 100, 20000, 'Raw Material'),
    ],
    landingCosts: [
      { id: 'LC-M1', category: 'Freight', description: 'Inbound freight', amount: 300000, providerId: SUPPLIERS.freight.id },
    ],
    ...over,
  };
}

function seed(opts: { pos?: any[] } = {}) {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', [stItem(), rmItem()]);
  putAll('accounts', coaFixture());
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('purchases', opts.pos ?? [poFixture()]);
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'supplierPayments', 'expenses', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'bankAccounts', 'bankTransactions']) {
    memStores.tables.set(t, new Map());
  }
}

const ledger = () => [...memStores.tables.get('ledger')!.values()];
const txnsFor = (itemId: string) =>
  [...memStores.tables.get('inventoryTransactions')!.values()].filter((t: any) => t.itemId === itemId);
const balanceOf = (id: string) => memStores.tables.get('suppliers')!.get(id)?.balance ?? null;
const storedPO = async () => await dbService.get<any>('purchases', 'PO-MC1');
const landingLCLegs = () => ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'));
const landingBillLegs = () => ledger().filter((e: any) => String(e.id).startsWith('LG-LCB'));
const landedEmbeddedTotal = () =>
  [...memStores.tables.get('inventoryTransactions')!.values()].reduce((s: number, t: any) => s + (Number(t.landedCostTotal) || 0), 0);

beforeEach(() => {
  memStores.tables.clear();
});

describe('A. Single GRN full receipt consumes exactly the source', () => {
  it('events, journals, WAC and remaining converge on K300,000', async () => {
    seed();
    const res: any = await transactionService.processGoodsReceipt(grnFixture());
    expect(res.success).toBe(true);

    const po = await storedPO();
    expect(po.landingConsumption).toHaveLength(1);
    expect(po.landingConsumption[0]).toMatchObject({ landingCostId: 'LC-M1', kind: 'GRN', grnId: 'GRN-MC1', amount: 300000 });

    const state = getLandingLineState(po, 'LC-M1');
    expect(state).toMatchObject({ source: 300000, consumed: 300000, remaining: 0, billed: false });

    // VALUE basis 1M/2M → 100k merchandise + 200k raw.
    const byDebit = new Map(landingLCLegs().map((e: any) => [e.debitAccountId, e.amount]));
    expect(byDebit.get(ACC.merchandise)).toBe(100000);
    expect(byDebit.get(ACC.rawMaterials)).toBe(200000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
    expect(balanceOf(SUPPLIERS.goods.id)).toBe(3000000);

    const rec = reconcileLandingCostLine({ landingCostId: 'LC-M1', purchase: po, ledgerEntries: ledger() });
    expect(rec).toMatchObject({ source: 300000, consumedWAC: 300000, journalledTotal: 300000, providerAPTotal: 300000, remaining: 0, balanced: true });
  });
});

describe('B. Bill-first then one GRN', () => {
  it('single AP obligation with full WAC embedding and zero remaining', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });
    await transactionService.processGoodsReceipt(grnFixture());

    expect(landingBillLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    expect(landingLCLegs()).toHaveLength(0);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
    expect(landedEmbeddedTotal()).toBe(300000);

    const po = await storedPO();
    expect(po.landingConsumption.filter((e: any) => e.kind === 'BILL')).toHaveLength(1);
    expect(po.landingConsumption.filter((e: any) => e.kind === 'GRN')).toHaveLength(1);
    const state = getLandingLineState(po, 'LC-M1');
    expect(state).toMatchObject({ consumed: 300000, remaining: 0, billed: true });

    const rec = reconcileLandingCostLine({ landingCostId: 'LC-M1', purchase: po, ledgerEntries: ledger() });
    expect(rec.balanced).toBe(true);
  });
});

describe('C. GRN-first then bill stays rejected', () => {
  it('no second obligation is created', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture());
    const before = ledger().length;
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' })
    ).rejects.toThrow(/already capitalized/i);
    expect(ledger()).toHaveLength(before);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
  });
});

describe('D. Bill-first then two partial GRNs converge on the source', () => {
  it('each GRN embeds its proportional entitlement; AP stays single', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });

    // PO basis 3M. GRN#1 basis 800k → entitlement 80k (40k/40k).
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-P1',
        items: [grnLine('ST-1', 40, 10000, 'Stationery'), grnLine('RM-1', 20, 20000, 'Raw Material')],
      })
    );
    expect(txnsFor('ST-1').reduce((s: number, t: any) => s + t.landedCostTotal, 0)).toBe(40000);
    expect(txnsFor('RM-1').reduce((s: number, t: any) => s + t.landedCostTotal, 0)).toBe(40000);

    // GRN#2 basis 2.2M → entitlement 220k (60k/160k).
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-P2',
        items: [grnLine('ST-1', 60, 10000, 'Stationery'), grnLine('RM-1', 80, 20000, 'Raw Material')],
      })
    );
    const p2 = [...memStores.tables.get('goodsReceipts')!.values()].find((g: any) => g.id === 'GRN-P2')!;
    expect((p2.landingAllocations || []).reduce((s: number, x: any) => s + x.amount, 0)).toBe(220000);

    expect(landedEmbeddedTotal()).toBe(300000);
    expect(landingBillLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    expect(landingLCLegs()).toHaveLength(0);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);

    const rec = reconcileLandingCostLine({ landingCostId: 'LC-M1', purchase: await storedPO(), ledgerEntries: ledger() });
    expect(rec).toMatchObject({ consumedWAC: 300000, remaining: 0, balanced: true });
  });
});

describe('E. GRN-first then two partial GRNs post proportionally once each', () => {
  it('each GRN journals its entitlement; combined AP equals source', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-P1',
        items: [grnLine('ST-1', 40, 10000, 'Stationery'), grnLine('RM-1', 20, 20000, 'Raw Material')],
      })
    );
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(80000);

    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-P2',
        items: [grnLine('ST-1', 60, 10000, 'Stationery'), grnLine('RM-1', 80, 20000, 'Raw Material')],
      })
    );
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
    expect(landedEmbeddedTotal()).toBe(300000);

    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' })
    ).rejects.toThrow(/already capitalized/i);
  });
});

describe('F. Three GRNs consume one line proportionally and exactly', () => {
  it('80k + 90k + 130k entitlements converge on K300,000', async () => {
    seed();
    const parts = [
      ['GRN-T1', 40, 20],
      ['GRN-T2', 30, 30],
      ['GRN-T3', 30, 50],
    ] as const;
    // Bases: 800k / 900k / 1,300k of 3M → 80k / 90k / 130k.
    for (const [id, st, rm] of parts) {
      await transactionService.processGoodsReceipt(
        grnFixture({
          id,
          items: [grnLine('ST-1', st, 10000, 'Stationery'), grnLine('RM-1', rm, 20000, 'Raw Material')],
        })
      );
    }
    expect(landedEmbeddedTotal()).toBe(300000);
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    const state = getLandingLineState(await storedPO(), 'LC-M1');
    expect(state).toMatchObject({ consumed: 300000, remaining: 0 });
  });
});

describe('G. Multiple accounts across multiple GRNs reconcile exactly', () => {
  it('two lines consumed by different GRNs sum to source per account and total', async () => {
    seed({
      pos: undefined,
    });
    memStores.tables.get('purchases')!.set('PO-MC1', poFixture({
      landingCosts: [
        { id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id },
        { id: 'LC-C1', category: 'Customs', amount: 40000, providerId: SUPPLIERS.freight.id },
      ],
    }));
    // GRN#1 snapshot carries only the freight line.
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-G1',
        landingCosts: [{ id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id }],
      })
    );
    // GRN#2 carries both; freight remaining is zero so only customs consumes.
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-G2',
        landingCosts: [
          { id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id },
          { id: 'LC-C1', category: 'Customs', amount: 40000, providerId: SUPPLIERS.freight.id },
        ],
      })
    );

    // Freight 60k over 1M/2M → 20k/40k; customs 40k → 13333.33/26666.67.
    const byDebit = new Map<string, number>();
    for (const e of landingLCLegs()) {
      byDebit.set(e.debitAccountId, (byDebit.get(e.debitAccountId) || 0) + e.amount);
    }
    expect(byDebit.get(ACC.merchandise)).toBeCloseTo(33333.33, 2);
    expect(byDebit.get(ACC.rawMaterials)).toBeCloseTo(66666.67, 2);
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBeCloseTo(100000, 2);
    expect(balanceOf(SUPPLIERS.freight.id)).toBeCloseTo(100000, 2);
    expect(landedEmbeddedTotal()).toBeCloseTo(100000, 2);
    for (const id of ['LC-F1', 'LC-C1']) {
      expect(getLandingLineState(await storedPO(), id).remaining).toBe(0);
    }
  });
});

describe('H. Rounding remainder across GRNs stays exact', () => {
  it('fractional splits in separate GRNs each sum exactly', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-MC1', poFixture({
      items: [
        { itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 3, cost: 100 },
        { itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 3, cost: 100 },
      ],
      landingCosts: [
        { id: 'LC-R1', category: 'Freight', amount: 100, providerId: SUPPLIERS.freight.id },
        { id: 'LC-R2', category: 'Handling', amount: 200, providerId: SUPPLIERS.freight.id },
      ],
    }));
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-R1',
        items: [
          grnLine('ST-1', 1, 100, 'Stationery'),
          grnLine('RM-1', 1, 100, 'Raw Material'),
          { ...grnLine('ST-1', 1, 100, 'Stationery') },
          grnLine('ST-1', 1, 100, 'Stationery'),
          grnLine('RM-1', 1, 100, 'Raw Material'),
          { ...grnLine('RM-1', 1, 100, 'Raw Material') },
        ],
        landingCosts: [{ id: 'LC-R1', category: 'Freight', amount: 100, providerId: SUPPLIERS.freight.id }],
      })
    );
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-R2',
        items: [
          grnLine('ST-1', 1, 100, 'Stationery'),
          grnLine('RM-1', 1, 100, 'Raw Material'),
          { ...grnLine('RM-1', 1, 100, 'Raw Material') },
          grnLine('ST-1', 1, 100, 'Stationery'),
          grnLine('RM-1', 1, 100, 'Raw Material'),
          { ...grnLine('ST-1', 1, 100, 'Stationery') },
        ],
        landingCosts: [{ id: 'LC-R2', category: 'Handling', amount: 200, providerId: SUPPLIERS.freight.id }],
      })
    );
    // Full PO-basis coverage per GRN: 33.33×6 and 66.66×5+66.68 — each exact
    // in cents (float sums compared at cent precision).
    expect(landedEmbeddedTotal()).toBeCloseTo(300, 2);
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBeCloseTo(300, 2);
    expect(getLandingLineState(await storedPO(), 'LC-R1').remaining).toBe(0);
    expect(getLandingLineState(await storedPO(), 'LC-R2').remaining).toBe(0);
  });
});

describe('I/J. Remaining reaches zero and never goes negative', () => {
  it('remaining is exactly zero with full receipt coverage', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture());
    expect(getLandingLineState(await storedPO(), 'LC-M1').remaining).toBe(0);
  });

  it('remaining never drops below zero across partitioned partial verifies', async () => {
    seed();
    // Partitioned coverage of the 3M PO basis: 800k + 900k + 1,300k →
    // entitlements 80k + 90k + 130k converge exactly on 300k.
    const parts = [
      ['GRN-N1', 40, 20],
      ['GRN-N2', 30, 30],
      ['GRN-N3', 30, 50],
    ] as const;
    for (const [id, st, rm] of parts) {
      await transactionService.processGoodsReceipt(
        grnFixture({
          id,
          items: [grnLine('ST-1', st, 10000, 'Stationery'), grnLine('RM-1', rm, 20000, 'Raw Material')],
        })
      );
      expect(getLandingLineState(await storedPO(), 'LC-M1').remaining).toBeGreaterThanOrEqual(0);
    }
    expect(landedEmbeddedTotal()).toBe(300000);
    expect(getLandingLineState(await storedPO(), 'LC-M1').remaining).toBe(0);
  });
});

describe('K. Duplicate GRN retry leaves consumption unchanged', () => {
  it('second verify throws with identical ledger, inventory and events', async () => {
    seed();
    const grn = grnFixture();
    await transactionService.processGoodsReceipt(grn);
    const snapshot = JSON.stringify({
      ledger: ledger(),
      inventory: [...memStores.tables.get('inventory')!.values()],
      events: (await storedPO()).landingConsumption,
    });
    await expect(transactionService.processGoodsReceipt(grn)).rejects.toThrow(/duplicate financial request/i);
    const after = JSON.stringify({
      ledger: ledger(),
      inventory: [...memStores.tables.get('inventory')!.values()],
      events: (await storedPO()).landingConsumption,
    });
    expect(after).toBe(snapshot);
  });
});

describe('L. Duplicate bill retry leaves consumption unchanged', () => {
  it('second bill throws with identical events and obligation', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });
    const events = JSON.stringify((await storedPO()).landingConsumption);
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' })
    ).rejects.toThrow(/already billed/i);
    expect(JSON.stringify((await storedPO()).landingConsumption)).toBe(events);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
  });
});

describe('M. Concurrent same-line capitalization serializes safely', () => {
  it('two concurrent GRNs consume the source exactly once in total', async () => {
    seed();
    const g1 = grnFixture({ id: 'GRN-CA' });
    const g2 = grnFixture({ id: 'GRN-CB' });
    const [r1, r2]: any[] = await Promise.all([
      transactionService.processGoodsReceipt(g1),
      transactionService.processGoodsReceipt(g2),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Exactly one GRN embedded the full line; the other embedded zero.
    expect(landedEmbeddedTotal()).toBe(300000);
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
    expect(getLandingLineState(await storedPO(), 'LC-M1').remaining).toBe(0);
  });
});

describe('N. PO landing edit after bill is rejected', () => {
  it('amount change throws and stored PO is untouched', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });
    const po: any = await storedPO();
    await expect(
      transactionService.processPurchaseOrder({
        ...po,
        landingCosts: [{ id: 'LC-M1', category: 'Freight', amount: 350000, providerId: SUPPLIERS.freight.id }],
      } as any)
    ).rejects.toThrow(/cannot be changed/i);
    const after: any = await storedPO();
    expect(after.landingCosts.find((c: any) => c.id === 'LC-M1').amount).toBe(300000);
    expect(after.landingConsumption).toHaveLength(1);
  });
});

describe('O. GRN landing edit after consumption is rejected', () => {
  it('re-verify throws duplicate and the stored snapshot is unchanged', async () => {
    seed();
    const grn = grnFixture();
    await transactionService.processGoodsReceipt(grn);
    const storedBefore = JSON.stringify(await dbService.get('goodsReceipts', 'GRN-MC1'));
    await expect(
      transactionService.processGoodsReceipt({
        ...grnFixture(),
        landingCosts: [{ id: 'LC-M1', category: 'Freight', amount: 350000, providerId: SUPPLIERS.freight.id }],
      })
    ).rejects.toThrow(/duplicate financial request/i);
    expect(JSON.stringify(await dbService.get('goodsReceipts', 'GRN-MC1'))).toBe(storedBefore);
  });
});

describe('P/Q. Allocation method freeze semantics', () => {
  it('P: method change after consumption is rejected', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture());
    const po: any = await storedPO();
    await expect(
      transactionService.processPurchaseOrder({ ...po, landingAllocationMethod: 'QUANTITY' } as any)
    ).rejects.toThrow(/allocation method/i);
    expect(((await storedPO()) as any).landingAllocationMethod ?? 'VALUE').not.toBe('QUANTITY');
  });

  it('Q: method change with no consumption is permitted', async () => {
    seed();
    const po: any = await storedPO();
    const res: any = await transactionService.processPurchaseOrder({ ...po, landingAllocationMethod: 'QUANTITY' } as any);
    expect(res.success).toBe(true);
    expect(((await storedPO()) as any).landingAllocationMethod).toBe('QUANTITY');
  });
});

describe('R. PO quantity change after bill cannot move posted bill accounting', () => {
  it('bill journals, invoice and balance are frozen; future entitlement follows the current PO basis', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });
    const billLegsBefore = JSON.stringify(landingBillLegs());

    const po: any = await storedPO();
    const res: any = await transactionService.processPurchaseOrder({
      ...po,
      items: [
        { itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 150, cost: 10000 },
        { itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 100, cost: 20000 },
      ],
    } as any);
    expect(res.success).toBe(true);
    expect(JSON.stringify(landingBillLegs())).toBe(billLegsBefore);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);

    // GRN built from the OLD snapshot: its entitlement is forward-looking
    // against the CURRENT PO basis (3M of 3.5M), so it consumes 257,142.86
    // and leaves an explicit remainder — never silently, never over.
    await transactionService.processGoodsReceipt(grnFixture());
    expect(landedEmbeddedTotal()).toBeCloseTo(257142.86, 2);
    expect(getLandingLineState(await storedPO(), 'LC-M1').remaining).toBeCloseTo(42857.14, 2);
  });
});

describe('S. Snapshot differing from PO consumes per snapshot numerator, current denominator', () => {
  it('allocation follows GRN prices against the PO basis with remainder explicit', async () => {
    seed();
    // GRN snapshot reprices ST to 5,000: snapshot basis 2.5M vs PO 3M →
    // entitlement 250k (ST 50k / RM 200k), remainder 50k explicit.
    await transactionService.processGoodsReceipt(
      grnFixture({
        items: [grnLine('ST-1', 100, 5000, 'Stationery'), grnLine('RM-1', 100, 20000, 'Raw Material')],
      })
    );
    expect(txnsFor('ST-1')[0].landedCostTotal).toBe(50000);
    expect(txnsFor('RM-1')[0].landedCostTotal).toBe(200000);
    const po = await storedPO();
    expect(po.landingConsumption).toHaveLength(1);
    expect(po.landingConsumption[0].amount).toBe(250000);
    expect(getLandingLineState(po, 'LC-M1').remaining).toBe(50000);
  });
});

describe('T/U. Unresolvable account/provider fail with no consumption recorded', () => {
  it('T: missing inventory account fails before mutation', async () => {
    seed();
    memStores.tables.get('accounts')!.delete(ACC.rawMaterials);
    memStores.tables.get('accounts')!.delete('ACC-11400');
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({ items: [grnLine('RM-1', 100, 10000, 'Raw Material')] })
      )
    ).rejects.toThrow(/inventory account/i);
    expect(ledger()).toHaveLength(0);
    expect(((await storedPO()) as any).landingConsumption ?? []).toEqual([]);
  });

  it('U: unknown provider fails before mutation', async () => {
    seed();
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({
          landingCosts: [{ id: 'LC-U1', category: 'Freight', amount: 50000, providerId: 'SUP-GHOST' }],
        })
      )
    ).rejects.toThrow(/unknown provider/i);
    expect(ledger()).toHaveLength(0);
    expect(((await storedPO()) as any).landingConsumption ?? []).toEqual([]);
  });
});

describe('V. Supplier payment settles the final obligation exactly once', () => {
  it('full payment clears the provider balance with DR AP and no expense', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-MC1', landingCostId: 'LC-M1' });
    await transactionService.processGoodsReceipt(grnFixture());
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);

    const res: any = await transactionService.recordSupplierPayment({
      id: 'SPAY-MC1',
      supplierId: SUPPLIERS.freight.id,
      supplier_id: SUPPLIERS.freight.id,
      date: '2026-03-20',
      payment_date: '2026-03-20',
      amount: 300000,
      paymentMethod: 'bank_transfer',
      payment_method: 'bank_transfer',
      accountId: ACC.bank,
      bank_account_id: ACC.bank,
    } as any);
    expect(res.success).toBe(true);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);
    const pay = ledger().find((e: any) => String(e.id).startsWith('LG-SPAY'))!;
    expect(pay.debitAccountId).toBe(ACC.accountsPayable);
    expect(pay.amount).toBe(300000);
    expect(ledger().some((e: any) => String(e.debitAccountId).startsWith('ACC-5'))).toBe(false);
  });
});

describe('W. Ordinary expenses remain ordinary', () => {
  it('addExpense posts DR expense / CR bank unchanged', async () => {
    seed();
    const res: any = await transactionService.addExpense({
      id: 'EXP-MC1',
      date: '2026-03-15',
      description: 'Office stationery',
      amount: 25000,
      category: 'Office',
      status: 'Approved',
    } as any);
    expect(res.success).toBe(true);
    const entry = ledger().find((e: any) => String(e.id).startsWith('LG-EXP-MAIN'))!;
    expect(entry.debitAccountId).toBe(ACC.defaultExpense);
    expect(entry.creditAccountId).toBe(ACC.bank);
    expect(entry.amount).toBe(25000);
  });
});

describe('X. Receipt without landing cost is unchanged', () => {
  it('posts goods-only journals with no events and no allocation fields', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture({ landingCosts: [] }));
    expect(landingLCLegs()).toHaveLength(0);
    expect(landingBillLegs()).toHaveLength(0);
    expect(((await storedPO()) as any).landingConsumption ?? []).toEqual([]);
    const stored: any = await dbService.get('goodsReceipts', 'GRN-MC1');
    expect(stored.landingAllocations ?? []).toEqual([]);
  });
});

describe('Y. Ledger balances per capitalization group', () => {
  it('landing debits equal landing credits equal the source', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-MC1', poFixture({
      landingCosts: [
        { id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id },
        { id: 'LC-C1', category: 'Customs', amount: 40000, providerId: SUPPLIERS.freight.id },
      ],
    }));
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [
          { id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id },
          { id: 'LC-C1', category: 'Customs', amount: 40000, providerId: SUPPLIERS.freight.id },
        ],
      })
    );
    const lc = landingLCLegs();
    let dr = 0;
    let cr = 0;
    for (const e of lc) {
      expect(e.debitAccountId).toBeTruthy();
      expect(e.creditAccountId).toBe(ACC.accountsPayable);
      expect(e.debitAccountId).not.toBe(e.creditAccountId);
      expect(e.amount).toBeGreaterThan(0);
      dr += e.amount;
      cr += e.amount;
    }
    expect(dr).toBe(100000);
    expect(cr).toBe(100000);
  });
});

describe('Z. WAC landed increment equals total consumed capitalization', () => {
  it('multi-GRN embedded total matches consumption events', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-Z1',
        items: [grnLine('ST-1', 40, 10000, 'Stationery'), grnLine('RM-1', 20, 20000, 'Raw Material')],
      })
    );
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-Z2',
        items: [grnLine('ST-1', 60, 10000, 'Stationery'), grnLine('RM-1', 80, 20000, 'Raw Material')],
      })
    );
    const po = await storedPO();
    const consumed = (po.landingConsumption || []).reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0);
    expect(consumed).toBe(300000);
    expect(landedEmbeddedTotal()).toBe(consumed);
  });
});
