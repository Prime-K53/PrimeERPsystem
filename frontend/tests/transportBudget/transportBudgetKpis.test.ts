/**
 * transportBudgetKpis.test.ts — Phase 10B KPI aggregation tests.
 *
 * Covers the pure aggregation in services/transportBudgetKpis.ts:
 * all six event families, signed nets, zero/net-zero cases, empty ledger,
 * date-window boundaries, weekly/monthly/yearly buckets, corrections and
 * reversals subtotals. No store, network, or database involved.
 */
import { describe, it, expect } from 'vitest';
import {
  sumTransportBudgetEvents,
  summarizeTransportBudgetByKind,
  bucketTransportBudgetByPeriod,
} from '../../services/transportBudgetKpis';
import type { TransportBudgetEvent } from '../../types/transportBudget';

let seq = 0;
const evt = (
  kind: TransportBudgetEvent['kind'],
  amount: number,
  businessDate: string,
): TransportBudgetEvent =>
  ({
    id: `evt-test-${++seq}`,
    kind,
    idempotencyKey: `TEST:${kind}:${seq}`,
    sourceEventId: null,
    sourceAmount: null,
    allocationRatePercent: null,
    amount,
    method: null,
    providerId: null,
    accountSplits: null,
    journalIds: null,
    reversesEventId: null,
    correctsEventId: null,
    businessDate,
    occurredAt: `${businessDate}T10:00:00.000Z`,
    createdAt: `${businessDate}T10:00:00.000Z`,
  }) as TransportBudgetEvent;

describe('transportBudgetKpis — six-family signed nets', () => {
  it('computes accumulated / used / remaining across all six kinds', () => {
    const events = [
      evt('SALES_ALLOCATION', 15000, '2026-09-30'),
      evt('REVERSAL', -15000, '2026-09-30'),
      evt('INBOUND_CONSUMPTION', -20000, '2026-09-15'),
      evt('CONSUMPTION_CORRECTION', 5000, '2026-09-20'),
      evt('OUTBOUND_CONSUMPTION', -8000, '2026-10-02'),
      evt('CONSUMPTION_REVERSAL', 8000, '2026-10-03'),
    ];
    const totals = sumTransportBudgetEvents(events);
    expect(totals.accumulated).toBe(0);
    expect(totals.inboundUsed).toBe(-15000);
    expect(totals.outboundUsed).toBe(0);
    expect(totals.used).toBe(-15000);
    expect(totals.remaining).toBe(-15000);
    expect(totals.corrections).toBe(5000);
    expect(totals.reversals).toBe(-7000);
    expect(totals.eventCount).toBe(6);
  });

  it('remaining always equals accumulated + used', () => {
    const events = [
      evt('SALES_ALLOCATION', 15000, '2026-09-30'),
      evt('REVERSAL', -5000, '2026-10-01'),
      evt('INBOUND_CONSUMPTION', -30000, '2026-09-15'),
      evt('CONSUMPTION_CORRECTION', 30000, '2026-09-20'),
      evt('OUTBOUND_CONSUMPTION', -12000, '2026-10-02'),
      evt('CONSUMPTION_REVERSAL', 12000, '2026-10-03'),
    ];
    const totals = sumTransportBudgetEvents(events);
    expect(totals.accumulated).toBe(10000);
    expect(totals.used).toBe(0);
    expect(totals.remaining).toBe(10000);
    expect(totals.remaining).toBe(totals.accumulated + totals.used);
  });

  it('net-zero pairs cancel exactly', () => {
    const events = [
      evt('SALES_ALLOCATION', 15000, '2026-09-30'),
      evt('REVERSAL', -15000, '2026-10-01'),
      evt('INBOUND_CONSUMPTION', -20000, '2026-09-15'),
      evt('CONSUMPTION_CORRECTION', 20000, '2026-09-20'),
      evt('OUTBOUND_CONSUMPTION', -8000, '2026-10-02'),
      evt('CONSUMPTION_REVERSAL', 8000, '2026-10-03'),
    ];
    const totals = sumTransportBudgetEvents(events);
    expect(totals.accumulated).toBe(0);
    expect(totals.inboundUsed).toBe(0);
    expect(totals.outboundUsed).toBe(0);
    expect(totals.used).toBe(0);
    expect(totals.remaining).toBe(0);
    expect(totals.eventCount).toBe(6);
  });

  it('empty and null ledgers yield zeros', () => {
    for (const input of [[], null, undefined]) {
      const totals = sumTransportBudgetEvents(
        input as unknown as TransportBudgetEvent[],
      );
      expect(totals).toEqual({
        accumulated: 0,
        used: 0,
        remaining: 0,
        inboundUsed: 0,
        outboundUsed: 0,
        corrections: 0,
        reversals: 0,
        eventCount: 0,
      });
    }
  });

  it('unknown kinds and non-numeric amounts never corrupt totals', () => {
    const events = [
      evt('SALES_ALLOCATION', 10000, '2026-09-30'),
      { ...evt('REVERSAL', -1000, '2026-10-01'), kind: 'FUTURE_KIND' },
      { ...evt('INBOUND_CONSUMPTION', -2000, '2026-09-15'), amount: NaN },
      { ...evt('OUTBOUND_CONSUMPTION', -3000, '2026-10-02'), amount: undefined },
      null,
      undefined,
    ] as unknown as TransportBudgetEvent[];
    const totals = sumTransportBudgetEvents(events);
    expect(totals.accumulated).toBe(10000);
    expect(totals.used).toBe(0);
    expect(totals.remaining).toBe(10000);
    // All three known-kind rows are counted; unknown kinds are not.
    // Non-numeric amounts normalize to 0 without corrupting the sums.
    expect(totals.eventCount).toBe(3);
  });
});

