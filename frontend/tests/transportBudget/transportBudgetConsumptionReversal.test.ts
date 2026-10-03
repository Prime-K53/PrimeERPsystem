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
  TransportBudgetConsumptionReversalError,
  TransportBudgetDuplicateIdError,
} from '../../services/repositories/transportBudgetRepository';
import {
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
  sameEconomicPayload,
} from '../../services/transportBudgetValidator';
import { TRANSPORT_BUDGET_TABLE_NAME } from '../../types/transportBudget';

// ---------------------------------------------------------------------------
// Fakes (hermetic local persistence + sync queue, no IndexedDB involved)
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

// A posted OUTBOUND_CONSUMPTION (terminal budget use). No producer exists in
// this phase; the row is seeded directly as the reversal target.
const outboundInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-out-001',
  kind: 'OUTBOUND_CONSUMPTION' as const,
  idempotencyKey: 'OUTBOUND_CONSUMPTION:EXP-7:DLV-7',
  sourceEventId: 'EXP-7:DLV-7',
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

// Frozen Phase 8D reversal shape: positive full amount, dedicated link,
// null snapshot hygiene (economics derive from the target).
const reversalInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-crev-001',
  kind: 'CONSUMPTION_REVERSAL' as const,
  idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-001',
  sourceEventId: null,
  sourceAmount: null,
  allocationRatePercent: null,
  amount: 20000,
  method: null,
  providerId: null,
  reversesEventId: 'evt-out-001',
  correctsEventId: null,
  businessDate: '2026-10-02',
  occurredAt: '2026-10-02T10:00:00.000Z',
  ...overrides,
});

const setup = (seed: Record<string, unknown>[] = []) => {
  const store = createStore(seed);
  const queue = createQueue();
  const repo = new TransportBudgetRepository(store as never, queue as never);
  return { store, queue, repo };
};

const setupWithTarget = async (
  parentOverrides: Record<string, unknown> = {},
) => {
  const { store, queue, repo } = setup();
  const appended = await repo.appendTransportBudgetEvent(
    outboundInput(parentOverrides) as never,
  );
  return { store, queue, repo, parent: appended.event };
};

const NOW = '2026-10-02T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Event shape (§8–9: sign, linkage, null hygiene)
// ---------------------------------------------------------------------------

