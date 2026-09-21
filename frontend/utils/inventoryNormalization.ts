import { normalizeInventoryItemPricing, resolveStoredCost } from './pricing';
import { computeOwnBalances } from '../services/accountingEngine';
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
      const normalized = normalizeInventoryItemPricing(flattenProductionItem(item) as Item);
      // Preserve the raw material token: accounting classification must see
      // the source value, never a defaulted canonical type.
      return { ...normalized, _rawType: item.data?.material, _rawClassification: undefined } as Item;
    }
    // Always run full pricing normalization so cost/type/stock resolve
    // through one deterministic rule no matter which historical field the
    // record carries (cost, costPrice, cost_price, cost_per_unit, …).
    const normalized = normalizeInventoryItemPricing(item as Item);
    return {
      ...normalized,
      _rawType: (item as any).type,
      _rawClassification: (item as any).classification,
    } as Item;
  });
}

export function normalizeInventoryItemForOpening(item: any): Item | null {
  if (!item) return null;

  if (isProductionItem(item)) {
    const normalized = normalizeInventoryItemPricing(flattenProductionItem(item) as Item);
    return { ...normalized, _rawType: item.data?.material, _rawClassification: undefined } as Item;
  }
  const normalized = normalizeInventoryItemPricing(item as Item);
  return {
    ...normalized,
    _rawType: (item as any).type,
    _rawClassification: (item as any).classification,
  } as Item;
}

export function hasInventoryItems(items: any[]): boolean {
  return items != null && items.length > 0;
}

export function getInventoryItemCount(items: any[]): number {
  return items ? items.length : 0;
}

// ─── Canonical inventory economics (single source of truth) ───────────────
// Every accounting consumer (opening inventory, COGS, reconciliation,
// sync, UI valuation) must resolve cost / quantity / GL account through
// these helpers so all supported record shapes value identically.
//
// Inventory value is ALWAYS quantity × cost (never Selling Price).

/** Canonical 5-digit inventory GL codes. */
export const INVENTORY_GL_CODES = {
  merchandise: '11410',
  rawMaterials: '11420',
  finishedGoods: '11430',
  parent: '11400',
} as const;

/** Reasons an item contributes no inventory value (always reported, never silent). */
export type InventoryExclusionReason =
  | 'SERVICE_ITEM'
  | 'NON_STOCK_TYPE'
  | 'DELETED_ITEM'
  | 'NEGATIVE_STOCK'
  | 'ZERO_COST'
  | 'MISSING_COST'
  | 'UNMAPPED_TYPE';

/**
 * Authoritative unit cost: deterministic preference across all historical
 * cost representations (snapshot baseCost → cost_price → cost_per_unit →
 * cost → costPrice). Never Selling Price.
 */
export function resolveInventoryCostPerUnit(item: any): number {
  if (!item) return 0;
  if (isProductionItem(item)) {
    const cpu = Number(item.data?.cost_per_unit);
    return Number.isFinite(cpu) ? cpu : 0;
  }
  const cost = Number(resolveStoredCost(item));
  return Number.isFinite(cost) ? cost : 0;
}

/** Whether any cost field is present on the record at all. */
export function hasInventoryCostField(item: any): boolean {
  if (!item) return false;
  if (isProductionItem(item)) return item.data?.cost_per_unit !== undefined && item.data?.cost_per_unit !== null;
  const carriers = [
    (item as any).cost,
    (item as any).cost_price,
    (item as any).cost_per_unit,
    (item as any).costPrice,
    (item as any).normalizedCP,
    (item as any).smartPricingSnapshot?.baseCost,
  ];
  return carriers.some((v) => v !== undefined && v !== null && v !== '');
}

