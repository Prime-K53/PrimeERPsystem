/**
 * transportBudgetConsumptionCorrection.ts — Phase 7G: correction producer.
 *
 * Mirrors an authoritative committed Landing Cost GRN CORRECTION event into
 * exactly one Transport Budget CONSUMPTION_CORRECTION event (Phase 7G-1
 * amended contract):
 *   correction.sourceAmount = original inbound sourceAmount snapshot
 *   correction.amount       = abs(landing correction amount), capped by
 *                             abs(original inbound amount) at the ledger.
 *
 * Frozen contract (Phase 7D-2 as amended by 7G-1, enforced by migration
 * 0033 + repository + validators):
 *   kind                  = CONSUMPTION_CORRECTION
 *   amount                = +abs(landingCorrection.amount) (single rounding)
 *   sourceEventId         = originalTransportInbound.id
 *   correctsEventId       = originalTransportInbound.id
 *   sourceAmount          = originalTransportInbound.sourceAmount
 *   method                = originalTransportInbound.method
 *   providerId            = originalTransportInbound.providerId
 *   allocationRatePercent = NULL / reversesEventId = NULL
 *   businessDate          = correction posting date (from correction.at)
 *   occurredAt            = correction posting timestamp (correction.at)
 *   idempotencyKey        = CONSUMPTION_CORRECTION:{originalTransportInbound.id}
 *
 * Design rules (mirror the Phase 7F inbound producer):
 * - The persisted Landing CORRECTION event is authoritative for the release
 *   magnitude; the parent Transport INBOUND event is authoritative for every
 *   snapshot (sourceAmount/method/providerId are copied, never re-resolved
 *   from today's Landing Cost configuration).
 * - The parent is resolved deterministically by scope
 *   (`{landingCostId}:{grnId}`) via the existing repository read filter —
 *   never by amount, provider, date, or journals. Zero or multiple matches
 *   fail closed with a retryable diagnostic (never a placeholder parent).
 * - The producer runs AFTER the Landing correction commit (post-commit,
 *   fire-and-forget from correctLandingConsumption). It never blocks the
 *   correction and never rolls a committed correction back: failures are
 *   logged loudly (never swallowed silently) and stay retryable through
 *   deterministic re-invocation, which converges on the Phase 7E idempotency
 *   layer (in-memory mutex is NOT relied upon).
 * - No GL journals, no COGS/WAC/inventory/revenue/AR/AP changes, no customer
 *   payload changes. Bill paths never produce corrections here.
 */

import { logger } from './logger';
import { roundMoney } from '../utils/roundingUtils';
import {
  TransportBudgetRepository,
  transportBudgetRepository,
  type TransportBudgetAppendResult,
} from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';

/** Minimal structural view of a persisted Landing CORRECTION event. */
export interface LandingCorrectionSourceEvent {
  id?: unknown;
  landingCostId?: unknown;
  kind?: unknown;
  billId?: unknown;
  grnId?: unknown;
  amount?: unknown;
  providerId?: unknown;
  at?: unknown;
  correctsEventId?: unknown;
}

export type ConsumptionCorrectionSkipReason =
  | 'not-correction-kind'
  | 'billed-event'
  | 'missing-grn-id'
  | 'missing-line-id'
  | 'non-negative-amount'
  | 'invalid-timestamp';

export interface ConsumptionCorrectionSkipped {
  scope: string;
  reason: ConsumptionCorrectionSkipReason;
}

export interface ConsumptionCorrectionFailed {
  scope: string;
  /** Stable machine-readable cause (missing-parent, ambiguous-parent, …). */
  reason:
    | 'missing-parent'
    | 'ambiguous-parent'
    | 'invalid-parent-snapshot'
    | 'append-failed';
  /** Human diagnostic carrying the deterministic retry identity. */
  error: string;
}

export interface ProduceConsumptionCorrectionOutcome {
  produced: TransportBudgetEvent[];
  deduplicated: TransportBudgetEvent[];
  skipped: ConsumptionCorrectionSkipped[];
  failed: ConsumptionCorrectionFailed[];
}

export interface ProduceConsumptionCorrectionInput {
  /** The exact persisted LandingConsumptionEvent (kind CORRECTION). */
  correction: LandingCorrectionSourceEvent | null | undefined;
}

