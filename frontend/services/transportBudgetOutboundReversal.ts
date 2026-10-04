/**
 * transportBudgetOutboundReversal.ts — Phase 8E: VOID -> CONSUMPTION_REVERSAL producer.
 *
 * Completes the outbound lifecycle started by transportBudgetOutboundConsumption.ts:
 *
 *   POSTED OUTBOUND_TRANSPORT line -> OUTBOUND_CONSUMPTION (-X)
 *   VOID of that expense            -> CONSUMPTION_REVERSAL (+X) per original
 *
 * SCOPE (frozen):
 * - Resolves ONLY already-persisted OUTBOUND_CONSUMPTION events by the
 *   deterministic scope OUTBOUND_CONSUMPTION:{expenseId}:{lineId}. The
 *   immutable original event is the economic source of truth — amounts are
 *   never rederived from reversal rows, journals, AP, header totals, or
 *   customer/invoice values.
 * - Builds reversals exclusively through the Phase 8D primitive
 *   `appendConsumptionReversal` with the canonical key
 *   `consumptionReversalIdempotencyKey(original.id)`. No local re-creation
 *   of validator/repository semantics.
 * - Never processes transport-expense reversal rows (isReversal /
 *   reversesExpenseId guard): reversing a reversal is impossible by
 *   construction, and no second OUTBOUND_CONSUMPTION is ever created here.
 * - Post-commit derived operation only: callers invoke it AFTER the
 *   accounting void has committed. Failures never roll back the void.
 * - No scanner, no backend producer, no sync changes, no accounting writes.
 *   The only record produced is a transport_budget_events row.
 */

import { logger } from './logger';
import {
  TransportBudgetRepository,
  transportBudgetRepository,
  consumptionReversalIdempotencyKey,
  type TransportBudgetAppendResult,
} from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';
import type { TransportExpense } from '../types';

export type OutboundReversalSkipReason =
  | 'not-voided'
  | 'reversal-document'
  | 'malformed-source'
  | 'no-outbound-events'
  | 'ineligible-target';

export interface OutboundReversalSkipped {
  scope: string;
  reason: OutboundReversalSkipReason;
}

export interface OutboundReversalFailed {
  scope: string;
  reason: 'append-failed';
  error: string;
}

export interface ProduceOutboundReversalOutcome {
  produced: TransportBudgetEvent[];
  deduplicated: TransportBudgetEvent[];
  skipped: OutboundReversalSkipped[];
  failed: OutboundReversalFailed[];
}

export interface OutboundReversalDeps {
  repository: Pick<
    TransportBudgetRepository,
    'appendConsumptionReversal' | 'listTransportBudgetEvents'
  >;
}

export const defaultOutboundReversalDeps: OutboundReversalDeps = {
  repository: transportBudgetRepository,
};

export interface ProduceOutboundReversalInput {
  /** The original expense row AFTER it flipped to VOIDED (frozen). */
  voidedExpense: TransportExpense;
  /**
   * Authoritative void timestamp from the persisted void operation
   * (the reversal row's occurredAt). Never generated per line here.
   */
  voidOccurredAt: string;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;

const isValidIsoDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
};

