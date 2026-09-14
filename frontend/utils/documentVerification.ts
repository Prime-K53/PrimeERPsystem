/**
 * Document verification foundation (generic, offline-safe).
 *
 * ONE architecture for every verifiable official document. The invoice
 * implementation was refactored into this module; `invoiceVerification.ts`
 * re-exports it so all existing invoice imports keep working byte-identically.
 *
 * Supported types (only documents with a stable number + persistent record
 * + existing PDF representation — see module docs per type):
 *   invoice, receipt, quotation, sales_order, purchase_order, delivery_note,
 *   supplier_payment, statement
 *
 * supplier_payment: official Supplier Payment voucher (supplierPayments
 * store -> supplier_payments table). The ERP treats the payment record id
 * as the official payment number (shown in every payment view, hover card
 * and ledger description), with an optional explicit `paymentNumber`.
 * Status comes from the payment's own status field (Cleared/Pending/
 * Voided); voided payments verify as VOID.
 *
 * statement: immutable statement snapshot (statementSnapshots store ->
 * statement_snapshots table). The QR verifies THAT snapshot (number +
 * period + frozen totals), never live customer data.
 *
 * Intentionally NOT enabled: credit_note (pseudo-status on invoice rows, no
 * own number/store/PDF), debit_note (no infrastructure).
 *
 * URL shape (HashRouter SPA):
 *   {base}/#/verify/{type-slug}/{documentNumber}?t={token}
 */

export const VERIFICATION_TOKEN_BYTES = 32;
export const VERIFICATION_TOKEN_HEX_LENGTH = VERIFICATION_TOKEN_BYTES * 2;

export type VerifiableDocumentType =
  | 'invoice'
  | 'receipt'
  | 'quotation'
  | 'sales_order'
  | 'purchase_order'
  | 'delivery_note'
  | 'supplier_payment'
  | 'statement';

export const SUPPORTED_DOCUMENT_TYPES: VerifiableDocumentType[] = [
  'invoice',
  'receipt',
  'quotation',
  'sales_order',
  'purchase_order',
  'delivery_note',
  'supplier_payment',
  'statement',
];

/** URL slug per type (matches the frontend verify routes). */
const TYPE_SLUGS: Record<VerifiableDocumentType, string> = {
  invoice: 'invoice',
  receipt: 'receipt',
  quotation: 'quotation',
  sales_order: 'sales-order',
  purchase_order: 'purchase-order',
  delivery_note: 'delivery-note',
  supplier_payment: 'supplier-payment',
  statement: 'statement',
};

const SLUG_TO_TYPE: Record<string, VerifiableDocumentType> = Object.fromEntries(
  Object.entries(TYPE_SLUGS).map(([type, slug]) => [slug, type as VerifiableDocumentType])
);

export function documentTypeSlug(type: VerifiableDocumentType): string {
  return TYPE_SLUGS[type];
}

export function documentTypeFromSlug(slug: unknown): VerifiableDocumentType | null {
  const t = SLUG_TO_TYPE[String(slug || '').toLowerCase().trim()];
  return t || null;
}

export function isSupportedDocumentType(value: unknown): value is VerifiableDocumentType {
  return typeof value === 'string' && (SUPPORTED_DOCUMENT_TYPES as string[]).includes(value);
}

