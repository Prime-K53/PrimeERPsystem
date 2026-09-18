/**
 * Purchase costing helpers (ERP purchasing only).
 *
 * A purchase-order line carries its OWN actual purchase/unit price. The
 * inventory master's cost fields (`cost` / `costPrice` / `normalizedCP`) are
 * the default/reference purchase price used to seed new PO lines and the
 * current weighted-average carrying value — they must never silently replace
 * a manually entered PO line price during save, reload, approval, receiving,
 * document generation, or synchronization.
 *
 * Cost basis flow (existing weighted moving-average policy, preserved):
 *   PO line unit price (actual supplier price)
 *     -> receiving totalCost = qty x PO line unit price
 *     -> purchase lot recorded at that actual unit cost
 *     -> master cost re-averaged: ((oldCost x oldStock) + (unitCost x qty)) / newStock
 *     -> sale COGS reads the line snapshot, falling back to the master
 *        (i.e. the average that already embeds the actual receipt cost).
 *
 * No Portal code may import this module.
 */

const toPositiveNumber = (value: unknown): number | undefined => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
};

/**
 * Resolve the actual purchase unit price carried by a PO / GRN line.
 * First positive wins, cost aliases before display-price aliases, so a sales
 * `price` (which may embed margin) can never shadow the recorded purchase
 * cost, while legacy lines that only carry `price` still resolve.
 */
export function resolvePoLineUnitCost(line: any): number {
  if (!line || typeof line !== 'object') return 0;
  return (
    toPositiveNumber(line.cost) ??
    toPositiveNumber(line.cost_price) ??
    toPositiveNumber(line.costPrice) ??
    toPositiveNumber(line.cost_per_unit) ??
    toPositiveNumber(line.unitCost) ??
    toPositiveNumber(line.unit_cost) ??
    toPositiveNumber(line.unitPrice) ??
    toPositiveNumber(line.unit_price) ??
    toPositiveNumber(line.price) ??
    0
  );
}

/** Alias kept for receiving-code readability: same PO actual-cost rule. */
export function resolveReceiptUnitCost(line: any): number {
  return resolvePoLineUnitCost(line);
}

export function resolvePoLineQuantity(line: any): number {
  if (!line || typeof line !== 'object') return 0;
  const qty = Number(line.quantity ?? line.qty ?? line.quantityReceived ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

/** Extended amount for a PO line: quantity x actual purchase unit price. */
export function purchaseLineTotal(line: any): number {
  return resolvePoLineQuantity(line) * resolvePoLineUnitCost(line);
}

/**
 * Normalize a PO line for persistence so every consumer (PO form, PO
 * details, PO document/PDF, PO totals, receiving workflow, stock movement,
 * supplier-facing documentation) reads the SAME actual purchase price
 * regardless of which alias it looks at. Non-price fields pass through
 * untouched; historical records are never rewritten by this helper.
 */
export function normalizePurchaseLine<T extends Record<string, any>>(line: T): T {
  const unitCost = resolvePoLineUnitCost(line);
  return {
    ...line,
    cost: unitCost,
    cost_price: unitCost,
    unitPrice: unitCost,
    price: unitCost,
  };
}

/**
 * Weighted moving-average carrying cost after receiving `receivedQty` units
 * at `receivedUnitCost` on top of `oldStock` units carried at `oldCost`.
 * Identical math to the GRN verification path; sales never adjust the
 * average (it moves on receipts only). Returns `receivedUnitCost` when there
 * is no prior stock, and `oldCost` when nothing is received.
 */
export function calculateWeightedAverageCost(  oldCost: unknown,
  oldStock: unknown,
  receivedUnitCost: unknown,
  receivedQty: unknown,
): number {
  const prevCost = Number(oldCost) || 0;
  const prevStock = Number(oldStock) || 0;
  const unitCost = Number(receivedUnitCost) || 0;
  const qty = Number(receivedQty) || 0;
  if (qty <= 0) return prevCost;
  const newStock = prevStock + qty;
  if (newStock <= 0) return unitCost;
  if (prevStock <= 0) return unitCost;
  return (prevCost * prevStock + unitCost * qty) / newStock;
}

/**
 * All five cost-alias fields set to one value. Canonical readers
 * (`resolveStoredCost`) prefer `cost_price`/`cost_per_unit` over `cost`, so
 * after any receipt/APPLY of a new average EVERY alias must carry it —
 * otherwise a stale alias shadows the fresh average for PO defaults, POS
 * snapshots, and sale CP.
 *
 * STOCK-TRACKED records only. Stamping these onto a printed product or
 * service would overwrite its explicit business CP. Callers must gate with
 * `isInventoryBearingItem` first (the GRN verification path, `addInventory`,
 * and `recordPurchase` all do).
 */
export function costAliasValues(unitCost: number): {
  cost: number;
  cost_price: number;
  cost_per_unit: number;
  costPrice: number;
  normalizedCP: number;
} {
  return {
    cost: unitCost,
    cost_price: unitCost,
    cost_per_unit: unitCost,
    costPrice: unitCost,
    normalizedCP: unitCost,
  };
}

/** `item` with every cost alias synced to `unitCost` (stock-tracked only). */
export function syncCostAliases<T extends Record<string, any>>(item: T, unitCost: number): T {
  return { ...item, ...costAliasValues(unitCost) };
}
