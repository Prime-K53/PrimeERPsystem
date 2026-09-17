/**
 * inventoryReconciliationDiagnostic.test.ts
 *
 * Tests the inventory reconciliation diagnostic that compares physical
 * inventory valuation against GL balances.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Item, Account, LedgerEntry } from '../../types';

// Mock dbService
const mockDb = vi.hoisted(() => ({
  getAll: vi.fn(),
}));

vi.mock('../../services/db', () => ({
  dbService: mockDb,
}));

// Dynamic import of the module under test (after mocks are set up)
let computeInventoryReconciliation: any;
let formatReconciliationReport: any;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import('../../services/inventoryReconciliationDiagnostic');
  computeInventoryReconciliation = mod.computeInventoryReconciliation;
  formatReconciliationReport = mod.formatReconciliationReport;
});

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: `ITEM-${Math.random().toString(36).slice(2, 7)}`,
    name: 'Test Item',
    type: 'Product',
    category: 'Test',
    unit: 'Piece',
    cost: 10,
    costPrice: 10,
    stock: 100,
    status: 'Active',
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-11410',
    code: '11410',
    account_number: '11410',
    name: 'Merchandise Inventory',
    account_type: 'ASSET',
    type: 'Asset',
    allow_posting: true,
    is_active: true,
    ...overrides,
  };
}

function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'LED-001',
    date: '2026-01-01T00:00:00Z',
    description: 'Test entry',
    debitAccountId: 'acc-11410',
    creditAccountId: 'acc-21110',
    amount: 1000,
    referenceId: 'TEST-001',
    reconciled: false,
    ...overrides,
  };
}

describe('computeInventoryReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports zero when no inventory items exist', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    expect(result.physicalInventoryValue).toBe(0);
    expect(result.glInventoryValue).toBe(0);
    expect(result.variance).toBe(0);
    expect(result.itemCount).toBe(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some(d => d.code === 'NO_INVENTORY')).toBe(true);
  });

  it('computes physical value from stock × cost', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        // Stock-bearing fixtures only: Product lines are non-stock under
        // the eligibility rule (value 0), so both fixtures are Raw Material.
        makeItem({ id: 'I-1', cost: 10, stock: 100, type: 'Raw Material' }),

makeItem({ id: 'I-2', cost: 5, stock: 200, type: 'Raw Material' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11420', code: '11420', name: 'Raw Materials', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    // I-1: 100 × 10 = 1000 (raw material)
    // I-2: 200 × 5 = 1000 (raw material)
    expect(result.physicalInventoryValue).toBe(2000);
    expect(result.merchandiseValue).toBe(0);
    expect(result.rawMaterialsValue).toBe(2000);
    expect(result.totalUnits).toBe(300);
    expect(result.itemCount).toBe(2);
  });

  it('excludes Product lines from physical value (non-stock)', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 10, stock: 100, type: 'Product' }),
        makeItem({ id: 'I-2', cost: 5, stock: 200, type: 'Raw Material' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11420', code: '11420', name: 'Raw Materials', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    // Product I-1 contributes 0; only the Raw Material values.
    expect(result.physicalInventoryValue).toBe(1000);
    expect(result.merchandiseValue).toBe(0);
    expect(result.rawMaterialsValue).toBe(1000);
    expect(result.totalUnits).toBe(200);
    expect(result.itemCount).toBe(2);
  });

  it('computes GL balance for merchandise inventory account', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 10, stock: 100, type: 'Raw Material' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
        makeAccount({ id: 'acc-51200', code: '51200', name: 'COGS', account_type: 'EXPENSE', type: 'Expense', allow_posting: true }),
        makeAccount({ id: 'acc-21110', code: '21110', name: 'Trade Creditors', account_type: 'LIABILITY', type: 'Liability', allow_posting: true }),
      ];
      if (store === 'ledger') return [
        // GRN: DR Inventory K1000, CR AP K1000
        makeLedgerEntry({ id: 'LED-001', debitAccountId: 'acc-11410', creditAccountId: 'acc-21110', amount: 1000 }),
        // Sale: DR COGS K200, CR Inventory K200
        makeLedgerEntry({ id: 'LED-002', debitAccountId: 'acc-51200', creditAccountId: 'acc-11410', amount: 200 }),
      ];
      return [];
    });

    const result = await computeInventoryReconciliation();
    // GL: 11410 = DR 1000 - CR 200 = 800 (debit normal, so positive = asset)
    expect(result.glMerchandiseValue).toBe(800);
    expect(result.glInventoryValue).toBe(800); // rollup from 11410
    // Physical: 100 × 10 = 1000
    expect(result.physicalInventoryValue).toBe(1000);
    expect(result.variance).toBe(200); // 1000 - 800 = 200 (GL understated)
  });

  it('validates GL children sum to parent', async () => {
    // Use fresh ledger entries with unambiguous amounts
    const ledgerEntries = [
      {
        id: 'LED-GRN-001',
        date: '2026-01-01T00:00:00Z',
        description: 'GRN: DR Merchandise K500, CR AP K500',
        debitAccountId: 'acc-11410',
        creditAccountId: 'acc-21110',
        amount: 500,
        referenceId: 'GRN-001',
        reconciled: false,
        entryType: undefined,
        referenceType: undefined,
      },
    ];
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [];
      if (store === 'accounts') return [
        { id: 'acc-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', type: 'Asset', allow_posting: true, is_active: true, parent_account_id: 'acc-11400' },
        { id: 'acc-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', type: 'Asset', allow_posting: true, is_active: true, parent_account_id: 'acc-11400' },
        { id: 'acc-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', type: 'Asset', allow_posting: true, is_active: true, parent_account_id: 'acc-11400' },
        { id: 'acc-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', type: 'Asset', allow_posting: false, is_active: true, parent_account_id: null },
      ];
      if (store === 'ledger') return ledgerEntries;
      return [];
    });

    const result = await computeInventoryReconciliation();
    // Debug: print actual values
    // Children: 11410 = 500, 11420 = 0, 11430 = 0 → sum = 500.
    // Finished goods map to 11430 (distinct from 11410 merchandise), so the
    // K500 merchandise GRN is counted under 11410 only.
    expect(result.glMerchandiseValue).toBe(500);
    expect(result.glRawMaterialsValue).toBe(0);
    expect(result.glFinishedGoodsValue).toBe(0);
    expect(result.glTotalChildrenValue).toBe(500);
    expect(result.glInventoryValue).toBe(500);
  });

  it('detects negative stock items', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 10, stock: -5, type: 'Product' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    expect(result.diagnostics.some(d => d.code === 'NEGATIVE_STOCK')).toBe(true);
  });

  it('detects zero-cost items with stock', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 0, costPrice: 0, stock: 100, type: 'Product' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    expect(result.diagnostics.some(d => d.code === 'ZERO_COST')).toBe(true);
  });

  it('returns formatted report string', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 10, stock: 100, type: 'Product' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    const report = formatReconciliationReport(result);
    expect(report).toContain('INVENTORY RECONCILIATION REPORT');
    expect(report).toContain('Physical Inventory Value:');
    expect(report).toContain('GL Inventory Value:');
    expect(report).toContain('Variance');
  });

  it('handles inactive items correctly', async () => {
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'inventory') return [
        makeItem({ id: 'I-1', cost: 10, stock: 100, type: 'Raw Material', status: 'Active' }),
        makeItem({ id: 'I-2', cost: 5, stock: 50, type: 'Raw Material', status: 'Inactive' }),
      ];
      if (store === 'accounts') return [
        makeAccount({ id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: null }),
        makeAccount({ id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false }),
      ];
      if (store === 'ledger') return [];
      return [];
    });

    const result = await computeInventoryReconciliation();
    expect(result.itemCount).toBe(2);
    expect(result.activeItemCount).toBe(1);
    expect(result.inactiveItemCount).toBe(1);
    // Only active items contribute to physical value? Actually the current code includes ALL items.
    // This is a design decision — inactive items are still in the DB with stock.
    expect(result.physicalInventoryValue).toBe(100 * 10 + 50 * 5); // 1000 + 250 = 1250
  });
});
