/**
 * transportBudgetInboundConsumption.ts — Phase 7F: inbound consumption producer.
 *
 * The FIRST and ONLY phase permitted to create INBOUND_CONSUMPTION transport
 * budget events, sourced exclusively from the authoritative Landing Cost GRN
 * Freight consumption fact:
 *   LandingConsumptionEvent { kind: 'GRN', billId: null, grnId, landingCostId,
 *     amount, sourceAmount, providerId, at }
 * joined to the posting snapshot line
 *   landingCosts[] { id, category === 'Freight' }.
 *
 * Frozen contract (Phase 7D-2 / 7E):
 *   kind                  = INBOUND_CONSUMPTION
 *   amount                = -roundMoney(landingEvent.amount)   (single rounding)
 *   sourceAmount          = roundMoney(landingEvent.sourceAmount)
 *   sourceEventId         = {landingCostId}:{grnId}
 *   method                = LANDING_COST_FREIGHT (constant tag)
 *   providerId            = frozen Freight provider snapshot from the event
 *   allocationRatePercent = NULL / reversesEventId = NULL / correctsEventId = NULL
 *   businessDate          = GRN business date (grn.date, never sync time)
 *   occurredAt            = landing event `at` (actual posting timestamp)
 *   idempotencyKey        = INBOUND_CONSUMPTION:{landingCostId}:{grnId}
 *
 * Design rules (mirror the Phase 5 sales-allocation precedent):
 * - The persisted Landing Consumption event is authoritative: amounts come
 *   from its `amount`/`sourceAmount` (never PO/bill/header/WAC/tax recompute),
 *   the provider comes from its `providerId` snapshot (never current purchase
 *   state, session, or master-after-the-fact), and the stored event is frozen.
 * - The producer runs AFTER the GRN commit (post-commit, fire-and-forget from
 *   processGoodsReceipt). It never blocks posting and never rolls a committed
 *   GRN back: transport failures are logged loudly (never swallowed silently)
 *   and stay retryable through re-invocation, which converges on the Phase 7E
 *   idempotency layer (in-memory mutex is NOT relied upon).
 * - Exactly-once per (grnId, landingCostId) scope comes from the deterministic
 *   economic key. Duplicate scopes inside one invocation are detected and
 *   skipped (never summed, never overwritten).
 * - No GL journals, no COGS/WAC/inventory/revenue/AR/AP changes, no customer
 *   payload changes. The -K20,000 on a K20,000 freight consumption exists ONLY
 *   as an internal Transport Budget event.
 * - Bill posting never produces consumption (GRN fact only). Corrections and
 *   outbound are explicitly out of scope for this phase.
 */

import { logger } from './logger';
import { roundMoney } from '../utils/roundingUtils';
import {
  TransportBudgetRepository,
  transportBudgetRepository,
  type TransportBudgetAppendResult,
} from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';

/** Canonical method tag for Landing-Cost-Freight consumption. */
export const INBOUND_CONSUMPTION_METHOD = 'LANDING_COST_FREIGHT' as const;

/** Deterministic economic identity for one (landingCostId, grnId) scope. */
export const inboundConsumptionIdempotencyKey = (
  landingCostId: string,
  grnId: string,
): string =>
  `INBOUND_CONSUMPTION:${String(landingCostId ?? '').trim()}:${String(grnId ?? '').trim()}`;

/** Deterministic source scope identity for one (landingCostId, grnId) scope. */
export const inboundConsumptionSourceEventId = (
  landingCostId: string,
  grnId: string,
): string =>
  `${String(landingCostId ?? '').trim()}:${String(grnId ?? '').trim()}`;

export class TransportBudgetInboundConsumptionError extends Error {
  readonly code: 'INVALID_DATE' | 'INVALID_IDENTITY';

  constructor(
    code: TransportBudgetInboundConsumptionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TransportBudgetInboundConsumptionError';
    this.code = code;
  }
}

/** Minimal structural view of a persisted LandingConsumptionEvent. */
export interface InboundConsumptionSourceEvent {
  id?: unknown;
  landingCostId?: unknown;
  kind?: unknown;
  billId?: unknown;
  grnId?: unknown;
  amount?: unknown;
  sourceAmount?: unknown;
  providerId?: unknown;
  at?: unknown;
}

/** Minimal structural view of a posting-snapshot landing-cost line. */
export interface InboundConsumptionSourceLine {
  id?: unknown;
  category?: unknown;
}

export type InboundConsumptionSkipReason =
  | 'not-grn-kind'
  | 'billed-event'
  | 'unknown-line'
  | 'non-freight'
  | 'non-positive-amount'
  | 'non-positive-source'
  | 'missing-provider'
  | 'duplicate-scope'
  | 'invalid-grn-date'
  | 'invalid-timestamp';

