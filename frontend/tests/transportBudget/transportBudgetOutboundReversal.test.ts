/**
 * transportBudgetOutboundReversal.test.ts — Phase 8E VOID → CONSUMPTION_REVERSAL.
 *
 * Covers the void-reversal producer
 * (frontend/services/transportBudgetOutboundReversal.ts) against the frozen
 * Phase 8D contract, using the REAL TransportBudgetRepository over hermetic
 * in-memory store/queue fakes (no IndexedDB, no network, no Supabase).
 *
 * Out of scope here (covered elsewhere, cited): POST producer behavior
 * (transportBudgetOutboundConsumption.test.ts), 8D matrix/regression
 * (transportBudgetConsumptionReversal.test.ts), end-to-end service void
 * (transportExpense.test.ts "post emits …; void reverses …").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn(), put: vi.fn() },
}));
vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: { enqueue: vi.fn(), hasPendingMutation: vi.fn() },
}));
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  TransportBudgetRepository,
  consumptionReversalIdempotencyKey,
} from '../../services/repositories/transportBudgetRepository';
import {
  produceOutboundReversalsForVoid,
  produceOutboundReversalsSafely,
  fireOutboundReversalHook,
} from '../../services/transportBudgetOutboundReversal';
import { TRANSPORT_BUDGET_TABLE_NAME } from '../../types/transportBudget';

// ---------------------------------------------------------------------------
// Fakes (same hermetic pattern as the Phase 8D suites)
// ---------------------------------------------------------------------------

const createStore = (seed: Record<string, unknown>[] = []) => {
  const rows = new Map<string, Record<string, unknown>>(
    seed.map((entry) => [String((entry as { id: string }).id), { ...entry }]),
  );
  return {
    async get(id: string) {
      const found = rows.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
    async put(event: Record<string, unknown>) {
      rows.set(String((event as { id: string }).id), { ...event });
    },
    size() {
      return rows.size;
    },
  };
};

const createQueue = () => {
  const ops: Array<{ table: string; recordId: string }> = [];
  return {
    ops,
    async enqueue(table: string, recordId: string) {
      ops.push({ table, recordId });
    },
    async hasPendingMutation() {
      return false;
    },
    clear() {
      ops.length = 0;
    },
  };
};

const OUTBOUND = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-out-001',
  kind: 'OUTBOUND_CONSUMPTION' as const,
  idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-V1:L-1',
  sourceEventId: 'TEXP-V1:L-1',
  sourceAmount: 20000,
  allocationRatePercent: null,
  amount: -20000,
  method: 'OUTBOUND_TRANSPORT',
  providerId: 'SUP-COURIER-7',
  reversesEventId: null,
  correctsEventId: null,
  businessDate: '2026-10-02',
  occurredAt: '2026-10-02T09:00:00.000Z',
  ...overrides,
});

const VOIDED = (overrides: Record<string, unknown> = {}) => ({
  id: 'TEXP-V1',
  status: 'VOIDED',
  businessDate: '2026-10-02',
  occurredAt: '2026-10-02T09:00:00.000Z',
  isReversal: false,
  reversesExpenseId: null,
  ...overrides,
});

const VOID_AT = '2026-10-03T11:00:00.000Z';

const setup = (seed: Record<string, unknown>[] = []) => {
  const store = createStore(seed);
  const queue = createQueue();
  const repo = new TransportBudgetRepository(store as never, queue as never);
  const deps = { repository: repo };
  return { store, queue, repo, deps };
};

const setupWithOutbound = async (
  outboundOverrides: Record<string, unknown> = {},
) => {
  const ctx = setup();
  await ctx.repo.appendTransportBudgetEvent(
    OUTBOUND(outboundOverrides) as never,
  );
  return ctx;
};

const produce = (
  ctx: ReturnType<typeof setup>,
  expenseOverrides: Record<string, unknown> = {},
  voidAt: string = VOID_AT,
) =>
  produceOutboundReversalsForVoid(ctx.deps, {
    voidedExpense: VOIDED(expenseOverrides) as never,
    voidOccurredAt: voidAt,
  });

beforeEach(() => {
  vi.clearAllMocks();
  // Production crypto.randomUUID is unique per call, but the shared jsdom
  // setup stubs it to a constant. Producer-generated event ids (id: '')
  // need production-like uniqueness, otherwise multi-line voids collide on
  // one physical id. Scoped to this file only.
  let uuidSeq = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as any).crypto ?? {}),
      randomUUID: () => `mock-uuid-${String(++uuidSeq).padStart(4, '0')}`,
    },
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// B–I: void creates the exact reversal (amount, key, linkage, dates, hygiene)
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — void creates exact reversal', () => {
  it('void of a posted expense creates +20,000 against the -20,000 original', async () => {
    const ctx = await setupWithOutbound();
    const out = await produce(ctx);
    expect(out.failed).toHaveLength(0);
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0]).toMatchObject({
      kind: 'CONSUMPTION_REVERSAL',
      amount: 20000,
      reversesEventId: 'evt-out-001',
      idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-001',
      sourceEventId: null,
      sourceAmount: null,
      method: null,
      providerId: null,
      allocationRatePercent: null,
      accountSplits: null,
      journalIds: null,
      correctsEventId: null,
      businessDate: '2026-10-02',
      occurredAt: VOID_AT,
    });
    // Net budget effect of post + void is exactly zero.
    const events = await ctx.repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
  });

  it('uses the canonical reversal key for the original id', async () => {
    const ctx = await setupWithOutbound();
    const out = await produce(ctx);
    expect(out.produced[0].idempotencyKey).toBe(
      consumptionReversalIdempotencyKey('evt-out-001'),
    );
  });

  it('queues only the budget table for the reversal', async () => {
    const ctx = await setupWithOutbound();
    await produce(ctx);
    expect(ctx.queue.ops.length).toBeGreaterThan(0);
    expect(
      ctx.queue.ops.every((op) => op.table === TRANSPORT_BUDGET_TABLE_NAME),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J–L, Q: no fabrication (non-transport, empty store, missing original)
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — no fabrication', () => {
  it('void of an expense with no outbound events does nothing', async () => {
    const ctx = setup();
    const out = await produce(ctx);
    expect(out.produced).toHaveLength(0);
    expect(out.deduplicated).toHaveLength(0);
    expect(out.failed).toHaveLength(0);
    expect(out.skipped).toMatchObject([
      { scope: 'TEXP-V1', reason: 'no-outbound-events' },
    ]);
    expect(ctx.store.size()).toBe(0);
  });

  it('non-POSTED/VOIDED input never derives economics', async () => {
    const ctx = await setupWithOutbound();
    for (const status of ['DRAFT', 'POSTED']) {
      const out = await produce(ctx, { status });
      expect(out.produced).toHaveLength(0);
      expect(out.skipped).toMatchObject([{ reason: 'not-voided' }]);
    }
    expect(ctx.store.size()).toBe(1);
  });

  it('malformed source and void timestamp fail closed without rows', async () => {
    const ctx = await setupWithOutbound();
    const badExpense = await produceOutboundReversalsForVoid(ctx.deps, {
      voidedExpense: null as never,
      voidOccurredAt: VOID_AT,
    });
    expect(badExpense.produced).toHaveLength(0);
    const badDate = await produce(ctx, {}, 'not-a-date');
    expect(badDate.produced).toHaveLength(0);
    expect(badDate.skipped).toMatchObject([{ reason: 'malformed-source' }]);
    expect(ctx.store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// K: mixed documents reverse each transport line independently
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — mixed documents', () => {
  it('reverses each transport line independently; non-transport ignored', async () => {
    const ctx = setup();
    // POST produced two outbound events (A -12,000, B -8,000); the 100,000
    // NON_TRANSPORT line never produced anything.
    await ctx.repo.appendTransportBudgetEvent(
      OUTBOUND({
        id: 'evt-out-A',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-MIX:LA',
        sourceEventId: 'TEXP-MIX:LA',
        sourceAmount: 12000,
        amount: -12000,
        providerId: 'SUP-A',
      }) as never,
    );
    await ctx.repo.appendTransportBudgetEvent(
      OUTBOUND({
        id: 'evt-out-B',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-MIX:LB',
        sourceEventId: 'TEXP-MIX:LB',
        sourceAmount: 8000,
        amount: -8000,
        providerId: 'SUP-B',
      }) as never,
    );
    const out = await produce(ctx, { id: 'TEXP-MIX' });
    expect(out.failed).toHaveLength(0);
    expect(out.produced).toHaveLength(2);
    const byTarget = new Map(out.produced.map((e) => [e.reversesEventId, e]));
    expect(byTarget.get('evt-out-A')).toMatchObject({
      amount: 12000,
      idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-A',
    });
    expect(byTarget.get('evt-out-B')).toMatchObject({
      amount: 8000,
      idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-B',
    });
    // No header-level collapse: two distinct reversal identities.
    expect(
      new Set(out.produced.map((e) => e.idempotencyKey)).size,
    ).toBe(2);
    const events = await ctx.repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
  });

  it('different expenses with same-looking lines stay isolated', async () => {
    const ctx = setup();
    await ctx.repo.appendTransportBudgetEvent(
      OUTBOUND({
        id: 'evt-out-A1',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-A:L-1',
        sourceEventId: 'TEXP-A:L-1',
      }) as never,
    );
    await ctx.repo.appendTransportBudgetEvent(
      OUTBOUND({
        id: 'evt-out-B1',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-B:L-1',
        sourceEventId: 'TEXP-B:L-1',
      }) as never,
    );
    const out = await produce(ctx, { id: 'TEXP-A' });
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0].reversesEventId).toBe('evt-out-A1');
  });

  it('ignores rows whose kind is not OUTBOUND even under a colliding scope', async () => {
    const ctx = setup();
    // Hand-seeded decoy: INBOUND row carrying an outbound-shaped key can
    // never arise from a validator, but the producer must not trust keys.
    await ctx.store.put({
      ...OUTBOUND(),
      kind: 'INBOUND_CONSUMPTION',
      amount: -20000,
    } as never);
    const out = await produce(ctx);
    expect(out.produced).toHaveLength(0);
    expect(out.skipped).toMatchObject([{ reason: 'no-outbound-events' }]);
    expect(ctx.store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M, N (§14), T: retry, producer-level concurrency, replay
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — idempotency and concurrency', () => {
  it('void retry dedupes to the same reversal', async () => {
    const ctx = await setupWithOutbound();
    const first = await produce(ctx);
    expect(first.produced).toHaveLength(1);
    expect(first.deduplicated).toHaveLength(0);
    const retry = await produce(ctx);
    expect(retry.produced).toHaveLength(0);
    expect(retry.deduplicated).toHaveLength(1);
    expect(retry.deduplicated[0].id).toBe(first.produced[0].id);
    expect(ctx.store.size()).toBe(2);
  });

  it('concurrent void invocations converge to one reversal per original', async () => {
    const ctx = await setupWithOutbound();
    const [a, b, c] = await Promise.all([
      produce(ctx),
      produce(ctx),
      produce(ctx),
    ]);
    const all = [...a.produced, ...b.produced, ...c.produced];
    const deduped = [
      ...a.deduplicated,
      ...b.deduplicated,
      ...c.deduplicated,
    ];
    expect(all).toHaveLength(1);
    expect(deduped).toHaveLength(2);
    expect(deduped.every((e) => e.id === all[0].id)).toBe(true);
    const reversals = (
      await ctx.repo.listTransportBudgetEvents({
        kind: 'CONSUMPTION_REVERSAL',
      })
    ).filter((e) => e.reversesEventId === 'evt-out-001');
    expect(reversals).toHaveLength(1);
  });

  it('sync replay (repeat invocation) never duplicates economics', async () => {
    const ctx = await setupWithOutbound();
    await produce(ctx);
    for (let i = 0; i < 3; i++) {
      const replay = await produce(ctx);
      expect(replay.produced).toHaveLength(0);
      expect(replay.failed).toHaveLength(0);
    }
    expect(ctx.store.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// O, P, X: reversal-row exclusion and chain impossibility
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — reversal-row exclusion', () => {
  it('never processes a reversal row as a fresh source', async () => {
    const ctx = await setupWithOutbound();
    for (const doc of [
      { id: 'TEXP-REV-1', status: 'POSTED', isReversal: true },
      {
        id: 'TEXP-REV-2',
        status: 'POSTED',
        isReversal: false,
        reversesExpenseId: 'TEXP-V1',
      },
    ]) {
      const out = await produceOutboundReversalsForVoid(ctx.deps, {
        voidedExpense: doc as never,
        voidOccurredAt: VOID_AT,
      });
      expect(out.produced).toHaveLength(0);
      expect(out.deduplicated).toHaveLength(0);
    }
    // The POSTED original still reverses normally afterwards.
    const out = await produce(ctx);
    expect(out.produced).toHaveLength(1);
  });

  it('a reversal row can never seed a second consumption (no chains)', async () => {
    const ctx = await setupWithOutbound();
    await produce(ctx);
    // Only a CONSUMPTION_REVERSAL row exists under a foreign scope: the
    // OUTBOUND-scoped resolution finds nothing and fabricates nothing.
    const out = await produce(ctx, { id: 'TEXP-NO-OUTBOUND' });
    expect(out.produced).toHaveLength(0);
    expect(out.skipped).toMatchObject([{ reason: 'no-outbound-events' }]);
    expect(ctx.store.size()).toBe(2);
  });

  it('reversal-of-reversal is impossible through this producer', async () => {
    const ctx = await setupWithOutbound();
    const first = await produce(ctx);
    const reversalId = first.produced[0].id;
    // Even aimed at the reversal row, resolution only matches OUTBOUND rows.
    const out = await produceOutboundReversalsForVoid(ctx.deps, {
      voidedExpense: VOIDED({ id: reversalId }) as never,
      voidOccurredAt: VOID_AT,
    });
    expect(out.produced).toHaveLength(0);
    expect(ctx.store.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S, R: failure recovery without touching the committed void
// ---------------------------------------------------------------------------

describe('transportBudgetOutboundReversal — failure recovery', () => {
  it('repository failure is reported, never thrown, and the void stands', async () => {
    const ctx = await setupWithOutbound();
    const failing = {
      repository: {
        appendConsumptionReversal: async () => {
          throw new Error('simulated outage');
        },
        listTransportBudgetEvents: ctx.repo.listTransportBudgetEvents.bind(
          ctx.repo,
        ),
      },
    };
    const out = await produceOutboundReversalsForVoid(failing as never, {
      voidedExpense: VOIDED() as never,
      voidOccurredAt: VOID_AT,
    });
    expect(out.produced).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].scope).toBe('evt-out-001');
    // Nothing merged: the original is untouched and no reversal exists.
    expect(ctx.store.size()).toBe(1);
  });

  it('safe wrapper never throws on total repository failure', async () => {
    const out = await produceOutboundReversalsSafely(
      {
        repository: {
          appendConsumptionReversal: async () => {
            throw new Error('boom');
          },
          listTransportBudgetEvents: async () => {
            throw new Error('boom');
          },
        } as never,
      },
      { voidedExpense: VOIDED() as never, voidOccurredAt: VOID_AT },
    );
    expect(out.failed).toHaveLength(1);
  });

  it('deterministic retry after failure creates the missing reversal', async () => {
    const ctx = await setupWithOutbound();
    let fail = true;
    const flaky = {
      repository: {
        appendConsumptionReversal: async (input: never) => {
          if (fail) throw new Error('simulated outage');
          return ctx.repo.appendConsumptionReversal(input);
        },
        listTransportBudgetEvents: ctx.repo.listTransportBudgetEvents.bind(
          ctx.repo,
        ),
      },
    };
    const first = await produceOutboundReversalsForVoid(flaky as never, {
      voidedExpense: VOIDED() as never,
      voidOccurredAt: VOID_AT,
    });
    expect(first.failed).toHaveLength(1);
    fail = false;
    const retry = await produceOutboundReversalsForVoid(flaky as never, {
      voidedExpense: VOIDED() as never,
      voidOccurredAt: VOID_AT,
    });
    expect(retry.failed).toHaveLength(0);
    expect(retry.produced).toHaveLength(1);
    expect(retry.produced[0]).toMatchObject({
      amount: 20000,
      reversesEventId: 'evt-out-001',
    });
  });

  it('fire-and-forget hook swallows rejection and returns void', () => {
    expect(
      fireOutboundReversalHook(
        Promise.reject(new Error('async budget failure')),
        'TEXP-V1',
      ),
    ).toBeUndefined();
  });
});
