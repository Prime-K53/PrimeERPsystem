import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { durableSyncQueue, resetDbConnection } from '../../../services/durableSyncQueue';
import { backgroundSyncService } from '../../../services/backgroundSyncService';
import { transferSyncStateFor } from '../../../views/accounts/Transfers';

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

describe('transfer sync flow (device A → gateway → device B path)', () => {
  beforeEach(() => {
    openDBMock.mockReset().mockResolvedValue(createDb());
    mockSendOps.mockReset().mockImplementation(async (ops: Array<{ operationId?: string }>) => ({
      ok: true,
      processed: ops.length,
      succeeded: ops.length,
      results: ops.map((op) => ({ operationId: op.operationId, ok: true, version: 1 })),
    }));
    mockUploadFile.mockReset().mockResolvedValue('mock-url');
    resetDbConnection();
    backgroundSyncService.reset();
    backgroundSyncService.setPaused(false);
  });

  afterEach(() => {
    backgroundSyncService.stopPeriodicSync();
    backgroundSyncService.setPaused(false);
  });

  it('a transfer plus its ledger and mirror ops all drain through the standard pipeline', async () => {
    await durableSyncQueue.enqueue({
      table: 'transfers', recordId: 'TRF-1', operation: 'upsert',
      payload: { id: 'TRF-1', amount: 1000, fromAccountId: '11220', toAccountId: '11210' },
    });
    await durableSyncQueue.enqueue({
      table: 'ledger_entries', recordId: 'LG-TRF-1', operation: 'upsert',
      payload: { id: 'LG-TRF-1', amount: 1000, debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11220' },
    });
    await durableSyncQueue.enqueue({
      table: 'bank_transactions', recordId: 'TXN-1', operation: 'upsert',
      payload: { id: 'TXN-1', amount: 1000, type: 'Withdrawal' },
    });

    const result = await backgroundSyncService.syncNow();
    expect(result!.success).toBe(3);
    expect(result!.failed).toBe(0);
    const tables = mockSendOps.mock.calls[0][0].map((o: { table: string }) => o.table).sort();
    expect(tables).toEqual(['bank_transactions', 'ledger_entries', 'transfers']);
    expect(await durableSyncQueue.findPendingOp('transfers', 'TRF-1')).toBeUndefined();
  });

  it('a failed transfer op is visible as Failed and recoverable via retry', async () => {
    mockSendOps.mockRejectedValueOnce(new Error('gateway timed out'));
    await durableSyncQueue.enqueue({
      table: 'transfers', recordId: 'TRF-9', operation: 'upsert',
      payload: { id: 'TRF-9', amount: 500, fromAccountId: '11220', toAccountId: '11210' },
    });

    await backgroundSyncService.syncNow();
    const ops = await durableSyncQueue.getAll();
    expect(transferSyncStateFor(ops as any, 'TRF-9')).toBe('Failed');

    // Manual "Sync now" path: retryFailed re-queues, next cycle drains.
    mockSendOps.mockResolvedValueOnce({
      ok: true, processed: 1, succeeded: 1,
      results: [{ operationId: 'x', ok: true, version: 1 }],
    });
    await backgroundSyncService.syncNow();
    const opsAfter = await durableSyncQueue.getAll();
    const row = opsAfter.find((o) => o.recordId === 'TRF-9');
    expect(row!.status).toBe('completed');
    expect(transferSyncStateFor(opsAfter as any, 'TRF-9')).toBe('Synced');
  });

  it('transferSyncStateFor maps newest-op status honestly', () => {
    const base = { table: 'transfers', recordId: 'TRF-1', createdAt: '2026-10-01T00:00:00.000Z' };
    expect(transferSyncStateFor([], 'TRF-1')).toBeNull();
    expect(transferSyncStateFor([{ ...base, status: 'pending' }], 'TRF-1')).toBe('Pending');
    expect(transferSyncStateFor([{ ...base, status: 'syncing' }], 'TRF-1')).toBe('Pending');
    expect(transferSyncStateFor([{ ...base, status: 'completed' }], 'TRF-1')).toBe('Synced');
    expect(transferSyncStateFor([{ ...base, status: 'failed' }], 'TRF-1')).toBe('Failed');
    expect(transferSyncStateFor([{ ...base, status: 'dead_letter' }], 'TRF-1')).toBe('Failed');
    // Other tables/records never leak in.
    expect(transferSyncStateFor([{ ...base, table: 'ledger_entries' }], 'TRF-1')).toBeNull();
    expect(transferSyncStateFor([{ ...base, recordId: 'TRF-2' }], 'TRF-1')).toBeNull();
    // Newest op wins.
    expect(transferSyncStateFor([
      { ...base, status: 'failed', createdAt: '2026-10-01T00:00:00.000Z' },
      { ...base, status: 'completed', createdAt: '2026-10-02T00:00:00.000Z' },
    ], 'TRF-1')).toBe('Synced');
  });
});
