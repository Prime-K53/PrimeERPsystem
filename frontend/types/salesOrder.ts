/**
 * Canonical Sales Order domain model (Prime ERP).
 *
 * Single source of truth for sales orders across all views (Sales Hub Orders tab,
 * dedicated Sales Orders workspace, customer portal adoption) and all persistence
 * paths (IndexedDB `salesOrders` store, sync to Supabase `sales_orders`, backend
 * REST + portal adoption lifecycle).
 *
 * The canonical lifecycle is `SalesOrderStatus`. Legacy statuses from the former
 * `orders` store (Pending/Paid/Partially Paid/Completed/Converted) are translated
 * at the boundary via `canonicalizeStatus` so no historical record or consumer
 * breaks. Payment state lives in `paymentStatus`, invoicing state in
 * `invoiceStatus`; `Converted` remains a terminal status for orders converted to
 * job tickets / work orders (legacy behaviour, preserved).
 */

export type SalesOrderStatus =
  | 'Draft'
  | 'Confirmed'
  | 'Processing'
  | 'Fulfilled'
  | 'Cancelled'
  | 'Converted';

export type SalesOrderPaymentStatus = 'Unpaid' | 'Partially Paid' | 'Paid';

export type SalesOrderInvoiceStatus = 'Not Invoiced' | 'Invoiced';

/**
 * Explicit persisted creation source/origin for Sales Orders.
 * DIRECT_ERP       → ORD sequence (manual ERP orders, initial Draft)
 * PORTAL_CONVERSION→ SO sequence (portal quotation/request conversion, Confirmed)
 * INVOICE_DERIVED  → ORD sequence (direct-invoice Order → Invoice chain, Confirmed)
 * QUOTATION_REQUEST is the legacy portal alias, normalized to PORTAL_CONVERSION.
 */
export type SalesOrderCreationSource =
  | 'DIRECT_ERP'
  | 'PORTAL_CONVERSION'
  | 'INVOICE_DERIVED';

export const SALES_ORDER_CREATION_SOURCES: readonly string[] = [
  'DIRECT_ERP',
  'PORTAL_CONVERSION',
  'INVOICE_DERIVED',
] as const;

const LEGACY_PORTAL_SOURCE_ALIAS = 'QUOTATION_REQUEST';

/** Normalize a persisted creation source (null when missing/invalid — never default to portal/SO). */
export function normalizeCreationSource(value?: string | null): SalesOrderCreationSource | null {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === 'DIRECT_ERP') return 'DIRECT_ERP';
  if (text === 'PORTAL_CONVERSION') return 'PORTAL_CONVERSION';
  if (text === 'INVOICE_DERIVED') return 'INVOICE_DERIVED';
  if (text === LEGACY_PORTAL_SOURCE_ALIAS) return 'PORTAL_CONVERSION';
  return null;
}

/** Read the explicit creation source from either spelling (snake/camel). */
export function readCreationSource(order: {
  creation_source?: unknown;
  creationSource?: unknown;
  origin?: unknown;
} | null | undefined): SalesOrderCreationSource | null {
  if (!order || typeof order !== 'object') return null;
  const raw =
    (order as Record<string, unknown>).creation_source ??
    (order as Record<string, unknown>).creationSource ??
    (order as Record<string, unknown>).origin ??
    null;
  return normalizeCreationSource(typeof raw === 'string' ? raw : null);
}

export interface SalesOrderItem {
  id: string;
  productId: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  lineTotal?: number;
  productName?: string;
  subtotal?: number;
  price?: number;
  parentId?: string;
  variantId?: string;
  pagesOverride?: number;
  pricingSource?: string;
  pricingBreakdown?: any;
  smartPricingSnapshot?: any;
  adjustmentSnapshots?: any[];
  transactionAdjustmentSnapshots?: any[];
  productionCostSnapshot?: any;
  [key: string]: any;
}

