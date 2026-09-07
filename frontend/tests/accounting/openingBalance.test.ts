import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeOpeningInventoryDiagnostic,
  openInventory,
  getOpeningInventoryStatus,
} from '../../services/openingBalanceService';
import {
  computeHierarchicalBalances,
  resolveInventoryAccountByItemType,
} from '../../services/transactions/_internal';

const CANONICAL_ACCOUNTS = [
  { id: 'ACC-11000', code: '11000', account_number: '11000', name: 'Current Assets', account_type: 'ASSET', parent_account_id: null, allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11000', allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-32000', code: '32000', account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', allow_posting: true, is_system_account: true, normal_balance: 'CREDIT' },
  { id: 'ACC-31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', allow_posting: true, is_system_account: false, normal_balance: 'CREDIT' },
];

const MOCK_INVENTORY_ITEMS = [
  { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00, status: 'Active' },
  { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, status: 'Active' },
  { id: 'INV-STA-001', name: 'Pen', type: 'Stationery', stock: 200, cost: 2.00, status: 'Active' },
];

describe('Opening Inventory Service', () => {

  describe('1. Diagnostic', () => {
    it('should calculate physical inventory valuation correctly', async () => {
      const ledgerEntries = [];
      const result = await computeOpeningInventoryDiagnostic(MOCK_INVENTORY_ITEMS, CANONICAL_ACCOUNTS, ledgerEntries);

      expect(result.merchandiseValue).toBe(500); // Product: 50 * 10
      expect(result.rawMaterialsValue).toBe(900); // Raw Material: 100 * 5 + Stationery: 200 * 2
      expect(result.finishedGoodsValue).toBe(0);
      expect(result.physicalInventoryValue).toBe(1400); // 500 + 900
      expect(result.glInventoryValue).toBe(0);
      expect(result.variance).toBe(1400);
    });

    it('should detect existing opening entries', async () => {
      const ledgerEntries = [
        { id: '1', referenceId: 'OPENING-INVENTORY', entryType: 'opening_inventory', amount: 1000 },
      ];
      const result = await computeOpeningInventoryDiagnostic(MOCK_INVENTORY_ITEMS, CANONICAL_ACCOUNTS, ledgerEntries);

      expect(result.openingEntriesExist).toBe(true);
    });

    it('should identify negative stock items', async () => {
      const items = [{ id: 'NEG-001', type: 'Product', stock: -5, cost: 10.00, status: 'Active' }];
      const result = await computeOpeningInventoryDiagnostic(items, CANONICAL_ACCOUNTS, []);

      expect(result.negativeInventoryItems.length).toBe(1);
      expect(result.negativeInventoryItems[0].id).toBe('NEG-001');
    });

    it('should identify zero-cost items', async () => {
      const items = [{ id: 'ZERO-001', type: 'Product', stock: 10, cost: 0, status: 'Active' }];
      const result = await computeOpeningInventoryDiagnostic(items, CANONICAL_ACCOUNTS, []);

      expect(result.zeroCostItems.length).toBe(1);
    });

    it('should identify unclassified items', async () => {
      const items = [{ id: 'UNK-001', type: 'Unknown', stock: 10, cost: 5.00, status: 'Active' }];
      const result = await computeOpeningInventoryDiagnostic(items, CANONICAL_ACCOUNTS, []);

      expect(result.unclassifiedItems.length).toBe(1);
      expect(result.missingAccountMapping.length).toBe(1);
    });

    it('should exclude service items', async () => {
      const items = [
        { id: 'SRV-001', type: 'Service', stock: 10, cost: 50.00, status: 'Active' },
        { id: 'PRD-001', type: 'Product', stock: 5, cost: 10.00, status: 'Active' },
      ];
      const result = await computeOpeningInventoryDiagnostic(items, CANONICAL_ACCOUNTS, []);

      expect(result.physicalInventoryValue).toBe(50); // 5 * 10
    });
  });

  describe('2. Account Mapping', () => {
    it('should resolve product to 11410', () => {
      const result = resolveInventoryAccountByItemType('product', CANONICAL_ACCOUNTS);
      expect(result).toBe('ACC-11410');
    });

    it('should resolve raw material to 11420', () => {
      const result = resolveInventoryAccountByItemType('raw material', CANONICAL_ACCOUNTS);
      expect(result).toBe('ACC-11420');
    });

    it('should resolve stationery to 11420', () => {
      const result = resolveInventoryAccountByItemType('stationery', CANONICAL_ACCOUNTS);
      expect(result).toBe('ACC-11420');
    });
  });

  describe('3. COA Parent Rollup', () => {
    it('11400 should equal sum of 11410 + 11420 + 11430', () => {
      const accounts = CANONICAL_ACCOUNTS;
      const leafBalances = { 'ACC-11410': 800, 'ACC-11420': 200, 'ACC-11430': 0 };
      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['ACC-11410']).toBe(800);
      expect(result['ACC-11420']).toBe(200);
      expect(result['ACC-11430']).toBe(0);
      expect(result['ACC-11400']).toBe(1000);
    });
  });

  describe('4. Opening Inventory Idempotency', () => {
    it('should detect existing opening inventory and return alreadyOpened', async () => {
      const result = await getOpeningInventoryStatus();
      expect(result.opened).toBe(false);
    });
  });

  describe('5. Opening Inventory Diagnostic Summary', () => {
    it('should return correct summary with zero GL', async () => {
      const items = [
        { id: 'RM-001', type: 'Raw Material', stock: 10, cost: 5.00, status: 'Active' },
        { id: 'FG-001', type: 'Product', stock: 20, cost: 10.00, status: 'Active' },
      ];
      const result = await computeOpeningInventoryDiagnostic(items, CANONICAL_ACCOUNTS, []);

      expect(result.physicalInventoryValue).toBe(250); // 50 + 200
      expect(result.glInventoryValue).toBe(0);
      expect(result.variance).toBe(250);
      expect(result.merchandiseValue).toBe(200);
      expect(result.rawMaterialsValue).toBe(50);
    });
  });

  describe('6. Production-Shaped Inventory', () => {
    it('should normalize production-shaped items and calculate correct valuation', async () => {
      const productionItems = [
        { id: 'prod-001', data: { name: 'Paper', material: 'material', quantity: 100, cost_per_unit: 5.00 } },
        { id: 'prod-002', data: { name: 'Book', material: 'product', quantity: 50, cost_per_unit: 10.00 } },
      ];

      const result = await computeOpeningInventoryDiagnostic(productionItems, CANONICAL_ACCOUNTS, []);

      expect(result.merchandiseValue).toBe(500); // Product: 50 * 10
      expect(result.rawMaterialsValue).toBe(500); // Raw Material: 100 * 5
      expect(result.physicalInventoryValue).toBe(1000);
      expect(result.variance).toBe(1000);
    });

    it('should normalize production-shaped items and include all active items', async () => {
      const productionItems = [
        { id: 'prod-001', status: 'Active', data: { name: 'Paper', material: 'material', quantity: 100, cost_per_unit: 5.00 } },
        { id: 'prod-002', status: 'Deleted', data: { name: 'Book', material: 'product', quantity: 50, cost_per_unit: 10.00 } },
      ];

      const result = await computeOpeningInventoryDiagnostic(productionItems, CANONICAL_ACCOUNTS, []);

      expect(result.physicalInventoryValue).toBe(1000); // Both items (diagnostic doesn't filter by status)
    });

    it('should return zero values for empty production inventory', async () => {
      const result = await computeOpeningInventoryDiagnostic([], CANONICAL_ACCOUNTS, []);

      expect(result.physicalInventoryValue).toBe(0);
      expect(result.glInventoryValue).toBe(0);
      expect(result.variance).toBe(0);
    });

    it('should identify negative stock in production-shaped items', async () => {
      const productionItems = [
        { id: 'prod-001', data: { name: 'Paper', material: 'material', quantity: -5, cost_per_unit: 5.00 } },
      ];

      const result = await computeOpeningInventoryDiagnostic(productionItems, CANONICAL_ACCOUNTS, []);

      expect(result.negativeInventoryItems.length).toBe(1);
    });

    it('should identify zero-cost items in production-shaped items', async () => {
      const productionItems = [
        { id: 'prod-001', data: { name: 'Paper', material: 'material', quantity: 10, cost_per_unit: 0 } },
      ];

      const result = await computeOpeningInventoryDiagnostic(productionItems, CANONICAL_ACCOUNTS, []);

      expect(result.zeroCostItems.length).toBe(1);
    });
  });
});