export interface InboundConsumptionSkipped {
  scope: string;
  reason: InboundConsumptionSkipReason;
}

export interface InboundConsumptionFailed {
  scope: string;
  error: string;
}

export interface ProduceInboundConsumptionOutcome {
  produced: TransportBudgetEvent[];
  deduplicated: TransportBudgetEvent[];
  skipped: InboundConsumptionSkipped[];
  failed: InboundConsumptionFailed[];
}

export interface ProduceInboundConsumptionInput {
  grnId: unknown;
  grnDate: unknown;
  /** Posting-snapshot landing-cost lines (category join source). */
  landingCosts: InboundConsumptionSourceLine[] | null | undefined;
  /** Persisted LandingConsumptionEvents committed by the GRN verify. */
  events: InboundConsumptionSourceEvent[] | null | undefined;
}

/** Injectable seams (hermetic tests supply fakes; production uses defaults). */
export interface InboundConsumptionDeps {
  repository: Pick<TransportBudgetRepository, 'appendTransportBudgetEvent'>;
  nowIso(): string;
}

/** Production deps: the Phase 7E ledger repository + wall clock. */
export const defaultInboundConsumptionDeps: InboundConsumptionDeps = {
  repository: transportBudgetRepository,
  nowIso: () => new Date().toISOString(),
};

/** Extract the YYYY-MM-DD business date from a persisted GRN date. */
const toBusinessDate = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new TransportBudgetInboundConsumptionError(
      'INVALID_DATE',
      `Cannot derive a GRN business date from ${JSON.stringify(raw)} (need YYYY-MM-DD).`,
    );
  }
  return match[1];
};

const isValidIsoDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Date.parse(value));
};

/**
 * Produce at most one INBOUND_CONSUMPTION per qualifying persisted GRN
 * Freight consumption event. Runs only after the Landing Cost GRN commit;
 * throws transport failures per scope (collected by the safely wrapper).
 */
