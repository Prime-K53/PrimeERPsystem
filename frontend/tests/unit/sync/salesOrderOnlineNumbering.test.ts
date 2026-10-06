import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { durableSyncQueue, resetDbConnection } from '../../../services/durableSyncQueue';
import { backgroundSyncService } from '../../../services/backgroundSyncService';
import { getSalesOrderDisplayNumber, PENDING_SALES_ORDER_NUMBER } from '../../../services/salesOrderService';

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
const { mockDbPut } = vi.hoisted(() => ({ mockDbPut: vi.fn() }));

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

// Local persistence is observed, not executed: every adoption must go through
// a cloud-source write (never re-enqueued, never a sync loop).
vi.mock('../../../services/db', () => ({
  dbService: {
    get: vi.fn(async () => undefined),
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

const unnumberedPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'local-1',
  orderNumber: null,
  order_number: null,
  orderNumberProvisional: false,
  creation_source: 'DIRECT_ERP',
  creationSource: 'DIRECT_ERP',
  customerId: 'cust-1',
  ...overrides,
});

async function seedQueuedOrder(payload: Record<string, unknown>) {
  return durableSyncQueue.enqueue({
    table: 'sales_orders',
    recordId: String(payload.id),
    operation: 'upsert',
    payload,
  });
}

describe('online Sales Order numbering fast-path', () => {
  beforeEach(() => {
    openDBMock.mockReset().mockResolvedValue(createDb());
    mockSendOps.mockReset().mockResolvedValue({ ok: true, processed: 0, succeeded: 0, results: [] });
    mockUploadFile.mockReset().mockResolvedValue('mock-url');
    mockDbPut.mockReset().mockImplementation(async (_store: string, item: unknown) => (item as { id: string }).id);
    resetDbConnection();
    backgroundSyncService.reset();
    backgroundSyncService.setPaused(false);
  });

  afterEach(() => {
    backgroundSyncService.stopPeriodicSync();
    backgroundSyncService.setPaused(false);
  });

  it('online flush returns the authoritative ORD number and drains exactly that op', async () => {
    await seedQueuedOrder(unnumberedPayload());
    mockSendOps.mockResolvedValueOnce({
      ok: true,
      processed: 1,
      succeeded: 1,
      results: [{ operationId: 'op-x', ok: true, id: 'local-1', order_number: 'ORD-P726/026', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }],
    });

    const flushed = await backgroundSyncService.flushSalesOrderNow('local-1');
    expect(flushed.synced).toBe(true);
    expect(flushed.order_number).toBe('ORD-P726/026');
    expect(mockSendOps).toHaveBeenCalledTimes(1);
    expect(mockSendOps.mock.calls[0][0]).toHaveLength(1);
    expect(mockSendOps.mock.calls[0][0][0].table).toBe('sales_orders');
    expect(mockSendOps.mock.calls[0][0][0].recordId).toBe('local-1');
    // Drained: no pending op remains for a later duplicate push.
    expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeUndefined();
  });

  it('claim adopts the server number locally via a cloud-source write (no re-enqueue, no Pending)', async () => {
    await seedQueuedOrder(unnumberedPayload());
    mockSendOps.mockResolvedValueOnce({
      ok: true,
      processed: 1,
      succeeded: 1,
      results: [{ operationId: 'op-x', ok: true, id: 'local-1', order_number: 'ORD-P726/026', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }],
    });

    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumberedPayload());
    expect(claimed.order_number).toBe('ORD-P726/026');
    expect(claimed.pending).toBeUndefined();
    expect(claimed.adopted).toBeTruthy();
    expect(getSalesOrderDisplayNumber(claimed.adopted)).toBe('ORD-P726/026');
    // The adoption write used cloud-source semantics: no new mutation queued.
    expect(mockDbPut).toHaveBeenCalledTimes(1);
    const [, adoptedArg, options] = mockDbPut.mock.calls[0];
    expect((adoptedArg as Record<string, unknown>).order_number).toBe('ORD-P726/026');
    expect((adoptedArg as Record<string, unknown>).orderNumber).toBe('ORD-P726/026');
    expect(options).toMatchObject({ cloudSource: true });
  });

  it('already-numbered record performs no network call', async () => {
    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(
      unnumberedPayload({ order_number: 'ORD-P726/026', orderNumber: 'ORD-P726/026' }),
    );
    expect(claimed.order_number).toBe('ORD-P726/026');
    expect(claimed.alreadyNumbered).toBe(true);
    expect(mockSendOps).not.toHaveBeenCalled();
    expect(mockDbPut).not.toHaveBeenCalled();
  });

  it('genuinely offline creation stays pending with the queue intact and no fabricated number', async () => {
    await seedQueuedOrder(unnumberedPayload());
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    try {
      const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumberedPayload());
      expect(claimed.adopted).toBeNull();
      expect(claimed.order_number).toBeNull();
      expect(claimed.pending).toBe(true);
      expect(mockSendOps).not.toHaveBeenCalled();
      expect(mockDbPut).not.toHaveBeenCalled();
      // Still queued for convergence on reconnect.
      expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeDefined();
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    }
  });

  it('transport failure keeps the durable order and returns pending (never throws past local save)', async () => {
    await seedQueuedOrder(unnumberedPayload());
    mockSendOps.mockRejectedValueOnce(new Error('gateway timed out'));

    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumberedPayload());
    expect(claimed.pending).toBe(true);
    expect(claimed.order_number).toBeNull();
    expect(mockDbPut).not.toHaveBeenCalled();
    expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeDefined();
  });

  it('conflict carrying the server number reconciles the SAME number without consuming a new one', async () => {
    await seedQueuedOrder(unnumberedPayload());
    mockSendOps.mockResolvedValueOnce({
      ok: true,
      processed: 1,
      succeeded: 0,
      results: [{
        operationId: 'op-x',
        ok: false,
        id: 'local-1',
        conflict: true,
        conflictType: 'version_required',
        retryable: true,
        error: 'Version conflict — record was updated by another device',
        server: {
          id: 'local-1',
          version: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          data: { id: 'local-1', order_number: 'ORD-P726/026' },
        },
      }],
    });

    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumberedPayload());
    expect(claimed.order_number).toBe('ORD-P726/026');
    expect(claimed.reconciled).toBe(true);
    expect(getSalesOrderDisplayNumber(claimed.adopted)).toBe('ORD-P726/026');
    // The op stays queued for the background merge of remaining fields.
    expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeDefined();
  });

  it('replayed success adopts the same number (response-loss retry consumes nothing)', async () => {
    await seedQueuedOrder(unnumberedPayload());
    mockSendOps.mockResolvedValueOnce({
      ok: true,
      processed: 1,
      succeeded: 1,
      results: [{ operationId: 'op-x', ok: true, id: 'local-1', replayed: true, order_number: 'ORD-P726/026', version: 1 }],
    });

    const claimed = await backgroundSyncService.claimOnlineSalesOrderNumber(unnumberedPayload());
    expect(claimed.order_number).toBe('ORD-P726/026');
    expect(claimed.adopted).toBeTruthy();
    expect(await durableSyncQueue.findPendingOp('sales_orders', 'local-1')).toBeUndefined();
  });

  it('never adopts a fabricated non-official value', async () => {
    const adopted = await backgroundSyncService.adoptFlushedSalesOrderNumber(unnumberedPayload(), 'TMP-0001', 1, null);
    expect(adopted).toBeNull();
    expect(mockDbPut).not.toHaveBeenCalled();
  });

  it('unnumbered local row still shows the neutral pending state (offline display contract)', async () => {
    expect(getSalesOrderDisplayNumber(unnumberedPayload())).toBe(PENDING_SALES_ORDER_NUMBER);
  });
});
