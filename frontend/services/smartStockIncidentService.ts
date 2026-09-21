/**
 * Smart Stock Incident Service — read-only analysis of bulkId SMART-1789588940379-egoshg.
 *
 * This service identifies items affected by the bulk seeding job and documents:
 *   - Quantity immediately before seeding (if recoverable; otherwise UNKNOWN)
 *   - The +500 seed quantity applied
 *   - Subsequent movements after seeding
 *   - Current quantity
 *   - Current warehouse quantity
 *   - Current calculated value
 *   - Whether item is inventory-bearing
 *   - Inventory account
 *
 * CRITICAL RULES:
 * - Does NOT infer original quantity if cannot be recovered — mark UNKNOWN
 * - Never substitutes zero
 * - Never substitutes seeded quantity as opening inventory
 *
 * OPENING BALANCE SEPARATION:
 * The conceptual model for inventory is:
 *   Verified opening inventory
 *   + Purchases / receipts
 *   ---------------------
 *   Inventory issues / COGS
 *   ± legitimate adjustments
 *   =========================
 *   Expected current inventory
 *
 * Compare expected current inventory against verified physical inventory.
 * Do NOT treat today's physical count automatically as opening balance.
 * Do NOT reuse old K41,868,000 figure automatically.
 * Do NOT use seeded K222,306,800 as inventory valuation.
 */

import { isInventoryBearingItem, resolveInventoryGLAccountCode, resolveInventoryCostPerUnit, resolveWarehouseQuantity, resolveInventoryQuantity } from '../utils/inventoryNormalization';

export interface SmartStockIncidentItem {
  itemId: string;
  name: string;
  sku: string;
  type: string;
  affectedByBulkId: boolean;
  quantityBeforeSeeding: number | null; // null = UNKNOWN
  seedQuantity: number;
  subsequentMovements: number;
  currentQuantity: number;
  currentWarehouseQuantity: number;
  currentCalculatedValue: number;
  isInventoryBearing: boolean;
  inventoryAccount: string | null;
  bulkId: string | null;
  note: string;
}

export interface SmartStockIncidentReport {
  bulkId: string;
  affectedItems: SmartStockIncidentItem[];
  unaffectedItems: SmartStockIncidentItem[];
  totalAffected: number;
  totalSeedQuantity: number;
  totalCurrentQuantity: number;
  totalCurrentWarehouseQuantity: number;
  totalCurrentValue: number;
  inventoryBearingCount: number;
  nonInventoryBearingCount: number;
  unrecoverableQuantityCount: number;
}

const TARGET_BULK_ID = 'SMART-1789588940379-egoshg';
const SEED_QUANTITY = 500;

function extractBulkId(item: any): string | null {
  const candidates = [
    item.bulkId,
    item.bulk_id,
    item.originBatchId,
    item.origin_batch_id,
    item.operationId,
    item.operation_id,
    item.adjustmentSnapshots && item.adjustmentSnapshots[0]?.bulkId,
  ];
  for (const c of candidates) {
    if (c && String(c).includes('SMART-')) return String(c);
  }
  return null;
}

