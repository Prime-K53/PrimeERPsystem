/**
 * Quick Photocopy billing-unit service.
 *
 * Business rule (single source of truth for QP math):
 * - Quick Photocopy is priced PER PHYSICAL SHEET (2 pages/sides per sheet).
 * - User enters number of PAGES (pagesPerCopy) + number of COPIES.
 * - Billable sheets = copies × CEILING(pagesPerCopy / 2)
 * - Amount = billableSheets × configuredPricePerSheet
 *
 * The configured price lives ONLY in:
 *   companyConfig.transactionSettings.pos.photocopyPrice
 * This module never hard-codes a price and never mutates settings.
 *
 * Data semantics preserved explicitly where architecture allows:
 * - pages            = customer-requested pages per copy
 * - copies           = number of copies
 * - totalPages       = pages × copies (customer-facing quantity)
 * - billableSheets   = copies × ceil(pages / 2) (billing quantity)
 * - unitPrice        = configured price per sheet (unchanged)
 * - lineTotal        = billableSheets × unitPrice (authoritative financial total)
 *
 * Applies ONLY to Quick Photocopy. Normal products use quantity × unit price.
 */

export const QUICK_PHOTOCOPY_ITEM_ID = 'SVC-PHOTOCOPY';
export const QUICK_PHOTOCOPY_SKU = 'QUICK-PHOTO';
export const QUICK_PHOTOCOPY_ID_PREFIX = 'QUICK-PHOTO';

/** Fallback per-sheet price when settings are absent (matches existing POS/OrderForm fallback). */
export const QUICK_PHOTOCOPY_FALLBACK_PRICE = 2.0;

export interface QuickPhotocopyInput {
  pagesPerCopy: number;
  copies: number;
  pricePerSheet: number;
}

export interface QuickPhotocopyResult {
  pagesPerCopy: number;
  copies: number;
  totalPages: number;
  billableSheets: number;
  unitPrice: number;
  lineTotal: number;
}

const toPositiveInt = (v: unknown, fallback = 1): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
};

const toNonNegativeNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

/**
 * Authoritative settings reader. Never hard-codes K150 or any price.
 * Returns the configured per-sheet price unchanged.
 */
export function getQuickPhotocopyPricePerSheet(
  companyConfig: any,
  fallback: number = QUICK_PHOTOCOPY_FALLBACK_PRICE
): number {
  const raw =
    companyConfig?.transactionSettings?.pos?.photocopyPrice ??
    companyConfig?.transactionSettings?.photocopyPrice ??
    fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Billable sheets for a single line: copies × ceil(pagesPerCopy / 2). */
export function calculateBillableSheets(pagesPerCopy: unknown, copies: unknown): number {
  const pages = toPositiveInt(pagesPerCopy, 1);
  const cps = toPositiveInt(copies, 1);
  return cps * Math.ceil(pages / 2);
}

/** Total customer-facing pages: pagesPerCopy × copies. */
export function calculateTotalPages(pagesPerCopy: unknown, copies: unknown): number {
  const pages = toPositiveInt(pagesPerCopy, 1);
  const cps = toPositiveInt(copies, 1);
  return pages * cps;
}

/** Authoritative line amount: billableSheets × pricePerSheet. Never divides the price. */
export function calculateQuickPhotocopyAmount(
  pagesPerCopy: unknown,
  copies: unknown,
  pricePerSheet: unknown
): number {
  const sheets = calculateBillableSheets(pagesPerCopy, copies);
  const price = toNonNegativeNumber(pricePerSheet, 0);
  return sheets * price;
}

export function calculateQuickPhotocopyLine(input: QuickPhotocopyInput): QuickPhotocopyResult {
  const pagesPerCopy = toPositiveInt(input.pagesPerCopy, 1);
  const copies = toPositiveInt(input.copies, 1);
  const unitPrice = toNonNegativeNumber(input.pricePerSheet, 0);
  const totalPages = pagesPerCopy * copies;
  const billableSheets = copies * Math.ceil(pagesPerCopy / 2);
  return {
    pagesPerCopy,
    copies,
    totalPages,
    billableSheets,
    unitPrice,
    lineTotal: billableSheets * unitPrice,
  };
}

/**
 * Strict Quick Photocopy detection. Only photocopy — never QUICK-PRINT,
 * never normal stationery/printing services/books/pads/files/pens/chalk.
 * Requires serviceDetails (or explicit billableSheets marker we persist) so
 * normal products with similar names are never affected.
 */
export function isQuickPhotocopyItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const id = String(item.id ?? '');
  const sku = String(item.sku ?? '');
  const itemId = String(item.itemId ?? item.productId ?? '');
  const isPhotocopyIdentity =
    id.startsWith(QUICK_PHOTOCOPY_ID_PREFIX) ||
    sku === QUICK_PHOTOCOPY_SKU ||
    itemId === QUICK_PHOTOCOPY_ITEM_ID;
  if (!isPhotocopyIdentity) return false;
  // Require QP billing markers so legacy/normal items are never misclassified.
  if (item.serviceDetails && typeof item.serviceDetails === 'object') return true;
  if (typeof item.billableSheets === 'number' && Number.isFinite(item.billableSheets)) return true;
  if (typeof (item as any).qpPages === 'number') return true;
  return false;
}

