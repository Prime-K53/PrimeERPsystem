/**
 * revenueRecognition.cjs (Phase 4 / C2+C5+C6)
 *
 * Backend mirror of frontend/utils/revenueRecognition.ts.
 * Canonical rule (matches financialReportingService.cjs legacy path):
 *   - excluded: draft | cancelled | void | voided (any case)
 *   - credit notes (credit_note|credit-note|creditnote) count NEGATIVE
 */

const normalizeStatus = (status) => String(status ?? '').trim().toLowerCase();

const EXCLUDED_STATUSES = new Set(['draft', 'cancelled', 'void', 'voided']);
const CREDIT_NOTE_STATUSES = new Set(['credit_note', 'credit-note', 'creditnote']);

// Backend sales CHECK values that carry revenue (db.cjs sales.status).
const RECOGNIZED_SALE_STATUSES = new Set([
  'paid',
  'completed',
  'partial',
  'partially paid',
  'partially-paid',
  'overpaid',
]);

const isExcludedStatus = (status) => EXCLUDED_STATUSES.has(normalizeStatus(status));
const isCreditNoteStatus = (status) => CREDIT_NOTE_STATUSES.has(normalizeStatus(status));
const isRecognizedSaleStatus = (status) => RECOGNIZED_SALE_STATUSES.has(normalizeStatus(status));
const isRecognizedSale = (sale) => isRecognizedSaleStatus(sale?.status);
const isRecognizedInvoiceStatus = (status) => !isExcludedStatus(status);
const isRecognizedInvoice = (invoice) => isRecognizedInvoiceStatus(invoice?.status);
const invoiceRevenueSign = (invoice) => (isCreditNoteStatus(invoice?.status) ? -1 : 1);
const isPostedInvoiceStatus = (status) => isRecognizedInvoiceStatus(status);

module.exports = {
  normalizeStatus,
  EXCLUDED_STATUSES,
  CREDIT_NOTE_STATUSES,
  RECOGNIZED_SALE_STATUSES,
  isExcludedStatus,
  isCreditNoteStatus,
  isRecognizedSaleStatus,
  isRecognizedSale,
  isRecognizedInvoiceStatus,
  isRecognizedInvoice,
  invoiceRevenueSign,
  isPostedInvoiceStatus,
};