/** Injectable seams (hermetic tests supply fakes; production uses defaults). */
export interface ConsumptionCorrectionDeps {
  repository: Pick<
    TransportBudgetRepository,
    'appendCorrection' | 'listTransportBudgetEvents'
  >;
  nowIso(): string;
}

/** Production deps: the Phase 7E ledger repository + wall clock. */
export const defaultConsumptionCorrectionDeps: ConsumptionCorrectionDeps = {
  repository: transportBudgetRepository,
  nowIso: () => new Date().toISOString(),
};

/** Extract the YYYY-MM-DD business date from a persisted ISO timestamp. */
const toBusinessDate = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    return '';
  }
  return match[1];
};

const isValidIsoDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Date.parse(value));
};

const describeCorrection = (correction: LandingCorrectionSourceEvent): string =>
  `landingCorrection=${String((correction as { id?: unknown })?.id ?? '?')} ` +
  `landingCostId=${String((correction as { landingCostId?: unknown })?.landingCostId ?? '?')} ` +
  `grnId=${String((correction as { grnId?: unknown })?.grnId ?? '?')}`;

/**
 * Produce at most one CONSUMPTION_CORRECTION for one committed Landing
 * CORRECTION event. Runs only after the Landing correction commit; per-scope
 * transport failures are collected (never thrown) by the safely wrapper.
 */
export async function produceConsumptionCorrectionForLandingCorrection(
  deps: ConsumptionCorrectionDeps,
  input: ProduceConsumptionCorrectionInput,
): Promise<ProduceConsumptionCorrectionOutcome> {
  const outcome: ProduceConsumptionCorrectionOutcome = {
    produced: [],
    deduplicated: [],
    skipped: [],
    failed: [],
  };
  const correction = (input?.correction ?? {}) as LandingCorrectionSourceEvent;
  const landingCostId = String(correction.landingCostId ?? '').trim();
  const grnId = String(correction.grnId ?? '').trim();
  const scope =
    landingCostId && grnId ? `${landingCostId}:${grnId}` : `?:${grnId || '?'}`;
  const skip = (reason: ConsumptionCorrectionSkipReason): void => {
    outcome.skipped.push({ scope, reason });
  };
  const fail = (
    reason: ConsumptionCorrectionFailed['reason'],
    error: string,
  ): void => {
    logger.error(`[TransportBudget] consumption correction failed: ${error}`);
    outcome.failed.push({ scope, reason, error });
  };

  // Eligibility: the persisted Landing CORRECTION fact only (never bills,
  // GRN consumptions, reversals, or uncommitted shapes).
  if (correction.kind !== 'CORRECTION') {
    skip('not-correction-kind');
    return outcome;
  }
  if (correction.billId !== null) {
    skip('billed-event');
    return outcome;
  }
  if (!grnId) {
    skip('missing-grn-id');
    return outcome;
  }
  if (!landingCostId) {
    skip('missing-line-id');
    return outcome;
  }
  // Release magnitude: the persisted correction amount is authoritative and
  // always negative (a release). Zero/positive/invalid values fail closed —
  // the producer never invents a magnitude.
  const releasedRaw = Number(correction.amount);
  if (!Number.isFinite(releasedRaw) || !(releasedRaw < 0)) {
    logger.warn(
      `[TransportBudget] correction skipped non-negative Landing amount (scope ${scope}, amount ${String(correction.amount)}).`,
    );
    skip('non-negative-amount');
    return outcome;
  }
  const magnitude = roundMoney(Math.abs(releasedRaw));
  if (!(magnitude > 0)) {
    skip('non-negative-amount');
    return outcome;
  }
  // Posting date/time come from the committed correction event itself (never
  // the original GRN period, never sync time).
  const postedAt =
    typeof correction.at === 'string' && isValidIsoDateTime(correction.at)
      ? correction.at
      : '';
  if (!postedAt) {
    logger.error(
      `[TransportBudget] correction missing posting timestamp (${describeCorrection(correction)}); refusing to invent one.`,
    );
    skip('invalid-timestamp');
    return outcome;
  }
  const businessDate = toBusinessDate(postedAt);

  // Parent resolution: exactly one INBOUND_CONSUMPTION carrying this scope.
  // Never by amount, provider, date, or journals; never manufactured.
  let parents: TransportBudgetEvent[];
  try {
    parents = await deps.repository.listTransportBudgetEvents({
      kind: 'INBOUND_CONSUMPTION',
      sourceEventId: scope,
    });
  } catch (err) {
    fail(
      'missing-parent',
      `parent lookup failed for scope ${scope} (${describeCorrection(correction)}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return outcome;
  }
  if (parents.length === 0) {
    fail(
      'missing-parent',
      `no Transport INBOUND_CONSUMPTION for scope ${scope} (${describeCorrection(correction)}); ` +
        `retry after the inbound event exists — same input converges.`,
    );
    return outcome;
  }
  if (parents.length > 1) {
    fail(
      'ambiguous-parent',
      `multiple (${parents.length}) Transport INBOUND_CONSUMPTION rows for scope ${scope} ` +
        `(${describeCorrection(correction)}); refusing to choose — manual review required.`,
    );
    return outcome;
  }
  const parent = parents[0];
  // Snapshot discipline (Phase 7G-1): frozen copies from the parent event.
  // Never re-resolved from today's Landing Cost configuration; no defaults.
  const parentSourceAmount = Number(parent.sourceAmount);
  const parentMethod = String(parent.method ?? '').trim();
  const parentProviderId = String(parent.providerId ?? '').trim();
  if (
    parent.sourceAmount === null ||
    parent.sourceAmount === undefined ||
    !Number.isFinite(parentSourceAmount) ||
    !(parentSourceAmount > 0) ||
    !parentMethod ||
    !parentProviderId
  ) {
    fail(
      'invalid-parent-snapshot',
      `parent ${parent.id} for scope ${scope} lacks a complete frozen snapshot ` +
        `(sourceAmount/method/providerId); refusing to invent one.`,
    );
    return outcome;
  }

  try {
    const result: TransportBudgetAppendResult =
      await deps.repository.appendCorrection({
        kind: 'CONSUMPTION_CORRECTION',
        idempotencyKey: `CONSUMPTION_CORRECTION:${String(parent.id)}`,
        sourceEventId: String(parent.id),
        sourceAmount: parentSourceAmount,
        allocationRatePercent: null,
        amount: magnitude,
        method: parentMethod,
        providerId: parentProviderId,
        reversesEventId: null,
        correctsEventId: String(parent.id),
        businessDate,
        occurredAt: postedAt,
      });
    if (result.deduplicated) outcome.deduplicated.push(result.event);
    else outcome.produced.push(result.event);
  } catch (err) {
    // The Landing correction already committed: record and stay retryable.
    // Re-invocation with the same input converges via the economic key.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[TransportBudget] correction append failed (scope ${scope}, parent ${parent.id}):`,
      err,
    );
    outcome.failed.push({ scope, reason: 'append-failed', error: message });
  }
  return outcome;
}