export async function produceOutboundReversalsForVoid(
  deps: OutboundReversalDeps,
  input: ProduceOutboundReversalInput,
): Promise<ProduceOutboundReversalOutcome> {
  const outcome: ProduceOutboundReversalOutcome = {
    produced: [],
    deduplicated: [],
    skipped: [],
    failed: [],
  };
  const src = (input?.voidedExpense ?? null) as unknown as Record<
    string,
    unknown
  > | null;
  if (!src || typeof src !== 'object') {
    outcome.skipped.push({ scope: '?', reason: 'malformed-source' });
    return outcome;
  }
  const expenseId = String((src['id'] as unknown) ?? '').trim();
  // Only a VOIDED original qualifies. Anything else (DRAFT/POSTED) means no
  // void happened and no reversal may be derived.
  if (String(src['status'] ?? '') !== 'VOIDED') {
    outcome.skipped.push({ scope: expenseId || '?', reason: 'not-voided' });
    return outcome;
  }
  // Reversal-row exclusion: a reversal row must never seed fresh budget
  // economics, and a reversal can never itself be reversed.
  const rawReverse: unknown = src['reversesExpenseId'];
  if (
    src['isReversal'] === true ||
    (rawReverse !== null && rawReverse !== undefined)
  ) {
    outcome.skipped.push({
      scope: expenseId || '?',
      reason: 'reversal-document',
    });
    return outcome;
  }
  if (!expenseId || !IDENTITY_PATTERN.test(expenseId)) {
    outcome.skipped.push({ scope: '?', reason: 'malformed-source' });
    return outcome;
  }
  const voidOccurredAt: unknown = (input as { voidOccurredAt?: unknown })
    .voidOccurredAt;
  if (!isValidIsoDateTime(voidOccurredAt)) {
    outcome.skipped.push({ scope: expenseId, reason: 'malformed-source' });
    return outcome;
  }
  // Resolve the immutable originals by deterministic scope. The reversal
  // row carries a different expense id, so its (nonexistent) events can
  // never match this prefix even if misrouted here.
  const scopePrefix = `OUTBOUND_CONSUMPTION:${expenseId}:`;
  let originals: TransportBudgetEvent[];
  try {
    const rows = await deps.repository.listTransportBudgetEvents({
      kind: 'OUTBOUND_CONSUMPTION',
    });
    originals = (rows || []).filter(
      (entry) =>
        entry?.kind === 'OUTBOUND_CONSUMPTION' &&
        typeof entry.idempotencyKey === 'string' &&
        entry.idempotencyKey.startsWith(scopePrefix),
    );
  } catch (err) {
    logger.error(
      `[TransportBudget] outbound reversal resolution failed (expense ${expenseId}):`,
      err,
    );
    outcome.failed.push({
      scope: expenseId,
      reason: 'append-failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return outcome;
  }
  if (originals.length === 0) {
    // No outbound economics exist (e.g. voided doc had no transport
    // lines): do nothing, fabricate nothing, fail nothing.
    outcome.skipped.push({ scope: expenseId, reason: 'no-outbound-events' });
    return outcome;
  }
  // Deterministic order keeps multi-line retries convergent.
  originals = [...originals].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  for (const original of originals) {
    const originalId = String((original as { id?: unknown }).id ?? '');
    const rawAmount = Number((original as { amount?: unknown }).amount);
    if (
      !originalId ||
      !Number.isFinite(rawAmount) ||
      !(rawAmount < 0)
    ) {
      logger.error(
        `[TransportBudget] outbound reversal ineligible target (expense ${expenseId}, row ${originalId || '?'}); refusing.`,
      );
      outcome.skipped.push({
        scope: originalId || expenseId,
        reason: 'ineligible-target',
      });
      continue;
    }
    try {
      const result: TransportBudgetAppendResult =
        await deps.repository.appendConsumptionReversal({
          id: '',
          kind: 'CONSUMPTION_REVERSAL',
          idempotencyKey: consumptionReversalIdempotencyKey(originalId),
          sourceEventId: null,
          sourceAmount: null,
          allocationRatePercent: null,
          amount: Math.abs(rawAmount),
          method: null,
          providerId: null,
          accountSplits: null,
          journalIds: null,
          reversesEventId: originalId,
          correctsEventId: null,
          businessDate: String(
            (original as { businessDate?: unknown }).businessDate ?? '',
          ),
          occurredAt: voidOccurredAt,
        });
      if (result.deduplicated) outcome.deduplicated.push(result.event);
      else outcome.produced.push(result.event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[TransportBudget] outbound reversal append failed (target ${originalId}):`,
        err,
      );
      outcome.failed.push({
        scope: originalId,
        reason: 'append-failed',
        error: message,
      });
    }
  }
  return outcome;
}

export async function produceOutboundReversalsSafely(
  deps: OutboundReversalDeps,
  input: ProduceOutboundReversalInput,
): Promise<ProduceOutboundReversalOutcome> {
  try {
    return await produceOutboundReversalsForVoid(deps, input);
  } catch (err) {
    const sid = String(
      (input?.voidedExpense as unknown as { id?: unknown } | null)?.id ?? '',
    );
    logger.error(
      `[TransportBudget] outbound reversal producer failed (expense ${sid}):`,
      err,
    );
    return {
      produced: [],
      deduplicated: [],
      skipped: [],
      failed: [
        {
          scope: sid,
          reason: 'append-failed',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

export function fireOutboundReversalHook(
  task: Promise<ProduceOutboundReversalOutcome>,
  transportExpenseId: string,
): void {
  task.catch((err) => {
    logger.error(
      `[TransportBudget] outbound reversal failed (expense ${transportExpenseId}):`,
      err,
    );
  });
}
