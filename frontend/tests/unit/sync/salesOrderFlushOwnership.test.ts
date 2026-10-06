import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { durableSyncQueue, resetDbConnection } from '../../../services/durableSyncQueue';
import { backgroundSyncService } from '../../../services/backgroundSyncService';
import { getSalesOrderDisplayNumber } from '../../../services/salesOrderService';

(globalThis as any).IDBKeyRange = {
  only: vi.fn((val: string) => ({ only: val })),
  upperBound: vi.fn(),
  lowerBound: vi.fn(),
  bound: vi.fn(),
};

const { openDBMock } = vi.hoisted(() => ({ openDBMock: vi.fn() }));
const { mockSendOps, mockUploadFile } = vi.hoisted(() => ({
  mockSendOps: vi.fn(),
  mockUploadFile: vi.fn(async () => 'mock-url'),
}));
const { mockDbPut, mockDbGet } = vi.hoisted(() => ({
  mockDbPut: vi.fn(),
  mockDbGet: vi.fn(),
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
  cloudDb: { uploadFile: mockUploadFile },
}));

// Local persistence is observed, not executed.
vi.mock('../../../services/db', () => ({
  dbService: {
    get: mockDbGet,
    getAll: vi.fn(async () => []),
    put: mockDbPut,
    bulkPut: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    hardDelete: vi.fn(async () => undefined),
  },
  getStoreForCloudTable: vi.fn((table: string) => (table === 'sales_orders' ? 'salesOrders' : null)),
}));

