/**
 * Document verification foundation (generic, offline-safe).
 *
 * ONE architecture for every verifiable official document. The invoice
 * implementation was refactored into this module; `invoiceVerification.ts`
 * re-exports it so all existing invoice imports keep working byte-identically.
 *
 * Supported types (only documents with a stable number + persistent record
 * + existing PDF representation — see module docs per type):
 *   invoice, receipt, quotation, sales_order, purchase_order, delivery_note
 *
 * Intentionally NOT enabled: credit_note (pseudo-status on invoice rows, no
 * own number/store/PDF), debit_note (no infrastructure), supplier_payment
 * (no status field), statement (generated on the fly, no persistent record).
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
  | 'delivery_note';

export const SUPPORTED_DOCUMENT_TYPES: VerifiableDocumentType[] = [
  'invoice',
  'receipt',
  'quotation',
  'sales_order',
  'purchase_order',
  'delivery_note',
];

/** URL slug per type (matches the frontend verify routes). */
const TYPE_SLUGS: Record<VerifiableDocumentType, string> = {
  invoice: 'invoice',
  receipt: 'receipt',
  quotation: 'quotation',
  sales_order: 'sales-order',
  purchase_order: 'purchase-order',
  delivery_note: 'delivery-note',
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

/** Public web origin used inside customer-facing QR codes. */
export function resolveVerificationBaseUrl(): string {
  try {
    const fromEnv = String((import.meta as any)?.env?.VITE_PUBLIC_PORTAL_URL || '').trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
  } catch { /* import.meta unavailable */ }
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
 * SO-/ORD-/PO-/DN-/PAY-). Returns null when the data is not a verifiable
 * document (legacy payload). A wrong guess is fail-closed: verification
 * looks the number up in that type's table and returns generic 404.
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
  const id = String(data.id || data.number || '');
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
    default:
      return '';
  }
}

/** Idempotent attach: keeps an existing token, issues one only when missing. */
export function ensureDocumentVerificationToken<T extends { verificationToken?: string }>(doc: T): T {
  if (!doc || doc.verificationToken) return doc;
  return { ...doc, verificationToken: generateVerificationToken() };
}