function extractSeedQuantity(item: any): number {
  const candidates = [
    item.seedQuantity,
    item.seed_quantity,
    item.adjustmentQuantity,
    item.adjustment_quantity,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return SEED_QUANTITY;
}

function extractSubsequentMovements(item: any): number {
  const candidates = [
    item.subsequentMovements,
    item.subsequent_movements,
    item.postAdjustmentMovements,
    item.post_adjustment_movements,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function extractQuantityBeforeSeeding(item: any): number | null {
  const candidates = [
    item.quantityBeforeSeeding,
    item.quantity_before_seeding,
    item.preAdjustmentStock,
    item.pre_adjustment_stock,
    item.previousStock,
    item.previous_stock,
    item.originalQuantity,
    item.original_quantity,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // If item has adjustment history, attempt to reconstruct
  if (Array.isArray(item.adjustmentSnapshots) && item.adjustmentSnapshots.length > 0) {
    const sorted = [...item.adjustmentSnapshots].sort((a: any, b: any) =>
      String(a.date || '').localeCompare(String(b.date || ''))
    );
    const first = sorted[0];
    const afterFirst = Number(first.quantityAfter || first.quantity_after || first.newQuantity || 0);
    const delta = Number(first.delta || first.quantityChange || 0);
    if (Number.isFinite(afterFirst) && Number.isFinite(delta)) {
      const before = afterFirst - delta;
      if (before >= 0) return before;
    }
  }
  return null; // UNKNOWN
}

export function analyzeSmartStockIncident(items: any[]): SmartStockIncidentReport {
  const affectedItems: SmartStockIncidentItem[] = [];
  const unaffectedItems: SmartStockIncidentItem[] = [];

  for (const raw of items || []) {
    const bulkId = extractBulkId(raw);
    const isAffected = bulkId === TARGET_BULK_ID;

    const quantityBeforeSeeding = isAffected ? extractQuantityBeforeSeeding(raw) : null;
    const seedQuantity = isAffected ? extractSeedQuantity(raw) : 0;
    const subsequentMovements = isAffected ? extractSubsequentMovements(raw) : 0;
    const currentQuantity = resolveInventoryQuantity(raw);
    const currentWarehouseQuantity = resolveWarehouseQuantity(raw);
    const costPerUnit = resolveInventoryCostPerUnit(raw);
    const isInventoryBearing = isInventoryBearingItem(raw);
    const inventoryAccount = isInventoryBearing ? resolveInventoryGLAccountCode(raw) : null;
    const currentCalculatedValue = isInventoryBearing ? round2Local(currentQuantity * costPerUnit) : 0;

    const incidentItem: SmartStockIncidentItem = {
      itemId: String(raw.id || ''),
      name: String(raw.name || ''),
      sku: String(raw.sku || raw.code || ''),
      type: String(raw.type || raw._rawType || ''),
      affectedByBulkId: isAffected,
      quantityBeforeSeeding: quantityBeforeSeeding,
      seedQuantity,
      subsequentMovements,
      currentQuantity,
      currentWarehouseQuantity,
      currentCalculatedValue,
      isInventoryBearing,
      inventoryAccount,
      bulkId,
      note: quantityBeforeSeeding === null
        ? 'UNKNOWN — original quantity cannot be recovered from available data'
        : isAffected
          ? `Affected by ${TARGET_BULK_ID}; seed +${seedQuantity} applied`
          : 'Not affected by bulk seeding incident',
    };

    if (isAffected) {
      affectedItems.push(incidentItem);
    } else {
      unaffectedItems.push(incidentItem);
    }
  }

  const totalAffected = affectedItems.length;
  const totalSeedQuantity = affectedItems.reduce((sum, i) => sum + i.seedQuantity, 0);
  const totalCurrentQuantity = affectedItems.reduce((sum, i) => sum + i.currentQuantity, 0);
  const totalCurrentWarehouseQuantity = affectedItems.reduce((sum, i) => sum + i.currentWarehouseQuantity, 0);
  const totalCurrentValue = affectedItems.reduce((sum, i) => sum + i.currentCalculatedValue, 0);
  const inventoryBearingCount = affectedItems.filter(i => i.isInventoryBearing).length;
  const nonInventoryBearingCount = affectedItems.filter(i => !i.isInventoryBearing).length;
  const unrecoverableQuantityCount = affectedItems.filter(i => i.quantityBeforeSeeding === null).length;

  return {
    bulkId: TARGET_BULK_ID,
    affectedItems,
    unaffectedItems,
    totalAffected,
    totalSeedQuantity,
    totalCurrentQuantity,
    totalCurrentWarehouseQuantity,
    totalCurrentValue,
    inventoryBearingCount,
    nonInventoryBearingCount,
    unrecoverableQuantityCount,
  };
}

function round2Local(n: number): number {
  return Math.round(n * 100) / 100;
}