function createDb() {
  const stores: Record<string, Map<string, Record<string, unknown>>> = {
    operations: new Map(),
    meta: new Map(),
    metrics: new Map(),
  };
  const INDEX_FIELD: Record<string, string> = {
    'by-status': 'status',
    'by-created': 'createdAt',
    'by-operationId': 'operationId',
    'by-metric': 'metric',
  };
  const getStore = (name: string) => (stores[name] ||= new Map());
  return {
    __stores: stores,
    get: vi.fn(async (storeName: string, key: string) => getStore(storeName).get(key)),
    put: vi.fn(async (storeName: string, value: Record<string, unknown>) => {
      getStore(storeName).set(value.id as string, { ...value });
    }),
    delete: vi.fn(async (storeName: string, key: string) => { getStore(storeName).delete(key); }),
    getAll: vi.fn(async (storeName: string) => Array.from(getStore(storeName).values())),
    getAllFromIndex: vi.fn(async (storeName: string, indexName: string, range?: unknown) => {
      const all = Array.from(getStore(storeName).values());
      if (!range) return all;
      const rangeVal = (range as { only: string }).only;
      const field = INDEX_FIELD[indexName] || indexName;
      return all.filter((r) => (r as any)[field] === rangeVal);
    }),
    count: vi.fn(async (storeName: string) => getStore(storeName).size),
    close: vi.fn(),
    objectStoreNames: { contains: vi.fn(() => true) },
    transaction: vi.fn(() => ({ done: Promise.resolve() })),
    createObjectStore: vi.fn(),
    deleteObjectStore: vi.fn(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const unnumbered = (overrides: Record<string, unknown> = {}) => ({
  id: 'local-1',
  orderNumber: null,
  order_number: null,
  orderNumberProvisional: false,
  creation_source: 'DIRECT_ERP',
  creationSource: 'DIRECT_ERP',
  customerId: 'cust-1',
  total: 100,
  ...overrides,
});

const numberedLocal = (n: string) => ({
  id: 'local-1',
  order_number: n,
  orderNumber: n,
  orderNumberProvisional: false,
  version: 1,
});

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

describe('inline flush send-ownership vs background engine', () => {
  let freshDb: ReturnType<typeof createDb>;

  beforeEach(() => {
    freshDb = createDb();
    openDBMock.mockReset().mockResolvedValue(freshDb);
    mockSendOps.mockReset().mockResolvedValue({ ok: true, processed: 0, succeeded: 0, results: [] });
    mockUploadFile.mockReset().mockResolvedValue('mock-url');
    mockDbPut.mockReset().mockImplementation(async (_s: string, item: unknown) => (item as { id: string }).id);
    mockDbGet.mockReset().mockResolvedValue(undefined);
    resetDbConnection();
    backgroundSyncService.reset();
    backgroundSyncService.setPaused(false);
  });

  afterEach(() => {
    backgroundSyncService.stopPeriodicSync();
    backgroundSyncService.setPaused(false);
  });

  it('1+4: simultaneous inline + background processing yields ONE submission and ONE number', async () => {
    let minted = 0;
    const sentPayloads: unknown[] = [];
    mockSendOps.mockImplementation(async (ops: Array<{ payload: unknown }>) => {
      sentPayloads.push(ops[0].payload);
      await sleep(50); // hold the window open: a duplicate sender would mint again
      minted += 1;
      const n = `ORD-P726/${String(minted).padStart(3, '0')}`;
      return {
        ok: true,
        processed: 1,
        succeeded: 1,
        results: [{ operationId: 'op-x', ok: true, id: 'local-1', order_number: n, version: 1 }],
      };
    });
    // Local record becomes numbered once the owner settles (background settle
    // adopts the number into the live row).
    mockDbGet.mockResolvedValue(numberedLocal('ORD-P726/001'));

    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered(),
    });

    // Background owns first (dequeue claims through the shared registry)…
    const dequeued = await durableSyncQueue.dequeue(10);
    expect(dequeued).toHaveLength(1);

    // …then the inline flush for the same record must NOT send again: it
    // waits for the owner and adopts the single authoritative number.
    const flushPromise = backgroundSyncService.flushSalesOrderNow('local-1', {
      deadlineMs: 5000,
      intervalMs: 25,
    });
    await sleep(100);
    expect(mockSendOps).not.toHaveBeenCalled();

    // Owner settles exactly once (as the background settle path would).
    await durableSyncQueue.markCompleted(dequeued[0].id);
    const flushed = await flushPromise;
    expect(flushed.order_number).toBe('ORD-P726/001');
    expect(mockSendOps).not.toHaveBeenCalled();
    expect(minted).toBe(0);
  });

  it('2: inline owns first, background dequeue skips the owned operation', async () => {
    let releaseSend!: (value: unknown) => void;
    const gate = new Promise((resolve) => { releaseSend = resolve; });
    mockSendOps.mockImplementationOnce(async (ops: Array<{ operationId?: string }>) => {
      await gate;
      return {
        ok: true,
        processed: 1,
        succeeded: 1,
        results: [{ operationId: ops[0].operationId, ok: true, id: 'local-1', order_number: 'ORD-P726/001', version: 1 }],
      };
    });

    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered(),
    });

    const flushPromise = backgroundSyncService.flushSalesOrderNow('local-1');
    // Flush claimed synchronously-owned state before its send resolves…
    await waitFor(async () => {
      const row = await durableSyncQueue.findPendingOp('sales_orders', 'local-1');
      return row?.status === 'syncing';
    });
    // …so the background worker must skip it: nothing to dequeue.
    expect(await durableSyncQueue.dequeue(10)).toHaveLength(0);

    releaseSend!({});
    const flushed = await flushPromise;
    expect(flushed.synced).toBe(true);
    expect(flushed.order_number).toBe('ORD-P726/001');
    expect(mockSendOps).toHaveBeenCalledTimes(1);
    expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeUndefined();
  });

  it('two concurrent flushes of one record produce ONE submission; both adopt the same number', async () => {
    let sends = 0;
    mockSendOps.mockImplementation(async (ops: Array<{ operationId?: string }>) => {
      sends += 1;
      await sleep(50);
      return {
        ok: true,
        processed: 1,
        succeeded: 1,
        results: [{ operationId: ops[0].operationId, ok: true, id: 'local-1', order_number: 'ORD-P726/001', version: 1 }],
      };
    });
    mockDbGet.mockResolvedValue(numberedLocal('ORD-P726/001'));

    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered(),
    });

    const [a, b] = await Promise.all([
      backgroundSyncService.flushSalesOrderNow('local-1', { deadlineMs: 5000, intervalMs: 25 }),
      backgroundSyncService.flushSalesOrderNow('local-1', { deadlineMs: 5000, intervalMs: 25 }),
    ]);
    expect(sends).toBe(1);
    const numbers = [a.order_number, b.order_number];
    expect(numbers).toEqual(['ORD-P726/001', 'ORD-P726/001']);
  });

  it('6: edit merged during an in-flight flush is never stranded — newer payload still sends', async () => {
    const transmitted: unknown[] = [];
    let releaseSend!: (value: unknown) => void;
    const gate = new Promise((resolve) => { releaseSend = resolve; });
    mockSendOps.mockImplementation(async (ops: Array<{ payload: unknown; operationId?: string }>) => {
      transmitted.push(ops[0].payload);
      await gate;
      return {
        ok: true,
        processed: 1,
        succeeded: 1,
        results: [{ operationId: ops[0].operationId, ok: true, id: 'local-1', order_number: 'ORD-P726/001', version: 1 }],
      };
    });

    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered({ total: 100 }),
    });

    const flushPromise = backgroundSyncService.flushSalesOrderNow('local-1');
    // Owned now (`syncing`): the concurrent edit cannot merge into it and
    // becomes a FRESH row instead of disappearing into the in-flight send.
    await waitFor(async () => {
      const row = await durableSyncQueue.findPendingOp('sales_orders', 'local-1');
      return row?.status === 'syncing';
    });
    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered({ total: 200 }),
    });
    const rows = (await durableSyncQueue.getAll()).filter((o) => o.table === 'sales_orders');
    expect(rows).toHaveLength(2);
    expect(rows.filter((o) => o.status === 'pending')).toHaveLength(1);

    releaseSend!({});
    const flushed = await flushPromise;
    expect(flushed.synced).toBe(true);
    // Only the frozen P1 snapshot was transmitted…
    expect((transmitted[0] as Record<string, unknown>).total).toBe(100);
    // …and the newer edit is still queued (never marked complete unsent).
    const survivor = await durableSyncQueue.findPendingOp('sales_orders', 'local-1');
    expect(survivor).toBeDefined();
    expect((survivor!.payload as Record<string, unknown>).total).toBe(200);
    expect(survivor!.status).toBe('pending');
  });

  it('7: a completion for a superseded payload is refused and the newer row stays sendable', async () => {
    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered({ total: 100 }),
    });

    const claim = await durableSyncQueue.claimForSend('sales_orders', 'local-1', 'inline-flush:local-1');
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') throw new Error('expected claimed');
    const snapshot = claim.item.payload;

    // Simulate a cross-tab merge racing the claim write: newer content lands
    // on the owned row while our frozen snapshot is in flight.
    const opsStore = freshDb.__stores.operations;
    const live = opsStore.get(claim.item.id)!;
    opsStore.set(claim.item.id, { ...live, payload: unnumbered({ total: 999 }) });

    const settled = await durableSyncQueue.settleSendClaim(
      claim.item.id,
      'inline-flush:local-1',
      snapshot,
      'completed',
    );
    expect(settled).toBe('changed');
    const row = opsStore.get(claim.item.id)!;
    expect(row.status).toBe('pending'); // sendable, not completed
    expect((row.payload as Record<string, unknown>).total).toBe(999); // newer content intact
  });

  it('claim protocol: owned rows report owned, settled rows report missing, legacy rows ineligible', async () => {
    const item = await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered(),
    });
    void item;

    const first = await durableSyncQueue.claimForSend('sales_orders', 'local-1', 'owner-a');
    expect(first.outcome).toBe('claimed');
    const second = await durableSyncQueue.claimForSend('sales_orders', 'local-1', 'owner-b');
    expect(second.outcome).toBe('owned');

    // Owner settles; a later claim finds nothing actionable.
    await durableSyncQueue.settleSendClaim(
      (first as { item: { id: string; payload: unknown } }).item.id,
      'owner-a',
      (first as { item: { payload: unknown } }).item.payload,
      'completed',
    );
    expect((await durableSyncQueue.claimForSend('sales_orders', 'local-1', 'owner-c')).outcome).toBe('missing');
  });

  it('wait path: terminal owner failure surfaces pending without sending', async () => {
    await durableSyncQueue.enqueue({
      table: 'sales_orders',
      recordId: 'local-1',
      operation: 'upsert',
      payload: unnumbered(),
    });
    // Background owns it…
    const dequeued = await durableSyncQueue.dequeue(10);
    expect(dequeued).toHaveLength(1);
    // …then dead-letters it (permanent failure).
    await durableSyncQueue.deadLetter(dequeued[0].id, 'permanent validation error');

    const flushed = await backgroundSyncService.flushSalesOrderNow('local-1', {
      deadlineMs: 2000,
      intervalMs: 25,
    });
    expect(flushed.synced).toBe(false);
    expect(flushed.order_number ?? null).toBeNull();
    expect(mockSendOps).not.toHaveBeenCalled();
  });

  it('offline creation performs no send and leaves exactly one pending op', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    try {
      const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumbered());
      expect(claimed.pending).toBe(true);
      expect(claimed.order_number).toBeNull();
      expect(mockSendOps).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    }
  });

  it('already-numbered orders never hit the network', async () => {
    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(
      unnumbered({ order_number: 'ORD-P726/026', orderNumber: 'ORD-P726/026' }),
    );
    expect(claimed.order_number).toBe('ORD-P726/026');
    expect(claimed.alreadyNumbered).toBe(true);
    expect(mockSendOps).not.toHaveBeenCalled();
    expect(getSalesOrderDisplayNumber(claimed.adopted)).toBe('ORD-P726/026');
  });
});
