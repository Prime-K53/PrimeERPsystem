/**
 * transportBudgetEventRepository.cjs — Phase 5A backend Transport Budget
 * event repository.
 *
 * Uses the EXISTING Phase 4 append mechanism: the narrowly-scoped atomic
 * PostgREST RPC `append_transport_budget_event(JSONB)`
 * (supabase/migrations/0029_transport_budget_events.sql), reached through
 * supabaseRepository's service-role transport. There is deliberately NO
 * direct INSERT path into `transport_budget_events` here — the RPC is the
 * authoritative idempotent append (physical-id retry, economic-key retry,
 * insert) and the Phase 4 BEFORE INSERT trigger remains the integrity
 * authority on every write path.
 *
 * Correctness layers (mirrors frontend/services/repositories/
 * transportBudgetRepository.ts semantics):
 *   1. Pure validator (fail-closed shape checks, identical codes).
 *   2. RPC-side idempotency: same idempotencyKey -> the existing economic
 *      event (no second event); same id + identical payload -> same row.
 *   3. Database triggers (authoritative): per-kind matrix, 4-decimal rate
 *      restriction, positive SALES_ALLOCATION, append-only immutability,
 *      unique idempotency key.
 *
 * The backend has NO local transport-budget store: the existing backend
 * Transport Budget infrastructure is the Supabase event ledger + RPC. When
 * Supabase is unavailable the append fails loudly (caller logs; API
 * responses are never affected).
 */

const crypto = require('crypto');
const supabaseRepository = require('./supabaseRepository.cjs');
const {
  assertValidTransportBudgetEvent,
  TransportBudgetValidationError,
} = require('./transportBudgetEventValidator.cjs');

/** Physical event id: independently generated UUID (never Date.now()). */
const generateEventId = () => crypto.randomUUID();

const nowIso = () => new Date().toISOString();

class TransportBudgetAppendError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TransportBudgetAppendError';
    this.cause = cause;
  }
}

/** Injectable transport (tests fake this; production uses the Phase 4 RPC). */
const defaultTransport = {
  async callAppendRpc(payload) {
    const row = await supabaseRepository.callRpc(
      'append_transport_budget_event',
      { p_event: payload },
    );
    if (row === null || row === undefined) {
      throw new TransportBudgetAppendError(
        'Transport Budget append RPC unavailable (Supabase not configured or returned no data)',
      );
    }
    return row;
  },
};

/** Normalize an RPC envelope row { id, data, ... } into the event shape. */
const fromEnvelopeRow = (row) => {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return {
    ...data,
    id: row.id,
    createdAt: data.createdAt || row.created_at || null,
  };
};

class TransportBudgetEventRepository {
  constructor(transport = defaultTransport) {
    this.transport = transport;
  }

  /**
   * Append a new event (or resolve a retry to the existing event).
   * Never edits, never deletes, never calculates business meaning.
   *
   * Event id is generated here when absent (independent physical identity);
   * economic identity comes from the caller via idempotencyKey.
   */
  async appendTransportBudgetEvent(input) {
    const timestamp = nowIso();
    const candidate = {
      ...input,
      id:
        typeof input.id === 'string' && input.id.trim() !== ''
          ? input.id.trim()
          : generateEventId(),
      occurredAt:
        typeof input.occurredAt === 'string' && String(input.occurredAt).trim() !== ''
          ? String(input.occurredAt)
          : timestamp,
    };

    // 1. Fail-closed shape validation (never calculates business meaning).
    const event = assertValidTransportBudgetEvent(candidate, timestamp);

    // 2. Authoritative idempotent append through the Phase 4 RPC. The RPC:
    //    - same id + identical payload -> existing row (no second event)
    //    - same idempotencyKey          -> existing economic event
    //    - otherwise                    -> INSERT (Phase 4 triggers apply)
    const payload = { ...event };
    const row = await this.transport.callAppendRpc(payload);
    const stored = fromEnvelopeRow(row);

    // Best-effort dedupe detection for observability: a row stored under a
    // different physical id than the submitted one is definitively an
    // economic-key retry. Same-id retries are indistinguishable from fresh
    // inserts through the RPC contract (the database uniqueness guarantees
    // correctness either way).
    const deduplicated = Boolean(stored && stored.id && event.id && stored.id !== event.id);

    return { event: stored || event, deduplicated };
  }
}

/** Default production repository (Phase 4 RPC transport). */
const transportBudgetEventRepository = new TransportBudgetEventRepository();

module.exports = {
  TransportBudgetEventRepository,
  TransportBudgetAppendError,
  TransportBudgetValidationError,
  transportBudgetEventRepository,
  generateEventId,
};
