/**
 * transactionRef — shared, read-only navigation resolver for ERP transaction
 * references (invoice / quotation / order / payment / receipt / purchase /
 * delivery note / examination batch / …).
 *
 * Design constraints (ERP only — no Portal, no backend):
 *  • Navigation never mutates business data.
 *  • A destination is only produced when the caller supplies enough identity
 *    information to open **exactly one** record. When nothing usable is known
 *    we return `null` so the caller can render plain text instead of risking a
 *    jump to an unrelated transaction.
 *  • Record lookup prefers the authoritative internal `id` and only falls back
 *    to the (potentially ambiguous) display number. Ambiguous numbers resolve
 *    to `ambiguous`, never to a guess.
 *  • Identity travels in the query string so the destination keeps working
 *    across refresh, direct URL entry and back/forward navigation.
 */

/* ── query-string contract ────────────────────────────────────────────────── */

export const TX_REF_PARAM = 'txRef';
export const TX_ID_PARAM = 'txId';
export const TX_NUMBER_PARAM = 'txNo';

/* ── supported transaction types ──────────────────────────────────────────── */

export type TransactionRefType =
  | 'invoice'
  | 'examination-invoice'
  | 'quotation'
  | 'order'
  | 'job-order'
  | 'subscription'
  | 'exchange'
  | 'quotation-request'
  | 'payment'
  | 'receipt'
  | 'supplier-payment'
  | 'purchase'
  | 'purchase-order'
  | 'grn'
  | 'delivery-note'
  | 'examination-batch'
  | 'expense'
  | 'transport-expense'
  | 'income'
  | 'journal-entry'
  | 'transfer'
  | 'work-order'
  | 'customer-statement'
  | 'supplier-statement';

interface TypeSpec {
  /** Module route that owns the detail view. */
  route: string;
  /** Human label used for titles / accessible names. */
  label: string;
  /**
   * When set, a record with a known id is addressed directly by path
   * (`route/:id`) instead of going through the module list.
   */
  pathParam?: string;
}

export const TRANSACTION_REF_TYPES: Record<TransactionRefType, TypeSpec> = {
  invoice: { route: '/sales-flow/invoices', label: 'Invoice' },
  'examination-invoice': { route: '/sales-flow/invoices', label: 'Examination invoice' },
  quotation: { route: '/sales-flow/quotations', label: 'Quotation' },
  order: { route: '/sales-flow/orders', label: 'Order' },
  'job-order': { route: '/sales-flow/sales-orders', label: 'Sales order' },
  subscription: { route: '/sales-flow/subscriptions', label: 'Subscription' },
  exchange: { route: '/sales-flow/exchanges', label: 'Exchange' },
  'quotation-request': { route: '/sales-flow/requests', label: 'Quotation request' },
  payment: { route: '/sales-flow/payments', label: 'Payment' },
  receipt: { route: '/sales-flow/payments', label: 'Receipt' },
  'supplier-payment': { route: '/procurement/payments', label: 'Supplier payment' },
  purchase: { route: '/procurement/bills', label: 'Purchase bill' },
  'purchase-order': { route: '/procurement/bills', label: 'Purchase order' },
  grn: { route: '/supply-chain/grn', label: 'Goods received note' },
  'delivery-note': { route: '/supply-chain/shipping', label: 'Delivery note' },
  'examination-batch': { route: '/examination/batches', label: 'Examination batch', pathParam: 'batchId' },
  expense: { route: '/procurement/expenses', label: 'Expense' },
  'transport-expense': { route: '/procurement/transport-expenses', label: 'Transport expense' },
  income: { route: '/accounts/income', label: 'Income' },
  'journal-entry': { route: '/fiscal-reports/ledgers', label: 'Journal entry' },
  transfer: { route: '/accounts/transfers', label: 'Transfer' },
  'work-order': { route: '/industrial/work-orders', label: 'Work order' },
  'customer-statement': { route: '/revenue/contacts', label: 'Customer statement' },
  'supplier-statement': { route: '/revenue/contacts', label: 'Supplier statement' },
};

