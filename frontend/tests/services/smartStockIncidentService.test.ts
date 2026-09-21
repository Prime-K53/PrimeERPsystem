import { describe, it, expect } from 'vitest';
import { analyzeSmartStockIncident } from '../../services/smartStockIncidentService';

function makeItem(overrides: any = {}): any {
  return {
    id: 'ITM-001',
    name: 'Test Item',
    sku: 'SKU-001',
    type: 'Raw Material',
    stock: 500,
    cost: 100,
    costPrice: 100,
    ...overrides,
  };
}

describe('Smart Stock Incident Service', () => {
  describe('identifying SMART-1789588940379-egoshg affected items', () => {
    it('should identify items with matching bulkId as affected', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
        makeItem({ id: 'ITM-002', bulkId: 'SMART-other-bulk-id', stock: 100 }),
        makeItem({ id: 'ITM-003', bulkId: undefined, stock: 200 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.totalAffected).toBe(1);
      expect(result.affectedItems[0].itemId).toBe('ITM-001');
      expect(result.affectedItems[0].affectedByBulkId).toBe(true);
    });

    it('should identify items with bulkId in originBatchId as affected', () => {
      const items = [
        makeItem({ id: 'ITM-001', originBatchId: 'SMART-1789588940379-egoshg', stock: 500 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.totalAffected).toBe(1);
      expect(result.affectedItems[0].bulkId).toBe('SMART-1789588940379-egoshg');
    });
  });

  describe('UNKNOWN marking when original quantity unrecoverable', () => {
    it('should mark quantityBeforeSeeding as null when unrecoverable', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].quantityBeforeSeeding).toBeNull();
      expect(result.affectedItems[0].note).toContain('UNKNOWN');
    });

    it('should never substitute zero for unknown quantity', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].quantityBeforeSeeding).toBeNull();
      expect(result.affectedItems[0].quantityBeforeSeeding).not.toBe(0);
    });
  });

  describe('inventory-bearing classification', () => {
    it('should classify Raw Material as inventory-bearing', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Raw Material' }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].isInventoryBearing).toBe(true);
      expect(result.affectedItems[0].inventoryAccount).toBe('11420');
    });

    it('should classify Stationery as inventory-bearing', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Stationery' }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].isInventoryBearing).toBe(true);
      expect(result.affectedItems[0].inventoryAccount).toBe('11420');
    });

    it('should classify Product as non-inventory-bearing', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Product' }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].isInventoryBearing).toBe(false);
      expect(result.affectedItems[0].inventoryAccount).toBeNull();
    });

    it('should classify Service as non-inventory-bearing', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Service' }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].isInventoryBearing).toBe(false);
      expect(result.affectedItems[0].inventoryAccount).toBeNull();
    });
  });

  describe('non-inventory-bearing exclusion', () => {
    it('should exclude non-inventory-bearing items from currentCalculatedValue', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Product', stock: 500, cost: 100 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].currentCalculatedValue).toBe(0);
      expect(result.totalCurrentValue).toBe(0);
    });

    it('should include inventory-bearing items in currentCalculatedValue', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', type: 'Raw Material', stock: 500, cost: 100 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].currentCalculatedValue).toBe(50000);
      expect(result.totalCurrentValue).toBe(50000);
    });
  });

  describe('seed quantity handling', () => {
    it('should record seed quantity of 500 by default', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].seedQuantity).toBe(500);
    });

    it('should never use seeded quantity as opening inventory', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].quantityBeforeSeeding).toBeNull();
      expect(result.affectedItems[0].note).toContain('UNKNOWN');
    });
  });

  describe('unaffected items', () => {
    it('should list unaffected items separately', () => {
      const items = [
        makeItem({ id: 'ITM-001', bulkId: 'SMART-1789588940379-egoshg', stock: 500 }),
        makeItem({ id: 'ITM-002', bulkId: 'SMART-other-bulk-id', stock: 100 }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.totalAffected).toBe(1);
      expect(result.unaffectedItems).toHaveLength(1);
      expect(result.unaffectedItems[0].itemId).toBe('ITM-002');
    });
  });

  describe('warehouse quantity', () => {
    it('should track warehouse quantity separately from stock quantity', () => {
      const items = [
        makeItem({
          id: 'ITM-001',
          bulkId: 'SMART-1789588940379-egoshg',
          stock: 500,
          locationStock: [{ warehouseId: 'WH-1', quantity: 300 }],
        }),
      ];

      const result = analyzeSmartStockIncident(items);

      expect(result.affectedItems[0].currentQuantity).toBe(500);
      expect(result.affectedItems[0].currentWarehouseQuantity).toBe(300);
    });
  });
});
