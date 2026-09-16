/**
 * Canonical revenue-recognition semantics (Phase 4 / C2+C5+C6).
 *
 * Single source of truth for WHICH sales/invoices count as revenue.
 * Backend P&L rule (financialReportingService.cjs:51,135-148):
 *   - excluded: draft | cancelled | void | voided (any case)
 *   - credit notes (credit_note|credit-note|creditnote) count NEGATIVE
 * Frontend revenueAnalysisService previously excluded only cancelled|draft
 * (case-sensitive gaps elsewhere: _internal.isPostedInvoiceStatus only knew
 * 'Draft'|'Cancelled'), so voided/credit-note documents inflated the dashboard
 * while P&L excluded/negated them.
 */

export const EXCLUDED_STATUSES = ['draft', 'cancelled', 'void', 'voided'] as const;

export const CREDIT_NOTE_STATUSES = ['credit_note', 'credit-note', 'creditnote'] as const;

export const normalizeStatus = (status: unknown): string =>
  String(status ?? '').trim().toLowerCase();

export const isExcludedStatus = (status: unknown): boolean =>
  (EXCLUDED_STATUSES as readonly string[]).includes(normalizeStatus(status));

export const isCreditNoteStatus = (status: unknown): boolean =>
  (CREDIT_NOTE_STATUSES as readonly string[]).includes(normalizeStatus(status));

/** Backend sales CHECK values that carry revenue (db.cjs sales.status). */
const RECOGNIZED_SALE_STATUSES = [
  'paid',
  'completed',
  'partial',
  'partially paid',
  'partially-paid',
  'overpaid',
] as const;

export const isRecognizedSaleStatus = (status: unknown): boolean =>
  (RECOGNIZED_SALE_STATUSES as readonly string[]).includes(normalizeStatus(status));

export const isRecognizedSale = (sale: any): boolean =>
  isRecognizedSaleStatus(sale?.status);

/**
 * Status gate for invoices: recognized unless excluded.
 * Credit notes pass the gate but carry a -1 revenue sign (see below).
 */
export const isRecognizedInvoiceStatus = (status: unknown): boolean =>
  !isExcludedStatus(status);

export const isRecognizedInvoice = (invoice: any): boolean =>
  isRecognizedInvoiceStatus(invoice?.status);

/** +1 normally, -1 for credit notes. Multiply all revenue-side metrics. */
export const invoiceRevenueSign = (invoice: any): 1 | -1 =>
  isCreditNoteStatus(invoice?.status) ? -1 : 1;

/** Posted = contributes AR/revenue/COGS/inventory (same gate as recognition). */
export const isPostedInvoiceStatus = (status: unknown): boolean =>
  isRecognizedInvoiceStatus(status);

/**
 * Revenue account selector shared by every invoice AR posting.
 * Explicit salesAccountId always wins; service-only invoices fall back to
 * 41200 Service Income, everything else to the default (41100 Product Sales).
 */
export const resolveInvoiceRevenueAccount = (
  invoice: any,
  defaultSalesAccount: string
): string => {
  if (invoice?.salesAccountId) return invoice.salesAccountId;
  const items = invoice?.items;
  if (Array.isArray(items) && items.length > 0 && items.every((i: any) => i?.type === 'Service')) {
    return '41200';
  }
  return defaultSalesAccount;
};
