import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn() },
}));

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: { getAll: vi.fn() },
}));

import { dbService } from '../../services/db';
import { durableSyncQueue } from '../../services/durableSyncQueue';
import { diagnoseMissingOrders } from '../../services/orderDiagnostics';
import '../../utils/devDiagnostics';

const liveRow = (id: string) => ({
  id,
  orderNumber: id,
  customerName: 'Lengwe Primary School',
  status: 'Confirmed',
  totalAmount: 58500,
});

describe('dev-only diagnoseMissingOrders global', () => {
  it('resolves as a function on globalThis (DevTools entry point)', () => {
    expect(typeof (globalThis as any).diagnoseMissingOrders).toBe('function');
  });

  it('delegates to the existing implementation with identical results', async () => {
    vi.mocked(dbService.get).mockImplementation(async (store: any, id: string) => {
      if (store === 'salesOrders' && id === 'ORDER-P726/022') return liveRow(id) as any;
      return undefined;
    });
    vi.mocked(durableSyncQueue.getAll).mockResolvedValue([]);

    const ids = ['ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024'];
    const viaGlobal = await (globalThis as any).diagnoseMissingOrders(ids);
    const direct = await diagnoseMissingOrders(ids);
    expect(viaGlobal).toEqual(direct);
    expect(viaGlobal.map((r: any) => [r.id, r.verdict])).toEqual([
      ['ORDER-P726/022', 'VISIBLE'],
      ['ORDER-P726/023', 'MISSING_LOCALLY'],
      ['ORDER-P726/024', 'MISSING_LOCALLY'],
    ]);
  });

  it('performs zero writes through the global', async () => {
    vi.mocked(dbService.get).mockResolvedValue(undefined);
    vi.mocked(durableSyncQueue.getAll).mockResolvedValue([]);
    await (globalThis as any).diagnoseMissingOrders(['ORDER-P726/022']);
    expect(vi.mocked(dbService.getAll)).not.toHaveBeenCalled();
    // The db mock exposes no put/delete; assert nothing else on it was touched.
    expect(Object.keys(dbService)).toEqual(['get', 'getAll']);
  });
});