describe('transportBudgetKpis — by-kind subtotals', () => {
  it('returns zero-filled rows for all six canonical kinds', () => {
    const rows = summarizeTransportBudgetByKind([
      evt('SALES_ALLOCATION', 15000, '2026-09-30'),
      evt('SALES_ALLOCATION', 5000, '2026-10-01'),
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.kind)).toEqual([
      'SALES_ALLOCATION',
      'REVERSAL',
      'INBOUND_CONSUMPTION',
      'OUTBOUND_CONSUMPTION',
      'CONSUMPTION_CORRECTION',
      'CONSUMPTION_REVERSAL',
    ]);
    expect(rows[0]).toEqual({ kind: 'SALES_ALLOCATION', total: 20000, count: 2 });
    expect(rows[1]).toEqual({ kind: 'REVERSAL', total: 0, count: 0 });
  });

  it('empty input yields six zero rows', () => {
    const rows = summarizeTransportBudgetByKind([]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.total === 0 && r.count === 0)).toBe(true);
  });
});

describe('transportBudgetKpis — weekly buckets', () => {
  it('groups by Monday within and across weeks', () => {
    // 2026-09-28 is a Monday; 2026-10-04 is a Sunday of the same week.
    const buckets = bucketTransportBudgetByPeriod(
      [
        evt('SALES_ALLOCATION', 15000, '2026-09-28'),
        evt('INBOUND_CONSUMPTION', -4000, '2026-10-04'),
        evt('OUTBOUND_CONSUMPTION', -1000, '2026-10-05'),
      ],
      'week',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2026-09-28', '2026-10-05']);
    expect(buckets[0]).toMatchObject({
      accumulated: 15000,
      used: -4000,
      net: 11000,
      count: 2,
    });
    expect(buckets[1]).toMatchObject({
      accumulated: 0,
      used: -1000,
      net: -1000,
      count: 1,
    });
  });

  it('window-boundary dates land in their own week bucket', () => {
    const buckets = bucketTransportBudgetByPeriod(
      [
        evt('SALES_ALLOCATION', 1000, '2026-10-04'),
        evt('SALES_ALLOCATION', 2000, '2026-10-05'),
      ],
      'week',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2026-09-28', '2026-10-05']);
  });
});

describe('transportBudgetKpis — monthly buckets', () => {
  it('groups by calendar month with yyyy-MM keys', () => {
    const buckets = bucketTransportBudgetByPeriod(
      [
        evt('SALES_ALLOCATION', 15000, '2026-09-30'),
        evt('REVERSAL', -15000, '2026-09-30'),
        evt('INBOUND_CONSUMPTION', -20000, '2026-09-15'),
        evt('OUTBOUND_CONSUMPTION', -8000, '2026-10-02'),
        evt('CONSUMPTION_REVERSAL', 8000, '2026-10-03'),
      ],
      'month',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2026-09', '2026-10']);
    expect(buckets[0]).toMatchObject({
      accumulated: 0,
      used: -20000,
      net: -20000,
      count: 3,
    });
    expect(buckets[1]).toMatchObject({
      accumulated: 0,
      used: 0,
      net: 0,
      count: 2,
    });
  });

  it('month boundary dates do not leak across buckets', () => {
    const buckets = bucketTransportBudgetByPeriod(
      [
        evt('SALES_ALLOCATION', 1000, '2026-09-30'),
        evt('SALES_ALLOCATION', 2000, '2026-10-01'),
      ],
      'month',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2026-09', '2026-10']);
  });
});

describe('transportBudgetKpis — yearly buckets', () => {
  it('groups by calendar year', () => {
    const buckets = bucketTransportBudgetByPeriod(
      [
        evt('SALES_ALLOCATION', 15000, '2025-12-31'),
        evt('SALES_ALLOCATION', 20000, '2026-01-01'),
        evt('INBOUND_CONSUMPTION', -5000, '2026-06-15'),
      ],
      'year',
    );
    expect(buckets.map((b) => b.key)).toEqual(['2025', '2026']);
    expect(buckets[0]).toMatchObject({ accumulated: 15000, used: 0, net: 15000 });
    expect(buckets[1]).toMatchObject({ accumulated: 20000, used: -5000, net: 15000 });
  });

  it('empty input yields no buckets and undated rows are excluded', () => {
    expect(bucketTransportBudgetByPeriod([], 'month')).toEqual([]);
    expect(
      bucketTransportBudgetByPeriod(
        [{ ...evt('SALES_ALLOCATION', 1000, '2026-09-30'), businessDate: '' }],
        'month',
      ),
    ).toEqual([]);
  });
});

describe('transportBudgetKpis — corrections and reversals', () => {
  it('isolates correction and reversal subtotals', () => {
    const totals = sumTransportBudgetEvents([
      evt('REVERSAL', -15000, '2026-10-01'),
      evt('CONSUMPTION_CORRECTION', 20000, '2026-09-20'),
      evt('CONSUMPTION_REVERSAL', 8000, '2026-10-03'),
    ]);
    expect(totals.corrections).toBe(20000);
    expect(totals.reversals).toBe(-7000);
    expect(totals.inboundUsed).toBe(20000);
    expect(totals.outboundUsed).toBe(8000);
  });
});
