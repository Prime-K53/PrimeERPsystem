/**
 * transportBudgetVoidReversal.cjs — Phase 9B backend void reversal.
 *
 * Backend-originated full-void REVERSAL for the direct-API void pathways
 * (DELETE /api/sales/:id, DELETE /api/invoices/:id, recognized ->
 * unrecognized demotions via PUT). Mirrors the frontend
 * transportBudgetVoidReversal.ts semantics exactly:
 *
 *   SALES_ALLOCATION +X  ->  REVERSAL -X  (exact negative of the ORIGINAL
 *   allocation amount; never today's total; no rate lookup; no rounding
 *   beyond what the frozen amount already carries).
 *
 * Design rules (same as the frontend void path):
 * - The persisted allocation is authoritative: resolved by the deterministic
 *   key SALES_ALLOCATION:{economicId}. Missing allocation (or a row whose
 *   kind is not SALES_ALLOCATION) fails closed with missing-allocation —
 *   nothing is fabricated.
 * - Identity is backend-raw (sale.id / invoice.id), matching the backend
 *   allocation producer (no mirror/conversion metadata server-side). A
 *   frontend mirror-keyed allocation under a different id is correctly
 *   invisible here; its economics belong to the mirror-invoice path, so no
 *   second reversal can arise.
 * - Runs AFTER the commercial void has committed (route handlers invoke it
 *   post-persistence, fire-and-forget). Failures are logged loudly and never
 *   roll back the committed void; retries converge on REVERSAL:{id}:VOID.
 * - No GL journals, no COGS/WAC/inventory/revenue/AR changes, no customer
 *   payload changes. The reversal exists ONLY as a Transport Budget event
 *   appended through the Phase 4 RPC repository (shape-validated, trigger-
 *   enforced, idempotent).
 */

const supabaseRepository = require('./supabaseRepository.cjs');
const {
  transportBudgetEventRepository,
} = require('./transportBudgetEventRepository.cjs');

class TransportBudgetVoidReversalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransportBudgetVoidReversalError';
    this.code = code;
  }
}

/** Deterministic identities (same frozen namespaces as the frontend). */
const salesAllocationIdempotencyKey = (economicId) =>
  `SALES_ALLOCATION:${String(economicId || '').trim()}`;
const voidReversalIdempotencyKey = (economicId) =>
  `REVERSAL:${String(economicId || '').trim()}:VOID`;

/** Normalize a PostgREST transport_budget_events envelope row to event shape. */
const fromEnvelopeRow = (row) => {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return { ...data, id: row.id };
};

const buildVoidReversalDeps = () => ({
  findAllocationByKey: async (allocationKey) => {
    const rows = await supabaseRepository.getAllFlat('transport_budget_events', {
      'data->>idempotencyKey': `eq.${allocationKey}`,
      limit: 1,
    });
    return fromEnvelopeRow(rows && rows[0]);
  },
  appendReversalEvent: (input) =>
    transportBudgetEventRepository.appendTransportBudgetEvent(input),
  nowIso: () => new Date().toISOString(),
});

/**
 * Produce the full-void REVERSAL for a backend-voided sale/invoice.
 * Fail-closed on a missing allocation; never throws (hook-safe).
 */
async function produceVoidReversalForVoidedDoc(
  deps = buildVoidReversalDeps(),
  { id } = {},
) {
  try {
    const economicId = String(id || '').trim();
    if (!economicId) {
      return { status: 'skipped', reason: 'no-identity' };
    }
    const allocationKey = salesAllocationIdempotencyKey(economicId);
    const original = await deps.findAllocationByKey(allocationKey);
    if (!original || original.kind !== 'SALES_ALLOCATION') {
      return {
        status: 'missing-allocation',
        economicKey: economicId,
        allocationKey,
      };
    }
    const result = await deps.appendReversalEvent({
      kind: 'REVERSAL',
      // Exact negative of the ORIGINAL allocation (never today's total).
      amount: -Number(original.amount),
      reversesEventId: String(original.id),
      correctsEventId: null,
      idempotencyKey: voidReversalIdempotencyKey(economicId),
      // Source period is inherited, never restated to the void period.
      businessDate: String(original.businessDate),
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      method: null,
      providerId: null,
      occurredAt: deps.nowIso(),
    });
    return {
      status: 'appended',
      event: result.event,
      deduplicated: result.deduplicated,
    };
  } catch (err) {
    return { status: 'failed', error: err };
  }
}

/**
 * Post-persistence fire-and-forget hook (mirrors fireAllocationHook):
 * loud on failure with endpoint + document context, never rolls back the
 * committed void, never blocks the response.
 */
function fireVoidReversalHook(task, endpoint, sourceDocumentId) {
  task.catch((err) => {
    console.error(
      `[TransportBudget] void reversal failed (endpoint=${endpoint}, document=${sourceDocumentId}, stage=${err.code || 'APPEND'}, error=${err.message})`,
    );
  });
}

module.exports = {
  TransportBudgetVoidReversalError,
  salesAllocationIdempotencyKey,
  voidReversalIdempotencyKey,
  buildVoidReversalDeps,
  produceVoidReversalForVoidedDoc,
  fireVoidReversalHook,
};
