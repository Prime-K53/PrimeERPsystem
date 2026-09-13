/**
 * stockAdjustmentAccounting.test.ts
 *
 * Regression protection for the Sept-12 defect (102 stock adjustments
 * crediting 42100 Interest Income via the 42000 parent fallback).
 *
 * Covers:
 *  - Opening inventory resolves to opening equity (31000), never 42100
 *  - Operational increase posts DR Inventory / CR COGS, never 42100
 *  - Operational decrease posts DR COGS / CR Inventory
 *  - Missing COGS / equity configuration fails closed (throws)
 *  - Invalid account type fails closed
 *  - 42100 explicitly rejected even when active/posting
 *  - 54000 non-posting account rejected
 *  - Inactive account rejected
 *  - Zero quantity / missing reason rejected
 *  - adjustStock integration: posts balanced COGS journal, never 42100,
 *    fails closed without mutating inventory, idempotent on retry,
 *    skips GL for service items
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

import {
  resolveStockAdjustmentPosting,
  assertAccountSemanticallyValidForStockAdjustment,
  StockAdjustmentAccountingError,
} from '../../services/inventoryAdjustmentAccounting';
import { transactionService } from '../../services/transactionService';
import { dbService } from '../../services/db';

function coaFixture(): any[] {
  const acc = (
    code: string,
    name: string,
    account_type: string,
    parent: string | null = null,
    extra: any = {}
  ) => ({
    id: `ACC-${code}`,
    code,
    account_number: code,
    name,
    account_type,
    type:
      account_type === 'ASSET'
        ? 'Asset'
        : account_type === 'EQUITY'
          ? 'Equity'
          : account_type === 'INCOME'
            ? 'Revenue'
            : 'Expense',
    normal_balance:
      account_type === 'ASSET' || account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    parent_account_id: parent ? `ACC-${parent}` : null,
    is_active: true,
    allow_posting: true,
    ...extra,
  });
  return [
    acc('11400', 'Inventory', 'ASSET', null, { allow_posting: false }),
    acc('11410', 'Merchandise Inventory', 'ASSET', '11400'),
    acc('11420', 'Raw Materials', 'ASSET', '11400'),
    acc('11430', 'Finished Goods', 'ASSET', '11400'),
    acc('31000', "Owner's Capital", 'EQUITY', null),
    acc('32000', 'Retained Earnings', 'EQUITY', null),
    acc('42000', 'Other Income', 'INCOME', null, { allow_posting: false }),
    acc('42100', 'Interest Income', 'INCOME', '42000'),
    acc('42200', 'Discount Received', 'INCOME', '42000'),
    acc('51200', 'Cost of Goods Sold', 'EXPENSE', null),
    acc('54000', 'Other Expenses', 'EXPENSE', null, { allow_posting: false }),
  ];
}

const GL = {
  defaultInventoryAccount: '11400',
  defaultCOGSAccount: '51200',
  ownerCapitalAccount: '31000',
  retainedEarningsAccount: '32000',
};

function seed(item: any, accounts = coaFixture()) {
  memStores.tables.clear();
  memStores.tables.set('inventory', new Map([[String(item.id), { ...item }]]));
  memStores.tables.set('accounts', new Map(accounts.map((a: any) => [String(a.id), a])));
  memStores.tables.set('ledger', new Map());
  memStores.tables.set('warehouseInventory', new Map());
  memStores.tables.set('inventoryTransactions', new Map());
  memStores.tables.set('idempotencyKeys', new Map());
}

describe('inventoryAdjustmentAccounting — semantic resolver', () => {
  it('OPENING_BALANCE resolves DR 11420 / CR 31000, never 42100', () => {
    const r = resolveStockAdjustmentPosting({
      reason: 'OPENING_BALANCE',
      qtyChange: 10,
      itemType: 'Raw Material',
      accounts: coaFixture(),
      gl: GL,
    });
    expect(r.debitCode).toBe('11420');
    expect(r.creditCode).toBe('31000');
    expect(r.creditCode).not.toBe('42100');
  });

  it('OPERATIONAL_ADJUSTMENT gain posts DR Inventory / CR COGS', () => {
    const r = resolveStockAdjustmentPosting({
      reason: 'OPERATIONAL_ADJUSTMENT',
      qtyChange: 5,
      itemType: 'Product',
      accounts: coaFixture(),
      gl: GL,
    });
    expect(r.debitCode).toBe('11410');
    expect(r.creditCode).toBe('51200');
  });

  it('OPERATIONAL_ADJUSTMENT loss posts DR COGS / CR Inventory', () => {
    const r = resolveStockAdjustmentPosting({
      reason: 'OPERATIONAL_ADJUSTMENT',
      qtyChange: -5,
      itemType: 'Raw Material',
      accounts: coaFixture(),
      gl: GL,
    });
    expect(r.debitCode).toBe('51200');
    expect(r.creditCode).toBe('11420');
  });

  it('RECONCILIATION gain posts DR Inventory / CR COGS', () => {
    const r = resolveStockAdjustmentPosting({
      reason: 'RECONCILIATION',
      qtyChange: 3,
      itemType: 'Stationery',
      accounts: coaFixture(),
      gl: GL,
    });
    expect(r.debitCode).toBe('11420');
    expect(r.creditCode).toBe('51200');
  });

  it('missing COGS configuration fails closed (throws, never falls back to 42100)', () => {
    const accounts = coaFixture().filter((a) => a.code !== '51200');
    expect(() =>
      resolveStockAdjustmentPosting({
        reason: 'OPERATIONAL_ADJUSTMENT',
        qtyChange: 5,
        itemType: 'Product',
        accounts,
        gl: GL,
      })
    ).toThrow(StockAdjustmentAccountingError);
  });

  it('missing opening-equity configuration fails closed', () => {
    const accounts = coaFixture().filter(
      (a) => a.code !== '31000' && a.code !== '32000'
    );
    expect(() =>
      resolveStockAdjustmentPosting({
        reason: 'OPENING_BALANCE',
        qtyChange: 5,
        itemType: 'Product',
        accounts,
        gl: GL,
      })
    ).toThrow(StockAdjustmentAccountingError);
  });

  it('explicitly rejects 42100 Interest Income even when active/posting', () => {
    const acc = coaFixture().find((a) => a.code === '42100')!;
    expect(() =>
      assertAccountSemanticallyValidForStockAdjustment(acc, 'credit')
    ).toThrow(/42100/);
  });

  it('rejects non-posting 54000 configuration account', () => {
    const acc = coaFixture().find((a) => a.code === '54000')!;
    expect(() =>
      assertAccountSemanticallyValidForStockAdjustment(acc, 'credit')
    ).toThrow(/54000/);
  });

  it('rejects inactive COGS account', () => {
    const accounts = coaFixture().map((a) =>
      a.code === '51200' ? { ...a, is_active: false } : a
    );
    expect(() =>
      resolveStockAdjustmentPosting({
        reason: 'OPERATIONAL_ADJUSTMENT',
        qtyChange: 5,
        itemType: 'Product',
        accounts,
        gl: GL,
      })
    ).toThrow(/inactive/i);
  });

  it('rejects zero quantity', () => {
    expect(() =>
      resolveStockAdjustmentPosting({
        reason: 'OPERATIONAL_ADJUSTMENT',
        qtyChange: 0,
        itemType: 'Product',
        accounts: coaFixture(),
        gl: GL,
      })
    ).toThrow(/non-zero/i);
  });

  it('rejects missing accounting reason', () => {
    expect(() =>
      resolveStockAdjustmentPosting({
        reason: undefined as any,
        qtyChange: 5,
        itemType: 'Product',
        accounts: coaFixture(),
        gl: GL,
      })
    ).toThrow(/explicit accounting reason/i);
  });

  it('rejects non-posting 42000 parent masquerading as a posting account', () => {
    const acc = coaFixture().find((a) => a.code === '42000')!;
    expect(() =>
      assertAccountSemanticallyValidForStockAdjustment(acc, 'credit')
    ).toThrow(/42000/);
  });
});

describe('adjustStock integration — fail-closed + idempotent + never 42100', () => {
  beforeEach(() => {
    memStores.tables.clear();
  });

  it('posts a balanced DR Inventory / CR COGS journal for an operational increase', async () => {
    seed({ id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10 });
    const res: any = await transactionService.adjustStock({
      itemId: 'INV-PRD-001',
      qtyChange: 5,
      reason: 'Test gain',
      warehouseId: 'WH-MAIN',
      accountingReason: 'OPERATIONAL_ADJUSTMENT',
      operationId: 'OP-001',
    });
    expect(res.success).toBe(true);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(1);
    const e = ledger[0];
    expect(e.debitAccountId).toBe('ACC-11410');
    expect(e.creditAccountId).toBe('ACC-51200');
    expect(e.creditAccountId).not.toContain('42100');
    expect(e.amount).toBe(50);
    const inv = await dbService.get<any>('inventory', 'INV-PRD-001');
    expect(inv.stock).toBe(55);
  });

  it('OPENING_BALANCE posts DR Inventory / CR 31000', async () => {
    seed({ id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 0, cost: 5 });
    const res: any = await transactionService.adjustStock({
      itemId: 'INV-MAT-001',
      qtyChange: 100,
      reason: 'Opening test',
      warehouseId: 'WH-MAIN',
      accountingReason: 'OPENING_BALANCE',
      operationId: 'OP-OPEN-001',
    });
    expect(res.success).toBe(true);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger[0].debitAccountId).toBe('ACC-11420');
    expect(ledger[0].creditAccountId).toBe('ACC-31000');
  });

  it('failed accounting does not mutate inventory (fail-closed ordering)', async () => {
    // Remove COGS so the resolver throws before any inventory write.
    const accounts = coaFixture().filter((a) => a.code !== '51200');
    seed({ id: 'INV-PRD-002', name: 'Pen', type: 'Product', stock: 20, cost: 2 }, accounts);
    const res: any = await transactionService.adjustStock({
      itemId: 'INV-PRD-002',
      qtyChange: 5,
      reason: 'Should fail',
      warehouseId: 'WH-MAIN',
      accountingReason: 'OPERATIONAL_ADJUSTMENT',
    });
    expect(res.success).toBe(false);
    const inv = await dbService.get<any>('inventory', 'INV-PRD-002');
    expect(inv.stock).toBe(20);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(0);
  });

  it('repeated operationId does not duplicate the journal (idempotent)', async () => {
    seed({ id: 'INV-PRD-003', name: 'Ruler', type: 'Product', stock: 10, cost: 4 });
    const params = {
      itemId: 'INV-PRD-003',
      qtyChange: 2,
      reason: 'Retry test',
      warehouseId: 'WH-MAIN',
      accountingReason: 'OPERATIONAL_ADJUSTMENT' as const,
      operationId: 'OP-RETRY-001',
    };
    const first: any = await transactionService.adjustStock(params);
    const second: any = await transactionService.adjustStock(params);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(1);
  });

  it('service items move quantity but post no GL (services never carry inventory value)', async () => {
    seed({ id: 'INV-SVC-001', name: 'Printing Service', type: 'Service', stock: 0, cost: 50 });
    const res: any = await transactionService.adjustStock({
      itemId: 'INV-SVC-001',
      qtyChange: 3,
      reason: 'Service move',
      warehouseId: 'WH-MAIN',
      accountingReason: 'OPERATIONAL_ADJUSTMENT',
    });
    expect(res.success).toBe(true);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(0);
    const inv = await dbService.get<any>('inventory', 'INV-SVC-001');
    expect(inv.stock).toBe(3);
  });
});
