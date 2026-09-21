import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildInventoryRecoveryReport, formatInventoryRecoveryReport } from '../../services/inventoryRecoveryService';
import { analyzeSmartStockIncident } from '../../services/smartStockIncidentService';
import { generatePhysicalCountReport } from '../../services/physicalCountService';

// Mock dependencies
vi.mock('../../services/smartStockIncidentService');
vi.mock('../../services/physicalCountService');
vi.mock('../../utils/inventoryNormalization', () => ({
  ...require('../../utils/inventoryNormalization'),
  isInventoryBearingItem: vi.fn(),
  resolveInventoryGLAccountCode: vi.fn(),
  resolveInventoryCostPerUnit: vi.fn(),
  resolveWarehouseQuantity: vi.fn(),
  resolveInventoryQuantity: vi.fn(),
  classifyInventoryItem: vi.fn(),
  reconcileInventoryValuation: vi.fn(),
  INVENTORY_GL_CODES: { merchandise: '11410', rawMaterials: '11420', finishedGoods: '11430', parent: '11400' },
}));
vi.mock('../../services/accountingEngine', () => ({
  computeOwnBalances: vi.fn(() => ({})),
}));

const mockAnalyzeSmartStockIncident = vi.mocked(analyzeSmartStockIncident);
const mockGeneratePhysicalCountReport = vi.mocked(generatePhysicalCountReport);