/** Cryptographically secure random token (hex). Throws without WebCrypto. */
export function generateVerificationToken(randomSource?: (bytes: Uint8Array) => void): string {
  const fill = randomSource
    ?? ((bytes: Uint8Array) => {
      const g = (globalThis as any)?.crypto;
      if (!g?.getRandomValues) {
        throw new Error('Secure random source unavailable — cannot issue document verification token.');
      }
      g.getRandomValues(bytes);
    });
  const bytes = new Uint8Array(VERIFICATION_TOKEN_BYTES);
  fill(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True inside a production build (Vite PROD/MODE or Node NODE_ENV). */
function isProductionBuild(): boolean {
  try {
    // NOTE: keep the `import.meta.env` member chain statically analyzable
    // (no `?.` between import.meta and env). Vite substitutes it at serve/
    // build time; an optional chain there defeats substitution and the lookup
    // silently reads the native (empty) import.meta at runtime.
    const env = (import.meta as any).env;
    if (env?.PROD) return true;
    if (typeof env?.MODE === 'string' && env.MODE === 'production') return true;
  } catch { /* import.meta unavailable */ }
  try {
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'production') return true;
  } catch { /* no process */ }
  return false;
}

/**
 * Public web origin used inside customer-facing QR codes.
 *
 * The Portal is the public verification surface, so this prefers the
 * configured Portal origin (`VITE_PUBLIC_PORTAL_URL`). Production builds
 * FAIL CLOSED when it is missing (return '') so new public QR codes can
 * never silently point back at the private ERP origin; callers then fall
 * back to the legacy human-readable QR payload. Local dev/test keep the
 * running-app-origin fallback so offline work is unaffected.
 */
export function resolveVerificationBaseUrl(): string {
  try {
    // NOTE: same static-analyzability requirement as above — `import.meta.env`
    // must stay a plain member chain so Vite injects the configured Portal
    // origin. `(import.meta as any)?.env` bypasses injection and always falls
    // through to the origin fallback below.
    const fromEnv = String((import.meta as any).env?.VITE_PUBLIC_PORTAL_URL || '').trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
  } catch { /* import.meta unavailable */ }
  if (isProductionBuild()) {
    return '';
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/+$/, '');
  }
  return '';
}

export interface VerifiableDocumentRef {
  documentType?: unknown;
  documentNumber?: unknown;
  invoiceNumber?: unknown;
  number?: unknown;
  verificationToken?: unknown;
}

/**
 * Deterministic verification URL, or null when the document cannot be
 * verified yet (unsupported type, missing number or token). Contains NOTHING
 * sensitive — only the public type slug, number and the random token.
 */
export function buildDocumentVerificationUrl(
  ref: VerifiableDocumentRef | null | undefined,
  baseUrl?: string
): string | null {
  const type = String(ref?.documentType || 'invoice');
  if (!isSupportedDocumentType(type)) return null;
  const number = String(ref?.documentNumber ?? ref?.invoiceNumber ?? ref?.number ?? '').trim();
  const token = String(ref?.verificationToken ?? '').trim();
  if (!number || !token) return null;
  const base = String(baseUrl ?? resolveVerificationBaseUrl()).replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/#/verify/${TYPE_SLUGS[type]}/${encodeURIComponent(number)}?t=${encodeURIComponent(token)}`;
}

/**
 * Detect the document type of PDF payload data for QR routing.
 * Explicit `documentType` wins, then official number fields, then the
 * namespaced id prefixes from the existing numbering module (INV-/QTN-/
 * SO-/ORD-/PO-/DN-/PAY-/SPAY-/STMT-). Returns null when the data is not a
 * verifiable document (legacy payload). A wrong guess is fail-closed:
 * verification looks the number up in that type's table and returns
 * generic 404.
 *
 * Ambiguity rule: bare PAY- numbers stay customer receipts; supplier
 * payments are detected ONLY via explicit documentType, the paymentNumber/
 * paymentId + supplierName pairing, or the SPAY- prefix. Statements are
 * detected ONLY via explicit documentType or a statementNumber field —
 * never from customer/ledger text.
 */
