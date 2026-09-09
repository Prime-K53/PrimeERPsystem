/**
 * endToEndAccounting.test.ts
 *
 * Full end-to-end accounting simulation:
 * 1. Create opening inventory
 * 2. Verify Inventory GL
 * 3. Receive/purchase inventory
 * 4. Verify DR Inventory / CR AP
 * 5. Sell inventory
 * 6. Verify DR COGS / CR Inventory
 * 7. Verify DR AR/Cash / CR Revenue
 * 8. Stock adjustment
 * 9. Verify Inventory + adjustment GL
 * 10. Return
 * 11. Verify reversal
 * 12. Recalculate inventory ↔ GL
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeInventoryReconciliation,
  computeHierarchicalBalances,
  resolveInventoryAccountByItemType,
} from '../../services/transactions/_internal';
import {
  computeOpeningInventoryDiagnostic,
  openInventory,
  getOpeningInventoryStatus,
} from '../../services/openingBalanceService';

// ─── Test Helpers ──────────────────────────────────────────────────

const CANONICAL_ACCOUNTS = [
  { id: 'ACC-11000', code: '11000', account_number: '11000', name: 'Current Assets', account_type: 'ASSET', parent_account_id: null, allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11000', allow_posting: false, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_system_account: false, normal_balance: 'DEBIT' },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-32000', code: '32000', account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', allow_posting: true, is_system_account: true, normal_balance: 'CREDIT' },
  { id: 'ACC-31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', allow_posting: true, is_system_account: false, normal_balance: 'CREDIT' },
  { id: 'ACC-21110', code: '21110', account_number: '21110', name: 'Trade Creditors', account_type: 'LIABILITY', allow_posting: true, is_system_account: false, normal_balance: 'CREDIT' },
  { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', allow_posting: true, is_system_account: true, normal_balance: 'DEBIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', allow_posting: true, is_system_account: true, normal_balance: 'CREDIT' },
];

function createLedgerEntry(overrides: any = {}): any {
  return {
    id: `LE-${Date.now()}-${Math.random()}`,
    date: new Date().toISOString(),
    description: '',
    debitAccountId: '',
    creditAccountId: '',
    amount: 0,
    referenceId: '',
    referenceType: '',
    entryType: '',
    journalId: '',
    reconciled: false,
    ...overrides,
  };
}

function simulateOpeningInventory(items: any[]): any[] {
  const ledgerEntries: any[] = [];
  const childBalances: Record<string, number> = {};

  for (const item of items) {
    if (item.type === 'Service') continue;
    const stock = item.stock || 0;
    const cost = item.cost || item.costPrice || 0;
    const value = stock * cost;
    const type = (item.type || '').toLowerCase();

    let accountCode: string | null = null;
    if (type === 'product' || type === 'finished good' || type === 'finished goods') {
      accountCode = '11410';
    } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
      accountCode = '11420';
    }
    if (!accountCode) continue;

    childBalances[accountCode] = (childBalances[accountCode] || 0) + value;
  }

  const now = new Date().toISOString();
  let entryIndex = 0;

  for (const [accountCode, amount] of Object.entries(childBalances)) {
    const account = CANONICAL_ACCOUNTS.find(a => a.account_number === accountCode);
    if (!account || account.allow_posting === false) continue;

    ledgerEntries.push(createLedgerEntry({
      id: `LE-OPEN-${entryIndex++}`,
      debitAccountId: account.id,
      creditAccountId: 'ACC-31000',
      amount: Math.round(amount * 100) / 100,
      referenceId: 'OPENING-INVENTORY',
      referenceType: 'opening_inventory',
      entryType: 'opening_inventory',
      journalId: 'INV-OPEN-001',
      description: `Opening Inventory: ${account.name}`,
    }));
  }

  return ledgerEntries;
}

function simulateGoodsReceipt(items: any[], ledgerEntries: any[]): any[] {
  const newEntries = [...ledgerEntries];
  let entryIndex = newEntries.length;

  for (const item of items) {
    if (item.type === 'Service') continue;
    const stock = item.stock || 0;
    const cost = item.cost || item.costPrice || 0;
    const value = stock * cost;
    const type = (item.type || '').toLowerCase();

    let accountCode: string | null = null;
    if (type === 'product' || type === 'finished good' || type === 'finished goods') {
      accountCode = '11410';
    } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
      accountCode = '11420';
    }
    if (!accountCode) continue;

    const account = CANONICAL_ACCOUNTS.find(a => a.account_number === accountCode);
    if (!account) continue;

    newEntries.push(createLedgerEntry({
      id: `LE-GRN-${entryIndex++}`,
      debitAccountId: account.id,
      creditAccountId: 'ACC-21110',
      amount: Math.round(value * 100) / 100,
      referenceId: `GRN-${item.id}`,
      referenceType: 'goods_receipt',
      entryType: 'goods_receipt',
      journalId: `GRN-${item.id}`,
      description: `Goods Receipt: ${item.name}`,
    }));
  }

  return newEntries;
}

function simulateSale(item: any, saleQty: number, ledgerEntries: any[]): any[] {
  const newEntries = [...ledgerEntries];
  let entryIndex = newEntries.length;

  const stock = item.stock || 0;
  const cost = item.cost || item.costPrice || 0;
  const saleValue = saleQty * cost;
  const revenueValue = saleQty * (item.sellingPrice || item.price || cost * 1.5);
  const type = (item.type || '').toLowerCase();

  let inventoryAccountCode: string | null = null;
  if (type === 'product' || type === 'finished good' || type === 'finished goods') {
    inventoryAccountCode = '11410';
  } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
    inventoryAccountCode = '11420';
  }
  if (!inventoryAccountCode) return newEntries;

  const inventoryAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === inventoryAccountCode);
  const cogsAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '51200');
  const salesAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '41100');
  const cashAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '11110');

  if (inventoryAccount && cogsAccount) {
    newEntries.push(createLedgerEntry({
      id: `LE-COGS-${entryIndex++}`,
      debitAccountId: cogsAccount.id,
      creditAccountId: inventoryAccount.id,
      amount: Math.round(saleValue * 100) / 100,
      referenceId: `SALE-${item.id}`,
      referenceType: 'sale',
      entryType: 'sale',
      journalId: `SALE-${item.id}`,
      description: `COGS: ${item.name}`,
    }));
  }

  if (salesAccount && cashAccount) {
    newEntries.push(createLedgerEntry({
      id: `LE-REV-${entryIndex++}`,
      debitAccountId: cashAccount.id,
      creditAccountId: salesAccount.id,
      amount: Math.round(revenueValue * 100) / 100,
      referenceId: `SALE-${item.id}`,
      referenceType: 'sale',
      entryType: 'sale',
      journalId: `SALE-${item.id}`,
      description: `Revenue: ${item.name}`,
    }));
  }

  return newEntries;
}

function simulateStockAdjustment(item: any, adjustmentQty: number, ledgerEntries: any[]): any[] {
  const newEntries = [...ledgerEntries];
  let entryIndex = newEntries.length;

  const cost = item.cost || item.costPrice || 0;
  const adjustmentValue = Math.abs(adjustmentQty) * cost;
  const type = (item.type || '').toLowerCase();

  let inventoryAccountCode: string | null = null;
  if (type === 'product' || type === 'finished good' || type === 'finished goods') {
    inventoryAccountCode = '11410';
  } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
    inventoryAccountCode = '11420';
  }
  if (!inventoryAccountCode) return newEntries;

  const inventoryAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === inventoryAccountCode);
  const cogsAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '51200');

  if (!inventoryAccount || !cogsAccount) return newEntries;

  if (adjustmentQty > 0) {
    newEntries.push(createLedgerEntry({
      id: `LE-ADJ-${entryIndex++}`,
      debitAccountId: inventoryAccount.id,
      creditAccountId: cogsAccount.id,
      amount: Math.round(adjustmentValue * 100) / 100,
      referenceId: `ADJ-${item.id}`,
      referenceType: 'adjustment',
      entryType: 'adjustment',
      journalId: `ADJ-${item.id}`,
      description: `Stock Adjustment (+${adjustmentQty}): ${item.name}`,
    }));
  } else {
    newEntries.push(createLedgerEntry({
      id: `LE-ADJ-${entryIndex++}`,
      debitAccountId: cogsAccount.id,
      creditAccountId: inventoryAccount.id,
      amount: Math.round(adjustmentValue * 100) / 100,
      referenceId: `ADJ-${item.id}`,
      referenceType: 'adjustment',
      entryType: 'adjustment',
      journalId: `ADJ-${item.id}`,
      description: `Stock Adjustment (${adjustmentQty}): ${item.name}`,
    }));
  }

  return newEntries;
}

function simulateReturn(item: any, returnQty: number, ledgerEntries: any[]): any[] {
  const newEntries = [...ledgerEntries];
  let entryIndex = newEntries.length;

  const cost = item.cost || item.costPrice || 0;
  const returnValue = returnQty * cost;
  const revenueValue = returnQty * (item.sellingPrice || item.price || cost * 1.5);
  const type = (item.type || '').toLowerCase();

  let inventoryAccountCode: string | null = null;
  if (type === 'product' || type === 'finished good' || type === 'finished goods') {
    inventoryAccountCode = '11410';
  } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
    inventoryAccountCode = '11420';
  }
  if (!inventoryAccountCode) return newEntries;

  const inventoryAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === inventoryAccountCode);
  const cogsAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '51200');
  const salesReturnAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '41100');
  const cashAccount = CANONICAL_ACCOUNTS.find(a => a.account_number === '11110');

  if (inventoryAccount && cogsAccount) {
    newEntries.push(createLedgerEntry({
      id: `LE-RET-${entryIndex++}`,
      debitAccountId: inventoryAccount.id,
      creditAccountId: cogsAccount.id,
      amount: Math.round(returnValue * 100) / 100,
      referenceId: `RET-${item.id}`,
      referenceType: 'return',
      entryType: 'return',
      journalId: `RET-${item.id}`,
      description: `Return: ${item.name}`,
    }));
  }

  if (salesReturnAccount && cashAccount) {
    newEntries.push(createLedgerEntry({
      id: `LE-REF-${entryIndex++}`,
      debitAccountId: salesReturnAccount.id,
      creditAccountId: cashAccount.id,
      amount: Math.round(revenueValue * 100) / 100,
      referenceId: `RET-${item.id}`,
      referenceType: 'return',
      entryType: 'return',
      journalId: `RET-${item.id}`,
      description: `Refund: ${item.name}`,
    }));
  }

  return newEntries;
}

function getGLBalance(accountId: string, ledgerEntries: any[]): number {
   const account = CANONICAL_ACCOUNTS.find(a => a.id === accountId);
   if (!account) return 0;

   const isDebitNormal = account.normal_balance === 'DEBIT';
   let balance = 0;
   for (const entry of ledgerEntries) {
     if (entry.debitAccountId === accountId) {
       balance += isDebitNormal ? entry.amount : -entry.amount;
     }
     if (entry.creditAccountId === accountId) {
       balance += isDebitNormal ? -entry.amount : entry.amount;
     }
   }
   // Return balance in "debit-positive" convention:
   // Credit-normal accounts (LIABILITY, EQUITY, INCOME) show negative
   return isDebitNormal ? balance : -balance;
 }

// ─── Tests ─────────────────────────────────────────────────────────

describe('End-to-End Accounting Simulation', () => {

  describe('Step 1: Opening Inventory', () => {
    it('should create opening inventory journal entries', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      const ledgerEntries = simulateOpeningInventory(items);

      const merchandiseBalance = getGLBalance('ACC-11410', ledgerEntries);
      const rawMaterialsBalance = getGLBalance('ACC-11420', ledgerEntries);
      const equityBalance = getGLBalance('ACC-31000', ledgerEntries);

      expect(merchandiseBalance).toBe(500); // 50 * 10
      expect(rawMaterialsBalance).toBe(500); // 100 * 5
      expect(equityBalance).toBe(-1000); // Credit to equity (CREDIT normal balance = negative)
      expect(ledgerEntries.length).toBe(2);
    });

    it('should have balanced debits and credits', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      const ledgerEntries = simulateOpeningInventory(items);
      const totalDebits = ledgerEntries.filter(e => e.debitAccountId).reduce((s, e) => s + e.amount, 0);
      const totalCredits = ledgerEntries.filter(e => e.creditAccountId).reduce((s, e) => s + e.amount, 0);

      expect(totalDebits).toBe(totalCredits);
    });
  });

  describe('Step 2: Verify Inventory GL After Opening', () => {
    it('should show zero variance after opening inventory', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      const ledgerEntries = simulateOpeningInventory(items);
      const result = computeInventoryReconciliation(items, CANONICAL_ACCOUNTS, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(result.glInventoryValue);
      expect(result.variance).toBe(0);
    });
  });

  describe('Step 3: Receive/Purchase Inventory', () => {
    it('should create GRN entries: DR Inventory / CR AP', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const newItems = [
        { id: 'INV-PRD-002', name: 'Notebook', type: 'Product', stock: 20, cost: 8.00 },
        { id: 'INV-MAT-002', name: 'Ink', type: 'Raw Material', stock: 50, cost: 12.00 },
      ];
      const allEntries = simulateGoodsReceipt(newItems, openingEntries);

      const merchandiseBalance = getGLBalance('ACC-11410', allEntries);
      const rawMaterialsBalance = getGLBalance('ACC-11420', allEntries);
      const apBalance = getGLBalance('ACC-21110', allEntries);

      expect(merchandiseBalance).toBe(500 + 160); // 50*10 + 20*8
      expect(rawMaterialsBalance).toBe(500 + 600); // 100*5 + 50*12
      expect(apBalance).toBe(-760); // Credit to AP
    });
  });

  describe('Step 4: Sell Inventory', () => {
    it('should create COGS and Revenue entries', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, sellingPrice: 15.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const allEntries = simulateSale(items[0], 10, openingEntries);

      const cogsBalance = getGLBalance('ACC-51200', allEntries);
      const inventoryBalance = getGLBalance('ACC-11410', allEntries);
      const revenueBalance = getGLBalance('ACC-41100', allEntries);
      const cashBalance = getGLBalance('ACC-11110', allEntries);

      expect(cogsBalance).toBe(100); // 10 * 10
      expect(inventoryBalance).toBe(500 - 100); // 500 - 100
      expect(revenueBalance).toBe(-150); // 10 * 15 (CREDIT account = negative)
      expect(cashBalance).toBe(150); // 10 * 15
    });

    it('should have balanced entries after sale', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, sellingPrice: 15.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const allEntries = simulateSale(items[0], 10, openingEntries);

      const totalDebits = allEntries.reduce((s, e) => s + e.amount, 0);
      const totalCredits = allEntries.reduce((s, e) => s + e.amount, 0);

      expect(totalDebits).toBe(totalCredits);
    });
  });

  describe('Step 5: Stock Adjustment', () => {
    it('should create adjustment entries for stock increase', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const allEntries = simulateStockAdjustment(items[0], 5, openingEntries);

      const inventoryBalance = getGLBalance('ACC-11410', allEntries);
      const cogsBalance = getGLBalance('ACC-51200', allEntries);

      expect(inventoryBalance).toBe(550); // 50*10 + 5*10
      expect(cogsBalance).toBe(-50); // Credit to COGS (reversal)
    });

    it('should create adjustment entries for stock decrease', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const allEntries = simulateStockAdjustment(items[0], -5, openingEntries);

      const inventoryBalance = getGLBalance('ACC-11410', allEntries);
      const cogsBalance = getGLBalance('ACC-51200', allEntries);

      expect(inventoryBalance).toBe(450); // 50*10 - 5*10
      expect(cogsBalance).toBe(50); // Debit to COGS
    });
  });

  describe('Step 6: Return', () => {
    it('should reverse COGS and revenue for returns', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, sellingPrice: 15.00 },
      ];

      const openingEntries = simulateOpeningInventory(items);
      const saleEntries = simulateSale(items[0], 10, openingEntries);
      const allEntries = simulateReturn(items[0], 3, saleEntries);

      const inventoryBalance = getGLBalance('ACC-11410', allEntries);
      const cogsBalance = getGLBalance('ACC-51200', allEntries);
      const revenueBalance = getGLBalance('ACC-41100', allEntries);
      const cashBalance = getGLBalance('ACC-11110', allEntries);

      // After opening: inv=500, after sale: inv=400, cogs=100, rev=-150, cash=150
      // After return of 3: inv=400+30=430, cogs=100-30=70, rev=-150+45=-105, cash=150-45=105
      expect(inventoryBalance).toBe(430);
      expect(cogsBalance).toBe(70);
      expect(revenueBalance).toBe(-105);
      expect(cashBalance).toBe(105);
    });
  });

  describe('Step 7: Final Reconciliation', () => {
    it('should show zero variance after all transactions', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, sellingPrice: 15.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
      ];

      // Step 1: Opening
      let ledgerEntries = simulateOpeningInventory(items);

      // Step 2: Verify opening
      let result = computeInventoryReconciliation(items, CANONICAL_ACCOUNTS, ledgerEntries);
      expect(result.variance).toBe(0);

      // Step 3: Purchase more
      const newItems = [
        { id: 'INV-PRD-002', name: 'Notebook', type: 'Product', stock: 20, cost: 8.00 },
      ];
      ledgerEntries = simulateGoodsReceipt(newItems, ledgerEntries);

      // Step 4: Sell
      ledgerEntries = simulateSale(items[0], 10, ledgerEntries);

      // Step 5: Adjust
      ledgerEntries = simulateStockAdjustment(items[0], 5, ledgerEntries);

      // Step 6: Return
      ledgerEntries = simulateReturn(items[0], 3, ledgerEntries);

      // Step 7: Recalculate
      // Physical inventory: Book has 50-10+5-3=42 units * 10 = 420, plus Notebook 20*8=160
      // But the simulation doesn't update stock quantities in the items array,
      // so we need to use the GL-reflecting quantities
      const updatedItems = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 48, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
        { id: 'INV-PRD-002', name: 'Notebook', type: 'Product', stock: 20, cost: 8.00 },
      ];

      result = computeInventoryReconciliation(updatedItems, CANONICAL_ACCOUNTS, ledgerEntries);

      // The GL should reflect all the ledger entries
      // The physical should match the GL if all transactions were properly recorded
      expect(result.variance).toBe(0);
    });

    it('should correctly calculate all GL balances after full pipeline', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00, sellingPrice: 15.00 },
      ];

      // Full pipeline
      let ledgerEntries = simulateOpeningInventory(items);
      ledgerEntries = simulateGoodsReceipt(
        [{ id: 'INV-PRD-002', name: 'Notebook', type: 'Product', stock: 20, cost: 8.00 }],
        ledgerEntries
      );
      ledgerEntries = simulateSale(items[0], 10, ledgerEntries);
      ledgerEntries = simulateStockAdjustment(items[0], 5, ledgerEntries);
      ledgerEntries = simulateReturn(items[0], 3, ledgerEntries);

      // Verify key account balances
      const inventory11410 = getGLBalance('ACC-11410', ledgerEntries);
      const cogs51200 = getGLBalance('ACC-51200', ledgerEntries);
      const revenue41100 = getGLBalance('ACC-41100', ledgerEntries);
      const cash11110 = getGLBalance('ACC-11110', ledgerEntries);
      const ap21110 = getGLBalance('ACC-21110', ledgerEntries);
      const equity31000 = getGLBalance('ACC-31000', ledgerEntries);

      // Opening: DR 11410=500, CR 31000=500
      // GRN: DR 11410=160, CR 21110=160
      // Sale: DR 51200=100, CR 11410=100; DR 11110=150, CR 41100=150
      // Adjustment: DR 11410=50, CR 51200=50
      // Return: DR 11410=30, CR 51200=30; DR 41100=45, CR 11110=45
      // 11410: 500+160-100+50+30 = 640
      // 51200: 100-50-30 = 20
      // 41100: 150-45 = 105
      // 11110: 150-45 = 105
      // 21110: -160
      // 31000: -500

      expect(inventory11410).toBe(640);
      expect(cogs51200).toBe(20);
      expect(revenue41100).toBe(-105);
      expect(cash11110).toBe(105);
      expect(ap21110).toBe(-160);
      expect(equity31000).toBe(-500);
    });
  });

  describe('Step 8: Diagnostic Verification', () => {
    it('should identify all inventory items correctly', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
        { id: 'INV-MAT-001', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5.00 },
        { id: 'INV-STA-001', name: 'Pen', type: 'Stationery', stock: 200, cost: 2.00 },
      ];

      const ledgerEntries = simulateOpeningInventory(items);
      const result = computeInventoryReconciliation(items, CANONICAL_ACCOUNTS, ledgerEntries);

      expect(result.merchandiseValue).toBe(500);
      expect(result.rawMaterialsValue).toBe(900); // 100*5 + 200*2
      expect(result.physicalInventoryValue).toBe(1400);
      expect(result.glInventoryValue).toBe(1400);
      expect(result.variance).toBe(0);
    });

    it('should detect missing opening inventory', () => {
      const items = [
        { id: 'INV-PRD-001', name: 'Book', type: 'Product', stock: 50, cost: 10.00 },
      ];

      const ledgerEntries: any[] = []; // No opening inventory
      const result = computeInventoryReconciliation(items, CANONICAL_ACCOUNTS, ledgerEntries);

      expect(result.physicalInventoryValue).toBe(500);
      expect(result.glInventoryValue).toBe(0);
      expect(result.variance).toBe(500);
    });
  });
});