export function getQuickPhotocopyPagesPerCopy(item: any): number {
  if (!item) return 1;
  const v =
    item?.serviceDetails?.pages ??
    item?.pagesOverride ??
    item?.pages ??
    (item as any)?.qpPages ??
    1;
  return toPositiveInt(v, 1);
}

export function getQuickPhotocopyCopies(item: any): number {
  if (!item) return 1;
  // NOTE: item.quantity is BILLABLE SHEETS for QP (not copies), so never use
  // it as copies. Copies live in serviceDetails.copies (or qpCopies).
  const v = item?.serviceDetails?.copies ?? (item as any)?.qpCopies ?? 1;
  return toPositiveInt(v, 1);
}

/** Configured per-sheet unit price stored on the line (never divided). */
export function getQuickPhotocopyUnitPrice(item: any): number {
  if (!item) return 0;
  const v =
    item?.serviceDetails?.pricePerSheet ??
    item?.price ??
    item?.unitPrice ??
    item?.unit_price ??
    0;
  return toNonNegativeNumber(v, 0);
}

export function getQuickPhotocopyTotals(item: any): {
  pagesPerCopy: number;
  copies: number;
  totalPages: number;
  billableSheets: number;
  unitPrice: number;
  lineTotal: number;
} {
  const pagesPerCopy = getQuickPhotocopyPagesPerCopy(item);
  const copies = getQuickPhotocopyCopies(item);
  const unitPrice = getQuickPhotocopyUnitPrice(item);
  // Prefer explicitly persisted billableSheets (set at creation) for
  // historical fidelity; recompute only when absent.
  const rawSheets =
    (item as any)?.billableSheets ??
    item?.serviceDetails?.billableSheets ??
    null;
  const billableSheets =
    typeof rawSheets === 'number' && Number.isFinite(rawSheets) && rawSheets >= 0
      ? Math.floor(rawSheets)
      : copies * Math.ceil(pagesPerCopy / 2);
  const totalPages = pagesPerCopy * copies;
  return {
    pagesPerCopy,
    copies,
    totalPages,
    billableSheets,
    unitPrice,
    lineTotal: billableSheets * unitPrice,
  };
}

/** Customer-facing quantity label: "50 pages" (never sheets). */
export function formatQuickPhotocopyQty(totalPages: number): string {
  const n = toPositiveInt(totalPages, 1);
  return `${n} pages`;
}

/** Customer-facing unit-price label: "K150/sheet" (price never divided). */
export function formatQuickPhotocopyPriceLabel(unitPrice: number, currencySymbol: string): string {
  const cur = currencySymbol || 'K';
  const n = toNonNegativeNumber(unitPrice, 0);
  // Keep existing 2-decimal ERP formatting for consistency.
  return `${cur}${n.toFixed(2)}/sheet`;
}

/**
 * Document line display for QP. Billing stays sheets×price; display shows pages.
 * - qtyLabel: "50 pages"
 * - priceLabel: "K150.00/sheet"
 * - amount: 25 × 150 = 3750
 * - descSuffix: " — K150.00/sheet" appended to item name where desc allows it.
 */
export function getQuickPhotocopyDocumentLine(
  item: any,
  currencySymbol: string
): {
  qtyLabel: string;
  priceLabel: string;
  amount: number;
  totalPages: number;
  billableSheets: number;
  unitPrice: number;
} {
  const t = getQuickPhotocopyTotals(item);
  return {
    qtyLabel: formatQuickPhotocopyQty(t.totalPages),
    priceLabel: formatQuickPhotocopyPriceLabel(t.unitPrice, currencySymbol),
    amount: t.lineTotal,
    totalPages: t.totalPages,
    billableSheets: t.billableSheets,
    unitPrice: t.unitPrice,
  };
}

/** Build serviceDetails payload for a new QP line (preserves both concepts). */
export function buildQuickPhotocopyServiceDetails(
  pagesPerCopy: number,
  copies: number,
  pricePerSheet: number,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const calc = calculateQuickPhotocopyLine({ pagesPerCopy, copies, pricePerSheet });
  return {
    pages: calc.pagesPerCopy,
    copies: calc.copies,
    totalPages: calc.totalPages,
    billableSheets: calc.billableSheets,
    pricePerSheet: calc.unitPrice,
    ...(extra || {}),
  };
}
