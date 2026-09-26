/**
 * erpQueryTypes.ts — General constrained ERP query model for the AI Copilot.
 *
 * The LLM interprets WHAT the user wants (see queryInterpreter.ts).
 * The application retrieves and calculates the data (see queryExecutor.ts).
 * The LLM explains the resulting data (see copilotQueryService.ts).
 *
 * The LLM is never the database: it can only produce an ErpQuery, which is
 * validated against the entity registry before any data is touched. No
 * arbitrary SQL, no mutations, no unrestricted field access.
 */

/** Every ERP entity the Copilot is allowed to read. Extend the registry — never this union alone. */
export type ErpEntityId =
  | 'orders'
  | 'order_items'
  | 'quotations'
  | 'invoices'
  | 'invoice_items'
  | 'customer_payments'
  | 'customers'
  | 'suppliers'
  | 'products'
  | 'inventory_transactions'
  | 'purchases'
  | 'expenses'
  | 'sales'
  | 'delivery_notes'
  | 'supplier_payments'
  | 'income'
  | 'goods_receipts'
  | 'shipments'
  | 'wallet_transactions'
  | 'referrals'
  | 'examination_batches'
  | 'work_orders'
  | 'boms'
  | 'subscriptions';

/** Read-only operations. `retrieve` returns single-record detail; `compare` runs the same aggregation over two periods. */
export type ErpOperation =
  | 'count'
  | 'list'
  | 'retrieve'
  | 'sum'
  | 'average'
  | 'minimum'
  | 'maximum'
  | 'group_by'
  | 'distinct_count'
  | 'compare';

export type ErpFilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'in'
  | 'between';

export interface ErpFilter {
  /** Canonical field name (validated against the entity registry). */
  field: string;
  operator: ErpFilterOperator;
  /** Scalar, array (for `in`/`between`), or date ISO string. Never SQL. */
  value: string | number | boolean | null | Array<string | number>;
}

export type ErpAggregateOperation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct_count';

export interface ErpAggregate {
  field: string;
  operation: ErpAggregateOperation;
  /** Optional label for presentation (e.g. "total_quantity"). */
  as?: string;
}

export interface ErpSort {
  field: string;
  direction: 'asc' | 'desc';
}

/** Absolute, resolved date range. The interpreter produces this from natural language. */
export interface DateScope {
  /** ISO strings (inclusive). Null start/end means open-ended. */
  start: string | null;
  end: string | null;
  /** Human label echoed back so date-scoped answers state their scope. */
  label: string;
  /** Which record date field the range applies to (validated per entity). */
  dateField: string;
}

export interface PeriodComparison {
  current: DateScope;
  previous: DateScope;
}

/**
 * Relationship traversal request. The executor resolves the parent record(s)
 * by stable ID first (name fallback only when IDs are absent), then queries
 * the child entity through the registry-declared link — never by guessing
 * from matching names alone.
 */
export interface ErpRelationship {
  /** Entity holding the parent record(s), e.g. 'customers' for "what did ABC buy". */
  parentEntity: ErpEntityId;
  /** Stable parent id when known. */
  parentId?: string;
  /** Canonical parent display name (businessName for customers) when id is unknown. */
  parentName?: string;
  /** Registry relationship key, e.g. 'customer_orders', 'invoice_payments'. */
  via: string;
}

export interface ErpQuery {
  entity: ErpEntityId;
  operation: ErpOperation;
  filters: ErpFilter[];
  groupBy: string[];
  aggregates: ErpAggregate[];
  sort: ErpSort[];
  /** Max rows to materialise for presentation. The executor always reports the true total. */
  limit: number;
  /** Resolved absolute date range (if the question is date-scoped). */
  dateScope: DateScope | null;
  /** Only set for `compare` operations. */
  comparison: PeriodComparison | null;
  /** Optional relationship traversal (parent → this entity). */
  relationship: ErpRelationship | null;
  /** Entity the caller believes disambiguates an item/customer reference (for error messages). */
  searchHint?: string;
}

export interface ErpAuthContext {
  userId?: string;
  role?: string;
  isAdmin?: boolean;
  /**
   * Returns true when the current user may read the entity through the ERP.
   * Wired to the existing ERP permission checks (see copilotQueryService).
   */
  canRead: (entity: ErpEntityId) => boolean;
}

/** In-memory, already-authorised ERP datasets. The executor never fetches or writes. */
export type ErpDataset = Partial<Record<ErpEntityId, readonly unknown[]>>;

export interface ErpGroupRow {
  key: Record<string, string>;
  count: number;
  aggregates: Record<string, number | null>;
}

export interface ErpQueryResult {
  entity: ErpEntityId;
  operation: ErpOperation;
  /** True total before `limit` truncation. */
  totalCount: number;
  /** Rows actually materialised (length <= limit). */
  rows: Array<Record<string, unknown>>;
  /** Scalar for count/sum/average/min/max/distinct_count. */
  scalar: number | null;
  /** Grouped rows for group_by. */
  groups: ErpGroupRow[];
  /** Comparison outcome for `compare` (current vs previous scalar). */
  comparisonResult: {
    current: number | null;
    previous: number | null;
    delta: number | null;
    deltaPercent: number | null;
  } | null;
  /** True when rows were truncated by `limit`. Never silently claim completeness. */
  truncated: boolean;
  /** Human date scope label (echoed in presentation). */
  scopeLabel: string | null;
  /** Facts actually touched — used for context isolation (only the queried entity). */
  factsUsed: ErpEntityId[];
  warnings: string[];
}

export type ErpQueryErrorCode =
  | 'unsupported_entity'
  | 'unsupported_operation'
  | 'unsupported_field'
  | 'unsupported_relationship'
  | 'invalid_date_range'
  | 'ambiguous_query'
  | 'authorization_denied'
  | 'data_unavailable'
  | 'mutation_rejected'
  | 'query_failed';

export class ErpQueryError extends Error {
  code: ErpQueryErrorCode;
  constructor(code: ErpQueryErrorCode, message: string) {
    super(message);
    this.name = 'ErpQueryError';
    this.code = code;
  }
}

/** Hard cap so "list all 5,000 invoices" never dumps everything into the LLM prompt. */
export const ERP_QUERY_MAX_LIMIT = 50;
/** Absolute safety cap even when a caller requests more. */
export const ERP_QUERY_HARD_CAP = 200;
