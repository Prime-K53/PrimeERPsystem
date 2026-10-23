/**
 * syncQueueCapabilityDeferral.test.ts
 *
 * The capability gate answers a contract-document write in two very different
 * ways, and the durable queue must treat them differently:
 *
 *   retryable: true   — a SERVER-side deferral ("the server cannot confirm the
 *                        required client capability … the write was deferred").
 *                        The condition is transient and server-owned, so the
 *                        operation must stay QUEUED and be retried. Dead-lettering
 *                        it would silently drop the customer's document.
 *   retryable: false  — an OUTDATED client ("…update the app and re-issue").
 *                        The device must be upgraded before the write can ever
 *                        succeed, so the operation is terminal.
 *
 * The REAL durable queue (against an in-memory IndexedDB boundary) and the REAL
 * settle decision in backgroundSyncService are exercised; only the HTTP
 * transport is mocked.
 *
 * NOTE on the IndexedDB boundary: the repository's global test setup stubs
 * `idb` with a no-op double (frontend/tests/setup.ts:6-23), so the queue
 * cannot persist in any other test. This file therefore provides a WORKING
 * in-memory implementation of the same boundary — the storage contract is
 * unchanged, only the transport underneath it differs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendSyncOpsMock = vi.hoisted(() => vi.fn());
const idbState = vi.hoisted(() => ({
  stores: new Map<string, { keyPath: string; indexes: Record<string, string> }>(),
  data: new Map<string, Map<string, any>>(),
}));

vi.mock('idb', () => ({
  openDB: vi.fn(async (_name: string, _version: number, opts: any) => {
    const stores = idbState.stores;
    const data = idbState.data;
    const storeOf = (n: string) => {
      if (!stores.has(n)) {
        stores.set(n, { keyPath: 'id', indexes: {} });
        data.set(n, new Map());
      }
      return stores.get(n)!;
    };
    const db: any = {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string, cfg: any) => {
        stores.set(n, { keyPath: cfg?.keyPath || 'id', indexes: {} });
        data.set(n, new Map());
        return { createIndex: (idx: string, keyPath: string) => { storeOf(n).indexes[idx] = keyPath; } };
      },
      deleteObjectStore: (n: string) => { stores.delete(n); data.delete(n); },
      put: async (n: string, value: any) => {
        const st = storeOf(n);
        const key = String(value[st.keyPath]);
        data.get(n)!.set(key, value);
        return key;
      },
      get: async (n: string, key: any) => data.get(n)?.get(String(key)),
      delete: async (n: string, key: any) => { data.get(n)?.delete(String(key)); },
      getAll: async (n: string) => [...(data.get(n)?.values() ?? [])],
      getAllFromIndex: async (n: string, indexName: string, range: any) => {
        const st = storeOf(n);
        const keyPath = st.indexes[indexName];
        const only = range && range.lower !== undefined && range.lower === range.upper ? range.lower : null;
        return [...(data.get(n)?.values() ?? [])].filter((r: any) => (only === null || r[keyPath] === only));
      },
      count: async (n: string) => data.get(n)?.size ?? 0,
      close: () => {},
    };
    if (opts && typeof opts.upgrade === 'function') opts.upgrade(db, 0);
    return db;
  }),
  deleteDB: vi.fn(async () => {}),
  unwrap: vi.fn(),
}));

vi.mock('../../../services/syncApiClient', async () => {
  const actual = await vi.importActual<any>('../../../services/syncApiClient');
  return { ...actual, sendSyncOps: sendSyncOpsMock };
});

// jsdom does not implement the IndexedDB key-range global, and the queue
// filters its stores with IDBKeyRange.only(status). Provide the minimal
// boundary the queue needs.
if (typeof (globalThis as any).IDBKeyRange === 'undefined') {
  (globalThis as any).IDBKeyRange = {
    only: (value: any) => ({ lower: value, upper: value, includes: () => true }),
  };
}

import { backgroundSyncService } from '../../../services/backgroundSyncService';
import { durableSyncQueue, resetDbConnection, classifyError } from '../../../services/durableSyncQueue';

const DEFER_MESSAGE =
  'the server cannot confirm the required client capability for contract documents - the write was deferred, no data was changed';
const OUTDATED_MESSAGE =
  'this client writes contract documents with an outdated protocol (declares capability 1, the server requires 2) - update the app and re-issue';

const enqueueDocumentOp = async () => {
  const queued = await durableSyncQueue.enqueue({
    table: 'contract_documents',
    recordId: 'SCH-1',
    operation: 'upsert',
    payload: {
      id: 'SCH-1', contract_id: 'cid-1', documentType: 'printing_contract_schedule',
      documentNumber: 'PC-1', documentVersion: 1, status: 'VALID',
    },
  } as any);
  const [stored] = await durableSyncQueue.getAll();
  expect(stored).toBeDefined();
  return stored;
};

const respondWith = (result: Record<string, unknown>) => {
  sendSyncOpsMock.mockResolvedValue({ results: [result] });
};

beforeEach(() => {
  sendSyncOpsMock.mockReset();
  idbState.stores.clear();
  idbState.data.clear();
  resetDbConnection();
});

describe('durable queue — a server-side capability deferral stays queued', () => {
  it('keeps a retryable server deferral queued instead of dead-lettering it', async () => {
    const item = await enqueueDocumentOp();
    respondWith({ operationId: item.operationId, ok: false, retryable: true, error: DEFER_MESSAGE });

    await backgroundSyncService.syncNow(true, 'test-capability-deferral');

    const [after] = await durableSyncQueue.getAll();
    expect(after.id).toBe(item.id);
    // NOT terminal: the operation is still in the queue, marked failed (the next
    // sync cycle re-queues it), never dead-lettered.
    expect(after.status).not.toBe('dead_letter');
    expect(after.status).toBe('failed');
    expect(String(after.lastError || '')).toContain('deferred');

    const metrics = await durableSyncQueue.getMetrics();
    expect(metrics.deadLetter).toBe(0);
    expect(metrics.failed).toBeGreaterThan(0);

    // and it is re-queued for the next attempt
    const requeued = await durableSyncQueue.retryFailed();
    expect(requeued).toBeGreaterThan(0);
    const [again] = await durableSyncQueue.getAll();
    expect(again.status).toBe('pending');
  });

  it('dead-letters an outdated-client refusal (retryable:false)', async () => {
    const item = await enqueueDocumentOp();
    respondWith({ operationId: item.operationId, ok: false, retryable: false, error: OUTDATED_MESSAGE });

    await backgroundSyncService.syncNow(true, 'test-outdated-client');

    const [after] = await durableSyncQueue.getAll();
    expect(after.status).toBe('dead_letter');

    const metrics = await durableSyncQueue.getMetrics();
    expect(metrics.deadLetter).toBe(1);
  });

  it('does not classify the server deferral message as a permanent error', async () => {
    // The queue also classifies by message; the server's deferral wording must
    // not match a permanent pattern (only the explicit flag may make it
    // terminal).
    expect(classifyError(DEFER_MESSAGE)).toBe('retryable');
    expect(classifyError(OUTDATED_MESSAGE)).toBe('retryable');
  });
});
