/**
 * timerDiag.test.ts — focused tests for the DEV-only timer-lifecycle
 * diagnostics (no production behavior touched):
 *
 * 1. syncDiag timer registry: scheduled / fired / cleared / replaced events
 *    carry generations; live counts track real instances; no "fired" event
 *    is emitted unless the callback logging runs.
 * 2. backgroundSyncService 60s timer: start → scheduled(g1); start again →
 *    cleared(g1) + scheduled(g2) + replaced(g1→g2); invoking the captured
 *    callback emits fired(g2) + invoking; stop → cleared. No fired before
 *    the callback is invoked.
 * 3. syncService pull timer: if the engine starts in this env, the captured
 *    pull callback emits fired + pull_trigger_invoked; otherwise the
 *    supabase-disabled skip is logged (documents the install gate).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  diagLiveTimerCount,
  diagNextTimerGeneration,
  diagTimerCleared,
  diagTimerFired,
  diagTimerReplaced,
  diagTimerScheduled,
} from '../../../services/syncDiag';

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
    transaction: vi.fn(),
    createObjectStore: vi.fn(),
    deleteObjectStore: vi.fn(),
  };
}

function debugLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

describe('syncDiag timer registry', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug');
    debugSpy.mockClear();
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('scheduled/fired/cleared/replaced carry generations; live counts track instances', () => {
    const before = diagLiveTimerCount('dashboard');
    const g1 = diagNextTimerGeneration('dashboard');
    diagTimerScheduled('dashboard', 'TestSource', 60000, g1);
    expect(diagLiveTimerCount('dashboard')).toBe(before + 1);

    // Scheduling alone must NOT produce a fired event.
    expect(debugLines(debugSpy).some((l) => l.includes('dashboard_poll_timer_fired'))).toBe(false);

    diagTimerFired('dashboard', 'TestSource', 60000, g1);
    const g2 = diagNextTimerGeneration('dashboard');
    diagTimerCleared('dashboard', 'TestSource', g1, 'replaced-by-test');
    diagTimerScheduled('dashboard', 'TestSource', 60000, g2);
    diagTimerReplaced('dashboard', 'TestSource', g1, g2, 60000);
    expect(diagLiveTimerCount('dashboard')).toBe(before + 1);

    const lines = debugLines(debugSpy);
    const scheduled = lines.filter((l) => l.includes('dashboard_poll_timer_scheduled'));
    expect(scheduled.length).toBe(2);
    expect(scheduled[0]).toContain(`timerGeneration=${g1}`);
    expect(scheduled[1]).toContain(`timerGeneration=${g2}`);
    const fired = lines.find((l) => l.includes('dashboard_poll_timer_fired'))!;
    expect(fired).toContain(`timerGeneration=${g1}`);
    const replaced = lines.find((l) => l.includes('dashboard_poll_timer_replaced'))!;
    expect(replaced).toContain(`oldTimerGeneration=${g1}`);
    expect(replaced).toContain(`newTimerGeneration=${g2}`);

    diagTimerCleared('dashboard', 'TestSource', g2, 'test-teardown');
    expect(diagLiveTimerCount('dashboard')).toBe(before);
  });

  it('pull-kind events use pull_* names and independent generations', () => {
    const g = diagNextTimerGeneration('pull');
    diagTimerScheduled('pull', 'TestSource', 30000, g);
    diagTimerFired('pull', 'TestSource', 30000, g);
    const lines = debugLines(debugSpy);
    expect(lines.some((l) => l.includes('pull_timer_scheduled') && l.includes(`timerGeneration=${g}`))).toBe(true);
    expect(lines.some((l) => l.includes('pull_timer_fired') && l.includes(`timerGeneration=${g}`))).toBe(true);
    diagTimerCleared('pull', 'TestSource', g, 'test-teardown');
  });
});

describe('backgroundSync 60s timer lifecycle (fresh module graph)', () => {
  let svc: any;
  let onlineHandlers: ((...args: unknown[]) => void)[];
  let visibilityHandlers: ((...args: unknown[]) => void)[];
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  async function freshGraph() {
    vi.resetModules();
    onlineHandlers = [];
    visibilityHandlers = [];
    (globalThis as any).window = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'online') onlineHandlers.push(handler);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    (globalThis as any).document = {
      visibilityState: 'visible',
      onvisibilitychange: null,
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'visibilitychange') visibilityHandlers.push(handler);
      }),
      removeEventListener: vi.fn(),
    };
    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).history = { pushState: vi.fn(), replaceState: vi.fn() };
    (globalThis as any).BroadcastChannel = vi.fn(function (this: unknown) {
      return { postMessage: vi.fn(), close: vi.fn() };
    });
    openDBMock.mockReset().mockResolvedValue(createDb());
    mockSendOps.mockReset().mockImplementation(async (ops: { operationId?: string }[]) => ({
      ok: true, processed: ops.length, succeeded: ops.length,
      results: ops.map((op) => ({ operationId: op.operationId, ok: true, id: 'mock-id' })),
    }));
    const svcMod = await import('../../../services/backgroundSyncService');
    svc = svcMod.backgroundSyncService;
  }

  beforeEach(async () => {
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    debugSpy = vi.spyOn(console, 'debug');
    await freshGraph();
  });

  afterEach(() => {
    try { svc?.stopPeriodicSync(); } catch { /* best-effort */ }
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    debugSpy.mockRestore();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).navigator;
    delete (globalThis as any).history;
    delete (globalThis as any).BroadcastChannel;
  });

  it('start → scheduled; restart → cleared+replaced; callback invoke → fired; stop → cleared', async () => {
    const scheduled: { cb: (...args: unknown[]) => unknown; ms: number }[] = [];
    let nextId = 5000;
    setIntervalSpy.mockImplementation(((cb: (...args: unknown[]) => unknown, ms?: number) => {
      scheduled.push({ cb, ms: ms ?? 0 });
      return nextId++ as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    svc.startPeriodicSync(60000);
    await vi.waitFor(() => {
      expect(debugLines(debugSpy).some((l) => l.includes('periodic_timer_scheduled'))).toBe(true);
    });
    const firstScheduled = debugLines(debugSpy).find((l) => l.includes('periodic_timer_scheduled'))!;
    const gen1 = Number(firstScheduled.match(/timerGeneration=(\d+)/)![1]);
    expect(firstScheduled).toContain('intervalMs=60000');

    // NOTE: startPeriodicSync runs one IMMEDIATE first pass (not via the
    // timer), which also logs fired/invoking with timerGeneration=0 ("no
    // timer installed yet"). The assertion below isolates the REAL timer
    // callback: exactly one additional fired event carrying the new gen.

    svc.startPeriodicSync(60000);
    await vi.waitFor(() => {
      expect(debugLines(debugSpy).some((l) => l.includes('periodic_timer_replaced'))).toBe(true);
    });
    const replaced = debugLines(debugSpy).find((l) => l.includes('periodic_timer_replaced'))!;
    expect(replaced).toContain(`oldTimerGeneration=${gen1}`);
    const gen2 = Number(replaced.match(/newTimerGeneration=(\d+)/)![1]);
    expect(gen2).toBe(gen1 + 1);

    // Invoke the LATEST installed callback: proves the fire path reaches diagnostics.
    const latestSync = scheduled.filter((s) => s.ms === 60000).pop()!;
    debugSpy.mockClear();
    await latestSync.cb();
    const afterFire = debugLines(debugSpy);
    const firedNow = afterFire.filter((l) => l.includes('periodic_timer_fired'));
    expect(firedNow).toHaveLength(1);
    expect(firedNow[0]).toContain(`timerGeneration=${gen2}`);
    expect(afterFire.some((l) => l.includes('periodic_sync_invoking'))).toBe(true);

    debugSpy.mockClear();
    svc.stopPeriodicSync();
    expect(debugLines(debugSpy).some((l) => l.includes('periodic_timer_cleared'))).toBe(true);
  });
});

describe('syncService pull timer (engine install gate)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug');
    debugSpy.mockClear();
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    // syncService.startPeriodicSync reads bare `navigator.onLine` (browser
    // assumption in pre-existing code); stub it for this harness. A prior
    // describe in this file deletes the jsdom navigator in its afterEach.
    (globalThis as any).navigator = { onLine: true };
  });

  afterEach(() => {
    debugSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('documents whether the pull timer installs in this env; if installed, its callback logs fired + trigger', async () => {
    // NOTE: supabase-js realtime maintains its own ~30s socket timers in the
    // same realm, so several 30000ms callbacks are captured. Select the pull
    // timer by its creation stack (syncService), not by interval alone.
    const scheduled: { cb: (...args: unknown[]) => unknown; ms: number; stack: string }[] = [];
    setIntervalSpy.mockImplementation(((cb: (...args: unknown[]) => unknown, ms?: number) => {
      scheduled.push({ cb, ms: ms ?? 0, stack: new Error().stack || '' });
      return 9000 as unknown as NodeJS.Timeout;
    }) as typeof setInterval);

    const { startPeriodicSync, stopPeriodicSync } = await import('../../../services/syncService');
    await startPeriodicSync(60000);
    try {
      const lines = debugLines(debugSpy);
      const pullScheduled = lines.find((l) => l.includes('pull_timer_scheduled'));
      if (!pullScheduled) {
        // Engine gate (e.g. Supabase not enabled here): the skip must be logged.
        expect(lines.some((l) => l.includes('periodic_lifecycle_call') && l.includes('supabase-not-enabled'))).toBe(true);
        return;
      }
      expect(pullScheduled).toContain('intervalMs=30000');
      const gen = Number(pullScheduled.match(/timerGeneration=(\d+)/)![1]);
      debugSpy.mockClear();
      const pullCb = scheduled.find(
        (s) => s.ms === 30000 && /syncService\.(ts|js)/.test(s.stack),
      )!.cb;
      // Fire without awaiting: the diag lines precede the first network
      // await, while the pull itself may stay pending in this harness.
      void (pullCb() as Promise<unknown>).catch(() => {});
      // Give the async callback a chance to reach its first diag lines.
      await vi.waitFor(() => {
        expect(debugLines(debugSpy).some((l) => l.includes('pull_timer_fired'))).toBe(true);
      });
      const after = debugLines(debugSpy);
      expect(after.find((l) => l.includes('pull_timer_fired'))).toContain(`timerGeneration=${gen}`);
      expect(after.some((l) => l.includes('pull_trigger_invoked') && l.includes('pull-timer'))).toBe(true);
    } finally {
      stopPeriodicSync();
      try {
        const { backgroundSyncService } = await import('../../../services/backgroundSyncService');
        backgroundSyncService.stopPeriodicSync();
      } catch { /* harness cleanup only */ }
    }
  }, 15000);
});