const TYPE_ALIASES: Record<string, TransactionRefType> = {
  inv: 'invoice',
  sale: 'invoice',
  possale: 'invoice',
  sales_invoice: 'invoice',
  salesinvoice: 'invoice',
  examination_invoice: 'examination-invoice',
  examinationinvoice: 'examination-invoice',
  exam_invoice: 'examination-invoice',
  exm_invoice: 'examination-invoice',
  quote: 'quotation',
  quotations: 'quotation',
  sales_order: 'order',
  so: 'order',
  orders: 'order',
  jobticket: 'job-order',
  job_ticket: 'job-order',
  jobticket_number: 'job-order',
  joborder: 'job-order',
  job_orders: 'job-order',
  recurring: 'subscription',
  sales_exchange: 'exchange',
  salesexchange: 'exchange',
  payment_receipt: 'receipt',
  receipt: 'receipt',
  pay: 'payment',
  payments: 'payment',
  customerpayment: 'payment',
  customer_payment: 'payment',
  receiptpayment: 'receipt',
  supplier_payment: 'supplier-payment',
  supplierpayment: 'supplier-payment',
  bill: 'purchase',
  purchase_bill: 'purchase',
  purchasebill: 'purchase',
  supplier_invoice: 'purchase',
  po: 'purchase-order',
  purchaseorder: 'purchase-order',
  purchase_order: 'purchase-order',
  goods_received: 'grn',
  grn_number: 'grn',
  goods_received_note: 'grn',
  goodsreceipt: 'grn',
  goods_receipt: 'grn',
  dn: 'delivery-note',
  deliverynote: 'delivery-note',
  delivery_note: 'delivery-note',
  deliverynotes: 'delivery-note',
  exam_batch: 'examination-batch',
  examinationbatch: 'examination-batch',
  examination_batch: 'examination-batch',
  batch: 'examination-batch',
  batchnumber: 'examination-batch',
  transport: 'transport-expense',
  workorder: 'work-order',
  job_work_order: 'work-order',
  journal: 'journal-entry',
  journalentry: 'journal-entry',
  ledger_entry: 'journal-entry',
  customer_statement: 'customer-statement',
  supplier_statement: 'supplier-statement',
  statement: 'customer-statement',
};

/**
 * Normalise a caller-supplied type string. Unknown / empty input yields
 * `null` — we never guess a transaction type from a display number.
 */
export function normalizeTransactionRefType(value: unknown): TransactionRefType | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if ((TRANSACTION_REF_TYPES as Record<string, unknown>)[raw]) return raw as TransactionRefType;
  const alias = TYPE_ALIASES[raw.replace(/[\s_-]+/g, '')];
  if (alias) return alias;
  const dashed = raw.replace(/[\s_]+/g, '-');
  if ((TRANSACTION_REF_TYPES as Record<string, unknown>)[dashed]) return dashed as TransactionRefType;
  return null;
}

/** Human label for a type; falls back to the raw type when unknown. */
export function transactionRefLabel(type: unknown): string {
  const norm = normalizeTransactionRefType(type);
  if (!norm) return 'Transaction';
  return TRANSACTION_REF_TYPES[norm].label;
}

/* ── safe string helpers ──────────────────────────────────────────────────── */

/** Trim + collapse a possibly-absent identifier into a comparable string. */
export function normalizeRefKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Legacy rows sometimes carry a number that was stored URL-encoded (numbers
 * such as `INV-P726/021` survive a round-trip through a query string).
 * Compare both the raw and the decoded form so those references still resolve.
 */
function candidateKeys(value: string): string[] {
  const keys = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) keys.push(decoded);
  } catch {
    /* malformed escape sequence — keep the raw form only */
  }
  return keys;
}

/* ── destination resolution ───────────────────────────────────────────────── */

export interface TransactionRefInput {
  /** Explicit record type. Required — never inferred from the display text. */
  type: unknown;
  /** Authoritative internal record id (preferred). */
  id?: unknown;
  /** Human-visible document number (fallback). */
  number?: unknown;
  /**
   * Optional existing query string on the destination route that should be
   * preserved (report filters, module tabs, …).
   */
  preserveSearch?: string;
}

