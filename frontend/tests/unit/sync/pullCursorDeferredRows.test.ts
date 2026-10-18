/**
 * Deferred remote-merge regression tests (silent multi-device convergence loss).
 *
 * Both the pull and realtime paths refuse to overwrite a local row that
 * carries a pending local mutation. Before this fix the refusal was SILENT and,
 * on the pull path, terminal: the row was skipped and the per-table cursor
 * still advanced past its `updated_at`, so the remote change could never be
 * re-read by any future incremental pass.
 *
 * These tests pin the replacement contract:
 *   1. A pull-skipped row is recorded as deferred (not dropped).
 *   2. A targeted drain re-reads the row BY ID and applies the merge.
 *   3. A row whose local mutation is STILL pending is re-deferred, never
 *      clobbered by the remote snapshot.
 *   4. Ids the server no longer returns are satisfied (no infinite retry).
 *   5. A 429 during the drain keeps every id deferred and opens the circuit.
 *   6. A completed drain clears the durable queue meta (no re-read loops).
 *   7. Draining with nothing deferred is a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IDBKeyRange = {
  only: vi.fn((val: string) => ({ only: val })),
  upperBound: vi.fn(),
  lowerBound: vi.fn(),
  bound: vi.fn(),
};

const { mockFetchPullPage, mockGetSyncAccessToken } = vi.hoisted(() => ({
  mockFetchPullPage: vi.fn(),
  mockGetSyncAccessToken: vi.fn(async () => 'tok-123'),
}));

const { dbStores, storeFor } = vi.hoisted(() => {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const get = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return { dbStores: stores, storeFor: get };
});

vi.mock('../../../services/syncApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/syncApiClient')>();
  return {
    ...actual,
    fetchPullPage: mockFetchPullPage,
    getSyncAccessToken: mockGetSyncAccessToken,
  };
});

vi.mock('../../../services/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'tok-123', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      })),
      refreshSession: vi.fn(async () => ({ data: { session: null } })),
    },
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));

type MockRecord = Record<string, unknown>;

vi.mock('../../../services/db', () => ({
  dbService: {
    get: vi.fn(async (storeName: string, key: string) => storeFor(storeName).get(String(key))),
    put: vi.fn(async (storeName: string, value: MockRecord) => {
      storeFor(storeName).set(String((value as any).id), { ...value });
      return String((value as any).id);
    }),
    delete: vi.fn(async (storeName: string, key: string) => {
      storeFor(storeName).delete(String(key));
    }),
    getAll: vi.fn(async (storeName: string) => Array.from(storeFor(storeName).values())),
  },
  // Mirrors the real store mapping for the tables under test.
  getStoreForCloudTable: (table: string) => (table === 'products' ? 'inventory' : table),
}));

function createMemoryDb() {
  const stores: Record<string, Map<string, MockRecord>> = {
    operations: new Map(),
    meta: new Map(),
    metrics: new Map(),
  };

  const db = {
    get: vi.fn(async (storeName: string, key: string) => stores[storeName]?.get(key) || undefined),
    put: vi.fn(async (storeName: string, value: MockRecord) => {
      stores[storeName].set(String((value as any).key ?? (value as any).id), { ...value });
    }),
    delete: vi.fn(async (storeName: string, key: string) => {
      stores[storeName].delete(key);
    }),
    getAll: vi.fn(async (storeName: string) => Array.from(stores[storeName].values())),
    getAllFromIndex: vi.fn(async (storeName: string, _indexName: string, range?: { only?: string }) => {
      const all = Array.from(stores[storeName].values());
      // The only indexed lookup under test is `operations.by-status`; honoring
      // the range is what makes `hasPendingMutation` see completed ops as done.
      return range && 'only' in range ? all.filter((row) => row.status === range.only) : all;
    }),
    count: vi.fn(async (storeName: string) => stores[storeName].size),
    close: vi.fn(),
    transaction: vi.fn(() => ({
      done: Promise.resolve(),
      objectStore: (n: string) => ({
        put: async (value: MockRecord) => {
          (stores[n] ||= new Map()).set(String((value as any).key ?? (value as any).id), { ...value });
        },
        get: async (key: string) => stores[n]?.get(key),
      }),
    })),
  };

  return { db, stores };
}

const { idbHolder } = vi.hoisted(() => ({
  idbHolder: { db: null as unknown as ReturnType<typeof createMemoryDb>['db'] },
}));

vi.mock('idb', () => ({
  openDB: vi.fn(async () => idbHolder.db),
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

import { durableSyncQueue, resetDbConnection } from '../../../services/durableSyncQueue';
import { SyncPullRateLimitedError } from '../../../services/syncApiClient';
import {
  pullRemoteChanges,
  deferRemoteMerge,
  drainDeferredRemoteMerges,
  getDeferredRemoteMergeCount,
  resetDeferredRemoteMerges,
  resetPullSyncState,
  isPullCircuitOpen,
} from '../../../services/syncService';

const emptyPage = (table: string, offset = 0) => ({
  table,
  rows: [],
  page: { offset, limit: 2000, count: 0, hasMore: false },
});

const envelopeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  data: { name: 'Remote Name', price: 100 },
  version: 4,
  updated_at: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

const idPage = (table: string, rows: Array<Record<string, unknown>>) => ({
  table,
  rows,
  page: { offset: 0, limit: Math.max(rows.length, 1), count: rows.length, hasMore: false },
});

describe('deferred remote merges (pull-skip recovery)', () => {
  beforeEach(() => {
    idbHolder.db = createMemoryDb().db;
    dbStores.clear();
    resetDbConnection();
    resetPullSyncState();
    resetDeferredRemoteMerges();
    mockFetchPullPage.mockReset().mockImplementation(async (table: string, opts: any = {}) =>
      opts.ids ? idPage(table, []) : emptyPage(table, opts.offset ?? 0)
    );
    mockGetSyncAccessToken.mockReset().mockResolvedValue('tok-123');
  });

  afterEach(() => {
    resetDeferredRemoteMerges();
    resetPullSyncState();
    vi.restoreAllMocks();
  });

  it('1. a pull row skipped for a pending local mutation is recorded as deferred', async () => {
    // Local row exists AND carries a pending mutation → the pull must not
    // overwrite it, but must remember to merge it later.
    storeFor('inventory').set('p1', { id: 'p1', name: 'Local Pending' });
    await durableSyncQueue.enqueue({
      table: 'products',
      recordId: 'p1',
      operation: 'upsert',
      payload: { id: 'p1', name: 'Local Pending' },
    });
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) =>
      table === 'products' && !opts.ids ? { ...emptyPage(table), rows: [envelopeRow()] } : emptyPage(table, opts.offset ?? 0)
    );

    await pullRemoteChanges();

    expect(getDeferredRemoteMergeCount()).toBe(1);
    // The local row was NOT overwritten by the remote snapshot.
    expect(storeFor('inventory').get('p1')!.name).toBe('Local Pending');
  });

  it('2. the drain re-reads by id and applies the merge once the queue settles', async () => {
    const op = await durableSyncQueue.enqueue({
      table: 'products',
      recordId: 'p1',
      operation: 'upsert',
      payload: { id: 'p1', name: 'Local Pending' },
    });
    storeFor('inventory').set('p1', { id: 'p1', name: 'Local Pending' });
    deferRemoteMerge('products', 'p1');

    // The push settles → the mutation is no longer pending.
    await durableSyncQueue.markCompleted(op.id);

    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) =>
      opts.ids ? idPage(table, [envelopeRow()]) : emptyPage(table, opts.offset ?? 0)
    );

    const merged = await drainDeferredRemoteMerges();

    expect(merged).toBe(1);
    // Targeted point lookup: by id, never a cursor walk.
    const idCall = mockFetchPullPage.mock.calls.find(([, opts]: any) => opts?.ids);
    expect(idCall?.[0]).toBe('products');
    expect(idCall?.[1].ids).toEqual(['p1']);
    // The remote row landed in the mirrored local store with the cloud-source tag.
    const written = storeFor('inventory').get('p1')!;
    expect(written.name).toBe('Remote Name');
    expect(written._cloudSource).toBe(true);
    expect(getDeferredRemoteMergeCount()).toBe(0);
  });

  it('3. a row still carrying a pending mutation is re-deferred, never clobbered', async () => {
    await durableSyncQueue.enqueue({
      table: 'products',
      recordId: 'p1',
      operation: 'upsert',
      payload: { id: 'p1', name: 'Still Queued' },
    });
    storeFor('inventory').set('p1', { id: 'p1', name: 'Still Queued' });
    deferRemoteMerge('products', 'p1');

    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) =>
      opts.ids ? idPage(table, [envelopeRow()]) : emptyPage(table, opts.offset ?? 0)
    );

    const merged = await drainDeferredRemoteMerges();

    expect(merged).toBe(0);
    expect(getDeferredRemoteMergeCount()).toBe(1);
    expect(storeFor('inventory').get('p1')!.name).toBe('Still Queued');
  });

  it('4. ids the server no longer returns are satisfied (no infinite retry)', async () => {
    deferRemoteMerge('products', 'gone-1');

    const merged = await drainDeferredRemoteMerges();

    expect(merged).toBe(0);
    expect(getDeferredRemoteMergeCount()).toBe(0);
  });

  it('5. a 429 during the drain keeps every id deferred and opens the pull circuit', async () => {
    deferRemoteMerge('products', 'p1');
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (opts.ids) throw new SyncPullRateLimitedError(table, 30);
      return emptyPage(table, opts.offset ?? 0);
    });

    const merged = await drainDeferredRemoteMerges();

    expect(merged).toBe(0);
    expect(getDeferredRemoteMergeCount()).toBe(1);
    expect(isPullCircuitOpen()).toBe(true);
  });

  it('6. a completed drain clears the durable queue meta for the table', async () => {
    deferRemoteMerge('products', 'p1');
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) =>
      opts.ids ? idPage(table, [envelopeRow()]) : emptyPage(table, opts.offset ?? 0)
    );

    await drainDeferredRemoteMerges();

    // The persisted id set is emptied so a reload cannot resurrect the drain.
    const stored = await durableSyncQueue.getMeta('deferred_merge:products');
    expect(Array.isArray(stored) ? stored : []).toEqual([]);
  });

  it('7. draining with nothing deferred is a no-op (no network calls)', async () => {
    const merged = await drainDeferredRemoteMerges();
    expect(merged).toBe(0);
    expect(mockFetchPullPage).not.toHaveBeenCalled();
  });
});
