/**
 * landingCostBillLifecycle.test.ts
 *
 * Bill/AP lifecycle for capitalized Landing Cost. Drives the real
 * transactionService.postLandingCostBill / processGoodsReceipt /
 * recordSupplierPayment / addExpense against in-memory stores.
 *
 * Canonical model under test:
 *   bill:  DR Inventory / CR landing-provider AP (purchase-invoice
 *          primitive with landingCostId linkage — never an expense)
 *   GRN:   WAC allocation always; journals skip already-billed lines
 *
 * Covers: A (freight provider), B (customs provider), C (same supplier),
 * D (no double billing), E (invalid provider fails pre-mutation),
 * F (ordinary expenses unchanged), G (supplier payment settles),
 * H (balanced ledger), I (GRN+bill never double-counts either order).
 * No VAT behavior assumed.
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
  customs: { id: 'SUP-CUSTOMS', name: 'Customs Broker', balance: 0 },
};

function stockItem() {
  return {
    id: 'RM-1', name: 'A4 Paper', type: 'Raw Material', stock: 100,
    cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000,
  };
}

function poFixture(over: any = {}) {
  return {
    id: 'PO-LCB1',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Ordered',
    total: 1000000,
    totalAmount: 1000000,
    items: [
      { itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 100, cost: 10000 },
    ],
    landingCosts: [
      { id: 'LC-F1', category: 'Freight', description: 'Inbound freight', amount: 60000, providerId: SUPPLIERS.freight.id },
      { id: 'LC-C1', category: 'Customs', description: 'Clearance and duty', amount: 40000, providerId: SUPPLIERS.customs.id },
    ],
    ...over,
  };
}

function grnFixture(over: any = {}) {
  return {
    id: 'GRN-LCB1',
    purchaseOrderId: 'PO-LCB1',
    date: '2026-03-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    items: [
      {
        itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material',
        orderedQty: 100, quantityReceived: 100, quantityRejected: 0,
        warehouseId: 'WH-MAIN', cost: 10000, cost_price: 10000, unitPrice: 10000, price: 10000,
      },
    ],
    landingCosts: [
      { id: 'LC-F1', category: 'Freight', description: 'Inbound freight', amount: 60000, providerId: SUPPLIERS.freight.id },
      { id: 'LC-C1', category: 'Customs', description: 'Clearance and duty', amount: 40000, providerId: SUPPLIERS.customs.id },
    ],
    ...over,
  };
}

function seed(opts: { po?: any | null } = {}) {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', [stockItem()]);
  putAll('accounts', coaFixture());
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('purchases', opts.po === null ? [] : [poFixture(opts.po)]);
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'supplierPayments', 'expenses', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'bankAccounts', 'bankTransactions']) {
    memStores.tables.set(t, new Map());
  }
}

const ledger = () => [...memStores.tables.get('ledger')!.values()];
const invoices = () => [...memStores.tables.get('purchaseInvoices')!.values()];
const expenses = () => [...memStores.tables.get('expenses')!.values()];
const balanceOf = (id: string) => memStores.tables.get('suppliers')!.get(id)?.balance ?? null;

beforeEach(() => {
  memStores.tables.clear();
});

describe('A. Separate freight provider bill: inventory up, provider AP up, no expense', () => {
  it('posts DR Inventory / CR freight-provider AP with full bill linkage', async () => {
    seed();
    const res: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-LCB1',
      landingCostId: 'LC-F1',
    });
    expect(res.success).toBe(true);

    const bills = ledger().filter((e: any) => String(e.id).startsWith('LG-LCB'));
    expect(bills).toHaveLength(1);
    expect(bills[0].debitAccountId).toBe(ACC.rawMaterials);
    expect(bills[0].creditAccountId).toBe(ACC.accountsPayable);
    expect(bills[0].amount).toBe(60000);
    expect(bills[0].supplierId).toBe(SUPPLIERS.freight.id);
    expect(bills[0].entryType).toBe('LANDING_COST_BILL');
    expect(bills[0].landingCostIds).toContain('LC-F1');
    expect(bills[0].landingProviderId).toBe(SUPPLIERS.freight.id);
    expect(bills[0].referenceId).toBe(res.billId);

    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);
    expect(balanceOf(SUPPLIERS.goods.id)).toBe(0);

    const inv = invoices().find((i: any) => i.landingCostId === 'LC-F1')!;
    expect(inv).toBeTruthy();
    expect(inv.supplier_id).toBe(SUPPLIERS.freight.id);
    expect(inv.purchase_order_id).toBe('PO-LCB1');
    expect(inv.total_amount).toBe(60000);
    expect(inv.status).toBe('pending');
    expect(inv.paid_amount).toBe(0);

    // No expense leg anywhere.
    expect(ledger().some((e: any) => String(e.debitAccountId).startsWith('ACC-5'))).toBe(false);
    expect(expenses()).toHaveLength(0);
  });
});

describe('B. Separate customs provider bill', () => {
  it('posts DR Inventory / CR customs-provider AP without touching freight or goods', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-C1' });

    const bills = ledger().filter((e: any) => String(e.id).startsWith('LG-LCB'));
    expect(bills).toHaveLength(1);
    expect(bills[0].amount).toBe(40000);
    expect(bills[0].supplierId).toBe(SUPPLIERS.customs.id);
    expect(balanceOf(SUPPLIERS.customs.id)).toBe(40000);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);
    expect(balanceOf(SUPPLIERS.goods.id)).toBe(0);
    expect(ledger().some((e: any) => String(e.debitAccountId).startsWith('ACC-5'))).toBe(false);
  });
});

describe('C. Same provider as goods supplier: single obligation, no duplicate', () => {
  it('credits the same supplier subledger once', async () => {
    seed({
      po: {
        landingCosts: [
          { id: 'LC-H1', category: 'Handling', description: 'Supplier handling', amount: 50000, providerId: SUPPLIERS.goods.id },
        ],
      },
    });
    const res: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-LCB1',
      landingCostId: 'LC-H1',
    });
    expect(res.success).toBe(true);

    const bills = ledger().filter((e: any) => String(e.id).startsWith('LG-LCB'));
    expect(bills).toHaveLength(1);
    expect(bills[0].supplierId).toBe(SUPPLIERS.goods.id);
    expect(bills[0].amount).toBe(50000);
    expect(balanceOf(SUPPLIERS.goods.id)).toBe(50000);
    expect(invoices()).toHaveLength(1);
  });
});

describe('D. Repeated billing of the same landing line converges safely', () => {
  it('rejects the second posting with no new obligation', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' });
    const ledgerCount = ledger().length;
    const invoiceCount = invoices().length;

    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' })
    ).rejects.toThrow(/already billed/i);

    expect(ledger()).toHaveLength(ledgerCount);
    expect(invoices()).toHaveLength(invoiceCount);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);
  });
});

describe('E. Invalid provider fails before financial mutation', () => {
  it('rejects unknown providers with nothing posted', async () => {
    seed({
      po: {
        landingCosts: [{ id: 'LC-X1', category: 'Freight', amount: 10000, providerId: 'SUP-GHOST' }],
      },
    });
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-X1' })
    ).rejects.toThrow(/unknown provider/i);
    expect(ledger()).toHaveLength(0);
    expect(invoices()).toHaveLength(0);
  });

  it('rejects a missing provider and allows retry after correction', async () => {
    seed({
      po: {
        landingCosts: [{ id: 'LC-X2', category: 'Freight', amount: 10000, providerId: '' }],
      },
    });
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-X2' })
    ).rejects.toThrow(/no provider/i);
    expect(ledger()).toHaveLength(0);

    // Correct the line on the PO, then bill: no idempotency block from the failure.
    const po: any = await dbService.get('purchases', 'PO-LCB1');
    po.landingCosts = [{ id: 'LC-X2', category: 'Freight', amount: 10000, providerId: SUPPLIERS.freight.id }];
    await dbService.put('purchases', po);
    const res: any = await transactionService.postLandingCostBill({
      purchaseOrderId: 'PO-LCB1',
      landingCostId: 'LC-X2',
    });
    expect(res.success).toBe(true);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(10000);
  });
});

describe('F. Genuine ordinary expenses remain ordinary expenses', () => {
  it('addExpense still posts DR default expense / CR bank with bank mirror', async () => {
    seed();
    const res: any = await transactionService.addExpense({
      id: 'EXP-ORD1',
      date: '2026-03-15',
      description: 'Office stationery',
      amount: 25000,
      category: 'Office',
      status: 'Approved',
    } as any);
    expect(res.success).toBe(true);

    const entry = ledger().find((e: any) => String(e.id).startsWith('LG-EXP-MAIN'))!;
    expect(entry).toBeTruthy();
    expect(entry.debitAccountId).toBe(ACC.defaultExpense);
    expect(entry.creditAccountId).toBe(ACC.bank);
    expect(entry.amount).toBe(25000);

    const stored = expenses().find((e: any) => e.id === 'EXP-ORD1')!;
    expect(stored.status).toBe('Paid');
  });
});

describe('G. Supplier payment settles the landing provider balance', () => {
  it('pays the freight provider via existing infrastructure: DR AP, balance cleared, no expense', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' });
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);

    const res: any = await transactionService.recordSupplierPayment({
      id: 'SPAY-LC1',
      supplierId: SUPPLIERS.freight.id,
      supplier_id: SUPPLIERS.freight.id,
      date: '2026-03-20',
      payment_date: '2026-03-20',
      amount: 60000,
      paymentMethod: 'bank_transfer',
      payment_method: 'bank_transfer',
      accountId: ACC.bank,
      bank_account_id: ACC.bank,
    } as any);
    expect(res.success).toBe(true);

    expect(balanceOf(SUPPLIERS.freight.id)).toBe(0);
    const pay = ledger().find((e: any) => String(e.id).startsWith('LG-SPAY'))!;
    expect(pay.debitAccountId).toBe(ACC.accountsPayable);
    expect(pay.creditAccountId).toBe(ACC.bank);
    expect(pay.amount).toBe(60000);
    expect(ledger().some((e: any) => String(e.debitAccountId).startsWith('ACC-5'))).toBe(false);
  });
});

describe('H. Ledger remains balanced', () => {
  it('every bill/payment entry balances; total debits equal total credits', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' });
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-C1' });

    let dr = 0;
    let cr = 0;
    for (const e of ledger()) {
      expect(e.debitAccountId).toBeTruthy();
      expect(e.creditAccountId).toBeTruthy();
      expect(e.debitAccountId).not.toBe(e.creditAccountId);
      expect(e.amount).toBeGreaterThan(0);
      dr += e.amount;
      cr += e.amount;
    }
    expect(dr).toBe(cr);
    expect(dr).toBe(100000);
  });
});

describe('I. GRN + bill never double-counts, either order', () => {
  it('bill-first: GRN capitalizes WAC but posts no second provider journal', async () => {
    seed();
    await transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' });

    const res: any = await transactionService.processGoodsReceipt(grnFixture());
    expect(res.success).toBe(true);

    // Only the customs line (unbilled) produced a GRN landing journal.
    const lc = ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'));
    expect(lc).toHaveLength(1);
    expect(lc[0].supplierId).toBe(SUPPLIERS.customs.id);
    expect(lc[0].amount).toBe(40000);

    // Provider obligation unchanged by the GRN (bill already established it).
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);
    expect(balanceOf(SUPPLIERS.customs.id)).toBe(40000);
    expect(balanceOf(SUPPLIERS.goods.id)).toBe(1000000);

    // Carrying cost still reflects the FULL landed amount (WAC 6000).
    const item = await dbService.get<any>('inventory', 'RM-1');
    expect(item.cost).toBe(6000);
    const txns = [...memStores.tables.get('inventoryTransactions')!.values()];
    expect(txns[0].landedCostTotal).toBe(100000);
  });

  it('GRN-first: billing an already-capitalized line is rejected with no new postings', async () => {
    seed();
    await transactionService.processGoodsReceipt(grnFixture());
    expect(
      ledger().filter((e: any) => String(e.id).startsWith('LG-GRN-LC'))
    ).toHaveLength(2);

    const before = ledger().length;
    await expect(
      transactionService.postLandingCostBill({ purchaseOrderId: 'PO-LCB1', landingCostId: 'LC-F1' })
    ).rejects.toThrow(/already capitalized/i);
    expect(ledger()).toHaveLength(before);
    expect(balanceOf(SUPPLIERS.freight.id)).toBe(60000);
  });
});
