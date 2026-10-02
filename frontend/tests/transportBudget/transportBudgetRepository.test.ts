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
  TransportBudgetDuplicateIdError,
  TransportBudgetReversalError,
} from '../../services/repositories/transportBudgetRepository';
import { TransportBudgetValidationError } from '../../services/transportBudgetValidator';
import {
  TRANSPORT_BUDGET_TABLE_NAME,
  type TransportBudgetEvent,
} from '../../types/transportBudget';

// ---------------------------------------------------------------------------
// Fakes (hermetic local persistence + sync queue, no IndexedDB involved)
// ---------------------------------------------------------------------------

const createStore = (seed: TransportBudgetEvent[] = []) => {
  const rows = new Map<string, TransportBudgetEvent>(
    seed.map((entry) => [entry.id, { ...entry }]),
  );
  return {
    async get(id: string) {
      const found = rows.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
    async put(event: TransportBudgetEvent) {
      rows.set(event.id, { ...event });
    },
    size() {
      return rows.size;
    },
  };
};

const createQueue = () => {
  const ops: Array<{
    table: string;
    recordId: string;
    payload: TransportBudgetEvent;
  }> = [];
  return {
    ops,
    async enqueue(
      table: string,
      recordId: string,
      payload: TransportBudgetEvent,
    ) {
      ops.push({ table, recordId, payload: { ...payload } });
    },
    async hasPendingMutation(table: string, recordId: string) {
      return ops.some(
        (op) => op.table === table && op.recordId === recordId,
      );
    },
    clear() {
      ops.length = 0;
    },
  };
};

const allocationInput = (overrides = {}) => ({
  id: 'evt-alloc-001',
  kind: 'SALES_ALLOCATION' as const,
  idempotencyKey: 'SALES_ALLOCATION:INV-0001',
  sourceEventId: 'INV-0001',
  sourceAmount: 500000,
  allocationRatePercent: 3,
  amount: 15000,
  method: null,
  providerId: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T10:00:00.000Z',
  ...overrides,
});

const reversalInput = (overrides = {}) => ({
  id: 'evt-rev-001',
  kind: 'REVERSAL' as const,
  idempotencyKey: 'REVERSAL:evt-alloc-001:1',
  sourceEventId: null,
  sourceAmount: null,
  allocationRatePercent: null,
  amount: -15000,
  method: null,
  providerId: null,
  reversesEventId: 'evt-alloc-001',
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T12:00:00.000Z',
  ...overrides,
});

const consumptionInput = (
  kind: 'INBOUND_CONSUMPTION' | 'OUTBOUND_CONSUMPTION',
  overrides = {},
) => ({
  id: `evt-${kind === 'INBOUND_CONSUMPTION' ? 'in' : 'out'}-001`,
  kind,
  idempotencyKey: `${kind}:SRC-001`,
  sourceEventId: 'SRC-001',
  sourceAmount: null,
  allocationRatePercent: null,
  amount: kind === 'INBOUND_CONSUMPTION' ? -5000 : -3000,
  method: null,
  providerId: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T13:00:00.000Z',
  ...overrides,
});

const setup = (seed: TransportBudgetEvent[] = []) => {
  const store = createStore(seed);
  const queue = createQueue();
  const repo = new TransportBudgetRepository(store, queue);
  return { store, queue, repo };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transportBudgetRepository — append + validation', () => {
  it('appends a valid SALES_ALLOCATION with a stable identity', async () => {
    const { store, queue, repo } = setup();
    const result = await repo.appendTransportBudgetEvent(allocationInput());
    expect(result.deduplicated).toBe(false);
    expect(result.event.id).toBe('evt-alloc-001');
    expect(result.event.amount).toBe(15000);
    expect(result.event.createdAt).toBeTruthy();
    expect(store.size()).toBe(1);
    expect(queue.ops).toHaveLength(1);
    expect(queue.ops[0].table).toBe(TRANSPORT_BUDGET_TABLE_NAME);
    expect(queue.ops[0].recordId).toBe('evt-alloc-001');
  });

  it('generates a stable id when omitted', async () => {
    // NOTE: tests/setup.ts pins crypto.randomUUID to a constant, so queue
    // two distinct values here to simulate real UUID generation.
    const uuidMock = crypto.randomUUID as unknown as {
      mockReturnValueOnce(value: string): unknown;
    };
    uuidMock.mockReturnValueOnce('gen-uuid-0001');
    uuidMock.mockReturnValueOnce('gen-uuid-0002');
    const { repo } = setup();
    const { id, ...withoutId } = allocationInput();
    void id;
    const first = await repo.appendTransportBudgetEvent({
      ...withoutId,
      idempotencyKey: 'SALES_ALLOCATION:INV-A',
    });
    const second = await repo.appendTransportBudgetEvent({
      ...withoutId,
      idempotencyKey: 'SALES_ALLOCATION:INV-B',
    });
    expect(first.event.id).toBeTruthy();
    expect(second.event.id).toBeTruthy();
    expect(first.event.id).not.toBe(second.event.id);
  });

  it('rejects missing/invalid input without persisting', async () => {
    const { store, queue, repo } = setup();
    const badInputs = [
      { ...allocationInput(), kind: undefined },
      { ...allocationInput(), kind: 'SALES_REFUND' },
      { ...allocationInput(), idempotencyKey: '' },
      { ...allocationInput(), amount: undefined },
      { ...allocationInput(), amount: '15000' },
      { ...allocationInput(), amount: -15000 },
      { ...allocationInput(), businessDate: '30-09-2026' },
      { ...allocationInput(), allocationRatePercent: 101 },
      { ...allocationInput(), journalIds: ['J-1'] },
      { ...allocationInput(), reversesEventId: 'evt-alloc-001' },
    ];
    for (const input of badInputs) {
      await expect(
        repo.appendTransportBudgetEvent(input as never),
      ).rejects.toBeInstanceOf(TransportBudgetValidationError);
    }
    expect(store.size()).toBe(0);
    expect(queue.ops).toHaveLength(0);
  });
});