export interface TransactionRefDestination {
  type: TransactionRefType;
  label: string;
  pathname: string;
  search: string;
  /** Router-relative location, safe to hand to `navigate()` / an `<a href>`. */
  to: string;
  id: string;
  number: string;
}

function buildSearch(params: Array<[string, string]>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of params) {
    if (value) sp.set(key, value);
  }
  const encoded = sp.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Resolve a reference into a concrete destination, or `null` when the
 * reference cannot be addressed safely.
 *
 * Returns `null` when:
 *  • the type is unknown/unsupported, or
 *  • neither an id nor a display number is available.
 */
export function resolveTransactionDestination(
  input: TransactionRefInput,
): TransactionRefDestination | null {
  const type = normalizeTransactionRefType(input?.type);
  if (!type) return null;

  const id = normalizeRefKey(input?.id);
  const number = normalizeRefKey(input?.number);
  if (!id && !number) return null;

  const spec = TRANSACTION_REF_TYPES[type];

  // Direct detail route when the owning module exposes one and we hold the id.
  if (spec.pathParam && id) {
    return {
      type,
      label: spec.label,
      pathname: `${spec.route}/${encodeURIComponent(id)}`,
      search: '',
      to: `${spec.route}/${encodeURIComponent(id)}`,
      id,
      number,
    };
  }

  // Preserve any pre-existing destination filters (e.g. `?tab=history`).
  let preserved = '';
  if (typeof input?.preserveSearch === 'string' && input.preserveSearch) {
    const raw = input.preserveSearch.startsWith('?') ? input.preserveSearch.slice(1) : input.preserveSearch;
    try {
      preserved = new URLSearchParams(raw).toString();
    } catch {
      preserved = '';
    }
  }

  const params: Array<[string, string]> = [];
  if (preserved) {
    for (const [key, value] of new URLSearchParams(preserved).entries()) params.push([key, value]);
  }
  params.push([TX_REF_PARAM, type]);
  // URLSearchParams already percent-encodes `/` and friends.
  params.push([TX_ID_PARAM, id]);
  params.push([TX_NUMBER_PARAM, number]);

  const search = buildSearch(params);
  return {
    type,
    label: spec.label,
    pathname: spec.route,
    search,
    to: `${spec.route}${search}`,
    id,
    number,
  };
}

/* ── reading a reference back off the URL ─────────────────────────────────── */

export interface ParsedTransactionRef {
  type: TransactionRefType;
  id: string;
  number: string;
}

/**
 * Read the transaction-ref contract out of a query string. Returns `null` when
 * the query string does not carry a *supported* reference.
 */
export function readTransactionRefFromSearch(search: string): ParsedTransactionRef | null {
  if (!search) return null;
  try {
    const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const type = normalizeTransactionRefType(sp.get(TX_REF_PARAM));
    if (!type) return null;
    const id = normalizeRefKey(sp.get(TX_ID_PARAM));
    const number = normalizeRefKey(sp.get(TX_NUMBER_PARAM));
    if (!id && !number) return null;
    return { type, id, number };
  } catch {
    return null;
  }
}

/* ── record lookup (the "open exactly one record" guarantee) ──────────────── */

export type RefLookupStatus = 'ok' | 'missing' | 'ambiguous';

export interface RefLookupResult<T> {
  status: RefLookupStatus;
  record?: T;
  /** Number of matches found for the winning criterion. */
  matchCount: number;
}

export interface RefLookupOptions<T> {
  /** Fields that hold the authoritative id. Default: `['id']`. */
  idKeys?: Array<keyof T | string>;
  /** Fields that hold the display number. Default: `['number']`. */
  numberKeys?: Array<keyof T | string>;
}

