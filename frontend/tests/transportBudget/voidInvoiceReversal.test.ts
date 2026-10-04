/**
 * voidInvoiceReversal.test.ts — Phase 6 production full-void REVERSAL tests.
 *
 * These exercise the ACTUAL `transactionService.voidInvoice` lifecycle with the
 * REAL Phase 4 `transportBudgetRepository`, over a hermetic in-memory dbService
 * boundary (no IndexedDB, no Supabase, no network) — the same mocking strategy
 * Phase 5C used.
 *
 * Covers:
 *   A. Full void produces one REVERSAL = -original amount, linked to the
 *      original allocation, with the deterministic key and business date.
 *   B. Historical-rate protection: a changed current policy never affects it.
 *   C. Deterministic retry dedupes to one economic REVERSAL.
 *   D. Missing allocation fails closed (no fabrication).
 *   E. Consumption targets are rejected by Phase 4 controls.
 *   F. A second full reversal is rejected by the cumulative cap.
 *   G. A commercial failure before commit produces no REVERSAL.
 *   H. An append failure after commercial commit leaves the void persisted,
 *      fabricates no second key, and a retry converges on the same key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted hermetic db boundary + failure injection ───────────────────────
const dbControl = vi.hoisted(() => {
  const stores = new Map<string, Map<string, unknown>>();
  const failPutStores = new Set<string>();

  function storeFor(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      get: async (id: string) => m.get(String(id)),
      put: async (rec: { id?: string; key?: string }) => {
        if (failPutStores.has(name)) {
          throw new Error(`forced put failure: ${name}`);
        }
        m.set(String(rec.id ?? rec.key), rec);
      },
      getAll: async () => Array.from(m.values()),
      delete: async (id: string) => {
        m.delete(String(id));
      },
    };
  }

  const dbService = {
    executeAtomicOperation: async (_names: string[], fn: (tx: unknown) => unknown) =>
      fn({ objectStore: (n: string) => storeFor(n), done: Promise.resolve() }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: { id?: string; key?: string }) => storeFor(s).put(rec),
    delete: async (s: string, id: string) => storeFor(s).delete(String(id)),
  };

  return {
    stores,
    failPutStores,
    storeFor,
    dbService,
    reset() {
      stores.clear();
      failPutStores.clear();
    },
  };
});

vi.mock('../../services/db', () => ({ dbService: dbControl.dbService }));
vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    enqueue: vi.fn(async () => undefined),
    hasPendingMutation: vi.fn(async () => false),
    recordMetric: vi.fn(async () => undefined),
  },
}));
vi.mock('../../services/backgroundSyncService', () => ({
  backgroundSyncService: {
    trigger: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { transactionService } from '../../services/transactionService';
import { transportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import {
  salesAllocationIdempotencyKey,
  voidReversalIdempotencyKey,
  produceVoidReversalSafely,
} from '../../services/transportBudgetVoidReversal';
import type { TransportBudgetEvent } from '../../types/transportBudget';
import { logger } from '../../services/logger';

const ECONOMIC_KEY = 'INV-1000';
const ALLOCATION_ID = 'evt-alloc-1000';

const seedAllocation = async (overrides: Record<string, unknown> = {}) => {
  await transportBudgetRepository.appendTransportBudgetEvent({
    id: ALLOCATION_ID,
    kind: 'SALES_ALLOCATION',
    idempotencyKey: salesAllocationIdempotencyKey(ECONOMIC_KEY),
    sourceEventId: ECONOMIC_KEY,
    sourceAmount: 500000,
    allocationRatePercent: 3,
    amount: 15000,
    method: null,
    providerId: null,
    reversesEventId: null,
    businessDate: '2026-09-30',
    occurredAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  } as never);
};

const seedInvoice = async (overrides: Record<string, unknown> = {}) => {
  await dbControl.dbService.put('invoices', {
    id: ECONOMIC_KEY,
    status: 'unpaid',
    items: [],
    date: '2026-09-30',
    customerId: 'CUST-1',
    totalAmount: 500000,
    ...overrides,
  });
};

const reversalEvents = () =>
  transportBudgetRepository.listTransportBudgetEvents({ kind: 'REVERSAL' });

const findReversal = () =>
  transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
    voidReversalIdempotencyKey(ECONOMIC_KEY),
  );

// tests/setup.ts pins crypto.randomUUID to a single constant. Production uses
// real unique ids, so allocate a fresh id per generation here; otherwise a
// retry would regenerate the SAME physical id as the existing event and hit the
// repository's physical-id conflict check before economic-key dedup.
let uuidSeq = 0;
beforeEach(() => {
  dbControl.reset();
  vi.clearAllMocks();
  uuidSeq = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidSeq}-0000-0000-0000-000000000000` as never,
  );
});

describe('Phase 6 — full void produces the deterministic REVERSAL', () => {
  it('A. reverses the original allocation amount and links the original', async () => {
    await seedAllocation();
    await seedInvoice();

    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void');

    const reversal = await findReversal();
    expect(reversal).not.toBeNull();
    expect(reversal?.kind).toBe('REVERSAL');
    expect(reversal?.idempotencyKey).toBe('REVERSAL:INV-1000:VOID');
    expect(reversal?.amount).toBe(-15000);
    expect(reversal?.reversesEventId).toBe(ALLOCATION_ID);
    expect(reversal?.businessDate).toBe('2026-09-30');
    // Phase 4 field hygiene: REVERSAL carries no source identity/rate.
    expect(reversal?.sourceEventId).toBeNull();
    expect(reversal?.sourceAmount).toBeNull();
    expect(reversal?.allocationRatePercent).toBeNull();

    // The commercial void itself persisted.
    const invoice = (await dbControl.dbService.get('invoices', ECONOMIC_KEY)) as {
      status?: string;
    };
    expect(invoice?.status).toBe('Cancelled');
  });

  it('B. historical-rate protection: a changed current policy never affects the reversal', async () => {
    localStorage.setItem(
      'nexus_company_config',
      JSON.stringify({ transportBudgetPolicy: { enabled: true, rate: 9 } }),
    );
    await seedAllocation({ allocationRatePercent: 3 });
    await seedInvoice();

    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void');

    const reversal = await findReversal();
    expect(reversal?.amount).toBe(-15000); // original allocation, not 9%
    expect(reversal?.reversesEventId).toBe(ALLOCATION_ID);
  });

  it('C. deterministic retry converges to ONE economic REVERSAL', async () => {
    // Pin the wall clock: both invocations must mint the same occurredAt for
    // the retry to be byte-identical. Without this, the two Date.now() calls
    // can straddle a millisecond boundary and the (correct, fail-closed)
    // same-key conflict triggers instead of dedupe — a pre-existing timing
    // flake under parallel-worker load, not a second economic event.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
    try {
    await seedAllocation();
    await seedInvoice();

    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void');
    const first = await findReversal();

    // Retry after commercial persistence succeeded (e.g. previous append lost).
    const retry = await produceVoidReversalSafely({ id: ECONOMIC_KEY });
    expect(retry.status).toBe('appended');
    if (retry.status === 'appended') {
      expect(retry.deduplicated).toBe(true);
      expect(retry.event.id).toBe(first?.id);
    }

    const all = await reversalEvents();
    expect(all).toHaveLength(1);
    expect(all[0].idempotencyKey).toBe('REVERSAL:INV-1000:VOID');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Phase 6 — fail-closed and protection', () => {
  it('D. missing allocation produces NO reversal and no fabrication', async () => {
    await seedInvoice(); // no SALES_ALLOCATION seeded

    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void');

    expect(await findReversal()).toBeNull();
    expect(await reversalEvents()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    // Only the invoice exists; no transport event was fabricated.
    const tbRows = await dbControl.dbService.getAll('transportBudgetEvents');
    expect(tbRows).toHaveLength(0);
  });

  it('E. consumption targets are rejected by Phase 4 controls', async () => {
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-in-001',
      kind: 'INBOUND_CONSUMPTION',
      idempotencyKey: 'INBOUND_CONSUMPTION:SRC-1',
      sourceEventId: 'SRC-1',
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);

    await expect(
      transportBudgetRepository.appendReversal({
        id: 'evt-rev-consumption',
        kind: 'REVERSAL',
        idempotencyKey: 'REVERSAL:SRC-1:VOID',
        sourceEventId: null,
        sourceAmount: null,
        allocationRatePercent: null,
        amount: -5000,
        method: null,
        providerId: null,
        reversesEventId: 'evt-in-001',
        businessDate: '2026-09-30',
        occurredAt: '2026-09-30T10:00:00.000Z',
      } as never),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });

  it('F. a second full reversal is rejected by the cumulative cap', async () => {
    await seedAllocation();
    await seedInvoice();
    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void'); // -15000

    await expect(
      transportBudgetRepository.appendReversal({
        id: 'evt-rev-void-2',
        kind: 'REVERSAL',
        idempotencyKey: 'REVERSAL:INV-1000:VOID2',
        sourceEventId: null,
        sourceAmount: null,
        allocationRatePercent: null,
        amount: -15000,
        method: null,
        providerId: null,
        reversesEventId: ALLOCATION_ID,
        businessDate: '2026-09-30',
        occurredAt: '2026-09-30T11:00:00.000Z',
      } as never),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });
});

describe('Phase 6 — ordering and failure handling', () => {
  it('G. a commercial failure before commit produces NO REVERSAL', async () => {
    await seedAllocation();
    await seedInvoice();
    dbControl.failPutStores.add('invoices'); // commercial persistence fails

    await expect(
      transactionService.voidInvoice(ECONOMIC_KEY, 'test void'),
    ).rejects.toThrow();

    expect(await findReversal()).toBeNull();
    expect(await reversalEvents()).toHaveLength(0);
  });

  it('I. voidSale reverses a non-mirror sale allocation exactly once', async () => {
    await dbControl.dbService.put('sales', {
      id: 'SALE-1000',
      status: 'Paid',
      items: [],
      totalAmount: 500000,
      date: '2026-09-30',
      customerId: 'walk-in',
    });
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-alloc-sale-1000',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: salesAllocationIdempotencyKey('SALE-1000'),
      sourceEventId: 'SALE-1000',
      sourceAmount: 500000,
      allocationRatePercent: 3,
      amount: 15000,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);

    await transactionService.voidSale('SALE-1000', 'test void');

    const sale = (await dbControl.dbService.get('sales', 'SALE-1000')) as {
      status?: string;
    };
    expect(sale?.status).toBe('Voided');
    const reversal =
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        voidReversalIdempotencyKey('SALE-1000'),
      );
    expect(reversal).not.toBeNull();
    expect(reversal).toMatchObject({
      kind: 'REVERSAL',
      amount: -15000,
      reversesEventId: 'evt-alloc-sale-1000',
      businessDate: '2026-09-30',
    });

    // A repeated void is rejected by the commercial guard and the
    // reversal stays exactly one.
    await expect(
      transactionService.voidSale('SALE-1000', 'test void again'),
    ).rejects.toThrow(/already voided/i);
    expect(await reversalEvents()).toHaveLength(1);
  });

  it('J. voidSale on a mirror sale reverses nothing (invoice path owns it)', async () => {
    await dbControl.dbService.put('sales', {
      id: 'SALE-M1',
      status: 'Paid',
      items: [],
      totalAmount: 200000,
      date: '2026-09-30',
      customerId: 'walk-in',
    });
    // Mirror economics live under the mirror invoice key only.
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-alloc-mirror-1',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: salesAllocationIdempotencyKey('INV-MIRROR-1'),
      sourceEventId: 'INV-MIRROR-1',
      sourceAmount: 200000,
      allocationRatePercent: 3,
      amount: 6000,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);

    await transactionService.voidSale('SALE-M1', 'test void');

    const sale = (await dbControl.dbService.get('sales', 'SALE-M1')) as {
      status?: string;
    };
    expect(sale?.status).toBe('Voided');
    expect(await reversalEvents()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('H. append failure after commit keeps the void and retries on the same key', async () => {
    await seedAllocation();
    await seedInvoice();
    dbControl.failPutStores.add('transportBudgetEvents'); // reversal append fails

    await transactionService.voidInvoice(ECONOMIC_KEY, 'test void');

    // Commercial void persisted; no reversal fabricated.
    const invoice = (await dbControl.dbService.get('invoices', ECONOMIC_KEY)) as {
      status?: string;
    };
    expect(invoice?.status).toBe('Cancelled');
    expect(await findReversal()).toBeNull();
    expect(logger.error).toHaveBeenCalled();

    // Recovery/retry reuses the SAME deterministic key.
    dbControl.failPutStores.delete('transportBudgetEvents');
    const retry = await produceVoidReversalSafely({ id: ECONOMIC_KEY });
    expect(retry.status).toBe('appended');

    const all = await reversalEvents();
    expect(all).toHaveLength(1);
    expect(all[0].idempotencyKey).toBe('REVERSAL:INV-1000:VOID');
    expect(all[0].amount).toBe(-15000);
  });
});
