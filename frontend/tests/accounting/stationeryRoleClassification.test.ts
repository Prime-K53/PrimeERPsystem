import { describe, it, expect } from 'vitest';
import {
  calculateCogsLegsPerInventoryAccount,
  resolveInventoryAccountByItemType,
  resolveInventoryAccountFromItems,
} from '../../services/transactions/_internal';
import {
  getInventoryAccountForItem,
  isInventoryBearingItem,
  resolveStationeryAccountCode,
} from '../../utils/inventoryNormalization';

const ACCOUNTS = [
  { id: 'acc-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, is_active: true },
  { id: 'acc-11420', code: '11420', name: 'Raw Materials', allow_posting: true, is_active: true },
  { id: 'acc-11430', code: '11430', name: 'Finished Goods', allow_posting: true, is_active: true },
];

describe('Stationery role-aware inventory classification', () => {
  describe('resolveStationeryAccountCode (fail-safe policy)', () => {
    it('sellable → 11410', () => {
      expect(resolveStationeryAccountCode('sellable')).toBe('11410');
    });

    it('internal → 11420', () => {
      expect(resolveStationeryAccountCode('internal')).toBe('11420');
    });

    it('both → 11420 (preserves today’s behavior)', () => {
      expect(resolveStationeryAccountCode('both')).toBe('11420');
    });

    it('absent/null/unknown → 11420 (fail-safe default)', () => {
      expect(resolveStationeryAccountCode(undefined)).toBe('11420');
      expect(resolveStationeryAccountCode(null)).toBe('11420');
      expect(resolveStationeryAccountCode('')).toBe('11420');
      expect(resolveStationeryAccountCode('whatever')).toBe('11420');
    });
  });

  describe('resolveInventoryAccountByItemType with role', () => {
    it('Raw Material → 11420 regardless of role', () => {
      expect(resolveInventoryAccountByItemType('raw material', ACCOUNTS)).toBe('acc-11420');
      expect(resolveInventoryAccountByItemType('raw material', ACCOUNTS, 'sellable')).toBe('acc-11420');
    });

    it('Stationery without role → 11420 (unchanged default)', () => {
      expect(resolveInventoryAccountByItemType('stationery', ACCOUNTS)).toBe('acc-11420');
    });

    it('Stationery + internal/both → 11420', () => {
      expect(resolveInventoryAccountByItemType('stationery', ACCOUNTS, 'internal')).toBe('acc-11420');
      expect(resolveInventoryAccountByItemType('stationery', ACCOUNTS, 'both')).toBe('acc-11420');
    });

    it('Stationery + sellable → 11410', () => {
      expect(resolveInventoryAccountByItemType('stationery', ACCOUNTS, 'sellable')).toBe('acc-11410');
    });

    it('Product still → 11410 at mapping level (eligibility gate blocks postings separately)', () => {
      expect(resolveInventoryAccountByItemType('product', ACCOUNTS)).toBe('acc-11410');
    });
  });

  describe('getInventoryAccountForItem (eligibility-first, role-aware)', () => {
    it('Raw Material → 11420', () => {
      expect(getInventoryAccountForItem({ type: 'Raw Material' })).toBe('11420');
    });

    it('Stationery + internal → 11420', () => {
      expect(getInventoryAccountForItem({ type: 'Stationery', inventoryRole: 'internal' })).toBe('11420');
    });

    it('Stationery + both → 11420', () => {
      expect(getInventoryAccountForItem({ type: 'Stationery', inventoryRole: 'both' })).toBe('11420');
    });

    it('Stationery + missing role → 11420', () => {
      expect(getInventoryAccountForItem({ type: 'Stationery' })).toBe('11420');
    });

    it('Stationery + unknown role → 11420', () => {
      expect(getInventoryAccountForItem({ type: 'Stationery', inventoryRole: 'mystery' })).toBe('11420');
    });

    it('Stationery + sellable → 11410', () => {
      expect(getInventoryAccountForItem({ type: 'Stationery', inventoryRole: 'sellable' })).toBe('11410');
    });

    it('Product → no inventory posting', () => {
      expect(isInventoryBearingItem({ type: 'Product' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Product', inventoryRole: 'sellable' })).toBeNull();
    });

    it('Service → no inventory posting', () => {
      expect(isInventoryBearingItem({ type: 'Service' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Service' })).toBeNull();
    });

    it('Printing Service → no inventory posting', () => {
      expect(isInventoryBearingItem({ type: 'Printing Service' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Printing Service' })).toBeNull();
    });

    it('Finished Good → no inventory posting under current workflow', () => {
      expect(isInventoryBearingItem({ type: 'Finished Good' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Finished Good' })).toBeNull();
    });
  });

  describe('purchase/receipt posting level (resolveInventoryAccountFromItems)', () => {
    it('sellable Stationery purchase → 11410', () => {
      const items = [{ id: 'S1', type: 'Stationery', inventoryRole: 'sellable', stock: 10, cost: 100 }];
      expect(resolveInventoryAccountFromItems(items, ACCOUNTS)).toBe('acc-11410');
    });

    it('internal Stationery purchase → 11420', () => {
      const items = [{ id: 'S1', type: 'Stationery', inventoryRole: 'internal', stock: 10, cost: 100 }];
      expect(resolveInventoryAccountFromItems(items, ACCOUNTS)).toBe('acc-11420');
    });

    it('roleless Stationery purchase → 11420 (unchanged)', () => {
      const items = [{ id: 'S1', type: 'Stationery', stock: 10, cost: 100 }];
      expect(resolveInventoryAccountFromItems(items, ACCOUNTS)).toBe('acc-11420');
    });
  });

  describe('COGS symmetry (calculateCogsLegsPerInventoryAccount)', () => {
    const sourceFor = (item: any) => [item];
    const resolveId = (item: any) => item.id;

    it('sellable Stationery sale relieves 11410', async () => {
      const item = { id: 'S1', type: 'Stationery', inventoryRole: 'sellable', quantity: 2, cost: 100 };
      const legs = await calculateCogsLegsPerInventoryAccount([item], sourceFor(item), resolveId, ACCOUNTS, null);
      expect(legs).toHaveLength(1);
      expect(legs[0].inventoryAccountCode).toBe('11410');
      expect(legs[0].amount).toBe(200);
    });

    it('internal Stationery sale relieves 11420', async () => {
      const item = { id: 'S1', type: 'Stationery', inventoryRole: 'internal', quantity: 2, cost: 100 };
      const legs = await calculateCogsLegsPerInventoryAccount([item], sourceFor(item), resolveId, ACCOUNTS, null);
      expect(legs).toHaveLength(1);
      expect(legs[0].inventoryAccountCode).toBe('11420');
      expect(legs[0].amount).toBe(200);
    });

    it('Product sale emits no inventory leg', async () => {
      const item = { id: 'P1', type: 'Product', quantity: 2, cost: 100 };
      const legs = await calculateCogsLegsPerInventoryAccount([item], sourceFor(item), resolveId, ACCOUNTS, null);
      expect(legs).toHaveLength(0);
    });
  });
});