describe('transportBudgetRepository — idempotency', () => {
  it('same event id retry resolves to the same event (no duplicate)', async () => {
    const { store, queue, repo } = setup();
    const first = await repo.appendTransportBudgetEvent(allocationInput());
    const retry = await repo.appendTransportBudgetEvent(allocationInput());
    expect(retry.deduplicated).toBe(true);
    expect(retry.event).toEqual(first.event);
    expect(store.size()).toBe(1);
  });

  it('same id with different economics is a conflict, not a silent overwrite', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    await expect(
      repo.appendTransportBudgetEvent(
        allocationInput({ amount: 15001, idempotencyKey: 'SALES_ALLOCATION:INV-999' }),
      ),
    ).rejects.toBeInstanceOf(TransportBudgetDuplicateIdError);
    const stored = await repo.getTransportBudgetEvent('evt-alloc-001');
    expect(stored?.amount).toBe(15000);
    expect(store.size()).toBe(1);
  });

  it('same idempotency key with a new id resolves to the same economic event', async () => {
    const { store, repo } = setup();
    const first = await repo.appendTransportBudgetEvent(allocationInput());
    const retry = await repo.appendTransportBudgetEvent(
      allocationInput({ id: 'evt-alloc-retry-2' }),
    );
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
    expect(store.size()).toBe(1);
  });

  it('different id + different key creates a separate event when otherwise valid', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    const second = await repo.appendTransportBudgetEvent(
      allocationInput({
        id: 'evt-alloc-002',
        idempotencyKey: 'SALES_ALLOCATION:INV-0002',
        sourceEventId: 'INV-0002',
      }),
    );
    expect(second.deduplicated).toBe(false);
    expect(second.event.id).toBe('evt-alloc-002');
    expect(store.size()).toBe(2);
  });

  it('does not double-enqueue when the store already queued (dbService path)', async () => {
    const { queue, repo } = setup();
    const store = createStore();
    // Simulate dbService.put: local write + standard sync enqueue together.
    const queuingStore = {
      ...store,
      async put(event: TransportBudgetEvent) {
        await store.put(event);
        await queue.enqueue(TRANSPORT_BUDGET_TABLE_NAME, event.id, {
          ...event,
        });
      },
    };
    const repoWithQueuingStore = new TransportBudgetRepository(
      queuingStore,
      queue,
    );
    const result = await repoWithQueuingStore.appendTransportBudgetEvent(
      allocationInput(),
    );
    expect(result.deduplicated).toBe(false);
    expect(queue.ops).toHaveLength(1);
  });

  it('offline-created events retain id + key through a sync-shaped round trip', async () => {
    const { store, queue, repo } = setup();
    const created = await repo.appendTransportBudgetEvent(allocationInput());
    // Simulate offline -> queue -> server -> pull: structured clone through
    // the JSON envelope must preserve identity exactly.
    const queuedPayload = queue.ops[0].payload;
    const pulled = JSON.parse(JSON.stringify(queuedPayload));
    expect(pulled.id).toBe(created.event.id);
    expect(pulled.idempotencyKey).toBe(created.event.idempotencyKey);
    expect(pulled.amount).toBe(15000);
    const retry = await repo.appendTransportBudgetEvent(pulled);
    expect(retry.deduplicated).toBe(true);
    expect(store.size()).toBe(1);
  });

  it('deduplicated retries re-queue when no mutation is pending (self-healing)', async () => {
    const { queue, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    queue.clear(); // simulate "stored locally but queue drained/lost"
    const retry = await repo.appendTransportBudgetEvent(allocationInput());
    expect(retry.deduplicated).toBe(true);
    expect(queue.ops).toHaveLength(1);
    expect(queue.ops[0].recordId).toBe('evt-alloc-001');
  });
});

