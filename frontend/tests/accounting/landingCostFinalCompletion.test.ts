/**
 * landingCostFinalCompletion.test.ts
 *
 * Final completion matrix: cross-GRN proportional entitlement (§3 example),
 * VAT/duty/withholding policy, negative fail-closed, bill reversal, pristine
 * GRN correction, manual-GRN safety, alternate-path guard, payment→invoice
 * application + void, sync union + queue round-trip, stale-save protection,
 * reporting and full reconciliation. No VAT behavior is assumed beyond what
 * the tests construct; withholding/negative paths assert fail-closed.
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

const { openDBMock } = vi.hoisted(() => ({ openDBMock: vi.fn() }));

vi.mock('idb', () => ({
  openDB: openDBMock,
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

import { transactionService } from '../../services/transactionService';
import { dbService } from '../../services/db';
import {
  getLandingLineState,
  reconcileLandingCostLine,
  getLandingCostReport,
  requiresGrnVerifyForLanding,
} from '../../services/landingAllocation';
import { mergeRecords, fieldLevelMerge } from '../../services/syncConflictResolver';
import { durableSyncQueue, resetDbConnection } from '../../services/durableSyncQueue';

const ACC = {
  merchandise: 'ACC-11410',
  rawMaterials: 'ACC-11420',
  accountsPayable: 'ACC-21110',
  vatPosition: 'ACC-21210',
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
    type: account_type === 'ASSET' ? 'Asset' : account_type === 'EXPENSE' ? 'Expense' : account_type === 'LIABILITY' ? 'Liability' : 'Asset',
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
    acc('21210', 'VAT Position', 'LIABILITY'),
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
    id: 'PO-FC1',
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
      { id: 'LC-F1', category: 'Freight', amount: 300000, providerId: SUPPLIERS.freight.id },
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
    id: 'GRN-FC1',
    purchaseOrderId: 'PO-FC1',
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
      { id: 'LC-F1', category: 'Freight', amount: 300000, providerId: SUPPLIERS.freight.id },
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
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'supplierPayments', 'expenses', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'vatTransactions', 'bankAccounts', 'bankTransactions']) {
    memStores.tables.set(t, new Map());
  }
}

const ledger = () => [...memStores.tables.get('ledger')!.values()];
const invoices = () => [...memStores.tables.get('purchaseInvoices')!.values()];
const vatTxns = () => [...memStores.tables.get('vatTransactions')!.values()];
const payments = () => [...memStores.tables.get('supplierPayments')!.values()];
const balanceOf = (id: string) => memStores.tables.get('suppliers')!.get(id)?.balance ?? null;
const storedPO = async () => await dbService.get<any>('purchases', 'PO-FC1');
const landingLCLegs = () => ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'));
const landingBillLegs = () => ledger().filter((e: any) => String(e.id).startsWith('LG-LCB') && !String(e.id).includes('-VAT'));
const landingVatLegs = () => ledger().filter((e: any) => String(e.id).includes('-VAT'));
const landedEmbeddedTotal = () =>
  [...memStores.tables.get('inventoryTransactions')!.values()].reduce((s: number, t: any) => s + (Number(t.landedCostTotal) || 0), 0);

function paymentFor(supplierId: string, amount: number, id: string) {
  return {
    id,
    supplierId,
    supplier_id: supplierId,
    date: '2026-03-20',
    payment_date: '2026-03-20',
    amount,
    paymentMethod: 'bank_transfer',
    payment_method: 'bank_transfer',
    accountId: ACC.bank,
    bank_account_id: ACC.bank,
  } as any;
}

beforeEach(() => {
  memStores.tables.clear();
});

describe('H. Required partial-receipt example (QUANTITY 90k/210k)', () => {
  it('GRN#1 60/200 units takes 30%, GRN#2 140/200 takes 70%, total exact', async () => {
    seed({ pos: [poFixture({ landingAllocationMethod: 'QUANTITY' })] });
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-H1',
        landingAllocationMethod: 'QUANTITY',
        items: [grnLine('ST-1', 40, 10000, 'Stationery'), grnLine('RM-1', 20, 20000, 'Raw Material')],
      })
    );
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-H2',
        landingAllocationMethod: 'QUANTITY',
        items: [grnLine('ST-1', 60, 10000, 'Stationery'), grnLine('RM-1', 80, 20000, 'Raw Material')],
      })
    );
    const h1 = [...memStores.tables.get('inventoryTransactions')!.values()].filter((t: any) =>
      t.referenceId === 'GRN-H1').reduce((s: number, t: any) => s + t.landedCostTotal, 0);
    const h2 = [...memStores.tables.get('inventoryTransactions')!.values()].filter((t: any) =>
      t.referenceId === 'GRN-H2').reduce((s: number, t: any) => s + t.landedCostTotal, 0);
    expect(h1).toBe(90000);
    expect(h2).toBe(210000);
    expect(landedEmbeddedTotal()).toBe(300000);
    expect(landingLCLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBe(300000);
    expect(getLandingLineState(await storedPO(), 'LC-F1').remaining).toBe(0);
  });
});

describe('X. Recoverable VAT never enters inventory', () => {
  it('bill-first: net capitalizes, VAT recovers via VAT_INPUT, AP stays gross', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-V1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })],
    });
    // 60000 incl 16% → VAT 8275.86, capitalizable 51724.14.
    const res: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-V1',
    });
    expect(res.success).toBe(true);

    expect(landingBillLegs().reduce((s: number, e: any) => s + e.amount, 0)).toBeCloseTo(51724.14, 2);
    const vatLegs = landingVatLegs();
    expect(vatLegs).toHaveLength(1);
    expect(vatLegs[0].debitAccountId).toBe(ACC.vatPosition);
    expect(vatLegs[0].creditAccountId).toBe(ACC.accountsPayable);
    expect(vatLegs[0].amount).toBeCloseTo(8275.86, 2);
    expect(vatLegs[0].entryType).toBe('VAT_INPUT');
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);

    const inv = invoices().find((i: any) => i.landingCostId === 'LC-V1')!;
    expect(inv.subtotal).toBeCloseTo(51724.14, 2);
    expect(inv.tax_amount).toBeCloseTo(8275.86, 2);
    expect(inv.total_amount).toBe(60000);

    const vats = vatTxns();
    expect(vats).toHaveLength(1);
    expect(vats[0]).toMatchObject({ type: 'Input', rate: 16, isFiled: false });
    expect(vats[0].amount).toBeCloseTo(8275.86, 2);

    // GRN receives the full PO basis: embeds the full net amount into WAC.
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [{
          id: 'LC-V1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })
    );
    expect(landedEmbeddedTotal()).toBeCloseTo(51724.14, 2);
    // No second VAT recovery at GRN (bill already recovered).
    expect(vatTxns()).toHaveLength(1);
    const item = await dbService.get<any>('inventory', 'ST-1');
    expect(item.cost).toBeCloseTo(10000 + 17241.38 / 100, 2);
  });

  it('GRN-first: VAT legs post with the GRN and later bill stays rejected', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-V2', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })],
    });
    // ST-only receipt: one-third PO basis → net 17,241.38 + VAT 2,758.62.
    await transactionService.processGoodsReceipt(
      grnFixture({
        items: [grnLine('ST-1', 100, 10000, 'Stationery')],
        landingCosts: [{
          id: 'LC-V2', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })
    );
    expect(landingVatLegs()).toHaveLength(1);
    expect(landingVatLegs()[0].amount).toBeCloseTo(2758.62, 2);
    expect(balanceOf(SUPPLIERS.freight.id)).toBeCloseTo(20000, 2);
    expect(landedEmbeddedTotal()).toBeCloseTo(17241.38, 2);
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-V2' })
    ).rejects.toThrow(/already capitalized/i);
  });
});

describe('Y/Z. Nonrecoverable tax and customs duty capitalize distinctly', () => {
  it('Y: NONRECOVERABLE_TAX capitalizes in full with no VAT rows', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-Y1', category: 'Clearance fee', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'NONRECOVERABLE_TAX',
        }],
      })],
    });
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [{
          id: 'LC-Y1', category: 'Clearance fee', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'NONRECOVERABLE_TAX',
        }],
      })
    );
    expect(landedEmbeddedTotal()).toBe(60000);
    expect(landingVatLegs()).toHaveLength(0);
    expect(vatTxns()).toHaveLength(0);
    const ev = ((await storedPO()) as any).landingConsumption.find((e: any) => e.landingCostId === 'LC-Y1')!;
    expect(ev.taxTreatment).toBe('NONRECOVERABLE_TAX');
  });

  it('Z: CUSTOMS_DUTY capitalizes and reports as duty', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-Z1', category: 'Customs', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'CUSTOMS_DUTY',
        }],
      })],
    });
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [{
          id: 'LC-Z1', category: 'Customs', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'CUSTOMS_DUTY',
        }],
      })
    );
    expect(landedEmbeddedTotal()).toBe(60000);
    expect(landingVatLegs()).toHaveLength(0);
    const report = getLandingCostReport({
      purchaseOrderId: 'PO-FC1',
      purchase: await storedPO(),
      ledgerEntries: ledger(),
      invoices: invoices(),
      payments: payments(),
      vatTransactions: vatTxns(),
    });
    const line = report.lines.find((l) => l.landingCostId === 'LC-Z1')!;
    expect(line.dutyAmount).toBe(60000);
    expect(line.taxTreatment).toBe('CUSTOMS_DUTY');
    expect(line.balanced).toBe(true);
  });
});

describe('AA/AE. Unsupported and negative treatments fail closed', () => {
  it('AA: WITHHOLDING fails on bill and GRN with nothing posted', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-W1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'WITHHOLDING',
        }],
      })],
    });
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-W1' })
    ).rejects.toThrow(/withholding/i);
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({
          items: [grnLine('ST-1', 100, 10000, 'Stationery')],
          landingCosts: [{
            id: 'LC-W1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
            taxTreatment: 'WITHHOLDING',
          }],
        })
      )
    ).rejects.toThrow(/withholding/i);
    expect(ledger()).toHaveLength(0);
    expect(vatTxns()).toHaveLength(0);
  });

  it('AE: negative landing fails on bill and GRN with correction direction', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{ id: 'LC-N1', category: 'Freight', amount: -5000, providerId: SUPPLIERS.freight.id }],
      })],
    });
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-N1' })
    ).rejects.toThrow(/correction/i);
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({
          items: [grnLine('ST-1', 100, 10000, 'Stationery')],
          landingCosts: [{ id: 'LC-N1', category: 'Freight', amount: -5000, providerId: SUPPLIERS.freight.id }],
        })
      )
    ).rejects.toThrow(/correction/i);
    expect(ledger()).toHaveLength(0);
  });
});

describe('AF. Bill reversal unwinds a pristine bill and permits re-billing', () => {
  it('mirrors journals/balance/invoice, appends REVERSAL, then re-bill succeeds', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-FC1', poFixture({
      items: [{ itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 }],
      landingCosts: [{ id: 'LC-AF1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    }));
    const billed: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AF1',
    });
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(100000);

    const reversed: any = await transactionService.reverseLandingCostBill({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AF1', reason: 'test reversal',
    });
    expect(reversed.success).toBe(true);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);
    const inv = invoices().find((i: any) => i.id === billed.billId)!;
    expect(inv.status).toBe('cancelled');
    const mirrors = ledger().filter((e: any) => String(e.entryType || '') === 'LANDING_BILL_REVERSAL');
    expect(mirrors.reduce((s: number, e: any) => s + e.amount, 0)).toBe(100000);
    // AP obligation net of mirrors is zero.
    const apCredits = ledger()
      .filter((e: any) => e.creditAccountId === ACC.accountsPayable)
      .reduce((s: number, e: any) => s + e.amount, 0);
    const apDebits = ledger()
      .filter((e: any) => e.debitAccountId === ACC.accountsPayable)
      .reduce((s: number, e: any) => s + e.amount, 0);
    expect(apCredits).toBe(apDebits);

    // Corrected re-bill proceeds (idempotency freed by the reversal).
    const rebilled: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AF1',
    });
    expect(rebilled.success).toBe(true);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(100000);
  });

  it('reversal with GRN consumption present stays rejected', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-FC1', poFixture({
      items: [{ itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 }],
      landingCosts: [{ id: 'LC-AF2', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    }));
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AF2' });
    await transactionService.processGoodsReceipt(
      grnFixture({
        items: [{ ...grnLine('ST-1', 100, 10000, 'Stationery'), batchNumber: 'B-AG1' }],
        landingCosts: [{ id: 'LC-AF2', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
      })
    );
    await expect(
      transactionService.reverseLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AF2' })
    ).rejects.toThrow(/GRN|consumption|correction/i);
  });
});

describe('AG/AH. Pristine GRN-consumption correction', () => {
  it('AG: mirrors journals, restores WAC/batches/balance, releases remaining', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-FC1', poFixture({
      items: [{ itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 }],
      landingCosts: [{ id: 'LC-AG1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    }));
    await transactionService.processGoodsReceipt(
      grnFixture({
        items: [{ ...grnLine('ST-1', 100, 10000, 'Stationery'), batchNumber: 'B-AG1' }],
        landingCosts: [{ id: 'LC-AG1', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
      })
    );
    const itemBefore = await dbService.get<any>('inventory', 'ST-1');
    expect(itemBefore.cost).toBe(11000);

    const res: any = await transactionService.correctLandingConsumption({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AG1', grnId: 'GRN-FC1', reason: 'test correction',
    });
    expect(res.success).toBe(true);

    // WAC restored to base-only value; batch restored to purchase cost.
    const itemAfter = await dbService.get<any>('inventory', 'ST-1');
    expect(itemAfter.cost).toBe(10000);
    const batch = [...memStores.tables.get('materialBatches')!.values()].find((b: any) => b.batchNumber === 'B-AG1')!;
    expect(batch.costPerUnit).toBe(10000);
    expect(batch.landedCostPerUnit).toBe(0);
    // Provider balance and AP obligation fully unwound.
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);
    // Remaining released back to source.
    expect(getLandingLineState(await storedPO(), 'LC-AG1').remaining).toBe(100000);
    // Corrective audit row appended; history untouched otherwise.
    const corr = [...memStores.tables.get('inventoryTransactions')!.values()].filter((t: any) => t.type === 'CORRECTION');
    expect(corr).toHaveLength(1);
    expect(corr[0].landedCostTotal).toBe(-100000);
    // Idempotent retry of the correction converges.
    await expect(
      transactionService.correctLandingConsumption({
        purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AG1', grnId: 'GRN-FC1',
      })
    ).rejects.toThrow(/duplicate|already corrected/i);
  });

  it('AH: correction after a partial first GRN releases only that GRN share', async () => {
    seed();
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-AH1',
        items: [grnLine('ST-1', 40, 10000, 'Stationery'), grnLine('RM-1', 20, 20000, 'Raw Material')],
        landingCosts: [{ id: 'LC-F1', category: 'Freight', amount: 300000, providerId: SUPPLIERS.freight.id }],
      })
    );
    await transactionService.processGoodsReceipt(
      grnFixture({
        id: 'GRN-AH2',
        items: [grnLine('ST-1', 60, 10000, 'Stationery'), grnLine('RM-1', 80, 20000, 'Raw Material')],
        landingCosts: [{ id: 'LC-F1', category: 'Freight', amount: 300000, providerId: SUPPLIERS.freight.id }],
      })
    );
    expect(landedEmbeddedTotal()).toBe(300000);

    await transactionService.correctLandingConsumption({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-F1', grnId: 'GRN-AH1', reason: 'test partial correction',
    });
    // GRN-AH1 embedded 80k (40k/40k); the rest stands. Net embedded drops
    // by the corrected amount (IN rows 300k + CORRECTION row -80k).
    expect(landedEmbeddedTotal()).toBe(220000);
    const corrTotal = [...memStores.tables.get('inventoryTransactions')!.values()]
      .filter((t: any) => t.type === 'CORRECTION')
      .reduce((s: number, t: any) => s + t.landedCostTotal, 0);
    expect(corrTotal).toBe(-80000);
    expect(getLandingLineState(await storedPO(), 'LC-F1').remaining).toBe(80000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(220000);
  });

  it('sold inventory fails correction closed', async () => {
    seed();
    memStores.tables.get('purchases')!.set('PO-FC1', poFixture({
      items: [{ itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 }],
      landingCosts: [{ id: 'LC-AG2', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
    }));
    await transactionService.processGoodsReceipt(
      grnFixture({
        items: [{ ...grnLine('ST-1', 100, 10000, 'Stationery'), batchNumber: 'B-AG1' }],
        landingCosts: [{ id: 'LC-AG2', category: 'Freight', amount: 100000, providerId: SUPPLIERS.freight.id }],
      })
    );
    // Simulate a later sale movement.
    await dbService.put('inventoryTransactions', {
      id: 'TXN-SALE1', itemId: 'ST-1', type: 'OUT', quantity: 10,
      timestamp: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      transactionService.correctLandingConsumption({
        purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AG2', grnId: 'GRN-FC1',
      })
    ).rejects.toThrow(/OUT|COGS|sold|movement/i);
  });
});

describe('AI/AJ. Manual GRN safety', () => {
  it('AI: manual GRN carrying landing costs is rejected without a PO', async () => {
    seed();
    await expect(
      transactionService.processGoodsReceipt(
        grnFixture({
          id: 'GRN-MAN1',
          purchaseOrderId: null,
          landingCosts: [{ id: 'LC-MN1', category: 'Freight', amount: 50000, providerId: SUPPLIERS.freight.id }],
        })
      )
    ).rejects.toThrow(/valid source PO|Manual GRNs without landing/i);
    expect(ledger()).toHaveLength(0);
  });

  it('AJ: ordinary manual GRN without landing costs still posts', async () => {
    seed();
    const res: any = await transactionService.processGoodsReceipt(
      grnFixture({ id: 'GRN-MAN2', purchaseOrderId: null, landingCosts: [] })
    );
    expect(res.success).toBe(true);
    expect(ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-INV'))).toHaveLength(1);
  });
});

describe('AK. Alternate receive path blocks landing POs explicitly', () => {
  it('requiresGrnVerifyForLanding flags landing POs and clears clean ones', async () => {
    const { requiresGrnVerifyForLanding } = await import('../../services/landingAllocation');
    expect(requiresGrnVerifyForLanding(poFixture())).toMatch(/Verify|landing costs/i);
    expect(requiresGrnVerifyForLanding(poFixture({ landingCosts: [] }))).toBeNull();
    expect(requiresGrnVerifyForLanding(null)).toBeNull();
  });
});

describe('AC/AD. Payment applies to the landing bill invoice', () => {
  it('partial then full payment drives pending/partial/paid with exact paid_amount', async () => {
    seed();
    const billed: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-FC1', landingCostId: 'LC-F1',
    });
    expect(billed.success).toBe(true);

    await transactionService.recordSupplierPayment(paymentFor(SUPPLIERS.freight.id, 100000, 'SPAY-AC1'));
    let inv = invoices().find((i: any) => i.landingCostId === 'LC-F1')!;
    expect(inv.status).toBe('partial');
    expect(inv.paid_amount).toBe(100000);

    await transactionService.recordSupplierPayment(paymentFor(SUPPLIERS.freight.id, 200000, 'SPAY-AC2'));
    inv = invoices().find((i: any) => i.landingCostId === 'LC-F1')!;
    expect(inv.status).toBe('paid');
    expect(inv.paid_amount).toBe(300000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);

    const pays = payments();
    expect(pays.find((p: any) => p.id === 'SPAY-AC1')!.invoiceApplications).toEqual([
      { invoiceId: billed.billId, amount: 100000 },
    ]);
    expect(pays.find((p: any) => p.id === 'SPAY-AC2')!.invoiceApplications).toEqual([
      { invoiceId: billed.billId, amount: 200000 },
    ]);
  });

  it('voiding a payment reverses its invoice application', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-F1' });
    await transactionService.recordSupplierPayment(paymentFor(SUPPLIERS.freight.id, 100000, 'SPAY-V1'));
    expect(invoices().find((i: any) => i.landingCostId === 'LC-F1')!.status).toBe('partial');

    await transactionService.voidSupplierPayment('SPAY-V1');
    const inv = invoices().find((i: any) => i.landingCostId === 'LC-F1')!;
    expect(inv.status).toBe('pending');
    expect(inv.paid_amount).toBe(0);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(300000);
  });
});

describe('S/T. Stale saves cannot erase landing financial state', () => {
  it('S: stale PO save preserves consumption events', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture());
    const stale = { ...(await storedPO()) };
    delete (stale as any).landingConsumption;
    const res: any = await transactionService.processPurchaseOrder(stale as any);
    expect(res.success).toBe(true);
    expect(((await storedPO()) as any).landingConsumption).toHaveLength(1);
  });

  it('T: stale GRN re-save cannot erase authoritative allocations', async () => {
    seed();
    const grn = grnFixture();
    await transactionService.processGoodsReceipt(grn);
    const storedBefore = JSON.stringify(await dbService.get('goodsReceipts', 'GRN-FC1'));
    await expect(
      transactionService.processGoodsReceipt({ ...grnFixture(), landingCosts: [] })
    ).rejects.toThrow(/duplicate financial request/i);
    expect(JSON.stringify(await dbService.get('goodsReceipts', 'GRN-FC1'))).toBe(storedBefore);
  });
});

describe('AL. Sync merges never drop landing consumption events', () => {
  const billEvent = (id: string) => ({
    id, landingCostId: 'LC-AL1', kind: 'BILL', billId: 'LCB-1', amount: 60000,
    sourceAmount: 60000, method: 'VALUE', providerId: 'SUP-FREIGHT', accountSplits: [],
    journalIds: ['LG-LCB-1'], at: '2026-03-15T10:00:00.000Z',
  });
  const grnEvent = (id: string) => ({
    id, landingCostId: 'LC-AL1', kind: 'GRN', grnId: 'GRN-AL1', amount: 60000,
    sourceAmount: 60000, method: 'VALUE', providerId: 'SUP-FREIGHT', accountSplits: [],
    journalIds: ['LG-GRN-LC-1'], at: '2026-03-16T10:00:00.000Z',
  });

  it('mergeRecords unions divergent event histories both directions', async () => {
    const local = { id: 'PO-AL1', version: 3, landingConsumption: [billEvent('LCC-B1')], total: 1 };
    const remote = { id: 'PO-AL1', version: 4, landingConsumption: [grnEvent('LCC-G1')], total: 1 };
    const a = mergeRecords(local, remote) as any;
    const b = mergeRecords(remote, local) as any;
    for (const merged of [a, b]) {
      const ids = merged.landingConsumption.map((e: any) => e.id).sort();
      expect(ids).toEqual(['LCC-B1', 'LCC-G1']);
    }
  });

  it('fieldLevelMerge unions events while merging other fields normally', async () => {
    const local = {
      id: 'PO-AL1', version: 3, _updatedAt: '2026-03-17T10:00:00.000Z',
      landingConsumption: [billEvent('LCC-B1')], notes: 'local note',
    };
    const remote = {
      id: 'PO-AL1', version: 3, updated_at: '2026-03-18T10:00:00.000Z',
      landingConsumption: [grnEvent('LCC-G1')], notes: 'local note',
    };
    const merged = fieldLevelMerge(local, remote) as any;
    expect(merged.landingConsumption.map((e: any) => e.id).sort()).toEqual(['LCC-B1', 'LCC-G1']);
  });

  it('duplicate delivery of the same merged row is stable', async () => {
    const row = {
      id: 'PO-AL1', version: 4,
      landingConsumption: [billEvent('LCC-B1'), grnEvent('LCC-G1')],
    };
    const once = mergeRecords(row, { ...row, version: 4 }) as any;
    const twice = mergeRecords(once, { ...row, version: 4 }) as any;
    expect(twice.landingConsumption).toHaveLength(2);
  });
});

describe('AM. Offline queue round-trips landing financial state intact', () => {
  (globalThis as any).IDBKeyRange = {
  only: (val: string) => ({ only: val }),
  upperBound: () => ({}),
  lowerBound: () => ({}),
  bound: () => ({}),
};

const queueStores: Record<string, Map<string, any>> = {
    operations: new Map(),
    meta: new Map(),
    metrics: new Map(),
  };

  beforeEach(() => {
    queueStores.operations.clear();
    queueStores.meta.clear();
    queueStores.metrics.clear();
    openDBMock.mockReset().mockResolvedValue({
      get: async (storeName: string, key: string) => queueStores[storeName]?.get(key),
      put: async (storeName: string, value: any) => {
        queueStores[storeName].set(String((value as any).id ?? (value as any).key), { ...value });
      },
      delete: async (storeName: string, key: string) => { queueStores[storeName].delete(key); },
      getAll: async (storeName: string) => Array.from(queueStores[storeName].values()),
      getAllFromIndex: async (storeName: string, indexName: string, range?: unknown) => {
        const all = Array.from(queueStores[storeName].values());
        if (typeof range === 'string') {
          const field = indexName === 'by-operationId' ? 'operationId' : indexName === 'by-status' ? 'status' : indexName;
          return all.filter((r: any) => r[field] === range);
        }
        return all;
      },
      close: () => {},
    });
    resetDbConnection();
  });

  it('enqueued PO update carries consumption events through dequeue', async () => {
    const payload = {
      id: 'PO-AM1',
      landingCosts: [{ id: 'LC-AM1', amount: 60000 }],
      landingConsumption: [{
        id: 'LCC-AM1', landingCostId: 'LC-AM1', kind: 'GRN', grnId: 'GRN-AM1',
        amount: 60000, sourceAmount: 60000, method: 'VALUE', providerId: 'SUP-FREIGHT',
        accountSplits: [{ account: 'ACC-11420', amount: 60000 }], journalIds: ['LG-GRN-LC-1'],
        at: '2026-03-16T10:00:00.000Z',
      }],
    };
    await durableSyncQueue.enqueue({
      table: 'purchases', recordId: 'PO-AM1', operation: 'upsert', payload,
    } as any);
    const [item] = await durableSyncQueue.dequeue(10);
    expect((item.payload as any).landingConsumption).toHaveLength(1);
    expect((item.payload as any).landingConsumption[0].id).toBe('LCC-AM1');
    expect((item.payload as any).landingConsumption[0].journalIds).toEqual(['LG-GRN-LC-1']);
  });
});
describe('AT. Full reconciliation and report', () => {
  it('VAT+bill+GRN+payment flow reconciles and reports every dimension', async () => {
    seed({
      pos: [poFixture({
        landingCosts: [{
          id: 'LC-AT1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })],
    });
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-FC1', landingCostId: 'LC-AT1' });
    await transactionService.processGoodsReceipt(
      grnFixture({
        landingCosts: [{
          id: 'LC-AT1', category: 'Freight', amount: 60000, providerId: SUPPLIERS.freight.id,
          taxTreatment: 'RECOVERABLE_VAT', vatRate: 16, taxInclusive: true,
        }],
      })
    );
    await transactionService.recordSupplierPayment(paymentFor(SUPPLIERS.freight.id, 60000, 'SPAY-AT1'));

    const po = await storedPO();
    const rec = reconcileLandingCostLine({
      landingCostId: 'LC-AT1',
      purchase: po,
      ledgerEntries: ledger(),
      invoices: invoices(),
      vatTransactions: vatTxns(),
      payments: payments(),
      providerId: SUPPLIERS.freight.id,
    });
    expect(rec.source).toBe(60000);
    expect(rec.recoverableVAT).toBeCloseTo(8275.86, 2);
    expect(rec.consumedWAC).toBeCloseTo(51724.14, 2);
    expect(rec.paidTotal).toBe(60000);
    expect(rec.apOutstanding).toBe(0);
    expect(rec.balanced).toBe(true);
    expect(rec.notes).toEqual([]);

    const { getLandingCostReport } = await import('../../services/landingAllocation');
    const report = getLandingCostReport({
      purchaseOrderId: 'PO-FC1',
      purchase: po,
      grns: [...memStores.tables.get('goodsReceipts')!.values()],
      ledgerEntries: ledger(),
      invoices: invoices(),
      payments: payments(),
      vatTransactions: vatTxns(),
      supplierNames: { [SUPPLIERS.freight.id]: SUPPLIERS.freight.name },
    });
    const line = report.lines.find((l) => l.landingCostId === 'LC-AT1')!;
    expect(line.providerName).toBe('Speedy Freight Ltd');
    expect(line.billStatus).toBe('paid');
    expect(line.balanced).toBe(true);
    expect(report.totals.apOutstanding).toBe(0);
  });
});
