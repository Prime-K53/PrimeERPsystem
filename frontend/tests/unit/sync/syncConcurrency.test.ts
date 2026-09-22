/**
 * syncConcurrency.test.ts — regression tests for the Device B offline → online
 * synchronization defects:
 *
 * - at most ONE active syncOnce() (synchronous single-consumer lock)
 * - one authoritative online/visibility/periodic lifecycle (no duplicates)
 * - no concurrent duplicate submission of the same pending operation
 * - partial success settles each op exactly once; retries stay single-path
 * - lock release on exception / zero-pending
 * - push-sync emits exactly ONE data-changed signal when data changed, none otherwise
 *
 * Part 1 uses the shared module graph (same harness as backgroundSync.test.ts).
 * Part 2 re-imports the service with stubbed browser globals to exercise the
 * real window/document listener lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { durableSyncQueue, resetDbConnection } from '../../../services/durableSyncQueue';
import { backgroundSyncService } from '../../../services/backgroundSyncService';

(globalThis as any).IDBKeyRange = {
  only: vi.fn((val: string) => ({ only: val })),
  upperBound: vi.fn(),
  lowerBound: vi.fn(),
  bound: vi.fn(),
};

const { openDBMock } = vi.hoisted(() => ({ openDBMock: vi.fn() }));
const { mockSendOps, mockUploadFile } = vi.hoisted(() => ({
  mockSendOps: vi.fn(async (ops: { operationId?: string }[]) => ({
    ok: true,
    processed: ops.length,
    succeeded: ops.length,
    results: ops.map((op) => ({ operationId: op.operationId, ok: true, id: 'mock-id' })),
  })),
  mockUploadFile: vi.fn(async () => 'mock-url'),
}));

vi.mock('idb', () => ({
  openDB: openDBMock,
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

vi.mock('../../../services/syncApiClient', () => ({
  sendSyncOps: mockSendOps,
  SyncAuthError: class SyncAuthError extends Error {
    readonly status: number;
    readonly code: 'unauthenticated' | 'forbidden';
    constructor(message: string, status: number) {
      super(message);
      this.name = 'SyncAuthError';
      this.status = status;
      this.code = status === 401 ? 'unauthenticated' : 'forbidden';
    }
  },
}));

vi.mock('../../../services/cloudDb', () => ({
  cloudDb: {
    uploadFile: mockUploadFile,
  },
}));

function createDb() {
  const stores: Record<string, Map<string, Record<string, unknown>>> = {
    operations: new Map(),
    meta: new Map(),
    metrics: new Map(),
    inventory: new Map(),
  };

  const INDEX_FIELD: Record<string, string> = {
    'by-status': 'status',
    'by-created': 'createdAt',
    'by-operationId': 'operationId',
    'by-metric': 'metric',
  };

  return {
    get: vi.fn(async (storeName: string, key: string) => stores[storeName]?.get(key) || undefined),
    put: vi.fn(async (storeName: string, value: Record<string, unknown>) => {
      stores[storeName].set(value.id as string, { ...value });
    }),
    delete: vi.fn(async (storeName: string, key: string) => { stores[storeName].delete(key); }),
    getAll: vi.fn(async (storeName: string) => Array.from(stores[storeName].values())),
    getAllFromIndex: vi.fn(async (storeName: string, indexName: string, range?: unknown) => {
      const all = Array.from(stores[storeName].values());
      if (!range) return all;
      const rangeVal = (range as { only: string }).only;
      const field = INDEX_FIELD[indexName] || indexName;
      return all.filter(r => (r as any)[field] === rangeVal);
    }),
    count: vi.fn(async (storeName: string) => stores[storeName].size),
    close: vi.fn(),
    objectStoreNames: { contains: vi.fn(() => true) },
    transaction: vi.fn((storeNames: string | string[], _mode?: string) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      return {
        done: Promise.resolve(),
        objectStore: (n: string) => ({
          put: async (value: Record<string, unknown>) => {
            (stores[n] ||= new Map()).set(value.id as string, { ...value });
          },
          get: async (key: string) => stores[n]?.get(key),
        }),
      };
    }),
    createObjectStore: vi.fn(),
    deleteObjectStore: vi.fn(),
  };
}

function okResults(ops: { operationId?: string }[]) {
  return {
    ok: true,
    processed: ops.length,
    succeeded: ops.length,
    results: ops.map((op) => ({ operationId: op.operationId, ok: true, id: 'mock-id' })),
  };
}

// tests/setup.ts stubs crypto.randomUUID to a CONSTANT ('mock-uuid-1234'),
// so every queued operation would share one operationId and the per-op
// result map would collapse. Production uses real UUIDs — restore uniqueness
// here so multi-op tests mirror production behavior.
let uuidCounter = 0;
function stubUniqueOperationIds() {
  const rnd = (globalThis as any)?.crypto?.randomUUID;
  if (rnd && typeof rnd.mockImplementation === 'function') {
    rnd.mockImplementation(() => `test-uuid-${++uuidCounter}`);
  }
}

/** A sendSyncOps mock that blocks until release() is called (holds the lock). */
function blockingSendOps() {
  let release!: (value: unknown) => void;
  const gate = new Promise<unknown>((resolve) => { release = resolve; });
  mockSendOps.mockImplementationOnce(() => gate as Promise<any>);
  return () => release(okResults([]));
}

