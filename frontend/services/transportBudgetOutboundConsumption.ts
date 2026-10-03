/**
 * transportBudgetOutboundConsumption.ts — Phase 8E: outbound consumption producer.
 * POSTED OUTBOUND_TRANSPORT line -> OUTBOUND_CONSUMPTION event (no reversals).
 */
import { logger } from './logger';
import { roundMoney } from '../utils/roundingUtils';
import {
  TransportBudgetRepository,
  transportBudgetRepository,
  type TransportBudgetAppendResult,
} from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';
import type { TransportExpense } from '../types';

/** Canonical method tag for outbound courier/delivery transport consumption. */
export const OUTBOUND_CONSUMPTION_METHOD = 'OUTBOUND_TRANSPORT' as const;

export const outboundConsumptionIdempotencyKey = (
  transportExpenseId: string,
  transportExpenseLineId: string,
): string =>
  `OUTBOUND_CONSUMPTION:${String(transportExpenseId ?? '').trim()}:${String(transportExpenseLineId ?? '').trim()}`;

export const outboundConsumptionSourceEventId = (
  transportExpenseId: string,
  transportExpenseLineId: string,
): string =>
  `${String(transportExpenseId ?? '').trim()}:${String(transportExpenseLineId ?? '').trim()}`;

export type OutboundConsumptionSkipReason =
  | 'not-posted'
  | 'reversal-document'
  | 'non-transport-line'
  | 'malformed-line'
  | 'malformed-source'
  | 'duplicate-scope';

export interface OutboundConsumptionSkipped {
  scope: string;
  reason: OutboundConsumptionSkipReason;
}

export interface OutboundConsumptionFailed {
  scope: string;
  reason: 'append-failed';
  error: string;
}

export interface ProduceOutboundConsumptionOutcome {
  produced: TransportBudgetEvent[];
  deduplicated: TransportBudgetEvent[];
  skipped: OutboundConsumptionSkipped[];
  failed: OutboundConsumptionFailed[];
}

export interface OutboundConsumptionDeps {
  repository: Pick<TransportBudgetRepository, 'appendTransportBudgetEvent'>;
  nowIso(): string;
}

export const defaultOutboundConsumptionDeps: OutboundConsumptionDeps = {
  repository: transportBudgetRepository,
  nowIso: () => new Date().toISOString(),
};

export interface ProduceOutboundConsumptionInput {
  transportExpense: TransportExpense;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;
const DATE_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

const isValidCalendarDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const c = new Date(Date.UTC(y, m - 1, d));
  return c.getUTCFullYear() === y && c.getUTCMonth() === m - 1 && c.getUTCDate() === d;
};

const isValidIsoDateTime = (value: string): boolean => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return false;
  return Number.isFinite(Date.parse(value));
};