const DEFAULT_NUMBER_KEYS = [
  'number',
  'invoiceNumber',
  'invoice_number',
  'invoiceRef',
  'quotationNumber',
  'quotation_number',
  'orderNumber',
  'order_number',
  'receiptNumber',
  'receipt_number',
  'reference',
  'referenceNumber',
  'reference_number',
  'documentNumber',
  'document_number',
  'transactionNumber',
  'paymentNumber',
  'payment_number',
  'poNumber',
  'po_number',
  'purchaseOrderNumber',
  'purchase_order_number',
  'dnNumber',
  'dn_number',
  'deliveryNoteNumber',
  'delivery_number',
  'batchNumber',
  'batch_number',
  'exchange_number',
  'exchangeNumber',
  'request_number',
  'requestNumber',
  'jobOrderNumber',
  'job_no',
  'statementNumber',
];

function readField<T>(record: T, keys: Array<keyof T | string>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = (record as Record<string, unknown>)?.[key as string];
    const norm = normalizeRefKey(value);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Find the single record addressed by a reference.
 *
 * Precedence:
 *  1. exact `id` match — authoritative;
 *  2. exact display-number match, including legacy URL-encoded forms.
 *
 * More than one match on the winning criterion yields `ambiguous` so callers
 * can refuse to open anything rather than showing the wrong transaction.
 */
export function lookupRecordByRef<T>(
  records: readonly T[] | null | undefined,
  ref: { id?: unknown; number?: unknown } | null | undefined,
  options: RefLookupOptions<T> = {},
): RefLookupResult<T> {
  const list = Array.isArray(records) ? records : [];
  const id = normalizeRefKey(ref?.id);
  const number = normalizeRefKey(ref?.number);

  const idKeys = (options.idKeys ?? (['id'] as Array<keyof T | string>)).map(String);
  const numberKeys = (options.numberKeys ?? (DEFAULT_NUMBER_KEYS as unknown as Array<keyof T | string>))
    .map(String);

  if (id) {
    const idMatches = list.filter((r) => readField(r, idKeys).includes(id));
    if (idMatches.length === 1) return { status: 'ok', record: idMatches[0], matchCount: 1 };
    if (idMatches.length > 1) return { status: 'ambiguous', matchCount: idMatches.length };
  }

  if (number) {
    const wanted = new Set(candidateKeys(number));
    const numberMatches = list.filter((r) =>
      readField(r, numberKeys).some((v) => candidateKeys(v).some((c) => wanted.has(c))),
    );
    if (numberMatches.length === 1) return { status: 'ok', record: numberMatches[0], matchCount: 1 };
    if (numberMatches.length > 1) return { status: 'ambiguous', matchCount: numberMatches.length };
  }

  return { status: 'missing', matchCount: 0 };
}

/** Convenience: true only when a reference can be addressed without guessing. */
export function isResolvableTransactionRef(input: TransactionRefInput): boolean {
  return resolveTransactionDestination(input) !== null;
}

/* ── originating-transaction metadata (ledgers, audit logs, mixed lists) ──── */

/**
 * Determine the originating transaction of a mixed record (ledger entry, audit
 * log row, activity feed item) from its own metadata — **never** from the
 * displayed text. Returns `null` when no reliable link exists, so callers can
 * keep the value as plain text instead of guessing a destination.
 */
export function resolveOriginatingTransactionRef(
  record: Record<string, unknown> | null | undefined,
): { type: TransactionRefType; id: string; number: string } | null {
  if (!record || typeof record !== 'object') return null;

  const rawType =
    (record as any).referenceType ??
    (record as any).sourceType ??
    (record as any).source_type ??
    (record as any).transactionType ??
    (record as any).entryType ??
    (record as any).originModule;
  const type = normalizeTransactionRefType(rawType);
  if (!type) return null;

  const id = normalizeRefKey((record as any).referenceId ?? (record as any).sourceId ?? (record as any).id);
  const number = normalizeRefKey(
    (record as any).reference ??
      (record as any).referenceNumber ??
      (record as any).documentNumber ??
      (record as any).sourceNumber,
  );
  if (!id && !number) return null;
  return { type, id, number };
}