describe('Inventory Recovery Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('safeguards and invoice protection', () => {
    it('should produce safeguards proving no invoice/COGS modification', () => {
      const result = buildInventoryRecoveryReport([], [], []);

      expect(result.safeguards.length).toBeGreaterThan(0);
      expect(result.safeguards.some(s => s.includes('zero references to invoices'))).toBe(true);
      expect(result.safeguards.some(s => s.includes('read-only'))).toBe(true);
    });

    it('should produce invoice protection proof', () => {
      const result = buildInventoryRecoveryReport([], [], []);

      expect(result.invoiceProtectionProof.length).toBeGreaterThan(0);
      expect(result.invoiceProtectionProof.some(p => p.includes('no invoice/COGS'))).toBe(true);
    });
  });

  describe('recoverability classification', () => {
    it('should classify RECOVERABLE when pre-seeding quantity is known with high confidence', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: 100,
          seedQuantity: 500,
          subsequentMovements: 50,
          stock: 650,
          locationStock: [{ warehouseId: 'WH-1', quantity: 650 }],
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.inventoryBearingItems[0].recoverability).toBe('RECOVERABLE');
      expect(result.inventoryBearingItems[0].confidence).toBe('HIGH');
    });

    it('should classify PARTIALLY RECOVERABLE when some evidence exists', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Stationery',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: null,
          seedQuantity: 500,
          subsequentMovements: 50,
          stock: 550,
          locationStock: [{ warehouseId: 'WH-1', quantity: 550 }],
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.inventoryBearingItems[0].recoverability).toBe('PARTIALLY_RECOVERABLE');
      expect(result.inventoryBearingItems[0].confidence).toBe('MEDIUM');
    });

    it('should classify UNKNOWN when no evidence exists', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: null,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 500,
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.inventoryBearingItems[0].recoverability).toBe('UNKNOWN');
      expect(result.inventoryBearingItems[0].confidence).toBe('UNKNOWN');
    });
  });

  describe('recovery model recommendation', () => {
    it('should recommend Model A when all items are recoverable', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: 100,
          seedQuantity: 500,
          subsequentMovements: 50,
          stock: 650,
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.recommendedRecoveryModel).toBe('A');
      expect(result.recoveryModelReason).toContain('recoverable');
    });

    it('should recommend Model B when all items are unknown', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: null,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 500,
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.recommendedRecoveryModel).toBe('B');
      expect(result.recoveryModelReason).toContain('Physical count is required');
    });

    it('should recommend Model C for mixed recoverability', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item 1',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: 100,
          seedQuantity: 500,
          subsequentMovements: 50,
          stock: 650,
          cost: 100,
        },
        {
          id: 'ITM-002',
          name: 'Test Item 2',
          sku: 'SKU-002',
          type: 'Stationery',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: null,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 500,
          cost: 200,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.recommendedRecoveryModel).toBe('C');
      expect(result.recoveryModelReason).toContain('Mixed recoverability');
    });
  });

  describe('Product/Service exclusion', () => {
    it('should exclude non-inventory-bearing items from recovery items', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Product Item',
          sku: 'SKU-001',
          type: 'Product',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: 100,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 600,
          cost: 100,
        },
        {
          id: 'ITM-002',
          name: 'Service Item',
          sku: 'SKU-002',
          type: 'Service',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: 50,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 550,
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      expect(result.inventoryBearingItems).toHaveLength(0);
      expect(result.nonInventoryBearingItems).toHaveLength(2);
      expect(result.recoverabilitySummary.recoverable).toBe(0);
    });
  });

  describe('account reconciliation', () => {
    it('should reconcile inventory accounts without modifying them', () => {
      const accounts = [
        { id: 'acc-11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', normal_balance: 'DEBIT', opening_balance: 0 },
        { id: 'acc-11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', normal_balance: 'DEBIT', opening_balance: 0 },
      ];
      const ledger = [
        { id: 'LED-001', debitAccountId: 'acc-11410', creditAccountId: 'acc-21110', amount: 1000, status: 'posted', entryType: 'journal', referenceType: 'grn', referenceId: 'GRN-001' },
      ];

      const result = buildInventoryRecoveryReport([], accounts, ledger);

      expect(result.accountReconciliations).toHaveLength(2);
      expect(result.accountReconciliations[0].accountCode).toBe('11410');
      expect(result.accountReconciliations[0].currentLedgerBalance).toBe(1000);
    });

    it('should not modify accounts or ledger', () => {
      const accounts = [{ id: 'acc-11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', opening_balance: 0 }];
      const ledger = [{ id: 'LED-001', debitAccountId: 'acc-11410', creditAccountId: 'acc-21110', amount: 1000, status: 'posted' }];

      const accountsCopy = JSON.parse(JSON.stringify(accounts));
      const ledgerCopy = JSON.parse(JSON.stringify(ledger));

      buildInventoryRecoveryReport([], accounts, ledger);

      expect(accounts).toEqual(accountsCopy);
      expect(ledger).toEqual(ledgerCopy);
    });
  });

  describe('formatting', () => {
    it('should format report as readable string', () => {
      const report = buildInventoryRecoveryReport([], [], []);
      const formatted = formatInventoryRecoveryReport(report);

      expect(formatted).toContain('INVENTORY RECOVERY REPORT');
      expect(formatted).toContain('SMART STOCK AFFECTED ITEMS');
      expect(formatted).toContain('RECOVERABILITY');
      expect(formatted).toContain('ACCOUNT RECONCILIATIONS');
      expect(formatted).toContain('SAFEGUARDS');
      expect(formatted).toContain('INVOICE PROTECTION PROOF');
    });
  });

  describe('opening balance separation', () => {
    it('should not infer opening balance from contaminated stock', () => {
      const items = [
        {
          id: 'ITM-001',
          name: 'Test Item',
          sku: 'SKU-001',
          type: 'Raw Material',
          bulkId: 'SMART-1789588940379-egoshg',
          quantityBeforeSeeding: null,
          seedQuantity: 500,
          subsequentMovements: 0,
          stock: 500,
          cost: 100,
        },
      ];

      const result = buildInventoryRecoveryReport(items, [], []);

      // Opening balance should be 0 unless explicitly provided in account data
      expect(result.accountReconciliations.every(r => r.openingBalance === 0)).toBe(true);
      expect(result.recoveryModelReason).not.toContain('K41,868,000');
      expect(result.recoveryModelReason).not.toContain('K222,306,800');
    });
  });

  describe('no live data changes', () => {
    it('should not modify any input arrays', () => {
      const items = [{ id: 'ITM-001', type: 'Raw Material', stock: 500, cost: 100 }];
      const accounts = [{ id: 'acc-11410', account_number: '11410', name: 'Merchandise Inventory' }];
      const ledger = [{ id: 'LED-001', amount: 1000 }];

      const itemsCopy = JSON.parse(JSON.stringify(items));
      const accountsCopy = JSON.parse(JSON.stringify(accounts));
      const ledgerCopy = JSON.parse(JSON.stringify(ledger));

      buildInventoryRecoveryReport(items, accounts, ledger);

      expect(items).toEqual(itemsCopy);
      expect(accounts).toEqual(accountsCopy);
      expect(ledger).toEqual(ledgerCopy);
    });
  });
});