/**
 * Post-commit wrapper used by `correctLandingConsumption`.
 *
 * MUST be invoked AFTER the Landing correction has durably persisted. Never
 * throws: transport failures are logged loudly and stay retryable through
 * deterministic re-invocation (same input converges on the Phase 7E
 * idempotency layer).
 */
export async function produceConsumptionCorrectionSafely(
  deps: ConsumptionCorrectionDeps,
  input: ProduceConsumptionCorrectionInput,
): Promise<ProduceConsumptionCorrectionOutcome> {
  try {
    return await produceConsumptionCorrectionForLandingCorrection(
      deps,
      input,
    );
  } catch (err) {
    logger.error(
      `[TransportBudget] correction producer failed (${String(
        (input?.correction as { id?: unknown })?.id ?? '',
      )}):`,
      err,
    );
    return {
      produced: [],
      deduplicated: [],
      skipped: [],
      failed: [
        {
          scope: '?',
          reason: 'append-failed',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

/**
 * Fire-and-forget hook shared by the Landing correction funnel (mirrors the
 * Phase 7F `fireInboundConsumptionHook` pattern): attaches a loud failure
 * log so a transport failure can never surface as an unhandled rejection,
 * and never affects the already-committed Landing result.
 */
export function fireConsumptionCorrectionHook(
  task: Promise<ProduceConsumptionCorrectionOutcome>,
  correctionId: string,
): void {
  task.catch((err) => {
    logger.error(
      `[TransportBudget] consumption correction failed (${correctionId}):`,
      err,
    );
  });
}