export async function produceOutboundConsumptionForExpense(
  deps: OutboundConsumptionDeps,
  input: ProduceOutboundConsumptionInput,
): Promise<ProduceOutboundConsumptionOutcome> {
  const outcome: ProduceOutboundConsumptionOutcome = {
    produced: [],
    deduplicated: [],
    skipped: [],
    failed: [],
  };
  const src = (input?.transportExpense ?? null) as unknown as Record<string, unknown> | null;
  if (!src || typeof src !== 'object') {
    outcome.skipped.push({ scope: '?', reason: 'malformed-source' });
    return outcome;
  }
  const expenseId = String((src['id'] as unknown) ?? '').trim();
  if (String(src['status'] ?? '') !== 'POSTED') {
    outcome.skipped.push({ scope: expenseId || '?', reason: 'not-posted' });
    return outcome;
  }

  const rawReverse: unknown = src['reversesExpenseId'];
  if (src['isReversal'] === true || (rawReverse !== null && rawReverse !== undefined)) {
    outcome.skipped.push({ scope: expenseId || '?', reason: 'reversal-document' });
    return outcome;
  }
  if (!expenseId || !IDENTITY_PATTERN.test(expenseId)) {
    outcome.skipped.push({ scope: '?', reason: 'malformed-source' });
    return outcome;
  }
  const businessDate = String((src['businessDate'] as unknown) ?? '').trim();
  if (!isValidCalendarDate(businessDate)) {
    outcome.skipped.push({ scope: expenseId, reason: 'malformed-source' });
    return outcome;
  }
  // Authoritative posting timestamp snapshot. The persisted posted source
  // exposes it as `occurredAt` (set at POST time by transportExpenseService);
  // `postedAt` is honored first per the frozen Phase 8E field contract when a
  // source carries it. Both invalid/absent => fail closed.
  const pickIso = (v: unknown): string | null =>
    typeof v === 'string' && isValidIsoDateTime(v) ? v : null;
  const occurredAt = pickIso(src['postedAt']) ?? pickIso(src['occurredAt']);
  if (!occurredAt) {
    outcome.skipped.push({ scope: expenseId, reason: 'malformed-source' });
    return outcome;
  }
  const lines: unknown = src['lines'];
  if (!Array.isArray(lines)) {
    outcome.skipped.push({ scope: expenseId, reason: 'malformed-source' });
    return outcome;
  }
  const seenScopes = new Set<string>();
  for (const rawLine of lines) {
    const line = ((rawLine ?? {}) as { id?: unknown; classification?: unknown; amount?: unknown; supplierId?: unknown });
    if (line.classification !== 'OUTBOUND_TRANSPORT') {
      const lid = String(line.id ?? '').trim();
      outcome.skipped.push({
        scope: lid ? `${expenseId}:${lid}` : expenseId,
        reason: line.classification === 'NON_TRANSPORT' ? 'non-transport-line' : 'malformed-line',
      });
      continue;
    }
    const lineId = String(line.id ?? '').trim();
    if (!lineId || !IDENTITY_PATTERN.test(lineId)) {
      logger.error(`[TransportBudget] outbound malformed line (expense ${expenseId}); refusing identity.`);
      outcome.skipped.push({ scope: expenseId, reason: 'malformed-line' });
      continue;
    }
    const sourceEventId = outboundConsumptionSourceEventId(expenseId, lineId);
    if (!IDENTITY_PATTERN.test(sourceEventId)) {
      logger.error(`[TransportBudget] outbound malformed scope (scope ${sourceEventId}); refusing identity.`);
      outcome.skipped.push({ scope: expenseId, reason: 'malformed-line' });
      continue;
    }
    const rawAmount = Number(line.amount);
    if (!Number.isFinite(rawAmount) || !(rawAmount > 0)) {
      logger.error(`[TransportBudget] outbound invalid amount (scope ${sourceEventId}); refusing zero-value.`);
      outcome.skipped.push({ scope: sourceEventId, reason: 'malformed-line' });
      continue;
    }
    const rounded = roundMoney(rawAmount);
    if (!Number.isFinite(rounded) || !(rounded > 0)) {
      logger.error(`[TransportBudget] outbound invalid rounded amount (scope ${sourceEventId}); refusing zero-value.`);
      outcome.skipped.push({ scope: sourceEventId, reason: 'malformed-line' });
      continue;
    }
    const providerId = String(line.supplierId ?? '').trim();
    if (!providerId) {
      logger.error(`[TransportBudget] outbound missing supplier (scope ${sourceEventId}); refusing provider.`);
      outcome.skipped.push({ scope: sourceEventId, reason: 'malformed-line' });
      continue;
    }
    if (seenScopes.has(sourceEventId)) {
      logger.error(`[TransportBudget] outbound duplicate scope (scope ${sourceEventId}); skipping.`);
      outcome.skipped.push({ scope: sourceEventId, reason: 'duplicate-scope' });
      continue;
    }
    seenScopes.add(sourceEventId);
    try {
      const result: TransportBudgetAppendResult =
        await deps.repository.appendTransportBudgetEvent({
          id: '',
          kind: 'OUTBOUND_CONSUMPTION',
          idempotencyKey: outboundConsumptionIdempotencyKey(expenseId, lineId),
          sourceEventId,
          sourceAmount: rounded,
          allocationRatePercent: null,
          amount: -rounded,
          method: OUTBOUND_CONSUMPTION_METHOD,
          providerId,
          accountSplits: null,
          journalIds: null,
          reversesEventId: null,
          correctsEventId: null,
          businessDate,
          occurredAt,
        });
      if (result.deduplicated) outcome.deduplicated.push(result.event);
      else outcome.produced.push(result.event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[TransportBudget] outbound append failed (scope ${sourceEventId}):`, err);
      outcome.failed.push({ scope: sourceEventId, reason: 'append-failed', error: message });
    }
  }
  return outcome;
}
export async function produceOutboundConsumptionSafely(
  deps: OutboundConsumptionDeps,
  input: ProduceOutboundConsumptionInput,
): Promise<ProduceOutboundConsumptionOutcome> {
  try {
    return await produceOutboundConsumptionForExpense(deps, input);
  } catch (err) {
    const sid = String((input?.transportExpense as unknown as { id?: unknown } | null)?.id ?? '');
    logger.error(`[TransportBudget] outbound producer failed (expense ${sid}):`, err);
    return {
      produced: [],
      deduplicated: [],
      skipped: [],
      failed: [{ scope: sid, reason: 'append-failed', error: err instanceof Error ? err.message : String(err) }],
    };
  }
}

export function fireOutboundConsumptionHook(
  task: Promise<ProduceOutboundConsumptionOutcome>,
  transportExpenseId: string,
): void {
  task.catch((err) => {
    logger.error(`[TransportBudget] outbound consumption failed (expense ${transportExpenseId}):`, err);
  });
}
