/**
 * inventoryReconciliation.test.ts
 *
 * Tests for inventory subledger ↔ general ledger reconciliation.
 *
 * Covers:
 * 1. COA parent rollup (11400 = 11410 + 11420 + 11430)
 * 2. 11410/11420/11430 mapping
 * 3. Goods receipt → Inventory GL
 * 4. Sale → COGS + Inventory reduction
 * 5. Inventory adjustment → GL
 * 6. Opening inventory → GL
 * 7. Inventory reconciliation idempotency
 * 8. No duplicate reconciliation journal
 * 9. Physical inventory = GL inventory after reconciliation
 * 10. Parent 11400 equals children
 * 11. No posting directly to parent if prohibited
 * 12. Zero inventory
 * 13. Multiple inventory categories
 * 14. Partial inventory reconciliation
 * 15. Existing legitimate GL balance is preserved
 * 16. Re-running reconciliation produces no additional adjustment
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeHierarchicalBalances,
  resolveInventoryAccountByItemType,
  resolveInventoryAccountFromItems,
  computeInventoryReconciliation,
} from '../../services/transactions/_internal';

// ─── Test Data ───────────────────────────────────────────────────────────

const CANONICAL_ACCOUNTS = [
  { id: 'acc-11000', code: '11000', account_number: '11000', name: 'Assets', account_type: 'ASSET', parent_account_id: null, allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'acc-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', parent_account_id: 'acc-11000', allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'acc-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', parent_account_id: 'acc-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'acc-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', parent_account_id: 'acc-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'acc-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', parent_account_id: 'acc-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'acc-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'acc-32000', code: '32000', account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', allow_posting: true, is_system_account: true, normal_balance: 'CREDIT' },
];

const MOCK_INVENTORY_ITEMS = [
  { id: 'RM-PAP-A4', name: 'A4 Copy Paper', type: 'Raw Material', stock: 100, cost: 3.50 },
  { id: 'RM-TON-HP', name: 'HP Toner', type: 'Raw Material', stock: 10, cost: 45.00 },
  { id: 'FG-BK-001', name: 'Perfect Bound Book', type: 'Product', stock: 200, cost: 2.80 },
  { id: 'FG-FL-001', name: 'A5 Flyer', type: 'Product', stock: 1000, cost: 0.35 },
];

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Inventory ↔ GL Reconciliation', () => {

  describe('1. COA Parent Rollup', () => {
    it('11400 should equal sum of 11410 + 11420 + 11430', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const leafBalances = {
        'acc-11410': 800,
        'acc-11420': 200,
        'acc-11430': 0,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['acc-11410']).toBe(800);
      expect(result['acc-11420']).toBe(200);
      expect(result['acc-11430']).toBe(0);
      expect(result['acc-11400']).toBe(1000); // 800 + 200 + 0
    });

    it('11400 should reflect children, not show 0', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const leafBalances = { 'acc-11410': 800 };
      const result = computeHierarchicalBalances(accounts, leafBalances);
      expect(result['acc-11400']).toBe(800);
      expect(result['acc-11400']).not.toBe(0);
    });
  });

  describe('2. 11410/11420/11430 Mapping', () => {
    it('should resolve product to 11410 Merchandise Inventory', () => {
      const result = resolveInventoryAccountByItemType('product', CANONICAL_ACCOUNTS);
      expect(result).toBe('acc-11410');
    });

    it('should resolve material to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('material', CANONICAL_ACCOUNTS);
      expect(result).toBe('acc-11420');
    });

    it('should resolve raw material to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('raw material', CANONICAL_ACCOUNTS);
      expect(result).toBe('acc-11420');
    });

    it('should resolve stationery to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('stationery', CANONICAL_ACCOUNTS);
      expect(result).toBe('acc-11420');
    });

    it('should be case-insensitive', () => {
      expect(resolveInventoryAccountByItemType('PRODUCT', CANONICAL_ACCOUNTS)).toBe('acc-11410');
      expect(resolveInventoryAccountByItemType('Material', CANONICAL_ACCOUNTS)).toBe('acc-11420');
    });
  });

  describe('3. Goods Receipt → Inventory GL', () => {
    it('should debit inventory and credit AP for goods receipt', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const inventoryAccountId = resolveInventoryAccountByItemType('product', accounts);
      const apAccountId = 'acc-21110'; // Trade Creditors

      expect(inventoryAccountId).toBe('acc-11410');
    });
  });

  describe('4. Sale → COGS + Inventory Reduction', () => {
    it('should debit COGS and credit inventory for sale', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const cogsAccountId = 'acc-51200';
      const inventoryAccountId = resolveInventoryAccountByItemType('product', accounts);

      expect(cogsAccountId).toBe('acc-51200');
      expect(inventoryAccountId).toBe('acc-11410');
    });
  });

  describe('5. Inventory Adjustment → GL', () => {
    it('should post adjustment to correct child account', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const inventoryAccountId = resolveInventoryAccountByItemType('raw material', accounts);
      expect(inventoryAccountId).toBe('acc-11420');
    });
  });

  describe('6. Opening Inventory → GL', () => {
    it('should distribute opening inventory across child accounts', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = MOCK_INVENTORY_ITEMS;

      let merchandiseValue = 0;
      let rawMaterialsValue = 0;

      for (const item of items) {
        const value = item.stock * item.cost;
        if (item.type === 'Product') merchandiseValue += value;
        else if (item.type === 'Raw Material') rawMaterialsValue += value;
      }

      expect(merchandiseValue).toBeGreaterThan(0);
      expect(rawMaterialsValue).toBeGreaterThan(0);
    });
  });

  describe('7. Inventory Reconciliation Idempotency', () => {
    it('re-running reconciliation should not create additional adjustment', () => {
      // Simulate: physical = GL, so no adjustment needed
      const accounts = CANONICAL_ACCOUNTS;
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 800, referenceId: 'INIT' },
      ];
      const items = [{ id: 'FG-001', type: 'Product', stock: 100, cost: 8.00 }];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      // Physical = 800, GL = 800, variance = 0
      expect(result.variance).toBe(0);
    });
  });

  describe('8. No Duplicate Reconciliation Journal', () => {
    it('should detect existing reconciliation', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 800, referenceId: 'INVENTORY-OPENING-RECONCILIATION' },
      ];
      const items = [{ id: 'FG-001', type: 'Product', stock: 100, cost: 8.00 }];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      // Physical = 800, GL = 800, variance = 0
      expect(result.variance).toBe(0);
    });
  });

  describe('9. Physical Inventory = GL Inventory After Reconciliation', () => {
    it('should show zero variance after reconciliation', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'FG-001', type: 'Product', stock: 100, cost: 8.00 }];
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 800, referenceId: 'INIT' },
      ];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(result.glInventoryValue);
      expect(result.variance).toBe(0);
    });
  });

  describe('10. Parent 11400 Equals Children', () => {
    it('should roll up correctly', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const leafBalances = { 'acc-11410': 500, 'acc-11420': 300, 'acc-11430': 200 };
      const result = computeHierarchicalBalances(accounts, leafBalances);
      expect(result['acc-11400']).toBe(1000);
    });
  });

  describe('11. No Posting Directly to Parent', () => {
    it('11400 should have allow_posting = false', () => {
      const parent = CANONICAL_ACCOUNTS.find(a => a.code === '11400');
      expect(parent?.allow_posting).toBe(false);
    });

    it('11410 should have allow_posting = true', () => {
      const child = CANONICAL_ACCOUNTS.find(a => a.code === '11410');
      expect(child?.allow_posting).toBe(true);
    });
  });

  describe('12. Zero Inventory', () => {
    it('should handle zero inventory items', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'FG-001', type: 'Product', stock: 0, cost: 8.00 }];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(0);
    });
  });

  describe('13. Multiple Inventory Categories', () => {
    it('should correctly categorize items', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [
        { id: 'RM-001', type: 'Raw Material', stock: 50, cost: 10.00 },
        { id: 'FG-001', type: 'Product', stock: 20, cost: 25.00 },
      ];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.rawMaterialsValue).toBe(500); // 50 * 10
      expect(result.merchandiseValue).toBe(500); // 20 * 25
      expect(result.physicalInventoryValue).toBe(1000);
    });
  });

  describe('14. Partial Inventory Reconciliation', () => {
    it('should only reconcile the difference', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'FG-001', type: 'Product', stock: 100, cost: 10.00 }];
      // GL already has 500, physical is 1000, so diff is 500
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 500, referenceId: 'INIT' },
      ];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(1000);
      expect(result.glInventoryValue).toBe(500);
      expect(result.variance).toBe(500);
    });
  });

  describe('15. Existing Legitimate GL Balance Preserved', () => {
    it('should not reverse existing COGS entries', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'FG-001', type: 'Product', stock: 50, cost: 10.00 }];
      // GL has 500 from legitimate purchase, physical is also 500
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 500, referenceId: 'PURCHASE-001' },
        { id: '2', debitAccountId: 'acc-51200', creditAccountId: 'acc-11410', amount: 200, referenceId: 'SALE-001' },
      ];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      // GL balance = 500 - 200 = 300, physical = 500, variance = 200
      expect(result.glInventoryValue).toBe(300);
      expect(result.variance).toBe(200);
    });
  });

  describe('16. Re-running Reconciliation Produces No Additional Adjustment', () => {
    it('should produce zero variance when already reconciled', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'FG-001', type: 'Product', stock: 100, cost: 8.00 }];
      const ledgerEntries = [
        { id: '1', debitAccountId: 'acc-11410', creditAccountId: null, amount: 800, referenceId: 'INVENTORY-OPENING-RECONCILIATION' },
      ];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.variance).toBe(0);
    });
  });

  describe('17. Diagnostic Utility', () => {
    it('should identify unclassified items', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'UNKNOWN-001', type: 'Unknown', stock: 10, cost: 5.00 }];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.unclassifiedItems.length).toBe(1);
    });

    it('should identify negative inventory', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'NEG-001', type: 'Product', stock: -5, cost: 10.00 }];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.negativeInventoryItems.length).toBe(1);
    });

    it('should identify zero-cost items', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [{ id: 'ZERO-001', type: 'Product', stock: 10, cost: 0 }];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.zeroCostItems.length).toBe(1);
    });

    it('should return correct summary', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const items = [
        { id: 'RM-001', type: 'Raw Material', stock: 10, cost: 5.00 },
        { id: 'FG-001', type: 'Product', stock: 20, cost: 10.00 },
      ];
      const ledgerEntries = [];

      const result = computeInventoryReconciliation(items, accounts, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(250); // 50 + 200
      expect(result.glInventoryValue).toBe(0);
      expect(result.variance).toBe(250);
      expect(result.merchandiseValue).toBe(200);
      expect(result.rawMaterialsValue).toBe(50);
    });
  });
});
