/**
 * transportBudget.ts — Phase 4: Transport Budget Event Ledger model.
 *
 * Isolated internal management-budget event system. NOT General Ledger, NOT
 * AR, NOT inventory, NOT COGS, NOT cash/tax, NOT customer statements, NOT
 * invoice lines, NOT delivery charges, NOT Landing Cost accounting. It never
 * touches `ledger_entries`.
 *
 * Every event is a SIGNED budget movement whose amount is stored exactly as
 * supplied by the (future) producer and never recalculated here:
 *   SALES_ALLOCATION    amount > 0   (budget generation)
 *   REVERSAL            amount < 0   (linked to one SALES_ALLOCATION)
 *   INBOUND_CONSUMPTION amount < 0   (budget consumption)
 *   OUTBOUND_CONSUMPTION amount < 0  (budget consumption)
 *   CONSUMPTION_CORRECTION amount > 0 (Phase 7E: single positive delta
 *     linked to one INBOUND_CONSUMPTION via correctsEventId; REVERSAL is
 *     never reused for consumption correction)
 *
 * Identity model (do not conflate the two):
 *   id             = physical record identity (client-generated UUID before
 *                    persistence, stable offline -> queue -> server -> pull).
 *   idempotencyKey = economic identity (e.g. conceptually
 *                    SALES_ALLOCATION:{convertedInvoiceId ?? saleId} for
 *                    future sales producers). Unique, immutable, preserved
 *                    through sync. A retry with the same key resolves to the
 *                    same economic event instead of creating a second one.
 *                    Phase 4 provides this infrastructure only; the sales
 *                    identity detection itself belongs to a later phase.
 */

/** Canonical ledger store/table names (single source for the repository). */
export const TRANSPORT_BUDGET_STORE_NAME = 'transportBudgetEvents' as const;
export const TRANSPORT_BUDGET_TABLE_NAME = 'transport_budget_events' as const;

/** Exactly the five canonical event kinds. No speculative types. */
export const TRANSPORT_BUDGET_EVENT_KINDS = [
  'SALES_ALLOCATION',
  'REVERSAL',
  'INBOUND_CONSUMPTION',
  'OUTBOUND_CONSUMPTION',
  'CONSUMPTION_CORRECTION',
] as const;

export type TransportBudgetEventKind =
  (typeof TRANSPORT_BUDGET_EVENT_KINDS)[number];

/**
 * A persisted transport budget event (local IndexedDB shape == cloud `data`
 * payload shape; the sync envelope adds id/created_at/updated_at/version
 * around it without changing these fields).
 */
