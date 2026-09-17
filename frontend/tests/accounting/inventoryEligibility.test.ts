/**
 * inventoryEligibility.test.ts
 *
 * Authoritative inventory-eligibility rule (Prime Printing business model):
 *   Raw Material → stock eligible (true)
 *   Stationery   → stock eligible (true)
 *   Product      → NOT stock eligible (false)
 *   Service      → NOT stock eligible (false)
 *
 * Eligibility derives SOLELY from the authoritative item type — never from
 * whether a record carries stock/quantity/cost fields, an ID prefix (FG-),
 * or an inventory-account mapping.
 *
 * Covers:
 *  - isInventoryBearingItem across canonical types, legacy aliases,
 *    classification variants, FG- prefixes, and unknown/empty types
 *  - getInventoryAccountForItem eligibility-first invariant
 *    (non-stock → null account, 0 value, stock not applicable)
 *  - valuation: stocked qty×cost included; Product/Service qty×cost excluded
 *  - business examples: Chalk (Stationery, stocked) vs School Board
 *    (Product, produced via BOM, never stocked) vs Service (never stocked)
 *  - A4 Paper anchor: 1000 reams × K17,000 = K17,000,000 (never ÷500)
 */
import { describe, it, expect } from 'vitest';
import {
  isInventoryBearingItem,
  getInventoryAccountForItem,
  classifyInventoryItem,
  reconcileInventoryValuation,
  resolveInventoryGLAccountCode,
} from '../../utils/inventoryNormalization';

const coaFixture = () => [
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods' },
];

describe('authoritative inventory-eligibility rule', () => {
  it('Raw Material → eligible (canonical + legacy aliases)', () => {
    expect(isInventoryBearingItem({ type: 'Raw Material' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Material' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'raw' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'consumable' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Raw Material', classification: 'raw_material' })).toBe(true);
  });

  it('Stationery → eligible (FG- prefix never overrides type)', () => {
    expect(isInventoryBearingItem({ type: 'Stationery' })).toBe(true);
    expect(isInventoryBearingItem({ id: 'FG-BC-014', type: 'Stationery' })).toBe(true);
    expect(isInventoryBearingItem({ type: 'Stationery', classification: 'stationery' })).toBe(true);
  });

  it('Product → not eligible (FG- prefix never makes it stocked)', () => {
    expect(isInventoryBearingItem({ type: 'Product' })).toBe(false);
    expect(isInventoryBearingItem({ id: 'FG-BC-009', type: 'Product' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'Finished Good' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'merchandise' })).toBe(false);
  });

  it('Service → not eligible (every service spelling)', () => {
    expect(isInventoryBearingItem({ type: 'Service' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'Printing Service' })).toBe(false);
    expect(isInventoryBearingItem({ type: 'Service', classification: 'printing_service' })).toBe(false);
    expect(isInventoryBearingItem({ classification: 'Printing Service' })).toBe(false);
  });

  it('unknown / empty types are fail-safe non-stock', () => {
    expect(isInventoryBearingItem({ type: 'Mystery' })).toBe(false);
    expect(isInventoryBearingItem({})).toBe(false);
    expect(isInventoryBearingItem(null)).toBe(false);
    expect(isInventoryBearingItem(undefined)).toBe(false);
  });

  it('never infers eligibility from stock/qty/cost fields', () => {
    // A Product carrying legacy stock + cost is still non-stock.
    expect(isInventoryBearingItem({ type: 'Product', stock: 500, quantity: 500, cost: 100 })).toBe(false);
    expect(isInventoryBearingItem({ type: 'Service', stock: 10, cost: 50 })).toBe(false);
  });
});

describe('getInventoryAccountForItem (eligibility-first invariant)', () => {
  it('stock-bearing items resolve to 11420', () => {
    expect(getInventoryAccountForItem({ type: 'Raw Material' })).toBe('11420');
    expect(getInventoryAccountForItem({ type: 'Stationery' })).toBe('11420');
  });

  it('non-stock items resolve to NO account even with a legacy 11410 mapping', () => {
    // The legacy type map still places Product in 11410 — the mapping alone
    // must never make a Product inventory-bearing.
    expect(resolveInventoryGLAccountCode({ type: 'Product' })).toBe('11410');
    expect(getInventoryAccountForItem({ type: 'Product' })).toBe(null);
    expect(getInventoryAccountForItem({ type: 'Service' })).toBe(null);
    expect(getInventoryAccountForItem({ id: 'FG-BC-009', type: 'Product' })).toBe(null);
  });
});

describe('valuation follows eligibility first', () => {
  it('Example 1 — Chalk (Stationery, stocked): 50 × 2800 = 140,000 in 11420', () => {
    const chalk = { id: 'INV-STA-011', name: 'Chalk', type: 'Stationery', stock: 50, cost: 2800, status: 'Active' };
    const c = classifyInventoryItem(chalk);
    expect(c.included).toBe(true);
    expect(c.inventoryValue).toBe(140000);
    expect(c.expectedAccount).toBe('11420');
  });

  it('Example 2 — School Board (Product, produced via BOM): excluded, value 0', () => {
    const board = { id: 'INV-PRD-900', name: 'School Board', type: 'Product', stock: 5, cost: 40000, status: 'Active' };
    const c = classifyInventoryItem(board);
    expect(c.included).toBe(false);
    expect(c.exclusionReason).toBe('NON_STOCK_TYPE');
    expect(c.inventoryValue).toBe(0);
  });

  it('Example 3 — Service: excluded, value 0', () => {
    const svc = { id: 'SVC-1', name: 'Printing Service', type: 'Service', stock: 10, cost: 50, status: 'Active' };
    const c = classifyInventoryItem(svc);
    expect(c.included).toBe(false);
    expect(c.inventoryValue).toBe(0);
  });

  it('A4 Paper anchor: 1000 reams × K17,000 = K17,000,000 (never ÷500)', () => {
    const a4 = { id: 'INV-MAT-008', name: 'A4 Paper 80gsm', type: 'Raw Material', stock: 1000, cost: 17000, status: 'Active' };
    const c = classifyInventoryItem(a4);
    expect(c.included).toBe(true);
    expect(c.inventoryValue).toBe(17000000);
    expect(c.expectedAccount).toBe('11420');
  });

  it('mixed batch values only the stock-bearing lines', () => {
    const items = [
      { id: 'R1', name: 'Paper', type: 'Raw Material', stock: 100, cost: 5, status: 'Active' },
      { id: 'S1', name: 'Chalk', type: 'Stationery', stock: 50, cost: 2800, status: 'Active' },
      { id: 'P1', name: 'School Board', type: 'Product', stock: 5, cost: 40000, status: 'Active' },
      { id: 'V1', name: 'Design Service', type: 'Service', stock: 1, cost: 50000, status: 'Active' },
    ];
    const report = reconcileInventoryValuation(items, coaFixture(), []);
    expect(report.totalInventoryValue).toBe(500 + 140000);
    expect(report.byCategory.rawMaterials.value).toBe(500 + 140000);
    expect(report.byCategory.merchandise.value).toBe(0);
    expect(report.byCategory.finishedGoods.value).toBe(0);
    expect(report.excludedByReason['NON_STOCK_TYPE']).toBe(1);
    expect(report.excludedByReason['SERVICE_ITEM']).toBe(1);
  });
});