async function enqueueSix() {
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    // Payloads carry no `id` so the server-version stamp path (dynamic
    // db import) is skipped — these tests target the queue boundary only.
    const op = await durableSyncQueue.enqueue({
      table: 'products',
      recordId: `PROD-${i}`,
      operation: 'upsert',
      payload: { name: `Widget ${i}` },
    });
    ids.push(op.operationId);
  }
  return ids;
}

describe('sync concurrency lock', () => {
  let freshDb: ReturnType<typeof createDb>;

  beforeEach(() => {
    stubUniqueOperationIds();
    freshDb = createDb();
    openDBMock.mockReset().mockResolvedValue(freshDb);
    mockSendOps.mockReset().mockImplementation(async (ops: { operationId?: string }[]) => okResults(ops));
    mockUploadFile.mockReset().mockResolvedValue('mock-url');
    resetDbConnection();
    backgroundSyncService.reset();
  });

  afterEach(() => {
    backgroundSyncService.stopPeriodicSync();
    vi.restoreAllMocks();
  });

  it('Test A — two simultaneous syncNow() calls: one runs, one is skipped', async () => {
    await enqueueSix();
    const release = blockingSendOps();

    const p1 = backgroundSyncService.syncNow(false, 'test-A-1');
    const p2 = backgroundSyncService.syncNow(false, 'test-A-2');
    const r2 = await p2;
    expect(r2).toBeNull();

    release();
    const r1 = await p1;
    expect(r1).not.toBeNull();
    expect(r1!.success).toBe(6);
    // Exactly ONE gateway submission for the six operations.
    expect(mockSendOps).toHaveBeenCalledTimes(1);
    expect(mockSendOps.mock.calls[0][0]).toHaveLength(6);
  });

  it('three simultaneous triggers: one active sync, two skips', async () => {
    await enqueueSix();
    const release = blockingSendOps();

    const p1 = backgroundSyncService.syncNow(false, 'test-tri-1');
    const p2 = backgroundSyncService.syncNow(false, 'test-tri-2');
    const p3 = backgroundSyncService.trigger();
    expect(await p2).toBeNull();
    expect(await p3).toBeNull();

    release();
    const r1 = await p1;
    expect(r1!.success).toBe(6);
    expect(mockSendOps).toHaveBeenCalledTimes(1);
  });

  it('six pending operations are each submitted at most once (no concurrent duplicates)', async () => {
    const opIds = await enqueueSix();
    const release = blockingSendOps();

    const p1 = backgroundSyncService.syncNow(false, 'test-dedupe-1');
    const p2 = backgroundSyncService.syncNow(false, 'test-dedupe-2');
    const p3 = backgroundSyncService.trigger();
    await expect(p2).resolves.toBeNull();
    await expect(p3).resolves.toBeNull();
    release();
    await p1;

    const submitted: string[] = [];
    for (const call of mockSendOps.mock.calls) {
      for (const op of call[0] as { operationId?: string }[]) {
        if (op.operationId) submitted.push(op.operationId);
      }
    }
    expect(submitted).toHaveLength(6);
    expect(new Set(submitted).size).toBe(6);
    for (const id of opIds) {
      expect(submitted.filter((s) => s === id)).toHaveLength(1);
    }
  });

  it('Test D — exception releases the lock so the next sync can run', async () => {
    await durableSyncQueue.enqueue({ table: 'products', recordId: 'P-1', operation: 'upsert', payload: { name: 'x' } });
    const metricsSpy = vi.spyOn(durableSyncQueue, 'getMetrics').mockRejectedValueOnce(new Error('boom'));

    const first = await backgroundSyncService.syncNow(false, 'test-exc-1');
    expect(first).toBeNull();

    const second = await backgroundSyncService.syncNow(false, 'test-exc-2');
    expect(second).not.toBeNull();
    expect(second!.success).toBe(1);
    metricsSpy.mockRestore();
  });

  it('transport failure releases the lock; the retry follows the single path', async () => {
    mockSendOps.mockRejectedValueOnce(new Error('timeout'));
    await durableSyncQueue.enqueue({ table: 'products', recordId: 'P-1', operation: 'upsert', payload: { name: 'x' } });

    const first = await backgroundSyncService.syncNow(false, 'test-retry-1');
    expect(first!.success).toBe(0);
    expect(first!.failed).toBe(1);

    // Sequential retry — same operation resubmitted exactly once, no parallel attempt.
    const second = await backgroundSyncService.syncNow(false, 'test-retry-2');
    expect(second!.success).toBe(1);
    expect(mockSendOps).toHaveBeenCalledTimes(2);
    const submitted = mockSendOps.mock.calls.flatMap((c) => (c[0] as { operationId?: string }[]).map((o) => o.operationId));
    expect(submitted[0]).toBe(submitted[1]);
  });

  it('Test E — zero pending: no processing, lock released for the next sync', async () => {
    const empty = await backgroundSyncService.syncNow(false, 'test-empty');
    expect(empty).toBeNull();

    await durableSyncQueue.enqueue({ table: 'products', recordId: 'P-1', operation: 'upsert', payload: { name: 'x' } });
    const next = await backgroundSyncService.syncNow(false, 'test-after-empty');
    expect(next).not.toBeNull();
    expect(next!.success).toBe(1);
  });

  it('partial success (3 of 6): successes settle once, failures retry under existing policy', async () => {
    const opIds = await enqueueSix();
    mockSendOps.mockImplementationOnce(async (ops: { operationId?: string }[]) => ({
      ok: true,
      processed: ops.length,
      succeeded: 3,
      results: ops.map((op, i) => (i < 3
        ? { operationId: op.operationId, ok: true, id: 'mock-id' }
        : { operationId: op.operationId, ok: false, error: 'timeout', retryable: true })),
    }));

    const first = await backgroundSyncService.syncNow(false, 'test-partial-1');
    expect(first!.success).toBe(3);
    expect(first!.failed).toBe(3);
    expect(await durableSyncQueue.getAll('failed')).toHaveLength(3);

    // Retry resubmits ONLY the three failed operations — never the successes.
    const second = await backgroundSyncService.syncNow(false, 'test-partial-2');
    expect(second!.success).toBe(3);
    expect(mockSendOps).toHaveBeenCalledTimes(2);
    const secondBatch = (mockSendOps.mock.calls[1][0] as { operationId?: string }[]).map((o) => o.operationId);
    expect(secondBatch).toHaveLength(3);
    const firstBatch = (mockSendOps.mock.calls[0][0] as { operationId?: string }[]).map((o) => o.operationId);
    for (const id of opIds.slice(0, 3)) {
      expect(firstBatch).toContain(id);
      expect(secondBatch).not.toContain(id);
    }
  });

  it('settlement is idempotent: double-settle of a terminal item is a no-op', async () => {
    const item = await durableSyncQueue.enqueue({ table: 't', recordId: '1', operation: 'upsert', payload: {} });
    const batch = await durableSyncQueue.dequeue(10);
    expect(batch).toHaveLength(1);

    await durableSyncQueue.markCompleted(item.id);
    // Stale second settlement must not corrupt the terminal state.
    await durableSyncQueue.markCompleted(item.id);
    await durableSyncQueue.markFailed(item.id, 'stale timeout');
    await durableSyncQueue.deadLetter(item.id, 'stale error');

    const completed = await durableSyncQueue.getAll('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].retryCount).toBe(0);
    expect(completed[0].lastError).toBeNull();
    expect(await durableSyncQueue.getAll('failed')).toHaveLength(0);
    expect(await durableSyncQueue.getAll('dead_letter')).toHaveLength(0);
  });
});

// ─── Fresh-graph lifecycle tests (stubbed browser globals) ──────────────────
// These exercise the REAL window/document listener registration in
// backgroundSyncService by importing a fresh module graph per test.

describe('sync lifecycle (fresh module graph)', () => {
  let freshDb: ReturnType<typeof createDb>;
  let svc: typeof backgroundSyncService;
  let queue: typeof durableSyncQueue;
  let onlineHandlers: ((...args: unknown[]) => void)[];
  let visibilityHandlers: ((...args: unknown[]) => void)[];
  let windowDispatch: ReturnType<typeof vi.fn>;
  let bcPostMessage: ReturnType<typeof vi.fn>;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  async function freshGraph() {
    vi.resetModules();
    onlineHandlers = [];
    visibilityHandlers = [];
    windowDispatch = vi.fn();
    bcPostMessage = vi.fn();

    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'online') onlineHandlers.push(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'online') onlineHandlers = onlineHandlers.filter((h) => h !== handler);
      }),
      dispatchEvent: windowDispatch,
    };
    (globalThis as any).document = {
      visibilityState: 'visible',
      onvisibilitychange: null,
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'visibilitychange') visibilityHandlers.push(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'visibilitychange') visibilityHandlers = visibilityHandlers.filter((h) => h !== handler);
      }),
    };
    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).history = {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    };
    (globalThis as any).BroadcastChannel = vi.fn(function (this: unknown) {
      return { postMessage: bcPostMessage, close: vi.fn() };
    });

    freshDb = createDb();
    openDBMock.mockReset().mockResolvedValue(freshDb);
    mockSendOps.mockReset().mockImplementation(async (ops: { operationId?: string }[]) => okResults(ops));

    const svcMod = await import('../../../services/backgroundSyncService');
    const queueMod = await import('../../../services/durableSyncQueue');
    svc = svcMod.backgroundSyncService;
    queue = queueMod.durableSyncQueue;
  }

  beforeEach(async () => {
    stubUniqueOperationIds();
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await freshGraph();
  });

  afterEach(() => {
    try { svc?.stopPeriodicSync(); } catch { /* best-effort */ }
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).navigator;
    delete (globalThis as any).history;
    delete (globalThis as any).BroadcastChannel;
  });

  it('start() x3 creates one timer, one online listener, one visibility listener', async () => {
    const scheduled: { id: number; ms: number }[] = [];
    let nextId = 1000;
    setIntervalSpy.mockImplementation(((cb: (...args: unknown[]) => void, ms?: number) => {
      scheduled.push({ id: nextId, ms: ms ?? 0 });
      return nextId++ as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const cleared: unknown[] = [];
    clearIntervalSpy.mockImplementation(((id: unknown) => {
      cleared.push(id);
    }) as typeof clearInterval);

    svc.start();
    svc.start();
    svc.start();
    await vi.waitFor(() => {
      expect(onlineHandlers.length).toBe(1);
    });

    expect(visibilityHandlers.length).toBe(1);
    // Sync interval: scheduled on the first start, REPLACED (never duplicated)
    // on subsequent starts — every superseded id was cleared.
    const syncTimers = scheduled.filter((t) => t.ms !== 3600000).map((t) => t.id);
    expect(syncTimers.length).toBeGreaterThanOrEqual(1);
    const superseded = syncTimers.slice(0, -1);
    for (const id of superseded) {
      expect(cleared).toContain(id);
    }
    const activeSyncTimers = syncTimers.filter((id) => !cleared.includes(id));
    expect(activeSyncTimers).toHaveLength(1);
    // Cleanup interval scheduled exactly once.
    expect(scheduled.filter((t) => t.ms === 3600000)).toHaveLength(1);
  });

  it('Test B/C — online + visibility + periodic timer at once: one active sync', async () => {
    for (let i = 1; i <= 6; i++) {
      await queue.enqueue({ table: 'products', recordId: `PROD-${i}`, operation: 'upsert', payload: { name: `W${i}` } });
    }
    let release!: (value: unknown) => void;
    mockSendOps.mockImplementationOnce(() => new Promise<unknown>((resolve) => { release = resolve; }));

    svc.startPeriodicSync(15000);
    await vi.waitFor(() => {
      expect(mockSendOps).toHaveBeenCalled();
    });

    // While the first cycle holds the lock, fire every trigger at once.
    const pOnline = Promise.resolve().then(() => { for (const h of [...onlineHandlers]) h(); });
    const pVis = Promise.resolve().then(() => { for (const h of [...visibilityHandlers]) h(); });
    const pManual = svc.syncNow(false, 'test-burst-manual');
    const pTrigger = svc.trigger();
    await pOnline;
    await pVis;
    expect(await pManual).toBeNull();
    expect(await pTrigger).toBeNull();

    release(okResults([]));
    // Drain: the admitted cycle settles all six; triggers above added nothing.
    await vi.waitFor(async () => {
      expect((await queue.getAll('completed')).length).toBe(6);
    });
    expect(mockSendOps).toHaveBeenCalledTimes(1);
    expect((mockSendOps.mock.calls[0][0] as unknown[])).toHaveLength(6);
  });

  it('successful push emits exactly ONE data-changed signal; no-change cycle emits none', async () => {
    await queue.enqueue({ table: 'products', recordId: 'P-1', operation: 'upsert', payload: { name: 'x' } });

    const result = await svc.syncNow(false, 'test-emit');
    expect(result!.success).toBe(1);

    expect(windowDispatch).toHaveBeenCalledTimes(1);
    const event = windowDispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe('primeerp:data-changed');
    expect((event.detail as { source: string }).source).toBe('push-sync');
    expect(bcPostMessage).toHaveBeenCalledTimes(1);
    expect((bcPostMessage.mock.calls[0][0] as { source: string }).source).toBe('push-sync');

    // A follow-up cycle with nothing applied emits nothing.
    windowDispatch.mockClear();
    bcPostMessage.mockClear();
    mockSendOps.mockRejectedValueOnce(new Error('timeout'));
    await queue.enqueue({ table: 'products', recordId: 'P-2', operation: 'upsert', payload: { name: 'y' } });
    const failed = await svc.syncNow(false, 'test-no-emit');
    expect(failed!.failed).toBe(1);
    expect(windowDispatch).not.toHaveBeenCalled();
    expect(bcPostMessage).not.toHaveBeenCalled();
  });

  it('stopPeriodicSync tears down the lifecycle; restart registers exactly once', async () => {
    svc.startPeriodicSync(15000);
    await vi.waitFor(() => {
      expect(onlineHandlers.length).toBe(1);
    });
    expect(visibilityHandlers.length).toBe(1);

    svc.stopPeriodicSync();
    expect(onlineHandlers.length).toBe(0);
    expect(visibilityHandlers.length).toBe(0);

    svc.startPeriodicSync(15000);
    await vi.waitFor(() => {
      expect(onlineHandlers.length).toBe(1);
    });
    expect(visibilityHandlers.length).toBe(1);
  });

  it('periodic timer callback reaches the new diagnostics (fired + invoking)', async () => {
    const debugSpy = vi.spyOn(console, 'debug');
    const callbacks: { cb: (...args: unknown[]) => unknown; ms: number }[] = [];
    setIntervalSpy.mockImplementation(((
      cb: (...args: unknown[]) => unknown,
      ms?: number,
    ) => {
      callbacks.push({ cb, ms: ms ?? 0 });
      return 7000 as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    svc.startPeriodicSync(60000);
    await vi.waitFor(() => {
      expect(callbacks.some((c) => c.ms === 60000)).toBe(true);
    });
    // Let the immediate (non-timer) first pass settle, then isolate log
    // output to the actual timer-callback invocation below.
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalled();
    });
    debugSpy.mockClear();

    const syncCb = callbacks.find((c) => c.ms === 60000)!.cb;
    await syncCb();

    const lines = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('periodic_timer_fired'))).toBe(true);
    expect(lines.some((l) => l.includes('periodic_sync_invoking'))).toBe(true);
    const fired = lines.find((l) => l.includes('periodic_timer_fired'))!;
    expect(fired).toContain('intervalMs=60000');
    expect(fired).toContain('trigger=periodic-interval');
    expect(fired).toContain('online=true');
    debugSpy.mockRestore();
  });
});
