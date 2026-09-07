import { describe, expect, it } from 'vitest';
import { normalizeInventoryItemPricing, normalizeInventoryItemType } from '../../utils/pricing';
import { normalizeInventoryItems, normalizeInventoryItemForOpening, hasInventoryItems, getInventoryItemCount } from '../../utils/inventoryNormalization';
import type { Item } from '../../types';

describe('inventory item normalization', () => {
  it('maps backend inventory type values to frontend classifications', () => {
    expect(normalizeInventoryItemType('material')).toBe('Raw Material');
    expect(normalizeInventoryItemType('product')).toBe('Product');
    expect(normalizeInventoryItemType('stationery')).toBe('Stationery');
    expect(normalizeInventoryItemType('service')).toBe('Service');
    expect(normalizeInventoryItemType(undefined, 'printing_service')).toBe('Service');
  });

  it('hydrates stock and canonical type from backend-shaped rows', () => {
    const item = normalizeInventoryItemPricing({
      id: 'itm-1',
      name: 'Bond Paper',
      sku: 'RAW-001',
      type: 'material',
      quantity: 25,
      cost_per_unit: 12,
      selling_price: 0,
    } as unknown as Item);

    expect(item.type).toBe('Raw Material');
    expect(item.stock).toBe(25);
    expect(item.quantity).toBe(25);
    expect(item.cost).toBe(12);
    expect(item.costPrice).toBe(12);
  });

  it('normalizes production-shaped items with nested data.data.* structure', () => {
    const productionItem = {
      id: 'prod-001',
      data: {
        name: 'Bond Paper',
        material: 'material',
        quantity: 100,
        cost_per_unit: 5.50,
      },
    };

    const result = normalizeInventoryItemForOpening(productionItem);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('prod-001');
    expect(result!.name).toBe('Bond Paper');
    expect(result!.type).toBe('Raw Material');
    expect(result!.stock).toBe(100);
    expect(result!.quantity).toBe(100);
    expect(result!.cost).toBe(5.50);
    expect(result!.costPrice).toBe(5.50);
  });

  it('normalizes an array of production-shaped items', () => {
    const productionItems = [
      { id: 'prod-001', data: { name: 'Paper', material: 'material', quantity: 100, cost_per_unit: 5 } },
      { id: 'prod-002', data: { name: 'Toner', material: 'consumable', quantity: 50, cost_per_unit: 20 } },
    ];

    const results = normalizeInventoryItems(productionItems);

    expect(results).toHaveLength(2);
    expect(results[0].type).toBe('Raw Material');
    expect(results[0].stock).toBe(100);
    expect(results[0].cost).toBe(5);
    expect(results[1].type).toBe('Raw Material');
    expect(results[1].stock).toBe(50);
    expect(results[1].cost).toBe(20);
  });

  it('passes through already-flat items unchanged', () => {
    const flatItems = [
      { id: 'flat-001', name: 'Book', type: 'Product', stock: 50, cost: 10, cost_per_unit: 10, selling_price: 0, price: 0 },
    ];

    const results = normalizeInventoryItems(flatItems);

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('Product');
    expect(results[0].stock).toBe(50);
    expect(results[0].cost).toBe(10);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeInventoryItems([])).toEqual([]);
    expect(normalizeInventoryItems(null)).toEqual([]);
    expect(normalizeInventoryItems(undefined)).toEqual([]);
  });

  it('hasInventoryItems returns correct boolean', () => {
    expect(hasInventoryItems([{ id: '1' }])).toBe(true);
    expect(hasInventoryItems([])).toBe(false);
    expect(hasInventoryItems(null)).toBe(false);
    expect(hasInventoryItems(undefined)).toBe(false);
  });

  it('getInventoryItemCount returns correct count', () => {
    expect(getInventoryItemCount([{ id: '1' }, { id: '2' }])).toBe(2);
    expect(getInventoryItemCount([])).toBe(0);
    expect(getInventoryItemCount(null)).toBe(0);
  });

  it('preserves status field from production items', () => {
    const productionItem = {
      id: 'prod-001',
      status: 'Active',
      data: {
        name: 'Paper',
        material: 'material',
        quantity: 100,
        cost_per_unit: 5,
      },
    };

    const result = normalizeInventoryItemForOpening(productionItem);

    expect(result!.status).toBe('Active');
  });
});
