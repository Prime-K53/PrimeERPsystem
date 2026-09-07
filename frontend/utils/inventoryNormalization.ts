import { normalizeInventoryItemPricing } from './pricing';
import type { Item } from '../types';

interface ProductionInventoryData {
  name: string;
  material: string;
  quantity: number;
  cost_per_unit: number;
}

interface ProductionInventoryItem {
  id: string;
  data: ProductionInventoryData;
}

function isProductionItem(item: any): item is ProductionInventoryItem {
  return item && item.data && typeof item.data === 'object' && 'name' in item.data;
}

function flattenProductionItem(item: ProductionInventoryItem): Partial<Item> {
  const { data } = item;
  return {
    ...item,
    id: item.id,
    name: data.name,
    type: data.material,
    quantity: data.quantity,
    stock: data.quantity,
    cost_per_unit: data.cost_per_unit,
    cost: data.cost_per_unit,
    costPrice: data.cost_per_unit,
    selling_price: 0,
    price: 0,
  };
}

export function normalizeInventoryItems(items: any[]): Item[] {
  if (!items || items.length === 0) return [];

  return items.map((item) => {
    if (isProductionItem(item)) {
      return normalizeInventoryItemPricing(flattenProductionItem(item) as Item);
    }
    if (item.type) {
      return item as Item;
    }
    return normalizeInventoryItemPricing(item as Item);
  });
}

export function normalizeInventoryItemForOpening(item: any): Item | null {
  if (!item) return null;

  if (isProductionItem(item)) {
    return normalizeInventoryItemPricing(flattenProductionItem(item) as Item);
  }
  if (item.type) {
    return item as Item;
  }
  return normalizeInventoryItemPricing(item as Item);
}

export function hasInventoryItems(items: any[]): boolean {
  return items != null && items.length > 0;
}

export function getInventoryItemCount(items: any[]): number {
  return items ? items.length : 0;
}
