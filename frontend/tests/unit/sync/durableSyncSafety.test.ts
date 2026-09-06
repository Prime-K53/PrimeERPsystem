/**
 * durableSyncSafety.test.ts
 *
 * Regression tests for the sync-generation safety contract:
 *  - NEW operations are always stamped with the generation at creation time.
 *  - Generation survives persistence, dequeue/requeue and serialization.
 *  - Legacy operations persisted WITHOUT generation (created by an older build)
 *    are quarantined into a terminal dead-letter state and are NEVER replayed,
 *    never upgraded to the current generation, and never looped.
 *  - Non-retryable (permanent) rejections reach a terminal state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  durableSyncQueue,
  resetDbConnection,
  getLocalGeneration,
  setLocalGeneration,
  quarantineOperationsMissingGeneration,
  LEGACY_GENERATION_QUARANTINE_REASON,
} from '../../../services/durableSyncQueue';

(globalThis as any).IDBKeyRange = {
  only: vi.fn((val: string) => ({ only: val })),
  upperBound: vi.fn(),
  lowerBound: vi.fn(),
  bound: vi.fn(),
};

const mockStorage = {
  _data: {} as Record<string, string>,
  getItem(key: string): string | null { return this._data[key] ?? null; },
  setItem(key: string, value: string): void { this._data[key] = value; },
  removeItem(key: string): void { delete this._data[key]; },
  clear(): void { this._data = {}; },
};
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });

type MockRecord = Record<string, unknown>;

const { openDBMock } = vi.hoisted(() => ({ openDBMock: vi.fn() }));

vi.mock('idb', () => ({
  openDB: openDBMock,
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

const INDEX_FIELD: Record<string, string> = {
  'by-status': 'status',
  'by-created': 'createdAt',
  'by-operationId': 'operationId',
  'by-metric': 'metric',
};

// Persistent in-memory store: `resetDbConnection()` re-opens the SAME store map
// so queue records survive an app reload exactly like real IndexedDB.
const stores: Record<string, Map<string, MockRecord>> = {
  operations: new Map(),
  meta: new Map(),
  metrics: new Map(),
};

const persistentDb = {
  get: vi.fn(async (storeName: string, key: string) => stores[storeName]?.get(key) || undefined),
  put: vi.fn(async (storeName: string, value: MockRecord) => {
    const key = (value as any).id ?? (value as any).key;
    stores[storeName].set(key, { ...value });
  }),
  delete: vi.fn(async (storeName: string, key: string) => { stores[storeName].delete(key); }),
  getAll: vi.fn(async (storeName: string) => Array.from(stores[storeName].values())),
  getAllFromIndex: vi.fn(async (storeName: string, indexName: string, range?: unknown) => {
    const all = Array.from(stores[storeName].values());
    if (!range) return all;
    // idb accepts a plain key (used by getByOperationId) or an IDBKeyRange.
    const rangeVal = typeof range === 'string'
      ? range
      : (range as { only: string }).only;
    const field = INDEX_FIELD[indexName] || indexName;
    return all.filter((r) => (r as any)[field] === rangeVal);
  }),
  close: vi.fn(),
};

function freshDb() {
  return persistentDb;
}

/** Inject a record the way an OLD build would have persisted it: straight into
 *  the store, with NO syncGeneration property at all. */
function injectLegacyOp(partial: Partial<MockRecord> = {}): MockRecord {
  const legacy = {
    id: partial.id || `legacy-${Math.random().toString(36).slice(2)}`,
    operationId: partial.operationId || `op-${Math.random().toString(36).slice(2)}`,
    table: partial.table || 'invoices',
    recordId: partial.recordId || 'INV-P726/001',
    operation: partial.operation || 'upsert',
    payload: partial.payload || { id: 'INV-P726/001', totalAmount: 100 },
    userId: null,
    createdAt: partial.createdAt || '2026-08-01T00:00:00.000Z',
    retryCount: 0,
    lastAttempt: null,
    status: partial.status || 'pending',
    lastError: null,
    dependsOn: [],
    fileRef: null,
    errorType: null,
  };
  // Intentionally NO syncGeneration key — exactly how a legacy op looks.
  stores.operations.set(String(legacy.id), legacy);
  return legacy;
}

