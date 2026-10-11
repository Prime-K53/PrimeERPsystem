/**
 * phase2ServerSync.test.ts — Phase 2 §3.1 client status model.
 * Server accepted vs local pending vs rejected are never conflated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { contractServerClient } from '../../../services/contractServerClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contractServerClient status model', () => {
  it('maps server ok to accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { success: true } }),
    })) as any);
    const res = await contractServerClient.consumeViaServer({ contractId: 'PC-1', itemId: 'A-1' });
    expect(res.status).toBe('accepted');
  });

  it('maps network failure to pending (never confirmed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }) as any);
    const res = await contractServerClient.consumeViaServer({ contractId: 'PC-1', itemId: 'A-1' });
    expect(res.status).toBe('pending');
    expect(res.retryable).toBe(true);
  });

  it('maps closed-period rejection to rejected with adjustmentRequired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: 'CLOSED_PERIOD: dated in closed FY', adjustmentRequired: true }),
    })) as any);
    const res = await contractServerClient.reserveViaServer({ contractId: 'PC-1', itemId: 'A-9', price: 100 });
    expect(res.status).toBe('rejected');
    expect(res.adjustmentRequired).toBe(true);
  });

  it('preserves the business date in the request payload (no sync-timestamp substitution)', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      seen.push(JSON.parse(String(init?.body || '{}')));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }) as any);
    await contractServerClient.consumeViaServer({ contractId: 'PC-1', itemId: 'A-1', businessDate: '2026-03-15' });
    expect(seen[0].businessDate).toBe('2026-03-15');
  });
});
