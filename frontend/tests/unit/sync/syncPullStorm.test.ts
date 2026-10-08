/**
 * PULL 429-storm regression tests (in-flight serialization + circuit breaker).
 *
 * Covers:
 *  1. Two simultaneous pullRemoteChanges() calls → one actual execution.
 *  2. A timer tick during an active PULL does not start another execution.
 *  3. A 429 stops additional pages immediately (no third page).
 *  4. A 429 prevents additional table requests after the circuit opens.
 *  5. Retry-After is captured correctly (resume timestamp honors it).
 *  6. The timer does not refire before the retry window expires.
 *  7. Jitter is bounded and can never produce an immediate retry.
 *  8. The last successful cursor is unchanged after a rate-limited page.
 *  9. A normal non-429 table failure still lets sibling tables continue.
 * 10. A 429 produces one controlled warning, not dozens of console errors.
 * 11. stopPeriodicSync (logout/SIGNED_OUT path) aborts the pass, resets the
 *     circuit, and no further PULL requests are issued afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetchPullPage, mockGetSyncAccessToken } = vi.hoisted(() => ({
  mockFetchPullPage: vi.fn(),
  mockGetSyncAccessToken: vi.fn(),
}));

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

vi.mock('../../../services/db', () => ({
  dbService: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => 'mock-id'),
    bulkPut: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    getAll: vi.fn(async () => []),
    getSetting: vi.fn(async () => undefined),
    saveSetting: vi.fn(async () => undefined),
  },
  getStoreForCloudTable: (table: string) => table,
}));

import {
  pullRemoteChanges,
  runScheduledPullTick,
  isPullInFlight,
  isPullCircuitOpen,
  getPullCircuitResumeAt,
  openPullCircuit,
  resetPullSyncState,
  computePullCircuitResumeAt,
  stopPeriodicSync,
  startPeriodicSync,
  awaitInitialSync,
  SYNC_RECONCILIATION_INTERVAL_MS,
} from '../../../services/syncService';
import { SyncPullRateLimitedError } from '../../../services/syncApiClient';
import { durableSyncQueue } from '../../../services/durableSyncQueue';
import { logger } from '../../../services/logger';

const emptyPage = (table: string, offset = 0) => ({
  table,
  rows: [],
  page: { offset, limit: 2000, count: 0, hasMore: false },
});

const rowPage = (table: string, offset: number, count: number, baseMs: number) => ({
  table,
  rows: Array.from({ length: count }, (_, i) => ({
    id: `${table}-r${offset + i}`,
    updated_at: new Date(baseMs + (offset + i) * 1000).toISOString(),
  })),
  page: { offset, limit: 2000, count, hasMore: count === 2000 },
});

const flush = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PULL serialization + rate-limit circuit breaker', () => {
  beforeEach(() => {
    resetPullSyncState();
    mockFetchPullPage.mockReset().mockImplementation(async (table: string, opts: any = {}) => emptyPage(table, opts.offset ?? 0));
    mockGetSyncAccessToken.mockReset().mockResolvedValue('tok-123');
  });

  afterEach(() => {
    resetPullSyncState();
    vi.restoreAllMocks();
  });

  it('1. two simultaneous pullRemoteChanges() calls result in one execution', async () => {
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      await flush(1);
      return emptyPage(table, opts.offset ?? 0);
    });
    const [a, b] = await Promise.all([pullRemoteChanges(), pullRemoteChanges()]);
    // 144 tables, one request each — a second execution would double this.
    expect(mockFetchPullPage.mock.calls.length).toBe(144);
    expect(a).toBe(b);
    expect(isPullInFlight()).toBe(false);
  });

  it('2. a timer tick during an active PULL does not start another execution', async () => {
    let open = false;
    const gate = new Promise<void>((resolve) => { (globalThis as any).__openPullGate = resolve; });
    void (async () => { await flush(20); open = true; })();
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (!open) await gate;
      return emptyPage(table, opts.offset ?? 0);
    });
    const pending = pullRemoteChanges();
    await flush(5);
    expect(isPullInFlight()).toBe(true);
    const callsBefore = mockFetchPullPage.mock.calls.length;
    expect(await runScheduledPullTick('test')).toBe('skipped-in-flight');
    expect(mockFetchPullPage.mock.calls.length).toBe(callsBefore);
    (globalThis as any).__openPullGate();
    await pending;
    // Exactly one full pass ran, even though a tick fired mid-pass.
    expect(mockFetchPullPage.mock.calls.length).toBe(144);
    expect(isPullInFlight()).toBe(false);
  });

  it('3. a 429 stops additional pages immediately (no third page)', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'products') {
        if ((opts.offset ?? 0) === 0) return rowPage(table, 0, 2000, base);
        throw new SyncPullRateLimitedError(table, 30);
      }
      return emptyPage(table, opts.offset ?? 0);
    });
    await pullRemoteChanges();
    const productOffsets = mockFetchPullPage.mock.calls
      .filter((c) => (c as unknown[])[0] === 'products')
      .map((c) => ((c as unknown[])[1] as any).offset);
    expect(productOffsets).toContain(0);
    expect(productOffsets).toContain(2000);
    expect(productOffsets).not.toContain(4000);
  });

  it('4. a 429 prevents additional table requests after the circuit opens', async () => {
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'user_groups') throw new SyncPullRateLimitedError(table, 60);
      return emptyPage(table, opts.offset ?? 0);
    });
    const result = await pullRemoteChanges();
    // Tables from later batches (e.g. settings, invoices) are never requested.
    const requestedTables = new Set(mockFetchPullPage.mock.calls.map((c) => (c as unknown[])[0]));
    expect(requestedTables.has('settings')).toBe(false);
    expect(requestedTables.has('invoices')).toBe(false);
    // Errors are keyed by store name ('userGroups' → table 'user_groups').
    expect(result.errors.some((e) => e.includes('userGroups') && e.includes('rate-limited'))).toBe(true);
    expect(isPullCircuitOpen()).toBe(true);
  });

  it('5. Retry-After is captured correctly in the resume timestamp', async () => {
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'user_groups') throw new SyncPullRateLimitedError(table, 45);
      return emptyPage(table, opts.offset ?? 0);
    });
    const before = Date.now();
    await pullRemoteChanges();
    const resumeAt = getPullCircuitResumeAt();
    // 45 s server window + 1–5 s bounded jitter.
    expect(resumeAt - before).toBeGreaterThanOrEqual(45_000 + 1_000);
    expect(resumeAt - before).toBeLessThanOrEqual(45_000 + 5_000 + 2_000);
  });

  it('6. the timer does not refire before the retry window expires', async () => {
    openPullCircuit(300, 'test');
    expect(await runScheduledPullTick('test')).toBe('skipped-circuit');
    expect(mockFetchPullPage).not.toHaveBeenCalled();
    resetPullSyncState();
    expect(await runScheduledPullTick('test')).toBe('started');
    expect(mockFetchPullPage.mock.calls.length).toBe(144);
  });

  it('7. jitter is bounded and can never produce an immediate retry', () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 200; i += 1) {
      const resume = computePullCircuitResumeAt(now, 30);
      expect(resume - now).toBeGreaterThanOrEqual(30_000 + 1_000);
      expect(resume - now).toBeLessThanOrEqual(30_000 + 5_000);
    }
    // Missing/unusable Retry-After falls back to the 60 s hold-open.
    for (let i = 0; i < 50; i += 1) {
      const resume = computePullCircuitResumeAt(now, 0);
      expect(resume - now).toBeGreaterThanOrEqual(60_000 + 1_000);
      expect(resume - now).toBeLessThanOrEqual(60_000 + 5_000);
    }
  });

  it('8. the last successful cursor is unchanged after a rate-limited page', async () => {
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    const setMetaSpy = vi.spyOn(durableSyncQueue, 'setMeta');
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'products') {
        if ((opts.offset ?? 0) === 0) return rowPage(table, 0, 2000, base);
        throw new SyncPullRateLimitedError(table, 30);
      }
      return emptyPage(table, opts.offset ?? 0);
    });
    await pullRemoteChanges();
    const productCursors = setMetaSpy.mock.calls
      .filter((c) => c[0] === 'last_synced_at:products')
      .map((c) => c[1]);
    // Exactly one cursor write for products: the last row of the last
    // SUCCESSFUL page. The failed page wrote nothing.
    expect(productCursors.length).toBe(1);
    expect(productCursors[0]).toBe(new Date(base + 1999 * 1000).toISOString());
  });

  it('9. a normal non-429 table failure still lets sibling tables continue', async () => {
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'products') throw new Error('boom');
      return emptyPage(table, opts.offset ?? 0);
    });
    const result = await pullRemoteChanges();
    const requestedTables = new Set(mockFetchPullPage.mock.calls.map((c) => (c as unknown[])[0]));
    // First-batch and last-batch tables were all attempted (calls carry
    // cloud table names: store 'inventory' → 'products', etc.).
    expect(requestedTables.has('user_groups')).toBe(true);
    expect(requestedTables.has('referral_reversals')).toBe(true);
    expect(result.errors.some((e) => e.includes('boom'))).toBe(true);
    expect(isPullCircuitOpen()).toBe(false);
  });

  it('10. a 429 produces one controlled warning, not dozens of console errors', async () => {
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      if (table === 'user_groups') throw new SyncPullRateLimitedError(table, 30);
      return emptyPage(table, opts.offset ?? 0);
    });
    await pullRemoteChanges();
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/rate limited/i);
  });

  it('11. stopPeriodicSync aborts the pass, resets the circuit, and stops further requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Faithful abort semantics: like a real fetch, the request rejects when
    // the pass signal aborts — even while the test gate is still closed.
    const abortOf = (signal?: AbortSignal) =>
      new Promise<never>((_, reject) => {
        if (!signal) return;
        const err = new Error('aborted');
        err.name = 'AbortError';
        if (signal.aborted) { reject(err); return; }
        signal.addEventListener('abort', () => reject(err), { once: true });
      });
    mockFetchPullPage.mockImplementation(async (table: string, opts: any = {}) => {
      await Promise.race([gate, abortOf(opts.signal)]);
      return emptyPage(table, opts.offset ?? 0);
    });
    const pending = pullRemoteChanges();
    await flush(10);
    expect(isPullInFlight()).toBe(true);
    const callsAtStop = mockFetchPullPage.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);
    openPullCircuit(300, 'test');
    stopPeriodicSync();
    expect(isPullCircuitOpen()).toBe(false);
    release();
    await pending;
    // No further requests were issued after teardown (in-flight batch
    // aborted; no subsequent pages or batches started).
    expect(mockFetchPullPage.mock.calls.length).toBe(callsAtStop);
    expect(isPullInFlight()).toBe(false);
  });
});

describe('PULL periodic reconciliation cadence (P1.2)', () => {
  const FULL_SWEEP_CALLS = 144; // one request per table, empty pages

  beforeEach(() => {
    resetPullSyncState();
    mockFetchPullPage
      .mockReset()
      .mockImplementation(async (table: string, opts: any = {}) => emptyPage(table, opts.offset ?? 0));
    mockGetSyncAccessToken.mockReset().mockResolvedValue('tok-123');
  });

  afterEach(() => {
    try { stopPeriodicSync(); } catch { /* harness cleanup only */ }
    resetPullSyncState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function drainPullCalls(target: number, stepMs = 25, maxSteps = 400) {
    for (let i = 0; i < maxSteps && mockFetchPullPage.mock.calls.length < target; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    return mockFetchPullPage.mock.calls.length;
  }

  it('uses the named 5-minute reconciliation interval (never 30 s)', () => {
    expect(SYNC_RECONCILIATION_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('installs exactly one periodic PULL timer at the named interval', async () => {
    const scheduledMs: number[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((cb: any, ms?: number) => {
      scheduledMs.push(ms ?? 0);
      return 424242 as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    try {
      await startPeriodicSync(60000);
      await awaitInitialSync().catch(() => undefined);
      expect(scheduledMs.filter((ms) => ms === SYNC_RECONCILIATION_INTERVAL_MS)).toHaveLength(1);
    } finally {
      stopPeriodicSync();
      spy.mockRestore();
    }
  });

  it('initial sync fires immediately as one full pull (not delayed by the timer)', async () => {
    vi.useFakeTimers();
    try {
      await startPeriodicSync(60000);
      // No timer advanced: the initial pass must already be underway.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchPullPage.mock.calls.length).toBeGreaterThan(0);
      await drainPullCalls(FULL_SWEEP_CALLS);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS);
      // Fresh store: the initial pass is a FULL pull (no incremental cursor).
      const firstCall = mockFetchPullPage.mock.calls[0][1] as any;
      expect(firstCall.since).toBeNull();
      await awaitInitialSync().catch(() => undefined);
    } finally {
      stopPeriodicSync();
      vi.useRealTimers();
    }
  });

  it('no reconciliation at 30 s; exactly one reconciliation at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      await startPeriodicSync(60000);
      await drainPullCalls(FULL_SWEEP_CALLS);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS);
      expect(isPullInFlight()).toBe(false);

      // +30 s: the old cadence would have fired a second full sweep.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS);

      // Advance to the reconciliation interval: exactly one more sweep.
      await vi.advanceTimersByTimeAsync(SYNC_RECONCILIATION_INTERVAL_MS - 30_000);
      await drainPullCalls(FULL_SWEEP_CALLS * 2);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS * 2);
      expect(isPullInFlight()).toBe(false);

      // No 429 storm: two full sweeps ≈ 288 requests, inside the 300/5-min
      // budget by construction, with zero errors recorded.
      const settled = await awaitInitialSync().catch(() => undefined);
      expect(settled?.errors ?? []).toEqual([]);
    } finally {
      stopPeriodicSync();
      vi.useRealTimers();
    }
  });

  it('stopPeriodicSync prevents future reconciliation', async () => {
    vi.useFakeTimers();
    try {
      await startPeriodicSync(60000);
      await drainPullCalls(FULL_SWEEP_CALLS);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS);
      stopPeriodicSync();
      await vi.advanceTimersByTimeAsync(SYNC_RECONCILIATION_INTERVAL_MS * 2);
      expect(mockFetchPullPage.mock.calls.length).toBe(FULL_SWEEP_CALLS);
    } finally {
      vi.useRealTimers();
    }
  });
});
