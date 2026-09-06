import { describe, it, expect, beforeEach } from 'vitest';
import { computeHierarchicalBalances, resolveInventoryAccountByItemType, resolveInventoryAccountFromItems } from '../../services/transactions/_internal';

describe('Phase 2.4: Inventory ↔ COA Integration + Hierarchical Balance Rollup', () => {
  describe('resolveInventoryAccountByItemType', () => {
    const accounts = [
      { id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, is_active: true },
      { id: 'acc-11420', code: '11420', name: 'Raw Materials', allow_posting: true, is_active: true },
      { id: 'acc-11430', code: '11430', name: 'Finished Goods', allow_posting: true, is_active: true },
      { id: 'acc-11400', code: '11400', name: 'Inventory', allow_posting: false, is_active: true },
    ];

    it('should resolve product to 11410 Merchandise Inventory', () => {
      const result = resolveInventoryAccountByItemType('product', accounts);
      expect(result).toBe('acc-11410');
    });

    it('should resolve material to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('material', accounts);
      expect(result).toBe('acc-11420');
    });

    it('should resolve raw material to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('raw material', accounts);
      expect(result).toBe('acc-11420');
    });

    it('should resolve stationery to 11420 Raw Materials', () => {
      const result = resolveInventoryAccountByItemType('stationery', accounts);
      expect(result).toBe('acc-11420');
    });

    it('should be case-insensitive', () => {
      expect(resolveInventoryAccountByItemType('PRODUCT', accounts)).toBe('acc-11410');
      expect(resolveInventoryAccountByItemType('Material', accounts)).toBe('acc-11420');
    });
  });

  describe('resolveInventoryAccountFromItems', () => {
    const accounts = [
      { id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, is_active: true },
      { id: 'acc-11420', code: '11420', name: 'Raw Materials', allow_posting: true, is_active: true },
    ];

    it('should return null for empty items', () => {
      const result = resolveInventoryAccountFromItems([], accounts);
      expect(result).toBeNull();
    });

    it('should resolve from dominant item type', () => {
      const items = [
        { type: 'product' },
        { type: 'product' },
        { type: 'material' },
      ];
      const result = resolveInventoryAccountFromItems(items, accounts);
      expect(result).toBe('acc-11410');
    });

    it('should ignore service items', () => {
      const items = [
        { type: 'Service' },
        { type: 'product' },
      ];
      const result = resolveInventoryAccountFromItems(items, accounts);
      expect(result).toBe('acc-11410');
    });
  });

  describe('computeHierarchicalBalances', () => {
    const accounts = [
      { id: '10000', code: '10000', name: 'Assets', parent_account_id: null },
      { id: '11000', code: '11000', name: 'Current Assets', parent_account_id: '10000' },
      { id: '11400', code: '11400', name: 'Inventory', parent_account_id: '11000' },
      { id: '11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: '11400' },
      { id: '11420', code: '11420', name: 'Raw Materials', parent_account_id: '11400' },
      { id: '11430', code: '11430', name: 'Finished Goods', parent_account_id: '11400' },
    ];

    it('should roll up leaf balances to parent accounts', () => {
      const leafBalances = {
        '11410': 800,
        '11420': 200,
        '11430': 0,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['11410']).toBe(800);
      expect(result['11420']).toBe(200);
      expect(result['11430']).toBe(0);
      expect(result['11400']).toBe(1000); // 800 + 200 + 0
      expect(result['11000']).toBe(1000); // rolls up from 11400
      expect(result['10000']).toBe(1000); // rolls up from 11000
    });

    it('should include parent opening balance plus children', () => {
      const leafBalances = {
        '11410': 800,
        '11420': 200,
        '11400': 50, // parent has its own balance
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['11400']).toBe(1050); // 50 + 800 + 200
      expect(result['11000']).toBe(1050);
      expect(result['10000']).toBe(1050);
    });

    it('should handle negative balances correctly', () => {
      const leafBalances = {
        '11410': -200,
        '11420': 100,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['11400']).toBe(-100); // -200 + 100
      expect(result['11000']).toBe(-100);
      expect(result['10000']).toBe(-100);
    });

    it('should handle accounts with no children', () => {
      const leafBalances = {
        '11410': 500,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);

      expect(result['11410']).toBe(500);
      expect(result['11420']).toBe(0);
      expect(result['11430']).toBe(0);
    });
  });

  describe('COA Display Requirements', () => {
    it('11400 should reflect its children, not show K0.00', () => {
      const accounts = [
        { id: '11400', code: '11400', name: 'Inventory', parent_account_id: null },
        { id: '11410', code: '11410', name: 'Merchandise Inventory', parent_account_id: '11400' },
      ];

      const leafBalances = {
        '11410': 800,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);
      expect(result['11400']).toBe(800);
      expect(result['11400']).not.toBe(0);
    });

    it('11000 should reflect all descendants', () => {
      const accounts = [
        { id: '11000', code: '11000', name: 'Current Assets', parent_account_id: null },
        { id: '11100', code: '11100', name: 'Cash', parent_account_id: '11000' },
        { id: '11200', code: '11200', name: 'Bank', parent_account_id: '11000' },
        { id: '11400', code: '11400', name: 'Inventory', parent_account_id: '11000' },
      ];

      const leafBalances = {
        '11100': 1000,
        '11200': 2000,
        '11400': 800,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);
      expect(result['11400']).toBe(800);
      expect(result['11000']).toBe(3800); // 1000 + 2000 + 800
    });

    it('10000 should reflect all asset descendants', () => {
      const accounts = [
        { id: '10000', code: '10000', name: 'Assets', parent_account_id: null },
        { id: '11000', code: '11000', name: 'Current Assets', parent_account_id: '10000' },
        { id: '12000', code: '12000', name: 'Fixed Assets', parent_account_id: '10000' },
      ];

      const leafBalances = {
        '11000': 3800,
        '12000': 5000,
      };

      const result = computeHierarchicalBalances(accounts, leafBalances);
      expect(result['10000']).toBe(8800); // 3800 + 5000
    });
  });

  describe('Reconciliation Test: Purchase → GRN → Sale', () => {
    it('should reconcile inventory subsystem valuation with GL balance', () => {
      const accounts = [
        { id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, is_active: true, parent_account_id: 'acc-11400' },
        { id: 'acc-51200', code: '51200', name: 'Cost of Goods Sold', allow_posting: true, is_active: true },
        { id: 'acc-21110', code: '21110', name: 'Trade Creditors', allow_posting: true, is_active: true },
        { id: 'acc-11400', code: '11400', name: 'Inventory', parent_account_id: null, allow_posting: false },
      ];

      // Simulate: Purchase 10 units @ K100 = K1,000
      // GRN: DR 11410 K1,000, CR 21110 K1,000
      // Sell 2 units @ K100 = K200 COGS
      // COGS: DR 51200 K200, CR 11410 K200

      const ledgerBalances = {
        'acc-11410': 800,  // K1,000 - K200
        'acc-51200': 200,  // K200
        'acc-21110': -1000, // K1,000 credit
      };

      const result = computeHierarchicalBalances(accounts, ledgerBalances);

      // 11410 Merchandise Inventory = K800
      expect(result['acc-11410']).toBe(800);
      // 11400 Inventory = K800 (rollup from 11410)
      expect(result['acc-11400']).toBe(800);
      // 51200 COGS = K200
      expect(result['acc-51200']).toBe(200);
    });
  });
});
