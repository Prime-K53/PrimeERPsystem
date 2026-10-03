/**
 * transportBudgetVoidReversal.ts — Phase 6: full-void REVERSAL producer.
 *
 * FROZEN ARCHITECTURE (frontend-originated Model A):
 *   voidInvoice
 *     -> resolve original SALES_ALLOCATION locally
 *     -> perform/persist commercial void mutations
 *     -> commercial persistence completes
 *     -> append deterministic REVERSAL event
 *     -> IndexedDB transport_budget_events
 *     -> durable sync queue
 *     -> /api/sync/ops (transport/write boundary only)
 *
 * This module is the SINGLE semantic full-void REVERSAL producer. It does NOT
 * touch accounting, inventory, payments, Portal, or customer documents, and it
 * does NOT write to Supabase directly — it reuses the existing Phase 4
 * repository (`transportBudgetRepository`) and its append/validator/DB
 * controls unchanged.
 *
 * HISTORICAL ALLOCATION IS AUTHORITATIVE. The reversal amount is the exact
 * negative of the ORIGINAL allocation amount; the current Transport Budget
 * policy / CompanyConfig rate is never consulted.
 *
 * FAIL-CLOSED. If the original SALES_ALLOCATION cannot be found locally, no
 * REVERSAL is produced — no fabricated rate, no zero-value event, no use of
 * the durable-sync `operationId` as a business identity.
 *
 * Phase 4 field hygiene is preserved: the REVERSAL event carries ONLY its
 * signed amount, its `reversesEventId` link, its business date and its
 * deterministic idempotency key. The Phase 4 validator/DB forbid
 * `sourceEventId` / `sourceAmount` / `allocationRatePercent` on REVERSAL
 * (its economics derive from the reversed event), so those fields are null.
 */
import { logger } from './logger';
import { transportBudgetRepository } from './repositories/transportBudgetRepository';
import type { TransportBudgetRepository } from './repositories/transportBudgetRepository';
import type {
  NewTransportBudgetEventInput,
  TransportBudgetEvent,
} from '../types/transportBudget';

/** Fixed operation token in the deterministic reversal identity. */
export const VOID_REVERSAL_OPERATION = 'VOID';

/** Deterministic allocation identity: `SALES_ALLOCATION:${economicKey}`. */
export const salesAllocationIdempotencyKey = (economicKey: string): string =>
  `SALES_ALLOCATION:${String(economicKey ?? '').trim()}`;

/** Deterministic full-void reversal identity: `REVERSAL:${economicKey}:VOID`. */
export const voidReversalIdempotencyKey = (economicKey: string): string =>
  `REVERSAL:${String(economicKey ?? '').trim()}:${VOID_REVERSAL_OPERATION}`;

/**
 * The invoice's economic identity for the void. The posted-invoice allocation
 * producer (`allocateForPostedInvoice`) keys the allocation on the persisted
 * invoice id, so the reversal resolves the same identity.
 */
export const voidEconomicKey = (invoice: { id?: string } | null | undefined): string =>
  String(invoice?.id ?? '').trim();

/** Injectable Phase 4 repository capabilities (read + append-only reversal). */
export type VoidReversalRepository = Pick<
  TransportBudgetRepository,
  'findTransportBudgetEventByIdempotencyKey' | 'appendReversal'
>;

export interface VoidReversalDeps {
  repository: VoidReversalRepository;
  nowIso(): string;
}

/** Production deps: the Phase 4 singleton ledger repository. */
export const defaultVoidReversalDeps: VoidReversalDeps = {
  repository: transportBudgetRepository,
  nowIso: () => new Date().toISOString(),
};

/**
 * REVERSAL input shape accepted by the Phase 4 `appendReversal` control.
 * `id` is supplied as an empty string so the repository generates a stable
 * physical id (its documented optional-id behavior) while satisfying the
 * existing `NewTransportBudgetEventInput` required-id typing.
 */
export type VoidReversalEventInput = Omit<
  NewTransportBudgetEventInput,
  'kind'
> & { kind: 'REVERSAL' };