export async function produceInboundConsumptionForGrn(
  deps: InboundConsumptionDeps,
  input: ProduceInboundConsumptionInput,
): Promise<ProduceInboundConsumptionOutcome> {
  const outcome: ProduceInboundConsumptionOutcome = {
    produced: [],
    deduplicated: [],
    skipped: [],
    failed: [],
  };
  const grnId = String(input.grnId ?? '').trim();
  if (!grnId) {
    throw new TransportBudgetInboundConsumptionError(
      'INVALID_IDENTITY',
      'Cannot produce inbound consumption without a GRN identity.',
    );
  }
  // Business date is per-GRN (same scope family); an underivable date fails
  // the whole batch loudly rather than inventing a period.
  const businessDate = toBusinessDate(input.grnDate);
  const lineById = new Map<string, InboundConsumptionSourceLine>();
  for (const line of input.landingCosts ?? []) {
    const id = String((line as { id?: unknown })?.id ?? '').trim();
    if (id && !lineById.has(id)) lineById.set(id, line);
  }
  const seenScopes = new Set<string>();
  for (const source of input.events ?? []) {
    const landingCostId = String(
      (source as { landingCostId?: unknown })?.landingCostId ?? '',
    ).trim();
    const scope =
      landingCostId && grnId
        ? `${landingCostId}:${grnId}`
        : `?:${grnId}`;
    const skip = (reason: InboundConsumptionSkipReason): void => {
      outcome.skipped.push({ scope, reason });
    };
    // Eligibility: persisted GRN-kind consumption only (never bills,
    // corrections, reversals, drafts, or unconsumed lines).
    if ((source as { kind?: unknown })?.kind !== 'GRN') {
      skip('not-grn-kind');
      continue;
    }
    if ((source as { billId?: unknown })?.billId !== null) {
      skip('billed-event');
      continue;
    }
    if (!landingCostId) {
      skip('unknown-line');
      continue;
    }
    const line = lineById.get(landingCostId);
    if (!line) {
      skip('unknown-line');
      continue;
    }
    if (String((line as { category?: unknown })?.category ?? '') !== 'Freight') {
      skip('non-freight');
      continue;
    }
    // Amounts: the persisted event is authoritative; single rounding here.
    const authoritativeAmount = Number(
      (source as { amount?: unknown })?.amount,
    );
    if (!Number.isFinite(authoritativeAmount) || !(authoritativeAmount > 0)) {
      // Unreachable under Landing invariants (negative lines throw
      // pre-mutation; zero/dust lines post nothing): fail closed loudly.
      logger.warn(
        `[TransportBudget] inbound skipped non-positive GRN consumption (scope ${scope}, amount ${String((source as { amount?: unknown })?.amount)}).`,
      );
      skip('non-positive-amount');
      continue;
    }
    const authoritativeSource = Number(
      (source as { sourceAmount?: unknown })?.sourceAmount,
    );
    if (!Number.isFinite(authoritativeSource) || !(authoritativeSource > 0)) {
      logger.warn(
        `[TransportBudget] inbound skipped non-positive GRN source (scope ${scope}).`,
      );
      skip('non-positive-source');
      continue;
    }
    // Provider: frozen snapshot from the event itself (never current
    // purchase state, session, or master-after-the-fact). Landing guarantees
    // a resolved provider for consumed lines; absence fails closed here.
    const providerId = String(
      (source as { providerId?: unknown })?.providerId ?? '',
    ).trim();
    if (!providerId) {
      logger.error(
        `[TransportBudget] inbound missing provider snapshot (scope ${scope}); refusing to invent one.`,
      );
      skip('missing-provider');
      continue;
    }
    // Identity-collision detection: more than one GRN event for one scope
    // must never be summed or overwritten (Landing duplicate-line guards
    // make this unreachable; detect rather than assume).
    const sourceEventId = inboundConsumptionSourceEventId(
      landingCostId,
      grnId,
    );
    if (seenScopes.has(sourceEventId)) {
      logger.error(
        `[TransportBudget] inbound duplicate scope detected (scope ${sourceEventId}); skipping second event, no aggregation.`,
      );
      skip('duplicate-scope');
      continue;
    }
    seenScopes.add(sourceEventId);
    const amount = -roundMoney(authoritativeAmount);
    const sourceAmount = roundMoney(authoritativeSource);
    // Phase 9B: the authoritative GRN timestamp is required. A missing or
    // malformed `at` fails closed (skipped, retryable once the source is
    // corrected) — wall-clock substitution would silently misdate an
    // otherwise valid economic event.
    const occurredAtRaw = (source as { at?: unknown })?.at;
    if (
      typeof occurredAtRaw !== 'string' ||
      !isValidIsoDateTime(occurredAtRaw)
    ) {
      logger.error(
        `[TransportBudget] inbound invalid timestamp (scope ${sourceEventId}); refusing wall-clock substitution.`,
      );
      skip('invalid-timestamp');
      continue;
    }
    const occurredAt = occurredAtRaw;
    try {
      const result: TransportBudgetAppendResult =
        await deps.repository.appendTransportBudgetEvent({
          kind: 'INBOUND_CONSUMPTION',
          idempotencyKey: inboundConsumptionIdempotencyKey(
            landingCostId,
            grnId,
          ),
          sourceEventId,
          sourceAmount,
          allocationRatePercent: null,
          amount,
          method: INBOUND_CONSUMPTION_METHOD,
          providerId,
          reversesEventId: null,
          correctsEventId: null,
          businessDate,
          occurredAt,
        });
      if (result.deduplicated) outcome.deduplicated.push(result.event);
      else outcome.produced.push(result.event);
    } catch (err) {
      // The Landing commit already succeeded: record and continue with the
      // remaining scopes. Re-invocation converges via the economic key.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[TransportBudget] inbound append failed (scope ${sourceEventId}):`,
        err,
      );
      outcome.failed.push({ scope: sourceEventId, error: message });
    }
  }
  return outcome;
}

/**
 * Post-commit wrapper used by `processGoodsReceipt`.
 *
 * MUST be invoked AFTER the Landing Cost GRN transaction has durably
 * persisted. Never throws: transport failures are logged loudly and stay
 * retryable through deterministic re-invocation (same input converges on
 * the Phase 7E idempotency layer).
 */
export async function produceInboundConsumptionSafely(
  deps: InboundConsumptionDeps,
  input: ProduceInboundConsumptionInput,
): Promise<ProduceInboundConsumptionOutcome> {
  try {
    return await produceInboundConsumptionForGrn(deps, input);
  } catch (err) {
    logger.error(
      `[TransportBudget] inbound producer failed (GRN ${String(input?.grnId ?? '')}):`,
      err,
    );
    return {
      produced: [],
      deduplicated: [],
      skipped: [],
      failed: [
        {
          scope: String(input?.grnId ?? ''),
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

/**
 * Fire-and-forget hook shared by the GRN posting funnel (mirrors the Phase 5
 * `fireAllocationHook` pattern): attaches a loud failure log so a transport
 * failure can never surface as an unhandled rejection, and never affects the
 * already-committed GRN result.
 */
export function fireInboundConsumptionHook(
  task: Promise<ProduceInboundConsumptionOutcome>,
  grnId: string,
): void {
  task.catch((err) => {
    logger.error(
      `[TransportBudget] inbound consumption failed (GRN ${grnId}):`,
      err,
    );
  });
}