export interface SalesOrderPayment {
  id: string;
  orderId: string;
  amount: number;
  method: string;
  date: string;
  amountPaid?: number;
  paymentMethod?: string;
  paymentDate?: string;
  recordedBy?: string;
  reference?: string;
  accountId?: string;
  [key: string]: any;
}

export interface SalesOrderConversionDetails {
  sourceType?: string;
  sourceNumber?: string;
  date?: string;
  acceptedBy?: string;
  [key: string]: any;
}

export interface SalesOrder {
  id: string;
  orderNumber?: string;
  orderNumberProvisional?: boolean;
  status: SalesOrderStatus | string;
  paymentStatus?: SalesOrderPaymentStatus;
  invoiceStatus?: SalesOrderInvoiceStatus;
  legacyStatus?: string;
  customerId?: string | null;
  customerName?: string;
  salesPersonId?: string | null;
  territoryId?: string | null;
  orderDate: string;
  date?: string;
  deliveryDate?: string | null;
  currency?: string;
  items: SalesOrderItem[];
  subtotal: number;
  discounts?: number;
  discount?: number;
  discountType?: string;
  discountRaw?: number;
  tax?: number;
  taxRate?: number;
  otherCharges?: number;
  total: number;
  totalAmount?: number;
  paidAmount?: number;
  remainingBalance?: number;
  payments?: SalesOrderPayment[];
  quotationId?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  sourceRequestId?: string;
  sourceRequestNumber?: string;
  referenceDoc?: string;
  source?: string;
  /** Explicit persisted creation source (snake + camel kept in sync for sync gateway). */
  creation_source?: SalesOrderCreationSource | string;
  creationSource?: SalesOrderCreationSource | string;
  conversionDetails?: SalesOrderConversionDetails;
  convertedAt?: string;
  convertedBy?: string;
  convertedJobTicketId?: string;
  linkedWorkOrderId?: string;
  conversionStatus?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  notes?: string | string[];
  shippingAddress?: any;
  billingAddress?: any;
  referredBy?: string;
  referredByName?: string;
  adjustmentSnapshots?: any[];
  adjustmentTotal?: number;
  materialTotal?: number;
  profitMarginTotal?: number;
  roundingTotal?: number;
  roundingDifference?: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  idempotencyKey?: string;
  companyId?: string;
  /** Optimistic concurrency control version — bumped on every cloud write. */
  version?: number;
  /** Server-side updated_at timestamp, preserved during cloud-to-local merge. */
  serverUpdatedAt?: string;
  [key: string]: any;
}

/** Canonical lifecycle in order. */
export const SALES_ORDER_STATUSES: readonly SalesOrderStatus[] = [
  'Draft',
  'Confirmed',
  'Processing',
  'Fulfilled',
  'Cancelled',
  'Converted',
] as const;

/** Legacy `orders`-store status -> canonical mapping (status field). */
export const LEGACY_STATUS_MAP: Record<string, SalesOrderStatus | undefined> = {
  Pending: 'Confirmed',
  Completed: 'Fulfilled',
  Cancelled: 'Cancelled',
  Converted: 'Converted',
  Draft: 'Draft',
  Confirmed: 'Confirmed',
  Processing: 'Processing',
  Fulfilled: 'Fulfilled',
  Paid: undefined,
  'Partially Paid': undefined,
};

/** Statuses that were payment-state in the legacy model, mapped to paymentStatus. */
export const LEGACY_PAYMENT_STATUS_MAP: Record<string, SalesOrderPaymentStatus> = {
  Paid: 'Paid',
  'Partially Paid': 'Partially Paid',
  Partial: 'Partially Paid',
};

export const SALES_ORDER_PAYMENT_STATUSES: readonly SalesOrderPaymentStatus[] = [
  'Unpaid',
  'Partially Paid',
  'Paid',
];

export const SALES_ORDER_INVOICE_STATUSES: readonly SalesOrderInvoiceStatus[] = [
  'Not Invoiced',
  'Invoiced',
];

