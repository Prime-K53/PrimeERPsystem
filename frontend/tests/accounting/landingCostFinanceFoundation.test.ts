/**
 * landingCostFinanceFoundation.test.ts
 *
 * Finance-foundation accounting tests for capitalized Landing Cost.
 * Drives the real transactionService.processGoodsReceipt against
 * in-memory stores (same harness style as stockAdjustmentAccounting).
 *
 * Canonical model under test:
 *   goods:  DR Inventory / CR goods-supplier AP (goods only)
 *   landed: DR Inventory / CR landing-provider AP (per provider)
 * Landing never posts DR Purchases 51100 merely because the landed
 * total exceeds the goods-only PO total, and the goods supplier is
 * never credited for third-party landing amounts.
 *
 * Covers: A (goods-only), B (goods + landed, split payables),
 * C (normal GRN incl. preserved price variance), D (no DR 51100 for
 * landed), E (balanced journals), F (idempotency), G (inventory landed
 * equals capitalized accounting), H (multiple providers + single-source
 * provider), plus fail-clearly provider validation and non-stock
 * allocation isolation. No VAT behavior assumed.
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

const ACC = {
  inventoryGroup: 'ACC-11400',
  rawMaterials: 'ACC-11420',
  accountsPayable: 'ACC-21110',
  purchases: 'ACC-51100',
  cogs: 'ACC-51200',
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
    acc('11420', 'Raw Materials', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('21110', 'Trade Creditors', 'LIABILITY'),
    acc('51100', 'Purchases', 'EXPENSE'),
    acc('51200', 'Cost of Goods Sold', 'EXPENSE'),
  ];
}

const SUPPLIERS = {
  goods: { id: 'SUP-GOODS', name: 'Goods Supplier', balance: 0 },
  freight: { id: 'SUP-FREIGHT', name: 'Speedy Freight Ltd', balance: 0 },
  customs: { id: 'SUP-CUSTOMS', name: 'Customs Broker', balance: 0 },
};

function stockItem(over: any = {}) {
  return {
    id: 'RM-1',
    name: 'A4 Paper',
    type: 'Raw Material',
    stock: 100,
    cost: 1000,
    cost_price: 1000,
    cost_per_unit: 1000,
    costPrice: 1000,
    normalizedCP: 1000,
    ...over,
  };
}

function productItem() {
  return { id: 'PROD-1', name: 'Printed Flyers', type: 'Product', stock: 0, cost: 50000 };
}

function poFixture(over: any = {}) {
  return {
    id: 'PO-LC1',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Ordered',
    total: 1000000,
    totalAmount: 1000000,
    // PO lines back the cross-GRN entitlement basis (VALUE/QUANTITY).
    items: [
      {
        itemId: 'RM-1',
        name: 'A4 Paper',
        type: 'Raw Material',
        quantity: 100,
        cost: 10000,
      },
    ],
    landingCosts: [],
    ...over,
  };
}

function grnFixture(over: any = {}) {
  return {
    id: 'GRN-LC1',
    purchaseOrderId: 'PO-LC1',
    date: '2026-03-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    items: [
      {
        itemId: 'RM-1',
        name: 'A4 Paper',
        type: 'Raw Material',
        orderedQty: 100,
        quantityReceived: 100,
        quantityRejected: 0,
        warehouseId: 'WH-MAIN',
        cost: 10000,
        cost_price: 10000,
        unitPrice: 10000,
        price: 10000,
      },
    ],
    landingCosts: [],
    ...over,
  };
}

function landingLine(over: any = {}) {
  return {
    id: `LC-${Math.random().toString(36).slice(2, 8)}`,
    category: 'Freight',
    description: 'Test freight',
    amount: 60000,
    providerId: SUPPLIERS.freight.id,
    ...over,
  };
}

function seed(opts: {
  items?: any[];
  suppliers?: any[];
  po?: any | null;
  accounts?: any[];
} = {}) {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', opts.items ?? [stockItem()]);
  putAll('accounts', opts.accounts ?? coaFixture());
  putAll('suppliers', opts.suppliers ?? Object.values(SUPPLIERS));
  putAll('purchases', opts.po === null ? [] : [poFixture(opts.po)]);
  for (const t of ['ledger', 'goodsReceipts', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'warehouseInventory']) {
    memStores.tables.set(t, new Map());
  }
}

const ledger = () => [...memStores.tables.get('ledger')!.values()];
const entriesByPrefix = (prefix: string) => ledger().filter((e: any) => String(e.id).startsWith(prefix));
const supplierBalance = (id: string) => memStores.tables.get('suppliers')!.get(id)?.balance ?? null;

beforeEach(() => {
  memStores.tables.clear();
});

describe('A. Goods-only GRN: DR Inventory / CR goods-supplier AP', () => {
  it('posts a single goods journal with no landing and no variance legs', async () => {
    seed();
    const res: any = await transactionService.processGoodsReceipt(grnFixture());
    expect(res.success).toBe(true);

    const inv = entriesByPrefix('LG-GRN-INV');
    expect(inv).toHaveLength(1);
    expect(inv[0].debitAccountId).toBe(ACC.rawMaterials);
    expect(inv[0].creditAccountId).toBe(ACC.accountsPayable);
    expect(inv[0].amount).toBe(1000000);
    expect(inv[0].supplierId).toBe(SUPPLIERS.goods.id);
    expect(inv[0].referenceId).toBe('GRN-LC1');

    expect(entriesByPrefix('LG-GRN-LC')).toHaveLength(0);
    expect(entriesByPrefix('LG-GRN-VAR')).toHaveLength(0);
    expect(ledger()).toHaveLength(1);
    expect(supplierBalance(SUPPLIERS.goods.id)).toBe(1000000);
  });
});

describe('B. Goods + capitalized landing: split payables, landed in inventory', () => {
  it('DR Inventory goods+landed; CR goods AP goods-only; CR provider AP landed', async () => {
    seed();
    const grn = grnFixture({
      landingCosts: [
        landingLine({ category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id }),
        landingLine({ category: 'Customs', amount: 40000, providerId: SUPPLIERS.customs.id }),
      ],
    });
    const res: any = await transactionService.processGoodsReceipt(grn);
    expect(res.success).toBe(true);

    const inv = entriesByPrefix('LG-GRN-INV');
    expect(inv).toHaveLength(1);
    expect(inv[0].debitAccountId).toBe(ACC.rawMaterials);
    expect(inv[0].creditAccountId).toBe(ACC.accountsPayable);
    expect(inv[0].amount).toBe(1000000);
    expect(inv[0].supplierId).toBe(SUPPLIERS.goods.id);

    const lc = entriesByPrefix('LG-GRN-LC');
    expect(lc).toHaveLength(2);
    const freight = lc.find((e: any) => e.supplierId === SUPPLIERS.freight.id)!;
    const customs = lc.find((e: any) => e.supplierId === SUPPLIERS.customs.id)!;
    expect(freight.debitAccountId).toBe(ACC.rawMaterials);
    expect(freight.creditAccountId).toBe(ACC.accountsPayable);
    expect(freight.amount).toBe(60000);
    expect(customs.amount).toBe(40000);
    expect(freight.referenceId).toBe('GRN-LC1');

    // Goods supplier obligation is goods only — never the landed-inclusive total.
    expect(supplierBalance(SUPPLIERS.goods.id)).toBe(1000000);
    expect(supplierBalance(SUPPLIERS.freight.id)).toBe(60000);
    expect(supplierBalance(SUPPLIERS.customs.id)).toBe(40000);

    // Inventory carrying cost absorbed the full landed amount (WAC 6000).
    const item = await dbService.get<any>('inventory', 'RM-1');
    expect(item.stock).toBe(200);
    expect(item.cost).toBe(6000);
    expect(item.cost_price).toBe(6000);
  });
});

describe('C. No landing: normal GRN accounting unchanged incl. price variance', () => {
  it('posts price variance to Purchases when goods differ from PO, without landing', async () => {
    seed({ po: { total: 900000, totalAmount: 900000 } });
    await transactionService.processGoodsReceipt(grnFixture());

    const variance = entriesByPrefix('LG-GRN-VAR');
    expect(variance).toHaveLength(1);
    expect(variance[0].debitAccountId).toBe(ACC.purchases);
    expect(variance[0].creditAccountId).toBe(ACC.accountsPayable);
    expect(variance[0].amount).toBe(100000);

    const inv = entriesByPrefix('LG-GRN-INV');
    expect(inv[0].amount).toBe(1000000);
  });

  it('posts negative variance as DR AP / CR Purchases', async () => {
    seed({ po: { total: 1100000, totalAmount: 1100000 } });
    await transactionService.processGoodsReceipt(grnFixture());

    const variance = entriesByPrefix('LG-GRN-VAR');
    expect(variance).toHaveLength(1);
    expect(variance[0].debitAccountId).toBe(ACC.accountsPayable);
    expect(variance[0].creditAccountId).toBe(ACC.purchases);
    expect(variance[0].amount).toBe(100000);
  });
});

describe('D. Landing never creates DR Purchases merely for exceeding the PO total', () => {
  it('records zero Purchases debits when the only excess over PO is landed cost', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [
          landingLine({ amount: 60000, providerId: SUPPLIERS.freight.id }),
          landingLine({ category: 'Customs', amount: 40000, providerId: SUPPLIERS.customs.id }),
        ],
      })
    );

    const purchasesDebits = ledger().filter((e: any) => e.debitAccountId === ACC.purchases);
    expect(purchasesDebits).toHaveLength(0);
    expect(entriesByPrefix('LG-GRN-VAR')).toHaveLength(0);
  });
});

describe('E. Journals balance exactly', () => {
  it('every entry carries debit, credit and positive amount; inventory debits equal AP credits', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [
          landingLine({ amount: 60000, providerId: SUPPLIERS.freight.id }),
          landingLine({ category: 'Customs', amount: 40000, providerId: SUPPLIERS.customs.id }),
        ],
      })
    );

    for (const e of ledger()) {
      expect(e.debitAccountId).toBeTruthy();
      expect(e.creditAccountId).toBeTruthy();
      expect(e.debitAccountId).not.toBe(e.creditAccountId);
      expect(e.amount).toBeGreaterThan(0);
    }
    const drInventory = ledger()
      .filter((e: any) => e.debitAccountId === ACC.rawMaterials)
      .reduce((s: number, e: any) => s + e.amount, 0);
    const crPayables = ledger()
      .filter((e: any) => e.creditAccountId === ACC.accountsPayable)
      .reduce((s: number, e: any) => s + e.amount, 0);
    expect(drInventory).toBe(1100000);
    expect(crPayables).toBe(1100000);
  });
});

describe('F. Repeated posting blocked by existing idempotency', () => {
  it('rejects a second verify of the same GRN without adding journals', async () => {
    seed();
    const grn = grnFixture({
      landingCosts: [landingLine({ amount: 60000, providerId: SUPPLIERS.freight.id })],
    });
    await transactionService.processGoodsReceipt(grn);
    const countAfterFirst = ledger().length;
    expect(countAfterFirst).toBeGreaterThan(0);

    await expect(transactionService.processGoodsReceipt(grn)).rejects.toThrow(/duplicate financial request/i);
    expect(ledger()).toHaveLength(countAfterFirst);
  });
});

describe('G. Inventory landed cost equals the capitalized accounting amount', () => {
  it('IN transaction landed totals match the landing payable credits; WAC carries both', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [
          landingLine({ amount: 60000, providerId: SUPPLIERS.freight.id }),
          landingLine({ category: 'Customs', amount: 40000, providerId: SUPPLIERS.customs.id }),
        ],
      })
    );

    const txns = [...memStores.tables.get('inventoryTransactions')!.values()];
    expect(txns).toHaveLength(1);
    expect(txns[0].landedCostTotal).toBe(100000);
    expect(txns[0].landedCostPerUnit).toBe(1000);
    expect(txns[0].effectiveUnitCost).toBe(11000);

    const lcCredits = entriesByPrefix('LG-GRN-LC').reduce((s: number, e: any) => s + e.amount, 0);
    expect(lcCredits).toBe(txns[0].landedCostTotal);

    const item = await dbService.get<any>('inventory', 'RM-1');
    // (100×1000 + 100×11000) / 200 = 6000
    expect(item.cost).toBe(6000);
  });
});

describe('H. Multiple providers produce separate payable credits', () => {
  it('credits each landing provider separately with audit linkage to cost lines', async () => {
    seed();
    const freightLine = landingLine({ id: 'LC-F1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id });
    const customsLine = landingLine({ id: 'LC-C1', category: 'Customs', amount: 40000, providerId: SUPPLIERS.customs.id });
    await transactionService.processGoodsReceipt(grnFixture({ landingCosts: [freightLine, customsLine] }));

    const lc = entriesByPrefix('LG-GRN-LC');
    expect(lc).toHaveLength(2);
    expect(new Set(lc.map((e: any) => e.supplierId)).size).toBe(2);
    const freight = lc.find((e: any) => e.supplierId === SUPPLIERS.freight.id)!;
    expect(freight.landingCostIds).toContain('LC-F1');
    expect(freight.landingProviderId).toBe(SUPPLIERS.freight.id);
    expect(freight.description).toContain('GRN-LC1');
  });

  it('keeps a single-source landing line with the goods supplier (genuine single invoice)', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [landingLine({ category: 'Handling', amount: 50000, providerId: SUPPLIERS.goods.id })],
      })
    );

    const lc = entriesByPrefix('LG-GRN-LC');
    expect(lc).toHaveLength(1);
    expect(lc[0].supplierId).toBe(SUPPLIERS.goods.id);
    expect(lc[0].amount).toBe(50000);
    // Goods 1,000,000 + single-source handling 50,000 on the same supplier.
    expect(supplierBalance(SUPPLIERS.goods.id)).toBe(1050000);
    expect(entriesByPrefix('LG-GRN-VAR')).toHaveLength(0);
  });
});

describe('Provider validation fails clearly before anything posts', () => {
  it('rejects a landing line without a provider and leaves no journals or idempotency block', async () => {
    seed();
    const bad = grnFixture({ id: 'GRN-BAD1', landingCosts: [landingLine({ providerId: '' })] });
    await expect(transactionService.processGoodsReceipt(bad)).rejects.toThrow(/no provider/i);
    expect(ledger()).toHaveLength(0);

    // Retry stays possible: fixing the provider lets the same GRN verify.
    const fixed = grnFixture({ id: 'GRN-BAD1', landingCosts: [landingLine({ providerId: SUPPLIERS.freight.id })] });
    const res: any = await transactionService.processGoodsReceipt(fixed);
    expect(res.success).toBe(true);
    expect(entriesByPrefix('LG-GRN-LC')).toHaveLength(1);
  });

  it('rejects an unknown provider without posting', async () => {
    seed();
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({ id: 'GRN-BAD2', landingCosts: [landingLine({ providerId: 'SUP-GHOST' })] })
      )
    ).rejects.toThrow(/unknown provider|not a known supplier/i);
    expect(ledger()).toHaveLength(0);
  });
});

describe('Non-stock lines do not swallow landed amounts', () => {
  it('allocates the full landed total across stock lines; non-stock value expenses to Purchases', async () => {
    seed({ items: [stockItem(), productItem()] });
    const grn = grnFixture({
      items: [
        { ...grnFixture().items[0] },
        { itemId: 'PROD-1', name: 'Printed Flyers', type: 'Product', orderedQty: 10, quantityReceived: 10, quantityRejected: 0, warehouseId: 'WH-MAIN', cost: 50000 },
      ],
      landingCosts: [landingLine({ amount: 100000, providerId: SUPPLIERS.freight.id })],
    });
    await transactionService.processGoodsReceipt(grn);

    const txns = [...memStores.tables.get('inventoryTransactions')!.values()];
    // Only the stock line generated an IN transaction, carrying the whole 100k.
    expect(txns).toHaveLength(1);
    expect(txns[0].landedCostTotal).toBe(100000);

    const lcCredits = entriesByPrefix('LG-GRN-LC').reduce((s: number, e: any) => s + e.amount, 0);
    expect(lcCredits).toBe(100000);

    // Non-stock 500k expenses via the legitimate non-stock leg (not landing).
    const nonStock = entriesByPrefix('LG-GRN-EXP');
    expect(nonStock).toHaveLength(1);
    expect(nonStock[0].amount).toBe(500000);
  });
});
