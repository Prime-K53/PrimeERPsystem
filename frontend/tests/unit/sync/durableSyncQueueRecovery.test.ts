/**
 * durableSyncQueueRecovery.test.ts
 *
 * Crash-safety regression for the durable queue.
 *
 * dequeue() flips rows to 'syncing' before handing them to a send cycle, but
 * nothing ever swept orphaned 'syncing' rows back to 'pending': dequeue() only
 * selects 'pending', retryFailed() only selects 'failed', and cleanup() only
 * prunes terminal states. A tab close or crash mid-batch therefore stranded the
 * operation forever — it never drained, and nothing reported it.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

// jsdom does not implement IndexedDB, so the global IDBKeyRange the queue uses
// for index lookups is absent. Mirrors the stub in syncConcurrency.test.ts.
if (typeof (globalThis as any).IDBKeyRange === 'undefined') {
  (globalThis as any).IDBKeyRange = {
    only: (value: unknown) => ({ only: value }),
    lowerBound: (value: unknown) => ({ lower: value }),
    upperBound: (value: unknown) => ({ upper: value }),
  };
}

const operations = new Map<string, any>();

const idbStub = {
  get: vi.fn(async (store: string, key: string) => (store === 'operations' ? operations.get(String(key)) : undefined)),
  put: vi.fn(async (store: string, item: any) => {
    if (store === 'operations') operations.set(String(item.id), { ...item });
  }),
  delete: vi.fn(async (store: string, key: string) => {
    if (store === 'operations') operations.delete(String(key));
  }),
  getAll: vi.fn(async (store: string) => (store === 'operations' ? Array.from(operations.values()) : [])),
  getAllFromIndex: vi.fn(async (store: string, _index: string, range?: any) => {
    if (store !== 'operations') return [];
    const all = Array.from(operations.values());
    if (!range || typeof range !== 'object') return all;
    if ('only' in range) {
      const wanted = String(range.only);
      return all.filter((op) => String(op.status) === wanted);
    }
    return all;
  }),
  count: vi.fn(async () => operations.size),
  createObjectStore: vi.fn(),
  deleteObjectStore: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
};

vi.mock('idb', () => ({
  openDB: vi.fn(async () => idbStub),
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const seedOp = (overrides: Record<string, any>) => {
  const op = {
    id: `op-${Math.random().toString(36).slice(2, 9)}`,
    table: 'examination_batches',
    recordId: 'batch-1',
    operation: 'upsert',
    payload: { id: 'batch-1', status: 'Calculated' },
    status: 'syncing',
    syncGeneration: 1,
    retryCount: 0,
    conflictCount: 0,
    dependsOn: [],
    createdAt: new Date().toISOString(),
    lastAttempt: new Date().toISOString(),
    ...overrides,
  };
  operations.set(op.id, op);
  return op;
};

describe('durable queue — stranded syncing operation recovery', () => {
  beforeEach(() => {
    operations.clear();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('returns an orphaned syncing row to pending', async () => {
    // lastAttempt is old enough to be considered abandoned.
    const orphan = seedOp({ lastAttempt: new Date(Date.now() - 10 * 60_000).toISOString() });

    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    const recovered = await durableSyncQueue.recoverStuckSyncing();

    expect(recovered).toBe(1);
    expect(operations.get(orphan.id)?.status).toBe('pending');
  });

  it('leaves a freshly in-flight row alone', async () => {
    const inFlight = seedOp({ lastAttempt: new Date().toISOString() });

    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    const recovered = await durableSyncQueue.recoverStuckSyncing();

    expect(recovered).toBe(0);
    expect(operations.get(inFlight.id)?.status).toBe('syncing');
  });

  it('preserves the payload so the resend is identical', async () => {
    const orphan = seedOp({
      lastAttempt: new Date(Date.now() - 10 * 60_000).toISOString(),
      payload: { id: 'batch-9', status: 'Approved', classes: [{ id: 'c1' }] },
    });
    const before = { ...operations.get(orphan.id)?.payload };

    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    await durableSyncQueue.recoverStuckSyncing();

    expect(operations.get(orphan.id)?.payload).toEqual(before);
  });

  it('recovers several stranded rows at once', async () => {
    const old = Date.now() - 30 * 60_000;
    seedOp({ lastAttempt: new Date(old).toISOString() });
    seedOp({ lastAttempt: new Date(old).toISOString() });
    seedOp({ lastAttempt: new Date(old).toISOString() });

    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    expect(await durableSyncQueue.recoverStuckSyncing()).toBe(3);
  });

  it('ignores rows already in a terminal state', async () => {
    const done = seedOp({ status: 'completed', lastAttempt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const dead = seedOp({ status: 'dead_letter', lastAttempt: new Date(Date.now() - 10 * 60_000).toISOString() });

    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    expect(await durableSyncQueue.recoverStuckSyncing()).toBe(0);
    expect(operations.get(done.id)?.status).toBe('completed');
    expect(operations.get(dead.id)?.status).toBe('dead_letter');
  });

  it('is safe to run when nothing is stranded', async () => {
    const { durableSyncQueue } = await import('../../services/durableSyncQueue');
    expect(await durableSyncQueue.recoverStuckSyncing()).toBe(0);
  });
});