export const TERMINAL_SALES_ORDER_STATUSES: readonly SalesOrderStatus[] = [
  'Fulfilled',
  'Cancelled',
  'Converted',
];

export function isCanonicalStatus(status: string): boolean {
  return (SALES_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * Translate any legacy or canonical status into the canonical vocabulary.
 * Legacy payment-only statuses ('Paid', 'Partially Paid') resolve to the
 * canonical status (typically 'Confirmed') and are reflected in
 * `paymentStatus` via `derivePaymentStatus`.
 */
export function canonicalizeStatus(status?: string | null): SalesOrderStatus {
  const s = String(status || '').trim();
  if (!s) return 'Confirmed';
  if (isCanonicalStatus(s)) return s as SalesOrderStatus;
  const mapped = LEGACY_STATUS_MAP[s] || LEGACY_STATUS_MAP[s.toLowerCase()];
  if (mapped) return mapped;
  return 'Confirmed';
}

/** Map a legacy payment-state status to canonical paymentStatus ('' when not payment-state). */
export function legacyPaymentStatus(status?: string | null): SalesOrderPaymentStatus | null {
  const s = String(status || '').trim();
  return LEGACY_PAYMENT_STATUS_MAP[s] || LEGACY_PAYMENT_STATUS_MAP[s.toLowerCase()] || null;
}

/** Derive paymentStatus from paid/total amounts (and optional legacy status). */
export function derivePaymentStatus(
  paidAmount: number,
  totalAmount: number,
  legacyStatus?: string | null,
): SalesOrderPaymentStatus {
  const fromLegacy = legacyPaymentStatus(legacyStatus);
  if (fromLegacy) return fromLegacy;
  if (paidAmount > 0 && totalAmount > 0 && paidAmount >= totalAmount - 0.005) return 'Paid';
  if (paidAmount > 0) return 'Partially Paid';
  return 'Unpaid';
}

export function deriveInvoiceStatus(
  invoiceId?: string | null,
  invoiceNumber?: string | null,
  legacyStatus?: string | null,
): SalesOrderInvoiceStatus {
  if (invoiceId || invoiceNumber) return 'Invoiced';
  if (String(legacyStatus || '').toLowerCase() === 'converted') return 'Invoiced';
  return 'Not Invoiced';
}

export function isTerminalStatus(status?: string | null): boolean {
  return (TERMINAL_SALES_ORDER_STATUSES as readonly string[]).includes(
    String(status || '').trim() as string,
  );
}

export function isCancelableStatus(status?: string | null): boolean {
  return !isTerminalStatus(status);
}

/** Display label for any status (canonical or legacy). */
export function displayStatus(status?: string | null): string {
  return canonicalizeStatus(status);
}

/**
 * True when the record carries a provisional (client-minted) order number.
 * Explicit flag wins. Otherwise official unified numbers
 * (SO|ORD-{series}/NNN) and legacy ORD-YYYY-NNNNNN are NOT provisional;
 * everything else (missing, TMP-, short SO-####/ORD-#### without a series
 * slash, ORDER-, bare ids) IS provisional and must never be presented as
 * the official Sales Order number.
 */
const OFFICIAL_UNIFIED_PATTERN = /^(SO|ORD)-([A-Za-z0-9]+)\/(\d+)$/i;
const LEGACY_ORD_YEAR_PATTERN = /^ORD-\d{4}-\d{6}$/;
export function isProvisionalNumber(order: Pick<SalesOrder, 'orderNumber' | 'orderNumberProvisional'>): boolean {
  if (order.orderNumberProvisional === true) return true;
  const value = String((order as { orderNumber?: unknown }).orderNumber || '').trim();
  if (!value) return true;
  if (OFFICIAL_UNIFIED_PATTERN.test(value)) return false;
  if (LEGACY_ORD_YEAR_PATTERN.test(value)) return false;
  return true;
}