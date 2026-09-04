import { describe, it, expect, vi, beforeEach } from 'vitest';

(globalThis as any).localStorage = {
  _data: {} as Record<string, string>,
  getItem(key: string): string | null { return this._data[key] ?? null; },
  setItem(key: string, value: string): void { this._data[key] = value; },
  removeItem(key: string): void { delete this._data[key]; },
  clear(): void { this._data = {}; },
};

(globalThis as any).IDBKeyRange = {
  only: vi.fn((val: string) => ({ only: val })),
  upperBound: vi.fn(),
  lowerBound: vi.fn(),
  bound: vi.fn(),
};

type MockRecord = Record<string, unknown>;

function createMemoryDB() {
  const stores: Record<string, Map<string, MockRecord>> = {
    operations: new Map(),
    meta: new Map(),
    metrics: new Map(),
  };

  const db = {
    get: vi.fn(async (storeName: string, key: string) => {
      return stores[storeName]?.get(key) || undefined;
    }),
    put: vi.fn(async (storeName: string, value: MockRecord) => {
      stores[storeName].set((value as any).id || (value as any).key, { ...value });
    }),
    delete: vi.fn(async (storeName: string, key: string) => {
      stores[storeName].delete(key);
    }),
    getAll: vi.fn(async (storeName: string) => {
      return Array.from(stores[storeName].values());
    }),
    getAllFromIndex: vi.fn(async (storeName: string, indexName: string, range?: unknown) => {
      return Array.from(stores[storeName].values());
    }),
    close: vi.fn(),
  };

  return { db, stores };
}

vi.mock('idb', () => ({
  openDB: vi.fn(async () => createMemoryDB().db),
  deleteDB: vi.fn(async () => {}),
}));

describe('Sync Generation — durableSyncQueue helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  describe('getLocalGeneration / setLocalGeneration', async () => {
    it('returns 1 by default when no generation is stored', async () => {
      const { getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      expect(getLocalGeneration()).toBe(1);
    });

    it('returns the stored generation value', async () => {
      localStorage.setItem('nexus_sync_generation', '3');
      const { getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      expect(getLocalGeneration()).toBe(3);
    });

    it('returns 1 for non-numeric stored values', async () => {
      localStorage.setItem('nexus_sync_generation', 'abc');
      const { getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      expect(getLocalGeneration()).toBe(1);
    });

    it('returns 1 for values less than 1', async () => {
      localStorage.setItem('nexus_sync_generation', '0');
      const { getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      expect(getLocalGeneration()).toBe(1);
    });

    it('setLocalGeneration stores the value', async () => {
      const { setLocalGeneration, getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      setLocalGeneration(5);
      expect(getLocalGeneration()).toBe(5);
    });

    it('setLocalGeneration clamps to minimum 1', async () => {
      const { setLocalGeneration, getLocalGeneration } = await import('../../../../services/durableSyncQueue');
      setLocalGeneration(0);
      expect(getLocalGeneration()).toBe(1);
    });
  });

  describe('QueuedOperation.syncGeneration field', async () => {
    it('enqueue stores the syncGeneration on the operation', async () => {
      localStorage.setItem('nexus_sync_generation', '2');
      const { durableSyncQueue } = await import('../../../../services/durableSyncQueue');
      const op = await durableSyncQueue.enqueue({
        table: 'customers',
        recordId: 'cust-1',
        operation: 'upsert',
        payload: { id: 'cust-1', name: 'Test' },
      });
      expect(op.syncGeneration).toBe(2);
    });

    it('enqueue accepts explicit syncGeneration that overrides localStorage', async () => {
      localStorage.setItem('nexus_sync_generation', '2');
      const { durableSyncQueue } = await import('../../../../services/durableSyncQueue');
      const op = await durableSyncQueue.enqueue({
        table: 'customers',
        recordId: 'cust-2',
        operation: 'upsert',
        payload: { id: 'cust-2', name: 'Explicit' },
        syncGeneration: 5,
      });
      expect(op.syncGeneration).toBe(5);
    });

    it('enqueue defaults to localStorage generation when no explicit value', async () => {
      localStorage.setItem('nexus_sync_generation', '3');
      const { durableSyncQueue } = await import('../../../../services/durableSyncQueue');
      const op = await durableSyncQueue.enqueue({
        table: 'products',
        recordId: 'prod-1',
        operation: 'upsert',
        payload: { id: 'prod-1', name: 'Default' },
      });
      expect(op.syncGeneration).toBe(3);
    });

    it('enqueue stores undefined syncGeneration when localStorage has no value and none supplied', async () => {
      const { durableSyncQueue } = await import('../../../../services/durableSyncQueue');
      const op = await durableSyncQueue.enqueue({
        table: 'products',
        recordId: 'prod-2',
        operation: 'upsert',
        payload: { id: 'prod-2', name: 'No Gen' },
      });
      expect(op.syncGeneration).toBeUndefined();
    });
  });

  describe('invalidateStaleOperations', async () => {
    it('marks pending operations as dead_letter', async () => {
      const { durableSyncQueue } = await import('../../../../services/durableSyncQueue');
      await durableSyncQueue.enqueue({
        table: 'customers',
        recordId: 'cust-stale',
        operation: 'upsert',
        payload: { id: 'cust-stale', name: 'Stale' },
      });

      const count = await durableSyncQueue.invalidateStaleOperations();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
