/**
 * Inventory-to-GL valuation regression tests.
 *
 * Covers the K0-inventory defect class:
 *  - valuation is ALWAYS quantity × cost (never Selling Price)
 *  - every historical cost representation values identically
 *  - production-shaped records normalize like canonical records
 *  - categories map to 11410 / 11420 / 11430 (products ≠ finished goods bucket)
 *  - services / deleted / negative / zero-cost / unmapped items are reported,
 *    never silently valued
 *  - opening inventory posts a balanced, idempotent journal exactly once
 *  - inventory sales relieve inventory + COGS; service sales do not
 *  - 11410/11420/11430 roll up to 11400 → 11000 → 10000 exactly once
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- In-memory dbService double (seeded per test) ---------------------------
const memStores = vi.hoisted(() => ({ tables: new Map<string, Map<string, any>>(), putLog: [] as Array<{ table: string; id: string }> }));

vi.mock('../../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const recordPut = (table: string, obj: any) => {
    memStores.putLog.push({ table, id: String(obj?.id ?? '') });
    getTable(table).set(String(obj.id ?? obj.key ?? Math.random()), obj);
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      recordPut(name, obj);
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
        recordPut(table, obj);
      },
      delete: async (table: string, id: string) => {
        getTable(table).delete(String(id));
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

import {
  classifyInventoryItem,
  reconcileInventoryValuation,
  formatInventoryReconciliation,
  resolveInventoryCostPerUnit,
  INVENTORY_GL_CODES,
} from '../../utils/inventoryNormalization';
import {
  computeOwnBalances,
  computeHierarchicalRollup,
  computeTypeTotals,
  computeTrialBalance,
} from '../../services/accountingEngine';
import { calculateItemsCost } from '../../services/transactions/_internal';
import {
  openInventory,
  previewOpeningInventory,
  getOpeningInventoryStatus,
  OPENING_INVENTORY_REQUIRES_RECONCILIATION,
} from '../../services/openingBalanceService';
import { getInventoryValuationReconciliation } from '../../services/inventoryReconciliationDiagnostic';
import { dbService } from '../../services/db';

// --- Fixtures ----------------------------------------------------------------

function coaFixture(): any[] {
  const acc = (
    code: string,
    name: string,
    account_type: string,
    parent: string | null = null,
    extra: any = {}
  ) => ({
    id: code,
    code,
    account_number: code,
    name,
    account_type,
    type:
      account_type === 'ASSET' ? 'Asset'
      : account_type === 'EQUITY' ? 'Equity'
      : account_type === 'INCOME' ? 'Revenue'
        : 'Expense',
    normal_balance: account_type === 'ASSET' || account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    parent_account_id: parent,
    ...extra,
  });
  return [
    acc('10000', 'Assets', 'ASSET', null, { allow_posting: false }),
    acc('11000', 'Current Assets', 'ASSET', '10000', { allow_posting: false }),
    acc('11300', 'Accounts Receivable', 'ASSET', '11000', { allow_posting: false }),
    acc('11310', 'Trade Debtors', 'ASSET', '11300', { allow_posting: true }),
    acc('11400', 'Inventory', 'ASSET', '11000', { allow_posting: false }),
    acc('11410', 'Merchandise Inventory', 'ASSET', '11400', { allow_posting: true }),
    acc('11420', 'Raw Materials', 'ASSET', '11400', { allow_posting: true }),
    acc('11430', 'Finished Goods', 'ASSET', '11400', { allow_posting: true }),
    acc('30000', 'Equity', 'EQUITY', null, { allow_posting: false }),
    acc('31000', "Owner's Capital", 'EQUITY', '30000', { allow_posting: true }),
    acc('40000', 'Income', 'INCOME', null, { allow_posting: false }),
    acc('41000', 'Sales / Revenue', 'INCOME', '40000', { allow_posting: false }),
    acc('41100', 'Product Sales', 'INCOME', '41000', { allow_posting: true }),
    acc('50000', 'Expenses', 'EXPENSE', null, { allow_posting: false }),
    acc('51000', 'Cost of Sales', 'EXPENSE', '50000', { allow_posting: false }),
    acc('51200', 'Cost of Goods Sold', 'EXPENSE', '51000', { allow_posting: true }),
  ];
}

function seedStores(items: any[], accounts: any[]) {
  memStores.tables.clear();
  memStores.putLog.length = 0;
  const inv = new Map(items.map((i: any) => [String(i.id), i]));
  const acc = new Map(accounts.map((a: any) => [String(a.id), a]));
  memStores.tables.set('inventory', inv);
  memStores.tables.set('accounts', acc);
  memStores.tables.set('ledger', new Map());
  memStores.tables.set('idempotencyKeys', new Map());
}

beforeEach(() => {
  memStores.tables.clear();
  memStores.putLog.length = 0;
});

// --- Tests -------------------------------------------------------------------

describe('inventory valuation (cost basis, never SP)', () => {
  it('Test 1 — quantity × CP, not SP (10 × 100 = 1,000, not 1,500)', () => {
    const item = { id: 'A', name: 'Item A', type: 'Product', stock: 10, cost: 100, price: 150, sellingPrice: 150, status: 'Active' };
    const classified = classifyInventoryItem(item);
    expect(resolveInventoryCostPerUnit(item)).toBe(100);
    expect(classified.included).toBe(true);
    expect(classified.inventoryValue).toBe(1000);
    expect(classified.inventoryValue).not.toBe(1500);
  });

  it('Test 2 — 90+ item dataset sums quantity × cost correctly', () => {
    const items: any[] = [];
    for (let i = 0; i < 95; i += 1) {
      items.push({
        id: `ITM-${i}`,
        name: `Item ${i}`,
        type: i % 3 === 0 ? 'Raw Material' : i % 3 === 1 ? 'Product' : 'Finished Good',
        stock: (i % 7) + 1,
        cost: (i % 5) + 2,
        price: 999,
        sellingPrice: 999,
        status: 'Active',
      });
    }
    const expected = items.reduce((s, it) => s + (it.stock as number) * (it.cost as number), 0);
    const report = reconcileInventoryValuation(items, coaFixture(), []);
    expect(report.items.length).toBe(95);
    expect(report.eligibleItems.length).toBe(95);
    expect(report.totalInventoryValue).toBe(expected);
    expect(report.isReconciled).toBe(false); // GL is empty
    expect(report.glInventoryTotal).toBe(0);
    expect(report.difference).toBe(expected);
  });

  it('Test 3 — mixed categories map to 11410 / 11420 / 11430', () => {
    const items = [
      { id: 'M1', name: 'Resale box', type: 'Product', stock: 10, cost: 100, status: 'Active' },
      { id: 'R1', name: 'Paper', type: 'Raw Material', stock: 20, cost: 5, status: 'Active' },
      { id: 'F1', name: 'Bound book', type: 'Finished Good', stock: 4, cost: 50, status: 'Active' },
      { id: 'S1', name: 'Glue sticks', type: 'Stationery', stock: 30, cost: 2, status: 'Active' },
    ];
    const report = reconcileInventoryValuation(items, coaFixture(), []);
    expect(report.byCategory.merchandise.value).toBe(1000);
    expect(report.byCategory.merchandise.accountCode).toBe('11410');
    expect(report.byCategory.rawMaterials.value).toBe(20 * 5 + 30 * 2);
    expect(report.byCategory.rawMaterials.accountCode).toBe('11420');
    expect(report.byCategory.finishedGoods.value).toBe(200);
    expect(report.byCategory.finishedGoods.accountCode).toBe('11430');
    expect(report.totalInventoryValue).toBe(1000 + 160 + 200);
  });

  it('Test 4 — production-shaped records value like canonical records', () => {
    const production = { id: 'prod-001', data: { name: 'Paper', material: 'material', quantity: 100, cost_per_unit: 5 } };
    const canonical = { id: 'INV-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' };
    const a = classifyInventoryItem(production);
    const b = classifyInventoryItem(canonical);
    expect(a.included).toBe(true);
    expect(a.expectedAccount).toBe('11420');
    expect(a.inventoryValue).toBe(b.inventoryValue);
    expect(a.inventoryValue).toBe(500);
  });

  it('Test 5 — canonical records: every historical cost field values identically', () => {
    const variants = [
      { id: 'V1', name: 'V', type: 'Product', stock: 10, cost: 7, status: 'Active' },
      { id: 'V2', name: 'V', type: 'Product', stock: 10, costPrice: 7, status: 'Active' },
      { id: 'V3', name: 'V', type: 'Product', stock: 10, cost_price: 7, status: 'Active' },
      { id: 'V4', name: 'V', type: 'Product', stock: 10, cost_per_unit: 7, status: 'Active' },
      { id: 'V5', name: 'V', type: 'Product', quantity: 10, costPrice: 7, status: 'Active' },
    ];
    for (const v of variants) {
      expect(resolveInventoryCostPerUnit(v)).toBe(7);
      expect(classifyInventoryItem(v).inventoryValue).toBe(70);
    }
  });

  it('Test 6 — zero cost with quantity is reported, never invented', () => {
    const item = { id: 'Z1', name: 'Mystery', type: 'Product', stock: 10, cost: 0, status: 'Active' };
    const classified = classifyInventoryItem(item);
    expect(classified.included).toBe(false);
    expect(classified.exclusionReason).toBe('ZERO_COST');
    expect(classified.inventoryValue).toBe(0);
    const report = reconcileInventoryValuation([item], coaFixture(), []);
    expect(report.totalInventoryValue).toBe(0);
    expect(report.excludedByReason['ZERO_COST']).toBe(1);
  });

  it('Test 7 — zero quantity has zero value', () => {
    const item = { id: 'ZQ', name: 'Out of stock', type: 'Product', stock: 0, cost: 100, status: 'Active' };
    expect(classifyInventoryItem(item).inventoryValue).toBe(0);
  });

  it('Test 8 — service items never contribute', () => {
    const items = [
      { id: 'S1', name: 'Printing', type: 'Service', stock: 10, cost: 50, status: 'Active' },
      { id: 'S2', name: 'Design', type: 'service', stock: 3, cost: 20, status: 'Active' },
    ];
    for (const s of items) {
      const c = classifyInventoryItem(s);
      expect(c.included).toBe(false);
      expect(c.exclusionReason).toBe('SERVICE_ITEM');
    }
    const report = reconcileInventoryValuation(items, coaFixture(), []);
    expect(report.totalInventoryValue).toBe(0);
  });

  it('Test 9 — negative stock follows the existing rule (excluded + reported)', () => {
    const item = { id: 'N1', name: 'Negative', type: 'Product', stock: -5, cost: 10, status: 'Active' };
    const classified = classifyInventoryItem(item);
    expect(classified.included).toBe(false);
    expect(classified.exclusionReason).toBe('NEGATIVE_STOCK');
    expect(classified.inventoryValue).toBe(0);
  });

  it('Test 10 — opening inventory is idempotent (second run posts nothing)', async () => {
    const accounts = coaFixture();
    const items = [
      { id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' },
      { id: 'M1', name: 'Box', type: 'Product', stock: 50, cost: 10, status: 'Active' },
      { id: 'F1', name: 'Book', type: 'Finished Good', stock: 20, cost: 25, status: 'Active' },
    ];
    seedStores(items, accounts);

    const first = await openInventory();
    expect(first.entriesPosted).toBe(3);
    expect(first.totalDebit).toBe(1500);
    expect(first.totalCredit).toBe(1500);
    const ledgerAfterFirst = await dbService.getAll<any>('ledger');
    expect(ledgerAfterFirst.length).toBe(3);

    const second = await openInventory();
    expect(second.alreadyOpened).toBe(true);
    expect(second.entriesPosted).toBe(0);
    const ledgerAfterSecond = await dbService.getAll<any>('ledger');
    expect(ledgerAfterSecond.length).toBe(3);
  });

  it('Test 11 — opening journal: Σ child debits = offset credit; 11410+11420+11430 = total', async () => {
    const accounts = coaFixture();
    seedStores(
      [
        { id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' },
        { id: 'M1', name: 'Box', type: 'Product', stock: 50, cost: 10, status: 'Active' },
        { id: 'F1', name: 'Book', type: 'Finished Good', stock: 20, cost: 25, status: 'Active' },
      ],
      accounts
    );
    await openInventory();
    const ledger = await dbService.getAll<any>('ledger');
    const debits = ledger.reduce((s: number, e: any) => s + (e.amount || 0), 0);
    // Every opening line debits inventory and credits the same offset once per line;
    // gross debits equal gross credits.
    expect(debits).toBe(1500);

    const report = reconcileInventoryValuation(
      await dbService.getAll<any>('inventory'),
      accounts,
      ledger
    );
    expect(report.glInventoryByAccount['11410']).toBe(500);
    expect(report.glInventoryByAccount['11420']).toBe(500);
    expect(report.glInventoryByAccount['11430']).toBe(500);
    expect(report.glInventoryTotal).toBe(1500);
    expect(report.totalInventoryValue).toBe(1500);
    expect(report.difference).toBe(0);
    expect(report.isReconciled).toBe(true);

    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    expect(trial.isBalanced).toBe(true);
    const text = formatInventoryReconciliation(report);
    expect(text).toContain('RECONCILED:                     YES');
  });

  it('Test 12 — inventory sale relieves inventory, creates COGS + revenue', async () => {
    const accounts = coaFixture();
    const inventory = [{ id: 'M1', name: 'Box', type: 'Product', stock: 50, cost: 10, status: 'Active' }];
    const saleItems = [{ id: 'M1', type: 'Product', quantity: 5, price: 20 }];

    // COGS from authoritative cost (weighted average).
    const cogsTotal = await calculateItemsCost(saleItems, inventory, (i: any) => i.id);
    expect(cogsTotal).toBe(50);

    const ledger: any[] = [
      { id: 'LG-REV', date: '2026-09-10T00:00:00.000Z', description: 'Sale', debitAccountId: '11310', creditAccountId: '41100', amount: 100, referenceId: 'S1' },
      { id: 'LG-COGS', date: '2026-09-10T00:00:00.000Z', description: 'COGS', debitAccountId: '51200', creditAccountId: '11410', amount: cogsTotal, referenceId: 'S1' },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    expect(own['51200']).toBe(50);
    expect(own['11410']).toBe(-50);
    expect(own['41100']).toBe(100);
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    expect(trial.isBalanced).toBe(true);
  });

  it('Test 13 — service sale posts revenue with no COGS/inventory movement', async () => {
    const saleItems = [{ id: 'S1', type: 'Service', quantity: 2, price: 100 }];
    const cogsTotal = await calculateItemsCost(
      saleItems,
      [{ id: 'S1', name: 'Printing', type: 'Service', stock: 99, cost: 50, status: 'Active' }],
      (i: any) => i.id
    );
    expect(cogsTotal).toBe(0);
  });

  it('Test 14 — 11410/11420/11430 roll up to 11400 → 11000 → 10000 exactly once', () => {
    const accounts = coaFixture();
    const own = { '11410': 500, '11420': 500, '11430': 500 };
    const tree = computeHierarchicalRollup(accounts as any[], own as any);
    expect(tree['11410']).toBe(500);
    expect(tree['11420']).toBe(500);
    expect(tree['11430']).toBe(500);
    expect(tree['11400']).toBe(1500);
    expect(tree['11000']).toBe(1500);
    expect(tree['10000']).toBe(1500);
    const totals = computeTypeTotals(accounts as any[], own as any);
    expect(totals.assets).toBe(1500);
    expect(INVENTORY_GL_CODES.merchandise).toBe('11410');
    expect(INVENTORY_GL_CODES.rawMaterials).toBe('11420');
    expect(INVENTORY_GL_CODES.finishedGoods).toBe('11430');
  });

  it('Test 15 — stale opening is reported, never silently rebuilt or skipped', async () => {
    const accounts = coaFixture();
    seedStores(
      [{ id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' }],
      accounts
    );
    const first = await openInventory();
    expect(first.totalDebit).toBe(500);

    // Stock grows after opening: the opening is now stale.
    const inv = memStores.tables.get('inventory')!;
    inv.set('R2', { id: 'R2', name: 'Ink', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' });

    const ledgerBefore = (await dbService.getAll<any>('ledger')).length;
    const second = await openInventory();
    expect(second.requiresReconciliation).toBe(true);
    expect(second.code).toBe(OPENING_INVENTORY_REQUIRES_RECONCILIATION);
    expect(second.success).toBe(false);
    expect(second.entriesPosted).toBe(0);
    expect(second.expectedValue).toBe(1000);
    expect(second.openingValue).toBe(500);
    expect(second.difference).toBe(500);
    // Nothing was posted, deleted, or changed.
    expect((await dbService.getAll<any>('ledger')).length).toBe(ledgerBefore);
  });

  it('Test 16 — forceRebuild reverses (never deletes) then reposts', async () => {
    const accounts = coaFixture();
    seedStores(
      [{ id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' }],
      accounts
    );
    await openInventory();
    const inv = memStores.tables.get('inventory')!;
    inv.set('R2', { id: 'R2', name: 'Ink', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' });

    const rebuilt = await openInventory({ forceRebuild: true, reason: 'staging review' });
    expect(rebuilt.success).toBe(true);
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.reversedEntries).toBe(1);

    const ledger = await dbService.getAll<any>('ledger');
    // History preserved: original + reversal + fresh repost.
    expect(ledger.length).toBe(1 + 1 + 1);
    const reversals = ledger.filter((e: any) => e.entryType === 'opening_inventory_reversal');
    expect(reversals.length).toBe(1);
    expect(reversals[0].reversesEntryId).toBeTruthy();
    expect(reversals[0].description).toContain('staging review');
    // Net GL equals current expected valuation.
    const report = reconcileInventoryValuation(
      await dbService.getAll<any>('inventory'),
      accounts,
      ledger
    );
    expect(report.glInventoryTotal).toBe(1000);
    expect(report.isReconciled).toBe(true);
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    expect(trial.isBalanced).toBe(true);
  });

  it('Test 17 — repeated forceRebuild converges (active value stable)', async () => {
    const accounts = coaFixture();
    seedStores(
      [{ id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' }],
      accounts
    );
    await openInventory();
    await openInventory({ forceRebuild: true, reason: 'first rebuild' });
    const second = await openInventory({ forceRebuild: true, reason: 'second rebuild' });
    expect(second.rebuilt).toBe(true);

    const ledger = await dbService.getAll<any>('ledger');
    const report = reconcileInventoryValuation(
      await dbService.getAll<any>('inventory'),
      accounts,
      ledger
    );
    // Active (unreversed) value stays at the expected valuation every time.
    expect(report.glInventoryTotal).toBe(500);
    expect(report.isReconciled).toBe(true);
  });

  it('Test 18 — preview matches the posting plan and writes nothing', async () => {
    const accounts = coaFixture();
    seedStores(
      [
        { id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' },
        { id: 'M1', name: 'Box', type: 'Product', stock: 50, cost: 10, status: 'Active' },
      ],
      accounts
    );
    memStores.putLog.length = 0;
    const preview = await previewOpeningInventory();
    expect(memStores.putLog.length).toBe(0);
    expect(preview.totalDebit).toBe(1000);
    expect(preview.totalCredit).toBe(1000);
    expect(preview.difference).toBe(0);
    expect(preview.lines.length).toBe(2);

    const posted = await openInventory();
    expect(posted.totalDebit).toBe(preview.totalDebit);
    expect(posted.totalCredit).toBe(preview.totalCredit);
    expect(posted.entriesPosted).toBe(preview.lines.length);
  });

  it('Test 19 — status reports active, reversed, and stale states', async () => {
    const accounts = coaFixture();
    seedStores(
      [{ id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' }],
      accounts
    );
    const empty = await getOpeningInventoryStatus();
    expect(empty.opened).toBe(false);

    await openInventory();
    const fresh = await getOpeningInventoryStatus();
    expect(fresh.opened).toBe(true);
    expect(fresh.activeDebitTotal).toBe(500);
    expect(fresh.reversedCount).toBe(0);
    expect(fresh.requiresReconciliation).toBe(false);

    const inv = memStores.tables.get('inventory')!;
    inv.set('R2', { id: 'R2', name: 'Ink', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' });
    const stale = await getOpeningInventoryStatus();
    expect(stale.opened).toBe(true);
    expect(stale.requiresReconciliation).toBe(true);
    expect(stale.difference).toBe(500);

    await openInventory({ forceRebuild: true, reason: 'test' });
    const rebuilt = await getOpeningInventoryStatus();
    expect(rebuilt.opened).toBe(true);
    expect(rebuilt.reversedCount).toBe(1);
    expect(rebuilt.requiresReconciliation).toBe(false);
  });

  it('Test 20 — reconciliation paths are strictly read-only', async () => {
    const accounts = coaFixture();
    seedStores(
      [{ id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' }],
      accounts
    );
    await openInventory();
    memStores.putLog.length = 0;

    await getInventoryValuationReconciliation();
    await previewOpeningInventory();
    await getOpeningInventoryStatus();

    expect(memStores.putLog.length).toBe(0);
    expect((await dbService.getAll<any>('inventory')).length).toBe(1);
  });
});
