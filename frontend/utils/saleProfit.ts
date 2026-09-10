import { roundMoney } from './roundingUtils';

/**
 * saleProfit — single authoritative path for ACTUAL sale-line profit.
 *
 * Used by POS (cart lines + summary), Order Form (lines + totals) and the
 * Sale/Order View Details modal so all three surfaces agree for the same sale.
 *
 * Economics per line:
 *   unitProfit      = sellingPrice - costPrice
 *   totalLineProfit = (sellingPrice - costPrice) * quantity
 * Whole sale:
 *   totalProfit     = sum(totalLineProfit) - unallocatedOrderDiscount
 *
 * Field conventions (traced from the existing data flow):
 * - Selling price lives on `price` (CartItem) or `unitPrice` (OrderItem).
 * - Cost price lives on the line itself (`cost` / `cost_price` / `costPrice` /
 *   `unitCost`). Line values always win over live lookups so historical
 *   records keep their snapshotted economics.
 * - `subtotal` on a saved POS line is the PRE-discount line total and the
 *   per-line `discount` is that line's discount share.
 * - `total` on an OrderItem is the ALREADY-NETTED line total (rule discounts
 *   removed at submit), so its `discount` must NOT be subtracted again.
 * - Persisted `pricingBreakdown` / `productionCostSnapshot` objects act as a
 *   cost fallback for saved lines that carry no direct cost field (e.g.
 *   orders converted to invoices).
 * - A caller-supplied `fallbackCost` (e.g. live inventory cost during order
 *   creation) is used only when the line carries no stored cost at all.
 *
 * This deliberately does NOT derive profit from markup percentages or from
 * the snapshot `profitMarginAmount`/`profitMarginTotal` fields.
 */

export interface SaleProfitLine {
  quantity?: number | string | null;
  price?: number | string | null;
  unitPrice?: number | string | null;
  sellingPrice?: number | string | null;
  selling_price?: number | string | null;
  cost?: number | string | null;
  cost_price?: number | string | null;
  costPrice?: number | string | null;
  unitCost?: number | string | null;
  discount?: number | string | null;
  subtotal?: number | string | null;
  total?: number | string | null;
  pricingBreakdown?: {
    costPrice?: number | string | null;
    baseMaterialCost?: number | string | null;
  } | null;
  productionCostSnapshot?: {
    baseProductionCost?: number | string | null;
  } | null;
  [key: string]: unknown;
}

const toNum = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const firstPositive = (values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

export const resolveSaleLineQuantity = (line: SaleProfitLine | null | undefined): number =>
  toNum(line?.quantity);

export const resolveSaleLinePrice = (line: SaleProfitLine | null | undefined): number =>
  toNum(line?.price ?? line?.unitPrice ?? line?.sellingPrice ?? line?.selling_price);

/**
 * Line cost price. Prefers the CP stored on the line, then persisted
 * snapshots, then the caller fallback (live lookup). An explicit zero on the
 * line never masks a positive stored/snapshot cost.
 */
export const resolveSaleLineCostPrice = (
  line: SaleProfitLine | null | undefined,
  fallbackCost = 0
): number =>
  firstPositive([
    line?.cost,
    line?.cost_price,
    line?.costPrice,
    line?.unitCost,
    line?.pricingBreakdown?.costPrice,
    line?.pricingBreakdown?.baseMaterialCost,
    line?.productionCostSnapshot?.baseProductionCost,
    fallbackCost,
  ]);

/** Discount already reflected against this line (never negative). */
export const resolveSaleLineDiscount = (line: SaleProfitLine | null | undefined): number =>
  Math.max(0, toNum(line?.discount));

/**
 * True when the line carries an already-netted `total` (OrderItem
 * convention: rule discounts were removed at submit time).
 */
export const isNettedLineTotal = (line: SaleProfitLine | null | undefined): boolean => {
  const raw = line?.total;
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw));
};

/** Final selling value of the line after line-level discounts. */
export const resolveSaleLineRevenue = (line: SaleProfitLine | null | undefined): number => {
  if (!line) return 0;
  if (isNettedLineTotal(line)) return toNum(line.total);
  const gross = line.subtotal !== null && line.subtotal !== undefined && Number.isFinite(Number(line.subtotal))
    ? toNum(line.subtotal)
    : resolveSaleLinePrice(line) * resolveSaleLineQuantity(line);
  return gross - resolveSaleLineDiscount(line);
};

export const calculateLineProfit = (
  line: SaleProfitLine | null | undefined,
  fallbackCost = 0
): number => {
  if (!line) return 0;
  const revenue = resolveSaleLineRevenue(line);
  const costTotal = resolveSaleLineCostPrice(line, fallbackCost) * resolveSaleLineQuantity(line);
  return roundMoney(revenue - costTotal);
};

/**
 * Whole-sale profit. `orderDiscount` is the order-level discount NOT already
 * reflected in the lines (POS manual %, OrderForm order discount).
 */
export const calculateSaleProfit = (
  lines: SaleProfitLine[] | null | undefined,
  orderDiscount = 0
): number => {
  const items = Array.isArray(lines) ? lines : [];
  const linesProfit = items.reduce((sum, line) => sum + calculateLineProfit(line), 0);
  return roundMoney(linesProfit - Math.max(0, toNum(orderDiscount)));
};

const resolveTransactionRootDiscount = (transaction: { [key: string]: unknown } | null | undefined): number =>
  toNum(
    (transaction as Record<string, unknown> | null | undefined)?.discount ??
    (transaction as Record<string, unknown> | null | undefined)?.discountTotal ??
    (transaction as Record<string, unknown> | null | undefined)?.discount_total ??
    (transaction as Record<string, unknown> | null | undefined)?.discountAmount
  );

/**
 * Profit for a saved transaction (order / invoice / sale record).
 * Per-line discounts are already reflected inside each line's revenue, so the
 * root discount contributes only its unallocated remainder. This avoids
 * double-counting POS sales (root == sum of line shares) while still
 * deducting the manual portion of OrderForm orders (lines carry no manual
 * share).
 */
export const calculateTransactionProfit = (
  transaction: { items?: SaleProfitLine[] | null; [key: string]: unknown } | null | undefined,
  fallbackCostOf?: (line: SaleProfitLine) => number
): number => {
  const items = Array.isArray(transaction?.items) ? (transaction.items as SaleProfitLine[]) : [];
  const allocatedDiscount = items.reduce((sum, line) => sum + resolveSaleLineDiscount(line), 0);
  const unallocatedDiscount = Math.max(0, resolveTransactionRootDiscount(transaction) - allocatedDiscount);
  const linesProfit = items.reduce(
    (sum, line) => sum + calculateLineProfit(line, fallbackCostOf ? Number(fallbackCostOf(line)) || 0 : 0),
    0
  );
  return roundMoney(linesProfit - unallocatedDiscount);
};

export default {
  resolveSaleLineQuantity,
  resolveSaleLinePrice,
  resolveSaleLineCostPrice,
  resolveSaleLineDiscount,
  isNettedLineTotal,
  resolveSaleLineRevenue,
  calculateLineProfit,
  calculateSaleProfit,
  calculateTransactionProfit,
};
