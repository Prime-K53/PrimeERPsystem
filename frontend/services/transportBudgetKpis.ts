/**
 * transportBudgetKpis.ts — Transport Budget KPI aggregation (Phase 10B).
 *
 * Pure client-side reporting over the authoritative
 * `transport_budget_events` ledger. The ONLY data source is the event list
 * returned by `transportBudgetRepository.listTransportBudgetEvents()` —
 * never duplicated counters, caches, tables, or a second balance model.
 *
 * Frozen KPI semantics (single signed-sum balance model):
 *   Accumulated = SALES_ALLOCATION + REVERSAL        (net allocation)
 *   Used        = INBOUND_CONSUMPTION + OUTBOUND_CONSUMPTION
 *               + CONSUMPTION_CORRECTION + CONSUMPTION_REVERSAL
 *   Remaining   = signed sum of ALL six kinds        (= Accumulated + Used)
 *
 * Amounts are summed from the frozen per-event `amount` exactly as stored;
 * the only normalization is a final 2dp rounding of each reported total
 * (float-dust guard, never a recalculation). Unknown kinds are ignored so
 * a future kind can never silently corrupt a published total.
 */

import { format, startOfWeek } from 'date-fns';
import type {
  TransportBudgetEvent,
  TransportBudgetEventKind,
} from '../types/transportBudget';
import { TRANSPORT_BUDGET_EVENT_KINDS } from '../types/transportBudget';

const GENERATION_KINDS: ReadonlySet<string> = new Set([
  'SALES_ALLOCATION',
  'REVERSAL',
]);

const INBOUND_KINDS: ReadonlySet<string> = new Set([
  'INBOUND_CONSUMPTION',
  'CONSUMPTION_CORRECTION',
]);

const OUTBOUND_KINDS: ReadonlySet<string> = new Set([
  'OUTBOUND_CONSUMPTION',
  'CONSUMPTION_REVERSAL',
]);

export interface TransportBudgetKpiTotals {
  /** Net allocation: SALES_ALLOCATION + REVERSAL. */
  accumulated: number;
  /** Net consumption: both consumptions + correction + consumption reversal. */
  used: number;
  /** Signed sum of all six kinds. Always equals accumulated + used. */
  remaining: number;
  /** INBOUND_CONSUMPTION + CONSUMPTION_CORRECTION. */
  inboundUsed: number;
  /** OUTBOUND_CONSUMPTION + CONSUMPTION_REVERSAL. */
  outboundUsed: number;
  /** CONSUMPTION_CORRECTION only. */
  corrections: number;
  /** REVERSAL + CONSUMPTION_REVERSAL. */
  reversals: number;
  /** Number of events included. */
  eventCount: number;
}

export interface TransportBudgetKindTotal {
  kind: TransportBudgetEventKind;
  total: number;
  count: number;
}

export type TransportBudgetPeriodGranularity = 'week' | 'month' | 'year';

