import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn() },
}));

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: { getAll: vi.fn() },
}));

import { dbService } from '../../services/db';
import { durableSyncQueue } from '../../services/durableSyncQueue';
import { diagnoseMissingOrders } from '../../services/orderDiagnostics';

const liveRow = (id: string) => ({
  id,
  orderNumber: id,
  customerName: 'Lengwe Primary School',
  status: 'Confirmed',
  totalAmount: 58500,
});

describe('diagnoseMissingOrders (read-only)', () => {
  beforeEach(() => {
    vi.mocked(dbService.get).mockReset();
    vi.mocked(durableSyncQueue.getAll).mockReset();
    vi.mocked(durableSyncQueue.getAll).mockResolvedValue([]);
  });

  it('reports VISIBLE for a live row with no queued ops', async () => {
    vi.mocked(dbService.get).mockImplementation(async (store: any, id: string) => {
      if (store === 'salesOrders' && id === 'ORDER-P726/022') return liveRow(id) as any;
      return undefined;
    });
    const [r] = await diagnoseMissingOrders(['ORDER-P726/022']);
    expect(r.verdict).toBe('VISIBLE');
    expect(r.presentInSalesOrders).toBe(true);
    expect(r.tombstoned).toBe(false);
    expect(r.projectable).toBe(true);
    expect(r.storedTotal).toBe(58500);
  });

  it('reports SOFT_DELETED_LOCALLY with the tombstone timestamp and pending delete op', async () => {
    vi.mocked(dbService.get).mockImplementation(async (store: any, id: string) => {
      if (store === 'salesOrders' && id === 'ORDER-P726/023')
        return { ...liveRow(id), customerName: 'Kanyenda Primary School', totalAmount: 175000, deletedAt: '2026-09-18T08:00:00.000Z' } as any;
      return undefined;
    });
    vi.mocked(durableSyncQueue.getAll).mockResolvedValue([
      { table: 'sales_orders', recordId: 'ORDER-P726/023', operation: 'delete', status: 'pending', lastError: null, retryCount: 0, lastAttempt: null },
    ] as any);
    const [r] = await diagnoseMissingOrders(['ORDER-P726/023']);
    expect(r.verdict).toBe('SOFT_DELETED_LOCALLY');
    expect(r.deletedAt).toBe('2026-09-18T08:00:00.000Z');
    expect(r.queuedOps).toEqual([
      { operation: 'delete', status: 'pending', lastError: null, retryCount: 0, lastAttempt: null },
    ]);
  });

  it('reports LEGACY_ONLY for rows living only in the legacy orders store', async () => {
    vi.mocked(dbService.get).mockImplementation(async (store: any, id: string) => {
      if (store === 'orders' && id === 'ORDER-P726/024') return liveRow(id) as any;
      return undefined;
    });
    const [r] = await diagnoseMissingOrders(['ORDER-P726/024']);
    expect(r.verdict).toBe('LEGACY_ONLY');
    expect(r.presentInSalesOrders).toBe(false);
    expect(r.presentInLegacyOrders).toBe(true);
  });

  it('reports MISSING_LOCALLY when the row is in neither store', async () => {
    vi.mocked(dbService.get).mockResolvedValue(undefined);
    const [r] = await diagnoseMissingOrders(['ORDER-P726/022']);
    expect(r.verdict).toBe('MISSING_LOCALLY');
    expect(r.presentInSalesOrders).toBe(false);
    expect(r.presentInLegacyOrders).toBe(false);
    expect(r.queuedOps).toEqual([]);
  });

  it('performs zero writes while diagnosing', async () => {
    vi.mocked(dbService.get).mockResolvedValue(undefined);
    await diagnoseMissingOrders(['ORDER-P726/021', 'ORDER-P726/022']);
    expect(vi.mocked(dbService.getAll)).not.toHaveBeenCalled();
    expect(durableSyncQueue).not.toHaveProperty('calledPut');
  });
});
