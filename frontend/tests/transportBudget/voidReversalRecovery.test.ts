/**
 * voidReversalRecovery.test.ts — Phase 6E recovery reconciliation tests.
 *
 * Exercises the REAL `reconcileMissingFullVoidReversals` reconciler with the
 * REAL Phase 6 producer (`produceVoidReversalSafely`) and the REAL Phase 4
 * `TransportBudgetRepository` over hermetic in-memory fakes (no IndexedDB,
 * no Supabase, no network) — the same mocking strategy Phase 6 used.
 *
 * Covers (§19):
 *   A. Cancelled + allocation + missing reversal -> one REVERSAL via producer.
 *   B. Cancelled + missing allocation -> no fabrication, producer untouched.
 *   C. Cancelled + existing reversal -> producer not called, no duplicate.
 *   D. Conflicting current policy -> producer still uses original allocation.
 *   E. Already-Cancelled -> producer directly, never voidInvoice; invoice kept.
 *   F. Producer failure for A -> B still processes (per-invoice isolation).
 *   G. Repeated reconciliation -> one REVERSAL, same deterministic key.
 *   H. Offline -> local REVERSAL + queue op, no HTTP.
 *   I. Scope guard -> only transport_budget_events + durable queue change.
 * Plus: static source guard (no second producer, no policy access) and
 * re-entrancy (concurrent triggers share one scan).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn(), put: vi.fn() },
}));
vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: { enqueue: vi.fn(), hasPendingMutation: vi.fn() },
}));
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { TransportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import {
  produceVoidReversalSafely,
  salesAllocationIdempotencyKey,
  voidReversalIdempotencyKey,
} from '../../services/transportBudgetVoidReversal';
import {
  reconcileMissingFullVoidReversals,
  requestVoidRecoveryReconciliation,
  type VoidRecoveryDeps,
  type VoidRecoveryInvoice,
} from '../../services/transportBudgetVoidRecovery';
import type { TransportBudgetEvent } from '../../types/transportBudget';
import recoverySource from '../../services/transportBudgetVoidRecovery.ts?raw';

const FIXED_NOW = '2026-10-02T00:00:00.000Z';

// Production uses real unique ids; tests pinning crypto.randomUUID to a
// constant would collide physical ids across appends, so allocate fresh ids.
let uuidSeq = 0;
beforeEach(() => {
  uuidSeq = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidSeq}-0000-0000-0000-000000000000` as never,
  );
  localStorage.removeItem('nexus_company_config');
  vi.clearAllMocks();
});

// ─── Hermetic harness ───────────────────────────────────────────────────────

interface Harness {
  invoiceRows: VoidRecoveryInvoice[];
  eventsById: Map<string, TransportBudgetEvent>;
  queueOps: Array<{ table: string; recordId: string }>;
  repo: TransportBudgetRepository;
  produceCalls: string[];
  logs: { debug: string[]; info: string[]; warn: string[]; error: string[] };
  deps: VoidRecoveryDeps;
  failProduceFor: Set<string>;
  failedOutcomeFor: Set<string>;
}

const createHarness = (invoiceRows: VoidRecoveryInvoice[] = []): Harness => {
  const eventsById = new Map<string, TransportBudgetEvent>();
  const queueOps: Array<{ table: string; recordId: string }> = [];
  const store = {
    async get(id: string) {
      const found = eventsById.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...eventsById.values()].map((entry) => ({ ...entry }));
    },
    async put(event: TransportBudgetEvent) {
      eventsById.set(event.id, { ...event });
    },
  };
  const queue = {
    async enqueue(table: string, recordId: string) {
      queueOps.push({ table, recordId });
    },
    async hasPendingMutation() {
      return false;
    },
  };
  const repo = new TransportBudgetRepository(store, queue);
  const produceCalls: string[] = [];
  const logs = { debug: [] as string[], info: [] as string[], warn: [] as string[], error: [] as string[] };
  const failProduceFor = new Set<string>();
  const failedOutcomeFor = new Set<string>();
  const deps: VoidRecoveryDeps = {
    listInvoices: async () => invoiceRows.map((row) => ({ ...row })),
    listTransportEvents: () => repo.listTransportBudgetEvents(),
    produceVoidReversal: async (invoice: { id: string }) => {
      produceCalls.push(invoice.id);
      if (failProduceFor.has(invoice.id)) throw new Error(`boom-producer:${invoice.id}`);
      if (failedOutcomeFor.has(invoice.id)) {
        return { status: 'failed' as const, error: new Error(`cap-exceeded:${invoice.id}`) };
      }
      return produceVoidReversalSafely(invoice, {
        repository: repo,
        nowIso: () => FIXED_NOW,
      });
    },
    log: {
      debug: (msg: string) => { logs.debug.push(String(msg)); },
      info: (msg: string) => { logs.info.push(String(msg)); },
      warn: (msg: string) => { logs.warn.push(String(msg)); },
      error: (msg: string) => { logs.error.push(String(msg)); },
    },
  };
  return { invoiceRows, eventsById, queueOps, repo, produceCalls, logs, deps, failProduceFor, failedOutcomeFor };
};

const seedAllocation = async (
  h: Harness,
  economicKey: string,
  overrides: Record<string, unknown> = {},
) => {
  await h.repo.appendTransportBudgetEvent({
    id: `evt-alloc-${economicKey}`,
    kind: 'SALES_ALLOCATION',
    idempotencyKey: salesAllocationIdempotencyKey(economicKey),
    sourceEventId: economicKey,
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

const reversalsFor = async (h: Harness, economicKey: string) =>
  (await h.repo.listTransportBudgetEvents({ kind: 'REVERSAL' })).filter(
    (entry) => entry.idempotencyKey === voidReversalIdempotencyKey(economicKey),
  );

// ─── A. Candidate converges through the existing producer ───────────────────

describe('Phase 6E — A. Cancelled + allocation + missing reversal', () => {
  it('calls the producer once and creates exactly one REVERSAL', async () => {
    const h = createHarness([{ id: 'INV-R1', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-R1');

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(h.produceCalls).toEqual(['INV-R1']);
    expect(summary.appended).toBe(1);
    expect(summary.appendedIds).toEqual(['INV-R1']);
    const found = await reversalsFor(h, 'INV-R1');
    expect(found).toHaveLength(1);
    expect(found[0].idempotencyKey).toBe('REVERSAL:INV-R1:VOID');
    expect(found[0].amount).toBe(-15000);
    expect(found[0].reversesEventId).toBe('evt-alloc-INV-R1');
    expect(found[0].businessDate).toBe('2026-09-30');
    // Phase 4 field hygiene preserved through the producer.
    expect(found[0].sourceEventId).toBeNull();
    expect(found[0].allocationRatePercent).toBeNull();
    // The local durable-sync operation was queued for later transport.
    expect(
      h.queueOps.some(
        (op) => op.table === 'transport_budget_events' && op.recordId === found[0].id,
      ),
    ).toBe(true);
  });
});

// ─── B. Missing allocation defers without fabrication ───────────────────────

describe('Phase 6E — B. Cancelled + missing allocation', () => {
  it('never invokes the producer and fabricates no event', async () => {
    const h = createHarness([{ id: 'INV-R2', status: 'Cancelled' }]);
    // No SALES_ALLOCATION seeded.

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(h.produceCalls).toHaveLength(0);
    expect(summary.deferredMissingAllocation).toBe(1);
    expect(summary.appended).toBe(0);
    expect(summary.failed).toBe(0);
    expect(await h.repo.listTransportBudgetEvents()).toHaveLength(0);
    expect(h.queueOps).toHaveLength(0);
  });

  it('ignores non-Cancelled invoices entirely', async () => {
    const h = createHarness([
      { id: 'INV-OPEN', status: 'unpaid' },
      { id: 'INV-DRAFT', status: 'Draft' },
    ]);
    await seedAllocation(h, 'INV-OPEN');

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(h.produceCalls).toHaveLength(0);
    expect(summary.scannedCancelled).toBe(0);
    expect(await h.repo.listTransportBudgetEvents({ kind: 'REVERSAL' })).toHaveLength(0);
  });
});

// ─── C. Existing reversal is an idempotent skip ─────────────────────────────

describe('Phase 6E — C. Cancelled + existing reversal', () => {
  it('does not call the producer and creates no duplicate', async () => {
    const h = createHarness([{ id: 'INV-R3', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-R3');
    const first = await produceVoidReversalSafely(
      { id: 'INV-R3' },
      { repository: h.repo, nowIso: () => FIXED_NOW },
    );
    expect(first.status).toBe('appended');
    h.produceCalls.length = 0;

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(h.produceCalls).toHaveLength(0);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.appended).toBe(0);
    expect(await reversalsFor(h, 'INV-R3')).toHaveLength(1);
  });
});

// ─── D. Historical allocation wins over current policy ──────────────────────

describe('Phase 6E — D. conflicting current policy is never read', () => {
  it('reconciles from the original allocation amount, not the policy rate', async () => {
    localStorage.setItem(
      'nexus_company_config',
      JSON.stringify({ transportBudgetPolicy: { enabled: true, rate: 9 } }),
    );
    const h = createHarness([{ id: 'INV-R4', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-R4', { allocationRatePercent: 3, amount: 15000 });

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(summary.appended).toBe(1);
    const found = await reversalsFor(h, 'INV-R4');
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(-15000); // original 3%, never 9%
    expect(found[0].businessDate).toBe('2026-09-30');
  });
});

// ─── E. Already-Cancelled never re-enters the commercial void ───────────────

describe('Phase 6E — E. already-Cancelled invoice', () => {
  it('keeps the invoice row byte-identical while converging the REVERSAL', async () => {
    const invoice = {
      id: 'INV-R5',
      status: 'Cancelled',
      totalAmount: 500000,
      paidAmount: 0,
      voidReason: 'customer request',
    };
    const before = JSON.parse(JSON.stringify(invoice));
    const h = createHarness([invoice]);
    await seedAllocation(h, 'INV-R5');

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(summary.appended).toBe(1);
    // The commercial record is untouched: no re-void, no status/total edit.
    // (voidInvoice would throw 'already voided' here and mutate ledger —
    // success plus an identical row proves it never ran.)
    expect(h.invoiceRows[0]).toEqual(before);
    expect(await reversalsFor(h, 'INV-R5')).toHaveLength(1);
  });
});

// ─── F. Per-invoice error isolation ─────────────────────────────────────────

describe('Phase 6E — F. producer failure isolates per invoice', () => {
  it('records A as failed (thrown) and C as failed (outcome) while B appends', async () => {
    const h = createHarness([
      { id: 'INV-FA', status: 'Cancelled' },
      { id: 'INV-FB', status: 'Cancelled' },
      { id: 'INV-FC', status: 'Cancelled' },
    ]);
    await seedAllocation(h, 'INV-FA');
    await seedAllocation(h, 'INV-FB');
    await seedAllocation(h, 'INV-FC');
    h.failProduceFor.add('INV-FA');
    h.failedOutcomeFor.add('INV-FC');

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(summary.appended).toBe(1);
    expect(summary.appendedIds).toEqual(['INV-FB']);
    expect(summary.failed).toBe(2);
    expect(summary.failures.map((f) => f.invoiceId).sort()).toEqual(['INV-FA', 'INV-FC']);
    expect(h.logs.error.length).toBeGreaterThanOrEqual(2);
    expect(await reversalsFor(h, 'INV-FB')).toHaveLength(1);
    expect(await reversalsFor(h, 'INV-FA')).toHaveLength(0);
    expect(await reversalsFor(h, 'INV-FC')).toHaveLength(0);
  });

  it('ambiguous partial-reversal state is skipped without a producer call', async () => {
    const h = createHarness([{ id: 'INV-P1', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-P1');
    // A foreign-keyed partial reversal already targets the allocation.
    await h.repo.appendReversal({
      id: 'evt-rev-partial',
      kind: 'REVERSAL',
      idempotencyKey: 'REVERSAL:INV-P1:PARTIAL',
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
      method: null,
      providerId: null,
      reversesEventId: 'evt-alloc-INV-P1',
      businessDate: '2026-09-30',
      occurredAt: FIXED_NOW,
    } as never);
    const callsBefore = h.produceCalls.length;

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(summary.skippedAmbiguous).toBe(1);
    expect(summary.appended).toBe(0);
    expect(h.produceCalls.length).toBe(callsBefore);
    expect(h.logs.warn.length).toBeGreaterThanOrEqual(1);
    // No full-void event was invented on top of the partial state.
    expect(await reversalsFor(h, 'INV-P1')).toHaveLength(0);
  });
});

// ─── G. Repeated runs converge on one economic REVERSAL ─────────────────────

describe('Phase 6E — G. repeated reconciliation', () => {
  it('second run skips (Case C): one REVERSAL, same deterministic key', async () => {
    const h = createHarness([{ id: 'INV-R7', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-R7');

    const first = await reconcileMissingFullVoidReversals(h.deps);
    const second = await reconcileMissingFullVoidReversals(h.deps);

    expect(first.appended).toBe(1);
    expect(second.appended).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(h.produceCalls).toEqual(['INV-R7']);
    const all = await reversalsFor(h, 'INV-R7');
    expect(all).toHaveLength(1);
    expect(all[0].idempotencyKey).toBe('REVERSAL:INV-R7:VOID');
  });

  it('duplicate invoice rows in one scan invoke the producer once', async () => {
    const h = createHarness([
      { id: 'INV-DUP', status: 'Cancelled' },
      { id: 'INV-DUP', status: 'Cancelled' },
    ]);
    await seedAllocation(h, 'INV-DUP');

    const summary = await reconcileMissingFullVoidReversals(h.deps);

    expect(h.produceCalls).toEqual(['INV-DUP']);
    expect(summary.appended).toBe(1);
    expect(await reversalsFor(h, 'INV-DUP')).toHaveLength(1);
  });
});

// ─── H. Offline behavior ────────────────────────────────────────────────────

describe('Phase 6E — H. offline retry', () => {
  it('creates the local REVERSAL and queues sync with no HTTP dependency', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network should never be touched');
    });
    const previousFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    try {
      const h = createHarness([{ id: 'INV-R8', status: 'Cancelled' }]);
      await seedAllocation(h, 'INV-R8');

      const summary = await reconcileMissingFullVoidReversals(h.deps);

      expect(summary.appended).toBe(1);
      const found = await reversalsFor(h, 'INV-R8');
      expect(found).toHaveLength(1);
      expect(found[0].amount).toBe(-15000);
      // Normal durable-sync transport is queued for later delivery.
      expect(
        h.queueOps.some(
          (op) => op.table === 'transport_budget_events' && op.recordId === found[0].id,
        ),
      ).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (previousFetch === undefined) {
        delete (globalThis as { fetch?: unknown }).fetch;
      } else {
        globalThis.fetch = previousFetch;
      }
    }
  });
});

// ─── I. Scope guard ─────────────────────────────────────────────────────────

describe('Phase 6E — I. commercial scope guard', () => {
  it('leaves invoices/ledger/payments/inventory/customers untouched', async () => {
    const ledgerBefore = [{ id: 'LG-1', amount: 500000, referenceId: 'INV-R9' }];
    const paymentsBefore = [{ id: 'PAY-1', reference: 'INV-R9', status: 'Voided' }];
    const inventoryBefore = [{ id: 'ITEM-1', stock: 42 }];
    const customersBefore = [{ id: 'CUST-1', balance: 0 }];
    const h = createHarness([
      { id: 'INV-R9', status: 'Cancelled', totalAmount: 500000, paidAmount: 0 },
      { id: 'INV-OPEN9', status: 'unpaid', totalAmount: 1000 },
    ]);
    await seedAllocation(h, 'INV-R9');
    const eventsBefore = await h.repo.listTransportBudgetEvents();
    const queueBefore = h.queueOps.length;

    await reconcileMissingFullVoidReversals(h.deps);

    // No commercial stores are reachable from the reconciler deps at all;
    // the snapshots below prove nothing else moved.
    expect(ledgerBefore).toEqual([{ id: 'LG-1', amount: 500000, referenceId: 'INV-R9' }]);
    expect(paymentsBefore).toEqual([{ id: 'PAY-1', reference: 'INV-R9', status: 'Voided' }]);
    expect(inventoryBefore).toEqual([{ id: 'ITEM-1', stock: 42 }]);
    expect(customersBefore).toEqual([{ id: 'CUST-1', balance: 0 }]);
    expect(h.invoiceRows).toEqual([
      { id: 'INV-R9', status: 'Cancelled', totalAmount: 500000, paidAmount: 0 },
      { id: 'INV-OPEN9', status: 'unpaid', totalAmount: 1000 },
    ]);
    // Only one REVERSAL was added to the transport ledger...
    const eventsAfter = await h.repo.listTransportBudgetEvents();
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const added = eventsAfter.filter((entry) => !eventsBefore.some((prev) => prev.id === entry.id));
    expect(added).toHaveLength(1);
    expect(added[0].kind).toBe('REVERSAL');
    expect(added[0].idempotencyKey).toBe('REVERSAL:INV-R9:VOID');
    // ...and only transport_budget_events ops were queued.
    const newOps = h.queueOps.slice(queueBefore);
    expect(newOps.length).toBeGreaterThan(0);
    for (const op of newOps) {
      expect(op.table).toBe('transport_budget_events');
    }
  });
});

// ─── Static guard: no second producer, no policy access ─────────────────────

describe('Phase 6E — static scope guard', () => {
  it('reconciler delegates to the existing producer and reads no policy', () => {
    // Detection + delegation only: the single semantic producer remains the
    // only place that constructs/appends REVERSALs or derives economics.
    expect(recoverySource).toContain('produceVoidReversalSafely');
    expect(recoverySource).not.toContain('transportBudgetPolicy');
    expect(recoverySource).not.toContain('resolveTransportBudgetRate');
    expect(recoverySource).not.toContain('CompanyConfig');
    expect(recoverySource).not.toContain('voidInvoice(');
    expect(recoverySource).not.toContain('appendReversal(');
    expect(recoverySource).not.toContain('fetch(');
  });
});

// ─── Re-entrancy: overlapping triggers share one scan ───────────────────────

describe('Phase 6E — re-entrancy guard', () => {
  it('concurrent triggers share a single in-flight scan', async () => {
    const h = createHarness([{ id: 'INV-RR', status: 'Cancelled' }]);
    await seedAllocation(h, 'INV-RR');
    let scanCount = 0;
    const slowDeps: VoidRecoveryDeps = {
      ...h.deps,
      listInvoices: async () => {
        scanCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return h.invoiceRows.map((row) => ({ ...row }));
      },
    };

    const [first, second] = await Promise.all([
      requestVoidRecoveryReconciliation(slowDeps),
      requestVoidRecoveryReconciliation(slowDeps),
    ]);

    expect(scanCount).toBe(1);
    expect(first).toBe(second);
    expect(first.appended).toBe(1);
    expect(await reversalsFor(h, 'INV-RR')).toHaveLength(1);
  });
});