/** Authoritative on-hand quantity (stock preferred, quantity fallback). */
export function resolveInventoryQuantity(item: any): number {
  if (!item) return 0;
  const source = isProductionItem(item) ? item.data : item;
  const qty = Number(source?.stock ?? source?.quantity ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

/** Authoritative warehouse quantity (locationStock sum, fallback to stock). */
export function resolveWarehouseQuantity(item: any): number {
  if (!item) return 0;
  const source = isProductionItem(item) ? item.data : item;
  const locationStock = source?.locationStock;
  if (Array.isArray(locationStock) && locationStock.length > 0) {
    const sum = locationStock.reduce((acc: number, ls: any) => acc + Number(ls?.quantity ?? 0), 0);
    return Number.isFinite(sum) ? sum : 0;
  }
  return resolveInventoryQuantity(item);
}

function tokenizeInventoryType(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Raw (pre-normalization) type token when the normalizer preserved it. */
function rawTypeOf(item: any): unknown {
  if (!item) return undefined;
  if (isProductionItem(item)) return item.data?.material;
  return (item as any)._rawType ?? (item as any).type;
}

/** Raw (pre-normalization) classification token when preserved. */
function rawClassificationOf(item: any): unknown {
  if (!item) return undefined;
  if (isProductionItem(item)) return undefined;
  return (item as any)._rawClassification ?? (item as any).classification;
}

/**
 * AUTHORITATIVE INVENTORY-ELIGIBILITY RULE (Prime Printing business model).
 *
 * Only Raw Material and Stationery are stock-bearing inventory items.
 * Product (produced from Raw Materials through BOM/production, never
 * stocked) and Service (no stock quantity, no inventory asset) are NOT
 * inventory-eligible.
 *
 * Derived SOLELY from the authoritative item type — never from whether a
 * record happens to contain stock/quantity/cost fields, an ID prefix
 * (e.g. `FG-`), or an inventory account mapping.
 *
 * Raw Material → true | Stationery → true | Product → false | Service → false
 */
export function isInventoryBearingItem(item: any): boolean {
  if (!item) return false;
  const tokens = [tokenizeInventoryType(rawTypeOf(item)), tokenizeInventoryType(rawClassificationOf(item))].filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => t.includes('service'))) return false;
  return tokens.some((t) =>
    t.includes('stationery') ||
    t.includes('stationaries') ||
    t.includes('raw') ||
    t.includes('material') ||
    t.includes('consumable')
  );
}

/**
 * Inventory account for one item, eligibility-first.
 *
 * Invariant: non-stock items (Product/Service/...) resolve to NO account,
 * carry NO inventory value, and have NO applicable stock — even if a legacy
 * mapping would otherwise place them in an inventory account (e.g. 11410).
 */
export function getInventoryAccountForItem(item: any): string | null {
  if (!isInventoryBearingItem(item)) return null;
  return resolveInventoryGLAccountCode(item);
}

/**
 * Canonical GL mapping for one inventory item.
 * Returns the 5-digit code, or null when the item must NOT post to
 * inventory (services) or cannot be mapped (unmapped type — reported, never
 * silently defaulted to 11410).
 *
 * NOTE: this is the type→account map only. Consumers that decide whether an
 * item participates in inventory at all MUST gate on isInventoryBearingItem()
 * (or getInventoryAccountForItem()) first — a mapping result alone must never
 * make a non-stock Product/Service inventory-bearing.
 *
 * Mapping (checked against raw type first, then classification):
 * - service-like           → null (SERVICE_ITEM, excluded upstream)
 * - finished good(s)       → 11430 Finished Goods
 * - product / merchandise  → 11410 Merchandise Inventory
 * - raw / material / consumable / stationery → 11420 Raw Materials
 */
export function resolveInventoryGLAccountCode(item: any): string | null {
  if (!item) return null;
  const rawType = rawTypeOf(item);
  const classification = rawClassificationOf(item);
  const tokens = [tokenizeInventoryType(rawType), tokenizeInventoryType(classification)].filter(Boolean);

  if (tokens.some((t) => t.includes('service'))) return null;
  if (tokens.some((t) => t.includes('finished good') || t.includes('finished product'))) return INVENTORY_GL_CODES.finishedGoods;
  if (tokens.some((t) => t.includes('product') || t.includes('merchandise'))) return INVENTORY_GL_CODES.merchandise;
  if (
    tokens.some((t) =>
      t.includes('raw') || t.includes('material') || t.includes('consumable') || t.includes('stationery') || t.includes('stationaries')
    )
  ) {
    return INVENTORY_GL_CODES.rawMaterials;
  }
  return null;
}

/** Whether the record is a non-stock service (never valued as inventory). */
export function isInventoryServiceItem(item: any): boolean {
  if (!item) return false;
  const rawType = rawTypeOf(item);
  const classification = rawClassificationOf(item);
  const tokens = [tokenizeInventoryType(rawType), tokenizeInventoryType(classification)].filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.some((t) => t.includes('service'));
}

/** Whether the record is soft-deleted / voided (never valued). */
export function isInventoryDeletedItem(item: any): boolean {
  if (!item) return true;
  const status = String((item as any).status ?? '').trim().toLowerCase();
  return status === 'deleted' || status === 'void' || status === 'voided' || status === 'cancelled';
}

export interface ClassifiedInventoryItem {
  itemId: string;
  name: string;
  sku: string;
  rawType: string;
  classification: string;
  quantity: number;
  warehouseQuantity: number;
  costPerUnit: number;
  inventoryValue: number;
  expectedAccount: string | null;
  included: boolean;
  exclusionReason: InventoryExclusionReason | null;
}

/**
 * Classify one raw inventory record: resolve quantity × cost, map the GL
 * account, and explain inclusion/exclusion. Read-only.
 */
export function classifyInventoryItem(rawItem: any): ClassifiedInventoryItem {
  const source = isProductionItem(rawItem) ? { ...rawItem, ...rawItem.data } : (rawItem || {});
  const itemId = String(source.id ?? rawItem?.id ?? '');
  const name = String(source.name ?? '');
  const sku = String(source.sku ?? source.code ?? '');
  const rawType = String(rawTypeOf(rawItem) ?? '');
  const classification = String(rawClassificationOf(rawItem) ?? '');

  const quantity = resolveInventoryQuantity(rawItem);
  const warehouseQuantity = resolveWarehouseQuantity(rawItem);
  const costPerUnit = resolveInventoryCostPerUnit(rawItem);

  let included = true;
  let exclusionReason: InventoryExclusionReason | null = null;
  let expectedAccount: string | null = null;

  if (isInventoryDeletedItem(rawItem)) {
    included = false;
    exclusionReason = 'DELETED_ITEM';
  } else if (isInventoryServiceItem(rawItem)) {
    included = false;
    exclusionReason = 'SERVICE_ITEM';
  } else if (!isInventoryBearingItem(rawItem)) {
    // Prime Printing rule: Product (and any other non Raw/Stationery type)
    // is never stock-bearing, even when legacy fields carry qty/cost or a
    // legacy mapping would place it in an inventory account (e.g. 11410).
    included = false;
    exclusionReason = 'NON_STOCK_TYPE';
  } else if (quantity < 0) {
    included = false;
    exclusionReason = 'NEGATIVE_STOCK';
  } else {
    expectedAccount = resolveInventoryGLAccountCode(rawItem);
    if (!expectedAccount) {
      included = false;
      exclusionReason = 'UNMAPPED_TYPE';
    } else if (quantity === 0) {
      included = true; // contributes zero; kept visible, not silently dropped
    } else if (!hasInventoryCostField(rawItem)) {
      included = false;
      exclusionReason = 'MISSING_COST';
    } else if (!(costPerUnit > 0)) {
      included = false;
      exclusionReason = 'ZERO_COST';
    }
  }

  return {
    itemId,
    name,
    sku,
    rawType,
    classification,
    quantity,
    warehouseQuantity,
    costPerUnit,
    inventoryValue: included ? Math.round(quantity * costPerUnit * 100) / 100 : 0,
    expectedAccount,
    included,
    exclusionReason,
  };
}

export interface InventoryValuationReconciliation {
  items: ClassifiedInventoryItem[];
  eligibleItems: ClassifiedInventoryItem[];
  excludedItems: ClassifiedInventoryItem[];
  excludedByReason: Record<string, number>;
  byCategory: {
    merchandise: { accountCode: string; quantity: number; warehouseQuantity: number; value: number; itemCount: number };
    rawMaterials: { accountCode: string; quantity: number; warehouseQuantity: number; value: number; itemCount: number };
    finishedGoods: { accountCode: string; quantity: number; warehouseQuantity: number; value: number; itemCount: number };
  };
  totalInventoryValue: number;
  glInventoryByAccount: Record<string, number>;
  glInventoryTotal: number;
  difference: number;
  isReconciled: boolean;
}

function round2Local(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Read-only inventory ↔ GL reconciliation (Phase 2/18 diagnostic).
 * Never creates journals. GL side uses posted entries only.
 *
 * INVENTORY VALUATION RULE:
 * - Calculates inventory independently of Account.balance field.
 * - For every inventory-bearing item shows: Item, Item type, Stock quantity,
 *   Warehouse quantity, Canonical cost, Calculated inventory value, Inventory account.
 * - Aggregates: 11410, 11420, 11430, Total Inventory.
 * - Separately calculates GL balances: Opening balance + ledger debits - ledger credits = GL balance.
 * - Compares PHYSICAL/CURRENT STOCK VALUATION versus INVENTORY GL.
 * - Does NOT change either side.
 */
export function reconcileInventoryValuation(
  rawItems: any[],
  accounts: any[],
  ledger: any[]
): InventoryValuationReconciliation {
  const items = (rawItems || []).map(classifyInventoryItem);
  const eligibleItems = items.filter((i) => i.included);
  const excludedItems = items.filter((i) => !i.included);

  const excludedByReason: Record<string, number> = {};
  for (const item of excludedItems) {
    const reason = item.exclusionReason || 'other';
    excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
  }

  const bucket = (code: string) => ({
    accountCode: code,
    quantity: 0,
    warehouseQuantity: 0,
    value: 0,
    itemCount: 0,
  });
  const byCategory = {
    merchandise: bucket(INVENTORY_GL_CODES.merchandise),
    rawMaterials: bucket(INVENTORY_GL_CODES.rawMaterials),
    finishedGoods: bucket(INVENTORY_GL_CODES.finishedGoods),
  };
  const bucketFor = (code: string | null) =>
    code === INVENTORY_GL_CODES.finishedGoods
      ? byCategory.finishedGoods
      : code === INVENTORY_GL_CODES.rawMaterials
        ? byCategory.rawMaterials
        : byCategory.merchandise;

  let totalInventoryValue = 0;
  for (const item of eligibleItems) {
    const slot = bucketFor(item.expectedAccount);
    slot.quantity = round2Local(slot.quantity + item.quantity);
    slot.warehouseQuantity = round2Local(slot.warehouseQuantity + item.warehouseQuantity);
    slot.value = round2Local(slot.value + item.inventoryValue);
    slot.itemCount += 1;
    totalInventoryValue = round2Local(totalInventoryValue + item.inventoryValue);
  }

  // GL side: own (pre-rollup) normal-positive balances of the three posting
  // accounts, posted entries only — each balance counted exactly once.
  const glInventoryByAccount: Record<string, number> = {
    [INVENTORY_GL_CODES.merchandise]: 0,
    [INVENTORY_GL_CODES.rawMaterials]: 0,
    [INVENTORY_GL_CODES.finishedGoods]: 0,
  };
  if (accounts && accounts.length > 0) {
    const own = computeOwnBalances(accounts as any[], (ledger || []) as any[]);
    for (const acc of accounts) {
      const code = String((acc as any).account_number || (acc as any).code || '');
      if (code in glInventoryByAccount) {
        const id = String((acc as any).id ?? '');
        glInventoryByAccount[code] = round2Local(glInventoryByAccount[code] + (own[id] || 0));
      }
    }
  }

  const glInventoryTotal = round2Local(
    glInventoryByAccount[INVENTORY_GL_CODES.merchandise] +
      glInventoryByAccount[INVENTORY_GL_CODES.rawMaterials] +
      glInventoryByAccount[INVENTORY_GL_CODES.finishedGoods]
  );
  const difference = round2Local(totalInventoryValue - glInventoryTotal);

  return {
    items,
    eligibleItems,
    excludedItems,
    excludedByReason,
    byCategory,
    totalInventoryValue,
    glInventoryByAccount,
    glInventoryTotal,
    difference,
    isReconciled: Math.abs(difference) < 0.01,
  };
}

/** Human-readable rendering of reconcileInventoryValuation (dev/test diagnostics). */
export function formatInventoryReconciliation(
  report: InventoryValuationReconciliation,
  currencySymbol = 'K'
): string {
  const money = (n: number) => `${currencySymbol}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const lines = [
    '========================================',
    'INVENTORY VALUATION RECONCILIATION',
    '========================================',
    '',
    `Items found:                    ${report.items.length}`,
    `Eligible items:                 ${report.eligibleItems.length}`,
    `Excluded items:                 ${report.excludedItems.length}`,
    ...Object.entries(report.excludedByReason).map(([reason, count]) => `  - ${reason}: ${count}`),
    '',
    'Merchandise:',
    `  Quantity:                     ${report.byCategory.merchandise.quantity}`,
    `  Warehouse Qty:                ${report.byCategory.merchandise.warehouseQuantity}`,
    `  Value:                        ${money(report.byCategory.merchandise.value)}`,
    '',
    'Raw Materials:',
    `  Quantity:                     ${report.byCategory.rawMaterials.quantity}`,
    `  Warehouse Qty:                ${report.byCategory.rawMaterials.warehouseQuantity}`,
    `  Value:                        ${money(report.byCategory.rawMaterials.value)}`,
    '',
    'Finished Goods:',
    `  Quantity:                     ${report.byCategory.finishedGoods.quantity}`,
    `  Warehouse Qty:                ${report.byCategory.finishedGoods.warehouseQuantity}`,
    `  Value:                        ${money(report.byCategory.finishedGoods.value)}`,
    '',
    `TOTAL INVENTORY VALUE:          ${money(report.totalInventoryValue)}`,
    '',
    '========================================',
    'GL INVENTORY',
    '========================================',
    '',
    `11410 Merchandise Inventory     ${money(report.glInventoryByAccount['11410'] || 0)}`,
    `11420 Raw Materials             ${money(report.glInventoryByAccount['11420'] || 0)}`,
    `11430 Finished Goods            ${money(report.glInventoryByAccount['11430'] || 0)}`,
    '',
    `TOTAL GL INVENTORY:             ${money(report.glInventoryTotal)}`,
    '',
    '========================================',
    `DIFFERENCE:                     ${money(report.difference)}`,
    `RECONCILED:                     ${report.isReconciled ? 'YES' : 'NO'}`,
    '========================================',
  ];
  return lines.join('\n');
}