describe('transportBudgetRepository — immutability', () => {
  it('exposes no update/delete API', async () => {
    const { repo } = setup();
    const surface = repo as unknown as Record<string, unknown>;
    expect(surface.update).toBeUndefined();
    expect(surface.delete).toBeUndefined();
    expect(surface.softDelete).toBeUndefined();
    expect(surface.put).toBeUndefined();
  });

  it('the original event is unchanged after a reversal', async () => {
    const { repo } = setup();
    const created = await repo.appendTransportBudgetEvent(allocationInput());
    const before = { ...created.event };
    await repo.appendReversal(reversalInput({ amount: -5000 }));
    const after = await repo.getTransportBudgetEvent('evt-alloc-001');
    expect(after).toEqual(before);
  });

  it('returned events are frozen', async () => {
    const { repo } = setup();
    const created = await repo.appendTransportBudgetEvent(allocationInput());
    expect(Object.isFrozen(created.event)).toBe(true);
  });
});

describe('transportBudgetRepository — reversal integrity', () => {
  it('accepts a valid reversal linked to its allocation', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    const result = await repo.appendReversal(reversalInput({ amount: -5000 }));
    expect(result.deduplicated).toBe(false);
    expect(result.event.reversesEventId).toBe('evt-alloc-001');
    expect(result.event.amount).toBe(-5000);
  });

  it('appendReversal rejects non-REVERSAL kinds', async () => {
    const { repo } = setup();
    await expect(
      repo.appendReversal({
        ...(consumptionInput('INBOUND_CONSUMPTION') as never),
      } as never),
    ).rejects.toBeInstanceOf(TransportBudgetReversalError);
  });

  it('rejects reversals of nonexistent events', async () => {
    const { repo } = setup();
    await expect(repo.appendReversal(reversalInput())).rejects.toMatchObject({
      name: 'TransportBudgetReversalError',
      code: 'TARGET_MISSING',
    });
  });

  it('rejects reversals of non-allocation events', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(
      consumptionInput('INBOUND_CONSUMPTION'),
    );
    await repo.appendTransportBudgetEvent(
      consumptionInput('OUTBOUND_CONSUMPTION'),
    );
    for (const target of ['evt-in-001', 'evt-out-001']) {
      await expect(
        repo.appendReversal(
          reversalInput({
            id: `evt-rev-x-${target}`,
            idempotencyKey: `REVERSAL:${target}:1`,
            reversesEventId: target,
            amount: -100,
          }),
        ),
      ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
    }
  });

  it('rejects REVERSAL of a REVERSAL (only SALES_ALLOCATION is reversible)', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    await repo.appendReversal(reversalInput({ amount: -5000 }));
    await expect(
      repo.appendReversal(
        reversalInput({
          id: 'evt-rev-of-rev',
          idempotencyKey: 'REVERSAL:evt-rev-001:1',
          reversesEventId: 'evt-rev-001',
          amount: -100,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });

  it('rejects a reversal larger than the allocation', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    await expect(
      repo.appendReversal(reversalInput({ amount: -15001 })),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });

  it('enforces the cumulative cap: -5000 then -10000 ok, then -1 rejected', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    await repo.appendReversal(
      reversalInput({
        id: 'evt-rev-a',
        idempotencyKey: 'REVERSAL:evt-alloc-001:a',
        amount: -5000,
      }),
    );
    const full = await repo.appendReversal(
      reversalInput({
        id: 'evt-rev-b',
        idempotencyKey: 'REVERSAL:evt-alloc-001:b',
        amount: -10000,
      }),
    );
    expect(full.deduplicated).toBe(false);
    await expect(
      repo.appendReversal(
        reversalInput({
          id: 'evt-rev-c',
          idempotencyKey: 'REVERSAL:evt-alloc-001:c',
          amount: -1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
    // Allocation + two reversals only: the -1 never persisted.
    expect(store.size()).toBe(3);
    const position = await repo.getReversalTotal('evt-alloc-001');
    expect(position).toEqual({ total: -15000, count: 2 });
  });

  it('serializes concurrent over-cap reversals: exactly one wins', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent(
      allocationInput({ amount: 10000, idempotencyKey: 'SALES_ALLOCATION:INV-C' }),
    );
    const attempts = await Promise.allSettled([
      repo.appendReversal(
        reversalInput({
          id: 'evt-rev-race-1',
          idempotencyKey: 'REVERSAL:race:1',
          amount: -6000,
        }),
      ),
      repo.appendReversal(
        reversalInput({
          id: 'evt-rev-race-2',
          idempotencyKey: 'REVERSAL:race:2',
          amount: -6000,
        }),
      ),
    ]);
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(store.size()).toBe(2);
  });
});

describe('transportBudgetRepository — reads', () => {
  it('gets by id and by idempotency key', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    expect(
      (await repo.getTransportBudgetEvent('evt-alloc-001'))?.amount,
    ).toBe(15000);
    expect(await repo.getTransportBudgetEvent('missing')).toBeNull();
    expect(
      (
        await repo.findTransportBudgetEventByIdempotencyKey(
          'SALES_ALLOCATION:INV-0001',
        )
      )?.id,
    ).toBe('evt-alloc-001');
    expect(
      await repo.findTransportBudgetEventByIdempotencyKey('nope'),
    ).toBeNull();
    expect(await repo.findTransportBudgetEventByIdempotencyKey('')).toBeNull();
  });

  it('filters by kind, source, and business-date range (never created_at)', async () => {
    const { store, repo } = setup();
    const seed: TransportBudgetEvent[] = [
      {
        ...allocationInput({ id: 'evt-seed-1', idempotencyKey: 'K1' }),
        businessDate: '2026-06-01',
        // Stale creation metadata must NOT affect business-date retrieval.
        createdAt: '2020-05-05T00:00:00.000Z',
      } as TransportBudgetEvent,
      {
        ...(consumptionInput('INBOUND_CONSUMPTION', {
          id: 'evt-seed-2',
          idempotencyKey: 'K2',
        }) as unknown as TransportBudgetEvent),
        businessDate: '2026-06-02',
        createdAt: '2020-05-05T00:00:00.000Z',
      },
      {
        ...(consumptionInput('OUTBOUND_CONSUMPTION', {
          id: 'evt-seed-3',
          idempotencyKey: 'K3',
        }) as unknown as TransportBudgetEvent),
        businessDate: '2020-01-15',
        createdAt: new Date().toISOString(),
      },
    ];
    for (const entry of seed) await store.put(entry);

    // created_at is "today" for evt-seed-3, but its businessDate is old:
    // it must be excluded by a 2026 business-date filter.
    const june = await repo.listTransportBudgetEvents({
      fromBusinessDate: '2026-06-01',
      toBusinessDate: '2026-06-30',
    });
    expect(june.map((entry) => entry.id)).toEqual([
      'evt-seed-1',
      'evt-seed-2',
    ]);

    expect(
      (await repo.listTransportBudgetEvents({ kind: 'SALES_ALLOCATION' })).map(
        (entry) => entry.id,
      ),
    ).toEqual(['evt-seed-1']);
    expect(
      (
        await repo.listTransportBudgetEvents({ sourceEventId: 'SRC-001' })
      ).map((entry) => entry.id),
    ).toEqual(['evt-seed-3', 'evt-seed-2']); // businessDate ASC, then id ASC
  });

  it('returns raw records without reporting math', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    const listed = await repo.listTransportBudgetEvents();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('balance');
    expect(listed[0]).not.toHaveProperty('generated');
  });
});

describe('transportBudgetRepository — isolation', () => {
  it('only ever writes the transport budget store/table', async () => {
    const { store, queue, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    await repo.appendTransportBudgetEvent(
      consumptionInput('OUTBOUND_CONSUMPTION'),
    );
    await repo.appendReversal(reversalInput({ amount: -1000 }));
    expect(store.size()).toBe(3);
    expect(queue.ops.length).toBe(3);
    for (const op of queue.ops) {
      expect(op.table).toBe('transport_budget_events');
    }
  });

  it('stores the authoritative amount untouched (no recalculation)', async () => {
    const { store, repo } = setup();
    await repo.appendTransportBudgetEvent(allocationInput());
    const stored = await store.get('evt-alloc-001');
    // 500000 x 3% = 15000 supplied by the producer; the ledger stores it
    // verbatim and never derives it from sourceAmount x rate.
    expect(stored?.amount).toBe(15000);
    expect(stored).not.toHaveProperty('debitAccountId');
    expect(stored).not.toHaveProperty('creditAccountId');
    expect(stored?.journalIds).toBeNull();
    expect(stored?.accountSplits).toBeNull();
  });
});