describe('transportBudgetConsumptionReversal — event shape', () => {
  it('accepts a valid CONSUMPTION_REVERSAL', () => {
    const result = validateTransportBudgetEvent(reversalInput(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.kind).toBe('CONSUMPTION_REVERSAL');
      expect(result.event.amount).toBe(20000);
      expect(result.event.reversesEventId).toBe('evt-out-001');
    }
  });

  it('rejects zero and negative reversal amounts', () => {
    for (const amount of [0, -20000, -0.01]) {
      expect(
        validateTransportBudgetEvent({ ...reversalInput(), amount }, NOW).ok,
      ).toBe(false);
    }
  });

  it('rejects a missing reversesEventId and self-links', () => {
    expect(
      validateTransportBudgetEvent(
        { ...reversalInput(), reversesEventId: null },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...reversalInput(), id: 'evt-same', reversesEventId: 'evt-same' },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects snapshot fields on reversals (null hygiene)', () => {
    for (const patch of [
      { sourceEventId: 'evt-out-001' },
      { sourceAmount: 20000 },
      { method: 'OUTBOUND_TRANSPORT' },
      { providerId: 'SUP-COURIER-7' },
      { allocationRatePercent: 3 },
      { correctsEventId: 'evt-out-001' },
    ]) {
      expect(
        validateTransportBudgetEvent({ ...reversalInput(), ...patch }, NOW).ok,
      ).toBe(false);
    }
  });

  it('rejects reversesEventId on every other kind', () => {
    for (const base of [
      { ...outboundInput(), kind: 'SALES_ALLOCATION' as const },
      { ...outboundInput(), kind: 'INBOUND_CONSUMPTION' as const },
      { ...outboundInput(), kind: 'OUTBOUND_CONSUMPTION' as const },
      { ...outboundInput(), kind: 'CONSUMPTION_CORRECTION' as const },
    ]) {
      expect(
        validateTransportBudgetEvent(
          { ...base, reversesEventId: 'evt-out-001' },
          NOW,
        ).ok,
      ).toBe(false);
    }
  });

  it('sameEconomicPayload covers kind + reversesEventId', () => {
    const a = assertValidTransportBudgetEvent(reversalInput(), NOW);
    const b = assertValidTransportBudgetEvent(
      { ...reversalInput(), createdAt: '2026-10-03T00:00:00.000Z' },
      NOW,
    );
    expect(sameEconomicPayload(a, b)).toBe(true);
    expect(
      sameEconomicPayload(
        a,
        assertValidTransportBudgetEvent(
          { ...reversalInput(), reversesEventId: 'evt-out-999' },
          NOW,
        ),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Target linkage (§8: six allowed/rejected cases + legacy REVERSAL intact)
// ---------------------------------------------------------------------------

describe('transportBudgetConsumptionReversal — target linkage', () => {
  it('appends a reversal targeting a valid OUTBOUND event', async () => {
    const { repo } = await setupWithTarget();
    const result = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    expect(result.deduplicated).toBe(false);
    expect(result.event.kind).toBe('CONSUMPTION_REVERSAL');
    expect(result.event.amount).toBe(20000);
  });

  it('rejects targets: SALES_ALLOCATION, REVERSAL, INBOUND, CORRECTION, self', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent({
      id: 'evt-alloc-001',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:INV-1',
      sourceEventId: 'INV-1',
      sourceAmount: 500000,
      allocationRatePercent: 3,
      amount: 15000,
      method: null,
      providerId: null,
      reversesEventId: null,
      correctsEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);
    await repo.appendTransportBudgetEvent({
      ...outboundInput({ id: 'evt-in-001', kind: 'INBOUND_CONSUMPTION' as const }),
    } as never);
    await repo.appendReversal({
      id: 'evt-rev-001',
      kind: 'REVERSAL',
      idempotencyKey: 'REVERSAL:evt-alloc-001:1',
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -15000,
      method: null,
      providerId: null,
      reversesEventId: 'evt-alloc-001',
      correctsEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T12:00:00.000Z',
    } as never);
    // Raw-seeded correction row (target-kind coverage only; validity of
    // corrections themselves is proven by the correction suite).
    await store.put({
      id: 'evt-corr-001',
      kind: 'CONSUMPTION_CORRECTION',
    } as never);
    for (const targetId of ['evt-alloc-001', 'evt-rev-001', 'evt-in-001', 'evt-corr-001']) {
      await expect(
        repo.appendConsumptionReversal(
          reversalInput({
            id: `evt-crev-${targetId}`,
            reversesEventId: targetId,
          }) as never,
        ),
      ).rejects.toMatchObject({
        name: 'TransportBudgetConsumptionReversalError',
        code: 'TARGET_NOT_REVERSIBLE',
      });
    }
    // A reversal must not target another consumption reversal (no chains).
    const { repo: repo2 } = await setupWithTarget();
    await repo2.appendConsumptionReversal(reversalInput() as never);
    await expect(
      repo2.appendConsumptionReversal(
        reversalInput({
          id: 'evt-crev-chain',
          idempotencyKey: 'CONSUMPTION_REVERSAL:evt-crev-001',
          reversesEventId: 'evt-crev-001',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({
          id: 'evt-crev-missing',
          reversesEventId: 'missing-target',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_MISSING' });
    // Self-links fail closed at shape validation (before target lookup).
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({ id: 'evt-crev-self', reversesEventId: 'evt-crev-self' }) as never,
      ),
    ).rejects.toThrow();
  });

  it('legacy REVERSAL targeting OUTBOUND stays rejected', async () => {
    const { repo } = await setupWithTarget();
    await expect(
      repo.appendReversal({
        id: 'evt-rev-out',
        kind: 'REVERSAL',
        idempotencyKey: 'REVERSAL:evt-out-001:1',
        sourceEventId: null,
        sourceAmount: null,
        allocationRatePercent: null,
        amount: -20000,
        method: null,
        providerId: null,
        reversesEventId: 'evt-out-001',
        correctsEventId: null,
        businessDate: '2026-10-02',
        occurredAt: '2026-10-02T10:00:00.000Z',
      } as never),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });

  it('appendConsumptionReversal rejects non-reversal kinds', async () => {
    const { repo } = setup();
    await expect(
      repo.appendConsumptionReversal(outboundInput() as never),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });
});

// ---------------------------------------------------------------------------
// Amount (§9: full-only) and cardinality (§10)
// ---------------------------------------------------------------------------

describe('transportBudgetConsumptionReversal — amount and cardinality', () => {
  it('accepts the exact full amount (+20,000 on -20,000, net 0)', async () => {
    const { repo } = await setupWithTarget();
    const result = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    expect(result.event.amount).toBe(20000);
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
  });

  it('rejects partial amounts (+19,999) and over-amounts (+20,001)', async () => {
    for (const amount of [19999, 20001, 1]) {
      const { repo } = await setupWithTarget();
      await expect(
        repo.appendConsumptionReversal(
          reversalInput({ amount }) as never,
        ),
      ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
    }
  });

  it('rejects a second reversal against the same original', async () => {
    const { repo } = await setupWithTarget();
    await repo.appendConsumptionReversal(reversalInput() as never);
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({
          id: 'evt-crev-002',
          idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-001:2',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    const total = await repo.getConsumptionReversalTotal('evt-out-001');
    expect(total).toEqual({ total: 20000, count: 1 });
  });

  it('rejects two partials summing to the full amount (+10,000 twice)', async () => {
    const { repo } = await setupWithTarget();
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({ amount: 10000 }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });
});

// ---------------------------------------------------------------------------
// Idempotency + concurrency (§7) and immutability (§12)
// ---------------------------------------------------------------------------

describe('transportBudgetConsumptionReversal — idempotency and concurrency', () => {
  it('same ID + same economics dedupes', async () => {
    const { repo } = await setupWithTarget();
    const first = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    const retry = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
  });

  it('same ID + changed economics rejects', async () => {
    const { repo } = await setupWithTarget();
    await repo.appendConsumptionReversal(reversalInput() as never);
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({ businessDate: '2026-10-03' }) as never,
      ),
    ).rejects.toBeInstanceOf(TransportBudgetDuplicateIdError);
  });

  it('different ID + same key resolves existing', async () => {
    const { repo } = await setupWithTarget();
    const first = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    const retry = await repo.appendConsumptionReversal(
      reversalInput({ id: 'evt-crev-other' }) as never,
    );
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
  });

  it('concurrent same-target attempts converge to one row', async () => {
    const { repo } = await setupWithTarget();
    const [a, b] = await Promise.all([
      repo.appendConsumptionReversal(reversalInput() as never),
      repo.appendConsumptionReversal(
        reversalInput({ id: 'evt-crev-race' }) as never,
      ),
    ]);
    expect(a.event.id).toBe(b.event.id);
    const total = await repo.getConsumptionReversalTotal('evt-out-001');
    expect(total.count).toBe(1);
  });

  it('original OUTBOUND event is immutable across reversal', async () => {
    const { repo, store } = await setupWithTarget();
    const before = await repo.getTransportBudgetEvent('evt-out-001');
    await repo.appendConsumptionReversal(reversalInput() as never);
    const after = await repo.getTransportBudgetEvent('evt-out-001');
    expect(after).toEqual(before);
    expect(after?.amount).toBe(-20000);
    expect(store.size()).toBe(2);
  });

  it('reversal cannot itself be reversed or corrected', async () => {
    const { repo } = await setupWithTarget();
    await repo.appendConsumptionReversal(reversalInput() as never);
    // No chains: targeting the reversal row fails kind gate.
    await expect(
      repo.appendConsumptionReversal(
        reversalInput({
          id: 'evt-crev-chain2',
          idempotencyKey: 'CONSUMPTION_REVERSAL:evt-crev-001',
          reversesEventId: 'evt-crev-001',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });
});

// ---------------------------------------------------------------------------
// Overdraft (§13), isolation (§14), regression anchors (§16 M)
// ---------------------------------------------------------------------------

describe('transportBudgetConsumptionReversal — overdraft and isolation', () => {
  it('reversal succeeds on an already-negative signed balance', async () => {
    const { repo } = setup();
    // Existing signed balance: -500,000 (unrelated prior consumption).
    await repo.appendTransportBudgetEvent(
      outboundInput({
        id: 'evt-prior-001',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:PRIOR',
        sourceEventId: 'PRIOR',
        amount: -500000,
      }) as never,
    );
    await repo.appendTransportBudgetEvent(outboundInput() as never);
    const result = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    expect(result.event.amount).toBe(20000);
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(-500000);
  });

  it('produced rows carry null accounting fields and queue to the budget table only', async () => {
    const { store, queue, repo } = await setupWithTarget();
    const result = await repo.appendConsumptionReversal(
      reversalInput() as never,
    );
    expect(result.event).toMatchObject({
      accountSplits: null,
      journalIds: null,
      allocationRatePercent: null,
      sourceEventId: null,
      sourceAmount: null,
      method: null,
      providerId: null,
      correctsEventId: null,
    });
    expect(
      queue.ops.every((op) => op.table === TRANSPORT_BUDGET_TABLE_NAME),
    ).toBe(true);
    expect(store.size()).toBe(2);
  });
});