export function detectVerifiableDocumentType(data: any): VerifiableDocumentType | null {
  if (!data || typeof data !== 'object') return null;
  if (isSupportedDocumentType(data.documentType)) return data.documentType;
  if (data.invoiceNumber) return 'invoice';
  if (data.receiptNumber) return 'receipt';
  if (data.quotationNumber || data.quotationId) return 'quotation';
  if (data.orderNumber && String(data.orderNumber).startsWith('SO-')) return 'sales_order';
  if (data.order_number || (data.orderNumber && String(data.orderNumber).startsWith('PO-'))) return 'purchase_order';
  if (data.dnNumber || data.deliveryNoteNumber || data.delivery_number) return 'delivery_note';
  if (data.statementNumber) return 'statement';
  if ((data.paymentNumber || data.paymentId) && (data.supplierName || data.supplier_id || data.supplierId)) return 'supplier_payment';
  const id = String(data.paymentNumber || data.paymentId || data.statementNumber || data.id || data.number || '');
  if (/^STMT-/i.test(id)) return 'statement';
  if (/^SPAY-/i.test(id)) return 'supplier_payment';
  if (/^INV-/i.test(id)) return 'invoice';
  if (/^QTN-/i.test(id)) return 'quotation';
  if (/^(SO-|ORD-)/i.test(id)) return 'sales_order';
  if (/^PO-/i.test(id)) return 'purchase_order';
  if (/^DN-/i.test(id)) return 'delivery_note';
  if (/^PAY-/i.test(id)) return 'receipt';
  return null;
}

/** Resolve the official display number for a document payload. */
export function resolveVerifiableDocumentNumber(data: any, type: VerifiableDocumentType): string {
  switch (type) {
    case 'invoice':
      return String(data?.invoiceNumber ?? data?.number ?? '').trim();
    case 'receipt':
      return String(data?.receiptNumber ?? data?.number ?? '').trim();
    case 'quotation':
      return String(data?.quotationNumber ?? data?.quotationId ?? data?.number ?? data?.id ?? '').trim();
    case 'sales_order':
      return String(data?.orderNumber ?? data?.number ?? data?.id ?? '').trim();
    case 'purchase_order':
      return String(data?.order_number ?? data?.orderNumber ?? data?.number ?? data?.id ?? '').trim();
    case 'delivery_note':
      return String(data?.dnNumber ?? data?.deliveryNoteNumber ?? data?.delivery_number ?? data?.number ?? data?.id ?? '').trim();
    case 'supplier_payment':
      return String(data?.paymentNumber ?? data?.paymentId ?? data?.number ?? data?.id ?? '').trim();
    case 'statement':
      return String(data?.statementNumber ?? data?.number ?? data?.id ?? '').trim();
    default:
      return '';
  }
}

/** Idempotent attach: keeps an existing token, issues one only when missing. */
export function ensureDocumentVerificationToken<T extends { verificationToken?: string }>(doc: T): T {
  if (!doc || doc.verificationToken) return doc;
  return { ...doc, verificationToken: generateVerificationToken() };
}

/**
 * Local store backing each verifiable document type (single-company, no
 * tenant scoping). Used by document-preparation paths to issue+persist the
 * permanent verification token BEFORE mapping, so the QR always encodes the
 * verification URL. Returns null for types with no directly stored record
 * (e.g. POS_RECEIPT, which is represented by its linked receipt record).
 */
export function verificationStoreForDocType(docType: string): string | null {
  switch (String(docType || '').toUpperCase()) {
    case 'INVOICE':
    case 'EXAMINATION_INVOICE':
      return 'invoices';
    case 'QUOTATION':
      return 'quotations';
    case 'ORDER':
      return 'orders';
    case 'SALES_ORDER':
      return 'salesOrders';
    case 'WORK_ORDER':
      return 'jobOrders';
    case 'DELIVERY_NOTE':
      return 'deliveryNotes';
    case 'PO':
      return 'purchases';
    case 'RECEIPT':
      return 'customerPayments';
    case 'SUPPLIER_PAYMENT':
      return 'supplierPayments';
    case 'SUBSCRIPTION':
      return 'recurringInvoices';
    case 'SALES_EXCHANGE':
      return 'salesExchanges';
    case 'ACCOUNT_STATEMENT':
      return 'statementSnapshots';
    default:
      return null;
  }
}