export interface TransportBudgetPeriodBucket {
  /** Stable bucket identity: week → Monday yyyy-MM-dd; month → yyyy-MM; year → yyyy. */
  key: string;
  label: string;
  accumulated: number;
  used: number;
  net: number;
  count: number;
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Final 2dp normalization for a reported total (float-dust guard). */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const amountOf = (event: TransportBudgetEvent): number =>
  toNumber((event as { amount?: unknown })?.amount);

const kindOf = (event: TransportBudgetEvent): string =>
  String((event as { kind?: unknown })?.kind || '');

function bucketKeyAndLabel(
  businessDate: string,
  granularity: TransportBudgetPeriodGranularity,
): { key: string; label: string } | null {
  const parsed = new Date(`${businessDate}T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (granularity === 'year') {
    const key = format(parsed, 'yyyy');
    return { key, label: key };
  }
  if (granularity === 'month') {
    const key = format(parsed, 'yyyy-MM');
    return { key, label: format(parsed, 'MMM yy') };
  }
  const monday = startOfWeek(parsed, { weekStartsOn: 1 });
  return { key: format(monday, 'yyyy-MM-dd'), label: format(monday, 'd MMM') };
}

/**
 * Signed KPI totals over an event list. Pure: no I/O, no store reads.
 */
export function sumTransportBudgetEvents(
  events: TransportBudgetEvent[] | null | undefined,
): TransportBudgetKpiTotals {
  const list = Array.isArray(events) ? events : [];
  let accumulated = 0;
  let inboundUsed = 0;
  let outboundUsed = 0;
  let corrections = 0;
  let reversals = 0;
  let remaining = 0;
  let eventCount = 0;
  for (const event of list) {
    if (!event) continue;
    const kind = kindOf(event);
    if (
      kind !== 'SALES_ALLOCATION' &&
      kind !== 'REVERSAL' &&
      kind !== 'INBOUND_CONSUMPTION' &&
      kind !== 'OUTBOUND_CONSUMPTION' &&
      kind !== 'CONSUMPTION_CORRECTION' &&
      kind !== 'CONSUMPTION_REVERSAL'
    ) {
      continue;
    }
    const amount = amountOf(event);
    eventCount += 1;
    remaining += amount;
    if (GENERATION_KINDS.has(kind)) accumulated += amount;
    else if (INBOUND_KINDS.has(kind)) inboundUsed += amount;
    else if (OUTBOUND_KINDS.has(kind)) outboundUsed += amount;
    if (kind === 'CONSUMPTION_CORRECTION') corrections += amount;
    if (kind === 'REVERSAL' || kind === 'CONSUMPTION_REVERSAL') {
      reversals += amount;
    }
  }
  return {
    accumulated: round2(accumulated),
    used: round2(inboundUsed + outboundUsed),
    remaining: round2(remaining),
    inboundUsed: round2(inboundUsed),
    outboundUsed: round2(outboundUsed),
    corrections: round2(corrections),
    reversals: round2(reversals),
    eventCount,
  };
}

/**
 * Per-kind signed subtotals, zero-filled for all six canonical kinds so a
 * missing family renders as 0 rather than disappearing.
 */
export function summarizeTransportBudgetByKind(
  events: TransportBudgetEvent[] | null | undefined,
): TransportBudgetKindTotal[] {
  const list = Array.isArray(events) ? events : [];
  const totals = new Map<string, { total: number; count: number }>();
  for (const kind of TRANSPORT_BUDGET_EVENT_KINDS) {
    totals.set(kind, { total: 0, count: 0 });
  }
  for (const event of list) {
    if (!event) continue;
    const slot = totals.get(kindOf(event));
    if (!slot) continue;
    slot.total += amountOf(event);
    slot.count += 1;
  }
  return TRANSPORT_BUDGET_EVENT_KINDS.map((kind) => ({
    kind,
    total: round2(totals.get(kind)?.total || 0),
    count: totals.get(kind)?.count || 0,
  }));
}

/**
 * Period buckets over businessDate (never created_at/sync time). Buckets
 * span the min..max businessDate present in the input; undated rows are
 * excluded from buckets (they still count in totals). Empty input yields [].
 */
export function bucketTransportBudgetByPeriod(
  events: TransportBudgetEvent[] | null | undefined,
  granularity: TransportBudgetPeriodGranularity,
): TransportBudgetPeriodBucket[] {
  const list = Array.isArray(events) ? events : [];
  const byKey = new Map<string, TransportBudgetPeriodBucket & { sortKey: string }>();
  for (const event of list) {
    if (!event) continue;
    const kind = kindOf(event);
    if (
      kind !== 'SALES_ALLOCATION' &&
      kind !== 'REVERSAL' &&
      kind !== 'INBOUND_CONSUMPTION' &&
      kind !== 'OUTBOUND_CONSUMPTION' &&
      kind !== 'CONSUMPTION_CORRECTION' &&
      kind !== 'CONSUMPTION_REVERSAL'
    ) {
      continue;
    }
    const resolved = bucketKeyAndLabel(
      String((event as { businessDate?: unknown })?.businessDate || ''),
      granularity,
    );
    if (!resolved) continue;
    let bucket = byKey.get(resolved.key);
    if (!bucket) {
      bucket = {
        key: resolved.key,
        label: resolved.label,
        accumulated: 0,
        used: 0,
        net: 0,
        count: 0,
        sortKey: resolved.key,
      };
      byKey.set(resolved.key, bucket);
    }
    const amount = amountOf(event);
    if (GENERATION_KINDS.has(kind)) bucket.accumulated += amount;
    else bucket.used += amount;
    bucket.count += 1;
  }
  return [...byKey.values()]
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      accumulated: round2(bucket.accumulated),
      used: round2(bucket.used),
      net: round2(bucket.accumulated + bucket.used),
      count: bucket.count,
    }));
}