export interface TransportBudgetEvent {
  /** Stable client-generated UUID (offline-safe, never regenerated). */
  id: string;
  /** Canonical event kind (exact uppercase match). */
  kind: TransportBudgetEventKind;
  /**
   * Immutable unique economic/idempotency key.
   * Never edited after creation.
   */
  idempotencyKey: string;
  /**
   * Generic source document/event identity (e.g. future sale, Landing Cost
   * event, or delivery/expense source). Required for SALES_ALLOCATION,
   * optional for consumptions, forbidden for REVERSAL (which links via
   * reversesEventId instead).
   */
  sourceEventId: string | null;
  /**
   * Source-document amount snapshot in canonical currency units (2dp).
   * Required (> 0) for SALES_ALLOCATION; otherwise optional metadata.
   * Forbidden for REVERSAL.
   */
  sourceAmount: number | null;
  /**
   * Historical allocation-rate snapshot (percent, 0..100, max 4 decimals,
   * exact precision preserved — e.g. 2.755). Never re-resolved from CompanyConfig on read.
   * Required for SALES_ALLOCATION; forbidden for all other kinds.
   */
  allocationRatePercent: number | null;
  /**
   * Signed budget movement in canonical currency units (2dp), authoritative
   * as supplied by the producer. Positive for SALES_ALLOCATION and
   * CONSUMPTION_CORRECTION, negative for REVERSAL and both consumptions.
   * Never edited after creation.
   */
  amount: number;
  /**
   * Generic future method tag (e.g. SALES_ALLOCATION, LANDING_COST_FREIGHT,
   * OUTBOUND_TRANSPORT — producers arrive in later phases). Free-form,
   * optional, never interpreted in Phase 4.
   */
  method: string | null;
  /** Generic future provider identity. Optional, never interpreted. */
  providerId: string | null;
  /**
   * Future-compatible accounting metadata. ALWAYS empty in Phase 4
   * (the validator + database reject anything else). The ledger never
   * creates journals, posts, or resolves COA accounts.
   */
  accountSplits: null;
  /** Future-compatible journal metadata. ALWAYS empty in Phase 4. */
  journalIds: null;
  /**
   * Link to the reversed event (physical `id` of a SALES_ALLOCATION).
   * Present if and only if kind === 'REVERSAL'. Immutable once set.
   * Never carried by CONSUMPTION_CORRECTION (which links via
   * correctsEventId instead).
   */
  reversesEventId: string | null;
  /**
   * Link to the corrected consumption (physical `id` of an
   * INBOUND_CONSUMPTION). Present if and only if kind ===
   * 'CONSUMPTION_CORRECTION'. Immutable once set. Phase 7E duplicate-field
   * rule: for corrections, sourceEventId MUST equal this same id; the
   * Landing (grnId, landingCostId) scope is resolved by following
   * correction -> correctsEventId -> original -> sourceEventId.
   */
  correctsEventId: string | null;
  /**
   * Business date (YYYY-MM-DD, date-only, no timezone conversion).
   * Reporting uses this, never created_at / sync time. Immutable.
   */
  businessDate: string;
  /** When the budget effect occurred (ISO-8601). Immutable. */
  occurredAt: string;
  /** When the event record was created locally (ISO-8601). */
  createdAt: string;
}

/**
 * Caller-supplied input for a new event. `id` is optional: when omitted the
 * repository generates a stable UUID before persistence so offline-created
 * events keep the same identity through sync.
 */
export type NewTransportBudgetEventInput = Omit<
  TransportBudgetEvent,
  'createdAt' | 'accountSplits' | 'journalIds'
> & {
  id?: string;
  /** Must be omitted/null in Phase 4 (validator rejects anything else). */
  accountSplits?: null;
  /** Must be omitted/null in Phase 4 (validator rejects anything else). */
  journalIds?: null;
};

/** Deterministic read filter. Date filtering always uses businessDate. */
export interface TransportBudgetEventFilter {
  kind?: TransportBudgetEventKind;
  /** Inclusive lower bound, YYYY-MM-DD. */
  fromBusinessDate?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  toBusinessDate?: string;
  /** Generic source linkage lookup. */
  sourceEventId?: string;
}

/** Machine-readable validation failure codes (fail-closed diagnostics). */
export type TransportBudgetValidationCode =
  | 'INVALID_KIND'
  | 'INVALID_ID'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_AMOUNT'
  | 'INVALID_SIGN'
  | 'INVALID_SOURCE_EVENT_ID'
  | 'INVALID_SOURCE_AMOUNT'
  | 'INVALID_RATE'
  | 'INVALID_BUSINESS_DATE'
  | 'INVALID_OCCURRED_AT'
  | 'INVALID_METHOD'
  | 'INVALID_PROVIDER_ID'
  | 'ACCOUNTING_FIELDS_FORBIDDEN'
  | 'MISSING_REVERSAL_LINK'
  | 'FORBIDDEN_REVERSAL_LINK'
  | 'MISSING_CORRECTION_LINK'
  | 'FORBIDDEN_CORRECTION_LINK'
  | 'FORBIDDEN_SOURCE_FIELDS'
  | 'FORBIDDEN_RATE'
  | 'MISSING_ALLOCATION_FIELDS';

export interface TransportBudgetValidationIssue {
  code: TransportBudgetValidationCode;
  field: string;
  message: string;
}