export type VoidReversalOutcome =
  | {
      status: 'appended';
      event: TransportBudgetEvent;
      deduplicated: boolean;
    }
  | {
      status: 'missing-allocation';
      economicKey: string;
      allocationKey: string;
    }
  | { status: 'skipped'; reason: 'no-identity' };

export type VoidReversalResolution =
  | {
      status: 'ready';
      economicKey: string;
      allocationKey: string;
      original: TransportBudgetEvent;
      input: VoidReversalEventInput;
    }
  | {
      status: 'missing-allocation';
      economicKey: string;
      allocationKey: string;
    }
  | { status: 'skipped'; reason: 'no-identity' };

/**
 * Build the REVERSAL event input from the authoritative original allocation.
 * Pure — no policy lookup, no recalculation, no rounding.
 */
export function buildVoidReversalInput(
  original: TransportBudgetEvent,
  economicKey: string,
  occurredAt: string,
): VoidReversalEventInput {
  return {
    // Blank id => the Phase 4 repository generates a stable physical id.
    id: '',
    kind: 'REVERSAL',
    // Exact negative of the ORIGINAL allocation amount (never today's total).
    amount: -Number(original.amount),
    reversesEventId: String(original.id),
    correctsEventId: null,
    idempotencyKey: voidReversalIdempotencyKey(economicKey),
    businessDate: String(original.businessDate),
    // Phase 4 field hygiene: REVERSAL must not carry source identity/rate.
    sourceEventId: null,
    sourceAmount: null,
    allocationRatePercent: null,
    method: null,
    providerId: null,
    occurredAt,
  };
}

/**
 * Resolve the original SALES_ALLOCATION and prepare the reversal input.
 * Read-only: performs no append.
 */
export async function resolveVoidReversal(
  deps: VoidReversalDeps,
  invoice: { id?: string } | null | undefined,
): Promise<VoidReversalResolution> {
  const economicKey = voidEconomicKey(invoice);
  if (!economicKey) return { status: 'skipped', reason: 'no-identity' };

  const allocationKey = salesAllocationIdempotencyKey(economicKey);
  const original = await deps.repository.findTransportBudgetEventByIdempotencyKey(
    allocationKey,
  );
  if (!original || original.kind !== 'SALES_ALLOCATION') {
    return { status: 'missing-allocation', economicKey, allocationKey };
  }

  return {
    status: 'ready',
    economicKey,
    allocationKey,
    original,
    input: buildVoidReversalInput(original, economicKey, deps.nowIso()),
  };
}

/**
 * Produce the full-void REVERSAL. Fail-closed on a missing allocation.
 * Reuses the Phase 4 `appendReversal` controls (target existence/kind,
 * cumulative cap, deterministic idempotency, append-only).
 */
export async function produceVoidReversal(
  deps: VoidReversalDeps,
  invoice: { id?: string } | null | undefined,
): Promise<VoidReversalOutcome> {
  const resolved = await resolveVoidReversal(deps, invoice);
  if (resolved.status !== 'ready') return resolved;

  const result = await deps.repository.appendReversal(resolved.input);
  return {
    status: 'appended',
    event: result.event,
    deduplicated: result.deduplicated,
  };
}

/**
 * Post-commit wrapper used by `voidInvoice`.
 *
 * MUST be invoked AFTER the commercial void has durably persisted. A failure
 * here is logged and swallowed (returns a `failed` outcome) so the committed
 * commercial void is never affected. A retry of the same full void reuses the
 * deterministic key `REVERSAL:${economicKey}:VOID` and converges through the
 * Phase 4 deduplication.
 */
export async function produceVoidReversalSafely(
  invoice: { id?: string } | null | undefined,
  deps: VoidReversalDeps = defaultVoidReversalDeps,
): Promise<VoidReversalOutcome | { status: 'failed'; error: unknown }> {
  try {
    const outcome = await produceVoidReversal(deps, invoice);
    if (outcome.status === 'missing-allocation') {
      logger.warn(
        `[TransportBudget] full-void REVERSAL skipped (missing original allocation) economicKey=${outcome.economicKey} allocationKey=${outcome.allocationKey}`,
      );
    }
    return outcome;
  } catch (err) {
    logger.error('[TransportBudget] full-void REVERSAL append failed:', err);
    return { status: 'failed', error: err };
  }
}
