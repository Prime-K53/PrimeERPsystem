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
 *   supplier_payment, statement, printing_contract
 *
 * printing_contract: commercial agreement (assessment_contracts store ->
 * assessment_contracts table, official number = contract_number, PC- prefix).
 * Status comes from the contract lifecycle; cancelled contracts verify as
 * terminal (authentic but cancelled).
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
  | 'statement'
  | 'printing_contract'
  | 'printing_contract_schedule'
  | 'printing_contract_completion_receipt'
  | 'work_order';

export const SUPPORTED_DOCUMENT_TYPES: VerifiableDocumentType[] = [
  'invoice',
  'receipt',
  'quotation',
  'sales_order',
  'purchase_order',
  'delivery_note',
  'supplier_payment',
  'statement',
  'printing_contract',
  'printing_contract_schedule',
  'printing_contract_completion_receipt',
  'work_order',
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
  printing_contract: 'printing-contract',
  printing_contract_schedule: 'printing-contract-schedule',
  printing_contract_completion_receipt: 'printing-contract-completion-receipt',
  work_order: 'work-order',
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
 * Document types the customer PORTAL serves on its public verification page.
 *
 * The Portal deployment used to whitelist eight slugs:
 *
 *   /^\/(verify\/invoice|verify\/(receipt|quotation|sales-order|purchase-order|
 *       delivery-note|supplier-payment|statement))/
 *
 * and anything else fell through to its authenticated shell, so a scanner
 * landed on the LOGIN page instead of the verification result. The Portal now
 * renders its verification page for EVERY `/#/verify/...` route, and knows the
 * four contract-document types, so all verifiable types are served publicly.
 *
 * The list stays explicit on purpose: a NEW document type must be confirmed to
 * be served by the Portal before its QR codes are pointed at it. A type that is
 * missing from this list falls back to the app that serves the verification
 * route (the ERP app's own public `/#/verify`), so a QR can never dead-end on a
 * login page.
 */
export const PORTAL_SERVED_VERIFICATION_TYPES: VerifiableDocumentType[] = [
  'invoice',
  'receipt',
  'quotation',
  'sales_order',
  'purchase_order',
  'delivery_note',
  'supplier_payment',
  'statement',
  'printing_contract',
  'printing_contract_schedule',
  'printing_contract_completion_receipt',
  'work_order',
];

/** True when the Portal deployment serves this type's public verification page. */
export function isPortalServedVerificationType(
  type: VerifiableDocumentType | null | undefined,
): boolean {
  if (!type) return false;
  return (PORTAL_SERVED_VERIFICATION_TYPES as string[]).includes(type);
}

/**
 * Pure decision table for the verification base URL.
 *
 * Split out of `resolveVerificationBaseUrl` so the rule is testable without
 * stubbing `import.meta.env` (Vitest inlines it at transform time) — the same
 * technique the Portal-origin helper uses.
 *
 *  - A type the Portal does NOT serve uses the app that serves the
 *    verification route (`appOrigin`), never the Portal: the Portal would
 *    send the scanner to its login page.
 *  - A type the Portal DOES serve uses the Portal origin; in production it
 *    fails closed (empty) when the Portal origin is unconfigured, so a public
 *    QR code never silently points at a private origin.
 */
export function pickVerificationBaseUrl(opts: {
  type?: VerifiableDocumentType | null;
  portalOrigin?: string | null;
  appOrigin?: string | null;
  isProduction?: boolean;
}): string {
  const portal = String(opts.portalOrigin || '').trim().replace(/\/+$/, '');
  const app = String(opts.appOrigin || '').trim().replace(/\/+$/, '');
  const type = opts.type || null;

  if (type && !isPortalServedVerificationType(type)) {
    // The Portal cannot show this document: use the app that can.
    return app;
  }
  if (portal) return portal;
  if (opts.isProduction) return '';
  return app;
}

/**
 * Public web origin used inside customer-facing QR codes.
 *
 * The Portal is the public verification surface for the types it serves, so
 * this prefers the configured Portal origin (`VITE_PUBLIC_PORTAL_URL`).
 * Production builds FAIL CLOSED when it is missing (return '') so new public QR
 * codes can never silently point back at the private ERP origin; callers then
 * fall back to the legacy human-readable QR payload. Local dev/test keep the
 * running-app-origin fallback so offline work is unaffected.
 *
 * For a type the Portal does NOT serve (the contract documents, work orders),
 * the Portal would send the scanner to its login page, so those types use the
 * app that serves the verification route: `VITE_PUBLIC_APP_URL` when
 * configured, otherwise the running app's own origin (the browser), otherwise
 * '' — a server-side renderer must configure `VITE_PUBLIC_APP_URL`.
 */
export function resolveVerificationBaseUrl(documentType?: VerifiableDocumentType | null): string {
  const portalOrigin = (): string => {
    try {
      // NOTE: same static-analyzability requirement as above — `import.meta.env`
      // must stay a plain member chain so Vite injects the configured Portal
      // origin. `(import.meta as any)?.env` bypasses injection and always falls
      // through to the origin fallback below.
      const fromEnv = String((import.meta as any).env?.VITE_PUBLIC_PORTAL_URL || '').trim();
      return fromEnv.replace(/\/+$/, '');
    } catch { /* import.meta unavailable */ }
    return '';
  };
  const appOrigin = (): string => {
    try {
      const fromEnv = String((import.meta as any).env?.VITE_PUBLIC_APP_URL || '').trim();
      if (fromEnv) return fromEnv.replace(/\/+$/, '');
    } catch { /* import.meta unavailable */ }
    if (typeof window !== 'undefined' && window.location?.origin) {
      return String(window.location.origin).replace(/\/+$/, '');
    }
    return '';
  };

  return pickVerificationBaseUrl({
    type: documentType || null,
    portalOrigin: portalOrigin(),
    appOrigin: appOrigin(),
    isProduction: isProductionBuild(),
  });
}

/**
 * Base URL for the CONTRACT verification page (`/verify?c=&h=`).
 *
 * A printing contract is verified by its canonical content hash, not by the
 * generic token route, so it has its own page. Its public origin is resolved
 * exactly like document verification (Portal when it serves the type, otherwise
 * the app that serves the route), so the hash verification link tracks the
 * document verification link. `''` means fail-closed: no public URL is emitted.
 */
export function resolveContractVerifyBaseUrl(): string {
  // The printing-contract content-hash verification page is served from the
  // same public surface as document verification (the Portal for the types it
  // serves, otherwise the app that serves the route). Reuse that resolution so
  // the hash verification link tracks the document verification link. The stored
  // document-verification system itself is left untouched.
  return resolveVerificationBaseUrl('printing_contract');
}

/**
 * URL-safe form of an official contract number for the `c` query parameter.
 * `PC-P726/023` → `PC-P726-023`. The verifier reverses the LAST hyphen when
 * the exact form does not resolve, so a genuine hyphen elsewhere survives.
 */
export function contractNumberForUrl(contractNumber: string): string {
  return String(contractNumber || '').trim().replace(/\//g, '-');
}

/**
 * Contract verification URL carried by the printed QR:
 *   {base}/verify?c=<url-safe-number>&h=<full-sha256>
 *
 * The full hash is what the server compares constant-time after recomputing
 * it from the stored record. The short code is for manual entry only and never
 * appears in the QR.
 */
export function buildContractVerificationUrl(
  contractNumber: string,
  contentHash: string,
  baseUrl?: string,
): string | null {
  const number = String(contractNumber || '').trim();
  const hash = String(contentHash || '').trim().toLowerCase();
  if (!number || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const base = String(baseUrl ?? resolveContractVerifyBaseUrl()).replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/verify?c=${encodeURIComponent(contractNumberForUrl(number))}&h=${hash}`;
}


export interface VerifiableDocumentRef {
  documentType?: unknown;
  documentNumber?: unknown;
  invoiceNumber?: unknown;
  contractNumber?: unknown;
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
  const number = String(ref?.documentNumber ?? ref?.invoiceNumber ?? ref?.contractNumber ?? ref?.number ?? '').trim();
  const token = String(ref?.verificationToken ?? '').trim();
  if (!number || !token) return null;
  const base = String(baseUrl ?? resolveVerificationBaseUrl(type)).replace(/\/+$/, '');
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
 * never from customer/ledger text. Printing contracts are detected via
 * explicit documentType, a contractNumber field, or the PC- prefix (used
 * only by printing contracts — purchase orders use PO-).
 */
export function detectVerifiableDocumentType(data: any): VerifiableDocumentType | null {
  if (!data || typeof data !== 'object') return null;
  if (isSupportedDocumentType(data.documentType)) return data.documentType;
  if (data.invoiceNumber) return 'invoice';
  if (data.receiptNumber) return 'receipt';
  if (data.contractNumber) return 'printing_contract';
  if (data.quotationNumber || data.quotationId) return 'quotation';
  if (data.orderNumber && /^(SO-|ORD-)/.test(String(data.orderNumber))) return 'sales_order';
  // Unified official numbers live in order_number for ANY configured series
  // (current or historical — never gate recognition on the current series).
  if (/^(SO|ORD)-[A-Za-z0-9]+\//.test(String((data as Record<string, unknown>).order_number ?? ''))) return 'sales_order';
  if (data.order_number || (data.orderNumber && String(data.orderNumber).startsWith('PO-'))) return 'purchase_order';
  if (data.dnNumber || data.deliveryNoteNumber || data.delivery_number) return 'delivery_note';
  if (data.statementNumber) return 'statement';
  if ((data.paymentNumber || data.paymentId) && (data.supplierName || data.supplier_id || data.supplierId)) return 'supplier_payment';
  // Examination invoices verify as invoices (same `invoices` store, EXM-
  // numbered). Explicit other-type fields above win; otherwise EXM identity
  // or examination markers route here so hand-built preview payloads
  // (official number only, no invoiceNumber/documentType) still verify
  // instead of falling back to the legacy human-readable QR.
  const examNumber = String(data.invoiceNumber || data.id || data.number || '');
  const examModule = String(data.originModule || data.origin_module || '').toLowerCase();
  const examTitle = String(data.documentTitle || data.document_title || '').toLowerCase();
  if (
    /^EXM-/i.test(examNumber) ||
    examModule === 'examination' ||
    examTitle.includes('examination invoice')
  ) return 'invoice';
  const id = String(data.paymentNumber || data.paymentId || data.statementNumber || data.contractNumber || data.id || data.number || '');
  if (/^STMT-/i.test(id)) return 'statement';
  if (/^PC-/i.test(id)) return 'printing_contract';
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
    case 'work_order':
      return String(data?.order_number ?? data?.orderNumber ?? data?.number ?? data?.id ?? '').trim();
    case 'purchase_order':
      return String(data?.order_number ?? data?.orderNumber ?? data?.number ?? data?.id ?? '').trim();
    case 'delivery_note':
      return String(data?.dnNumber ?? data?.deliveryNoteNumber ?? data?.delivery_number ?? data?.number ?? data?.id ?? '').trim();
    case 'supplier_payment':
      return String(data?.paymentNumber ?? data?.paymentId ?? data?.number ?? data?.id ?? '').trim();
    case 'statement':
      return String(data?.statementNumber ?? data?.number ?? data?.id ?? '').trim();
    case 'printing_contract':
      return String(data?.contractNumber ?? data?.contract_number ?? data?.number ?? data?.id ?? '').trim();
    case 'printing_contract_schedule':
      return String(data?.contractNumber ?? data?.contract_number ?? data?.number ?? data?.id ?? '').trim();
    case 'printing_contract_completion_receipt':
      return String(data?.receiptNumber ?? data?.contractNumber ?? data?.contract_number ?? data?.number ?? data?.id ?? '').trim();
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
    case 'PRINTING_CONTRACT':
      return 'assessmentContracts';
    case 'CONTRACT_SCHEDULE':
    case 'CONTRACT_COMPLETION_RECEIPT':
      return 'assessmentContracts';
    default:
      return null;
  }
}