describe('durableSyncQueue sync-generation safety', () => {
  beforeEach(() => {
    localStorage.clear();
    stores.operations.clear();
    stores.meta.clear();
    stores.metrics.clear();
    openDBMock.mockReset().mockResolvedValue(freshDb());
    resetDbConnection();
  });

  describe('new operations are stamped at creation time', () => {
    it('enqueue stamps the current local generation when the caller omits it', async () => {
      setLocalGeneration(4);
      const op = await durableSyncQueue.enqueue({
        table: 'invoices', recordId: 'INV-1', operation: 'upsert', payload: { id: 'INV-1' },
      });
      expect(op.syncGeneration).toBe(4);
    });

    it('enqueue always produces a valid generation even with no local generation set', async () => {
      const op = await durableSyncQueue.enqueue({
        table: 'settings', recordId: 'some-setting', operation: 'upsert', payload: { value: 1 },
      });
      expect(op.syncGeneration).toBeGreaterThanOrEqual(1);
      expect(getLocalGeneration()).toBeGreaterThanOrEqual(1);
    });

    it('an explicit syncGeneration is respected (provenance from the caller)', async () => {
      setLocalGeneration(9);
      const op = await durableSyncQueue.enqueue({
        table: 'invoices', recordId: 'INV-2', operation: 'upsert', payload: { id: 'INV-2' }, syncGeneration: 3,
      });
      expect(op.syncGeneration).toBe(3);
    });

    it('generation survives persistence, dequeue/requeue and retrieval', async () => {
      setLocalGeneration(5);
      const op = await durableSyncQueue.enqueue({
        table: 'products', recordId: 'P-1', operation: 'upsert', payload: { id: 'P-1' },
      });
      // "Reload" via fresh db handle
      resetDbConnection();
      openDBMock.mockResolvedValue(freshDb());
      // requeue simulation (conflict merge round)
      await durableSyncQueue.requeue(op.id, { id: 'P-1', name: 'merged' });
      const persisted = await durableSyncQueue.getByOperationId(op.operationId);
      expect(persisted?.syncGeneration).toBe(5);

      // dequeue returns the item carrying its generation
      const dequeued = await durableSyncQueue.dequeue(10);
      expect(dequeued).toHaveLength(1);
      expect(dequeued[0].syncGeneration).toBe(5);
    });

    it('a fresh edit merges into an existing upsert WITHOUT re-stamping its generation', async () => {
      setLocalGeneration(2);
      const first = await durableSyncQueue.enqueue({
        table: 'customers', recordId: 'C-1', operation: 'upsert', payload: { id: 'C-1', name: 'a' },
      });
      setLocalGeneration(3); // pretend the device generation moved after a reset
      const second = await durableSyncQueue.enqueue({
        table: 'customers', recordId: 'C-1', operation: 'upsert', payload: { id: 'C-1', name: 'b' },
      });
      expect(second.id).toBe(first.id); // deduped/merged into the same op
      expect(second.syncGeneration).toBe(2); // provenance of the original mutation
    });
  });

  describe('legacy operations (no generation) are quarantined, never replayed', () => {
    it('dequeue quarantines a legacy pending op and never returns it', async () => {
      injectLegacyOp({ table: 'invoices', recordId: 'INV-P726/001', status: 'pending' });
      const dequeued = await durableSyncQueue.dequeue(10);
      expect(dequeued).toHaveLength(0);

      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead).toHaveLength(1);
      expect(dead[0].recordId).toBe('INV-P726/001');
      expect(dead[0].lastError).toContain('QUARANTINED');
      expect(dead[0].errorType).toBe('permanent');
      expect(dead[0].syncGeneration).toBeUndefined(); // never upgraded
      expect(await durableSyncQueue.countPending()).toBe(0);
    });

    it('quarantineOperationsMissingGeneration covers pending/syncing/failed and is idempotent', async () => {
      injectLegacyOp({ recordId: 'R1', status: 'pending' });
      injectLegacyOp({ recordId: 'R2', status: 'syncing' });
      injectLegacyOp({ recordId: 'R3', status: 'failed' });
      // A healthy current-generation op is left untouched
      setLocalGeneration(1);
      const healthy = await durableSyncQueue.enqueue({
        table: 'products', recordId: 'P-OK', operation: 'upsert', payload: { id: 'P-OK' },
      });
      expect(healthy.status).toBe('pending');

      const first = await quarantineOperationsMissingGeneration();
      expect(first).toBe(3);
      expect(await durableSyncQueue.getAll('dead_letter')).toHaveLength(3);

      const second = await quarantineOperationsMissingGeneration();
      expect(second).toBe(0); // idempotent
      // healthy op untouched and still pending
      const still = await durableSyncQueue.getAll('pending');
      expect(still.map((o) => o.recordId)).toEqual(['P-OK']);
    });

    it('retryFailed never re-queues a legacy failed op into the send loop', async () => {
      injectLegacyOp({ recordId: 'INV-P726/001', status: 'failed', retryCount: 1 });
      const count = await durableSyncQueue.retryFailed();
      expect(count).toBe(0);
      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead).toHaveLength(1);
      expect(dead[0].lastError).toContain('QUARANTINED');
    });

    it('retryDeadLetter refuses to re-arm a quarantined legacy op', async () => {
      const legacy = injectLegacyOp({ recordId: 'INV-P726/001', status: 'dead_letter' });
      await durableSyncQueue.retryDeadLetter(String(legacy.id));
      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead).toHaveLength(1);
      expect(await durableSyncQueue.getAll('pending')).toHaveLength(0);
      expect(String(dead[0].lastError)).toContain('Manual retry is blocked');
    });

    it('a new write to the same record replaces the legacy op with a fresh, stamped one', async () => {
      injectLegacyOp({ table: 'invoices', recordId: 'INV-P726/001', status: 'pending' });
      setLocalGeneration(2);
      const fresh = await durableSyncQueue.enqueue({
        table: 'invoices', recordId: 'INV-P726/001', operation: 'upsert',
        payload: { id: 'INV-P726/001', totalAmount: 250 },
      });
      expect(fresh.syncGeneration).toBe(2);
      // The legacy record was quarantined (kept for diagnostics), the new write is separate.
      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead.some((o) => o.recordId === 'INV-P726/001' && o.syncGeneration === undefined)).toBe(true);
      const pending = await durableSyncQueue.getAll('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(fresh.id);
    });

    it('quarantine keeps the payload for diagnostics (no silent data loss)', async () => {
      injectLegacyOp({ table: 'settings', recordId: 'prime:pagination:default', payload: { id: 'prime:pagination:default', value: 25 } });
      await durableSyncQueue.dequeue(10);
      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead[0].payload).toMatchObject({ value: 25 });
      expect(dead[0].lastError).toContain(LEGACY_GENERATION_QUARANTINE_REASON.slice(0, 40));
    });
  });

  describe('permanent rejections are terminal', () => {
    it('markFailed with a permanent classification dead-letters (never requeued by retryFailed)', async () => {
      const op = await durableSyncQueue.enqueue({
        table: 'invoices', recordId: 'INV-NEW', operation: 'upsert', payload: { id: 'INV-NEW' },
      });
      await durableSyncQueue.markFailed(op.id, 'Operation has no sync generation; cannot be safely replayed after a company reset', 'permanent');
      expect((await durableSyncQueue.getAll('dead_letter')).map((o) => o.recordId)).toContain('INV-NEW');
      const retried = await durableSyncQueue.retryFailed();
      expect(retried).toBe(0);
      expect((await durableSyncQueue.getAll('failed'))).toHaveLength(0);
    });

    it('retryFailed escalates a repeatedly-transient item to dead_letter at the cap', async () => {
      const op = await durableSyncQueue.enqueue({
        table: 'products', recordId: 'P-RETRY', operation: 'upsert', payload: { id: 'P-RETRY' },
      });
      for (let i = 0; i < 10; i++) {
        await durableSyncQueue.markFailed(op.id, 'timeout');
        await durableSyncQueue.retryFailed();
      }
      // After crossing the cap the item must be terminal.
      const dead = await durableSyncQueue.getAll('dead_letter');
      expect(dead.some((o) => o.recordId === 'P-RETRY')).toBe(true);
      expect((await durableSyncQueue.getAll('failed')).some((o) => o.recordId === 'P-RETRY')).toBe(false);
    });
  });

  describe('company-reset provenance invariants', () => {
    it('an op created under an old generation keeps its old generation after the local generation moves', async () => {
      setLocalGeneration(1);
      const op = await durableSyncQueue.enqueue({
        table: 'invoices', recordId: 'INV-OLD', operation: 'upsert', payload: { id: 'INV-OLD' }, syncGeneration: 1,
      });
      setLocalGeneration(2); // simulated company reset advanced the local generation
      const persisted = await durableSyncQueue.getByOperationId(op.operationId);
      expect(persisted?.syncGeneration).toBe(1);
      expect(getLocalGeneration()).toBe(2);
      // The op is NOT upgraded at replay/dequeue time.
      const dequeued = await durableSyncQueue.dequeue(10);
      expect(dequeued).toHaveLength(1);
      expect(dequeued[0].syncGeneration).toBe(1);
    });

    it('a current-generation operation still syncs normally (not affected by quarantine)', async () => {
      setLocalGeneration(1);
      const op = await durableSyncQueue.enqueue({
        table: 'customers', recordId: 'CUST-OK', operation: 'upsert', payload: { id: 'CUST-OK' },
      });
      await quarantineOperationsMissingGeneration();
      const pending = await durableSyncQueue.getAll('pending');
      expect(pending.map((o) => o.id)).toContain(op.id);
    });
  });
});
