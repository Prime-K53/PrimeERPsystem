/**
 * transportBudgetRecovery.test.ts — Phase 9B missing-event reconciliation.
 *
 * Exercises reconcileTransportBudget() with the REAL producers and REAL
 * Phase 4 repository over a hermetic in-memory dbService boundary
 * (no IndexedDB, no Supabase, no network) — the voidInvoiceReversal.test.ts
 * mocking strategy.
 *
 * Proves per family: missing -> recreated with frozen economics; present ->
 * no duplicate; repeated runs stable; conflicts deferred/failed loudly;
 * ledger rows never mutated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbControl = vi.hoisted(() => {
  const stores = new Map<string, Map<string, unknown>>();
  function storeFor(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      get: async (id: string) => m.get(String(id)),
      put: async (rec: { id?: string; key?: string }) => {
        m.set(String((rec as any).id ?? (rec as any).key), rec);
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
    storeFor,
    dbService,
    reset() {
      stores.clear();
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
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  reconcileTransportBudget,
  requestTransportBudgetReconciliation,
} from '../../services/transportBudgetRecovery';
import { transportBudgetRepository } from '../../services/repositories/transportBudgetRepository';

// The shared setup mocks localStorage.getItem to null (setItem is a no-op),
// so policy must be injected through the getItem mock itself.
const seedPolicy = (rate: number) => {
  const json = JSON.stringify({
    transportBudgetPolicy: { allocationRatePercent: rate },
  });
  vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
    key === 'nexus_company_config' ? json : null,
  );
};

const budgetRows = () =>
  dbControl.dbService.getAll('transportBudgetEvents') as Promise<any[]>;

let uuidSeq = 0;
beforeEach(() => {
  dbControl.reset();
  vi.clearAllMocks();
  uuidSeq = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidSeq}-0000-0000-0000-000000000000` as never,
  );
  seedPolicy(3);
});

const seedSale = (overrides: Record<string, unknown> = {}) =>
  dbControl.dbService.put('sales', {
    id: 'SALE-R1',
    status: 'Paid',
    items: [],
    totalAmount: 150000,
    date: '2026-09-30',
    customerId: 'walk-in',
    ...overrides,
  });

const seedInvoice = (overrides: Record<string, unknown> = {}) =>
  dbControl.dbService.put('invoices', {
    id: 'INV-R1',
    status: 'Unpaid',
    items: [],
    totalAmount: 90000,
    date: '2026-09-28',
    customerId: 'CUST-1',
    ...overrides,
  });

describe('Phase 9B — SALES_ALLOCATION recovery', () => {
  it('recreates a missing allocation with frozen persisted economics', async () => {
    await seedSale();
    await seedInvoice();
    const summary = await reconcileTransportBudget();
    expect(summary.salesAllocation.scanned).toBe(2);
    expect(summary.salesAllocation.recreated).toBe(2);
    const rows = await budgetRows();
    const byKey = new Map(rows.map((r: any) => [r.idempotencyKey, r]));
    expect(byKey.get('SALES_ALLOCATION:SALE-R1')).toMatchObject({
      kind: 'SALES_ALLOCATION',
      amount: 4500,
      sourceAmount: 150000,
      allocationRatePercent: 3,
    });
    expect(byKey.get('SALES_ALLOCATION:INV-R1')).toMatchObject({
      kind: 'SALES_ALLOCATION',
      amount: 2700,
    });
  });

  it('present events are left alone; repeated runs are stable', async () => {
    await seedSale();
    const first = await reconcileTransportBudget();
    expect(first.salesAllocation.recreated).toBe(1);
    const second = await reconcileTransportBudget();
    expect(second.salesAllocation.recreated).toBe(0);
    expect(second.salesAllocation.alreadyPresent).toBe(1);
    expect(second.salesAllocation.failed).toBe(0);
    expect((await budgetRows()).filter((r: any) => r.kind === 'SALES_ALLOCATION')).toHaveLength(1);
  });

  it('historical rate is preserved when policy changes (no recalculation)', async () => {
    await seedSale();
    await reconcileTransportBudget();
    seedPolicy(9);
    const retry = await reconcileTransportBudget();
    expect(retry.salesAllocation.recreated).toBe(0);
    const rows = await budgetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 4500, allocationRatePercent: 3 });
  });

  it('present key is never overwritten even when the source doc diverged', async () => {
    await seedSale();
    await reconcileTransportBudget();
    // Sale total edited after allocation: same key now disagrees with the
    // doc. Recovery leaves the frozen ledger row alone (manual review owns
    // commercial divergence; the ledger never rewrites history).
    await dbControl.dbService.put('sales', {
      id: 'SALE-R1',
      status: 'Paid',
      items: [],
      totalAmount: 160000,
      date: '2026-09-30',
      customerId: 'walk-in',
    });
    const retry = await reconcileTransportBudget();
    expect(retry.salesAllocation.recreated).toBe(0);
    expect(retry.salesAllocation.failed).toBe(0);
    expect(retry.salesAllocation.alreadyPresent).toBe(1);
    const rows = await budgetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 4500, sourceAmount: 150000 });
  });

  it('unrecognized sales and credit notes are never allocated', async () => {
    await dbControl.dbService.put('sales', {
      id: 'SALE-DRAFT',
      status: 'Draft',
      items: [],
      totalAmount: 50000,
      date: '2026-09-30',
    });
    await seedInvoice({ id: 'INV-CN', status: 'credit_note', totalAmount: 10000 });
    const summary = await reconcileTransportBudget();
    expect(summary.salesAllocation.scanned).toBe(0);
    expect(summary.salesAllocation.recreated).toBe(0);
  });
});

describe('Phase 9B — REVERSAL recovery (sale + backend-spelling invoice voids)', () => {
  it('voided sale with allocation but no reversal is repaired', async () => {
    await seedSale({ status: 'Voided' });
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-alloc-r1',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:SALE-R1',
      sourceEventId: 'SALE-R1',
      sourceAmount: 150000,
      allocationRatePercent: 3,
      amount: 4500,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);
    const summary = await reconcileTransportBudget();
    expect(summary.reversal.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.reversal.recreated).toBe(1);
    const reversal =
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'REVERSAL:SALE-R1:VOID',
      );
    expect(reversal).toMatchObject({ kind: 'REVERSAL', amount: -4500 });
  });

  it('voided sale whose mirror invoice is still posted is left alone', async () => {
    await seedSale({ id: 'SALE-M9', status: 'Voided', totalAmount: 200000 });
    await dbControl.dbService.put('invoices', {
      id: 'INV-MIRROR-9',
      reference: 'SALE-M9',
      notes: 'POS sale - source: SALE-M9',
      status: 'Unpaid',
      items: [],
      totalAmount: 200000,
      date: '2026-09-30',
      customerId: 'walk-in',
    });
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-alloc-m9',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:INV-MIRROR-9',
      sourceEventId: 'INV-MIRROR-9',
      sourceAmount: 200000,
      allocationRatePercent: 3,
      amount: 6000,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);
    const summary = await reconcileTransportBudget();
    expect(summary.reversal.recreated).toBe(0);
    // The mirror allocation stands untouched.
    expect(
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'REVERSAL:INV-MIRROR-9:VOID',
      ),
    ).toBeNull();
  });

  it('backend-spelling voided invoice is repaired', async () => {
    await seedInvoice({ status: 'Voided' });
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-alloc-inv-r1',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:INV-R1',
      sourceEventId: 'INV-R1',
      sourceAmount: 90000,
      allocationRatePercent: 3,
      amount: 2700,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate: '2026-09-28',
      occurredAt: '2026-09-28T10:00:00.000Z',
    } as never);
    const summary = await reconcileTransportBudget();
    expect(summary.reversal.recreated).toBe(1);
    expect(
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'REVERSAL:INV-R1:VOID',
      ),
    ).toMatchObject({ amount: -2700 });
  });
});

describe('Phase 9B — INBOUND / CORRECTION recovery', () => {
  const seedGrnWorld = async () => {
    await dbControl.dbService.put('purchases', {
      id: 'PO-R1',
      landingConsumption: [
        {
          id: 'LCE-R1',
          landingCostId: 'LC-R1',
          kind: 'GRN',
          billId: null,
          grnId: 'GRN-R1',
          amount: 20000,
          sourceAmount: 20000,
          method: 'LANDING_COST_FREIGHT',
          providerId: 'SUP-R',
          at: '2026-09-15T10:00:00.000Z',
        },
      ],
    });
    await dbControl.dbService.put('goodsReceipts', {
      id: 'GRN-R1',
      date: '2026-09-15',
      landingCosts: [{ id: 'LC-R1', category: 'Freight' }],
    });
  };

  it('missing inbound is recreated from persisted GRN rows', async () => {
    await seedGrnWorld();
    const summary = await reconcileTransportBudget();
    expect(summary.inboundConsumption.recreated).toBe(1);
    expect(
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'INBOUND_CONSUMPTION:LC-R1:GRN-R1',
      ),
    ).toMatchObject({ kind: 'INBOUND_CONSUMPTION', amount: -20000 });
  });

  it('missing GRN row defers without fabrication', async () => {
    await dbControl.dbService.put('purchases', {
      id: 'PO-R2',
      landingConsumption: [
        {
          id: 'LCE-R2',
          landingCostId: 'LC-R2',
          kind: 'GRN',
          billId: null,
          grnId: 'GRN-MISSING',
          amount: 5000,
          sourceAmount: 5000,
          method: 'LANDING_COST_FREIGHT',
          providerId: 'SUP-R',
          at: '2026-09-15T10:00:00.000Z',
        },
      ],
    });
    const summary = await reconcileTransportBudget();
    expect(summary.inboundConsumption.recreated).toBe(0);
    expect(summary.inboundConsumption.deferred).toBe(1);
    expect(await budgetRows()).toHaveLength(0);
  });

  it('missing correction is recreated once its parent exists', async () => {
    await seedGrnWorld();
    await reconcileTransportBudget();
    await dbControl.dbService.put('purchases', {
      id: 'PO-R1',
      landingConsumption: [
        {
          id: 'LCE-R1',
          landingCostId: 'LC-R1',
          kind: 'GRN',
          billId: null,
          grnId: 'GRN-R1',
          amount: 20000,
          sourceAmount: 20000,
          method: 'LANDING_COST_FREIGHT',
          providerId: 'SUP-R',
          at: '2026-09-15T10:00:00.000Z',
        },
        {
          id: 'LCR-R1',
          landingCostId: 'LC-R1',
          kind: 'CORRECTION',
          billId: null,
          grnId: 'GRN-R1',
          amount: -5000,
          sourceAmount: 20000,
          method: 'LANDING_COST_FREIGHT',
          providerId: 'SUP-R',
          at: '2026-09-20T10:00:00.000Z',
        },
      ],
    });
    const summary = await reconcileTransportBudget();
    expect(summary.consumptionCorrection.recreated).toBe(1);
    const rows = await budgetRows();
    const correction = rows.find(
      (r: any) => r.kind === 'CONSUMPTION_CORRECTION',
    );
    expect(correction).toMatchObject({ amount: 5000 });
    // Stable on repeat.
    const again = await reconcileTransportBudget();
    expect(again.consumptionCorrection.recreated).toBe(0);
  });
});

describe('Phase 9B — OUTBOUND / CONSUMPTION_REVERSAL recovery', () => {
  const postedExpense = (overrides: Record<string, unknown> = {}) => ({
    id: 'TEXP-R1',
    status: 'POSTED',
    businessDate: '2026-10-02',
    occurredAt: '2026-10-02T09:00:00.000Z',
    isReversal: false,
    reversesExpenseId: null,
    lines: [
      {
        id: 'L-1',
        classification: 'OUTBOUND_TRANSPORT',
        amount: 20000,
        supplierId: 'SUP-R',
      },
    ],
    ...overrides,
  });

  it('missing outbound is recreated from the POSTED expense row', async () => {
    await dbControl.dbService.put('transportExpenses', postedExpense());
    const summary = await reconcileTransportBudget();
    expect(summary.outboundConsumption.recreated).toBe(1);
    expect(
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'OUTBOUND_CONSUMPTION:TEXP-R1:L-1',
      ),
    ).toMatchObject({ amount: -20000 });
  });

  it('missing consumption reversal is recreated from the VOIDED pair', async () => {
    await dbControl.dbService.put('transportExpenses', {
      ...postedExpense(),
      status: 'VOIDED',
    });
    await dbControl.dbService.put('transportExpenses', {
      ...postedExpense(),
      id: 'TEXP-R1R',
      status: 'POSTED',
      isReversal: true,
      reversesExpenseId: 'TEXP-R1',
      occurredAt: '2026-10-03T11:00:00.000Z',
    });
    await transportBudgetRepository.appendTransportBudgetEvent({
      id: 'evt-out-r1',
      kind: 'OUTBOUND_CONSUMPTION',
      idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-R1:L-1',
      sourceEventId: 'TEXP-R1:L-1',
      sourceAmount: 20000,
      allocationRatePercent: null,
      amount: -20000,
      method: 'OUTBOUND_TRANSPORT',
      providerId: 'SUP-R',
      reversesEventId: null,
      correctsEventId: null,
      businessDate: '2026-10-02',
      occurredAt: '2026-10-02T09:00:00.000Z',
    } as never);
    const summary = await reconcileTransportBudget();
    expect(summary.consumptionReversal.recreated).toBe(1);
    expect(
      await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        'CONSUMPTION_REVERSAL:evt-out-r1',
      ),
    ).toMatchObject({
      amount: 20000,
      reversesEventId: 'evt-out-r1',
      occurredAt: '2026-10-03T11:00:00.000Z',
    });
  });

  it('void without a reversal row defers (no timestamp exists to use)', async () => {
    await dbControl.dbService.put('transportExpenses', {
      ...postedExpense(),
      status: 'VOIDED',
    });
    const summary = await reconcileTransportBudget();
    expect(summary.consumptionReversal.recreated).toBe(0);
    expect(summary.consumptionReversal.deferred).toBe(1);
    expect(await budgetRows()).toHaveLength(0);
  });
});

describe('Phase 9B — trigger safety and ledger immutability', () => {
  it('request function is single-flight, never throws, and is stable', async () => {
    await seedSale();
    requestTransportBudgetReconciliation();
    requestTransportBudgetReconciliation();
    // Poll for convergence (no fixed wall-clock assumption under load).
    let rows: any[] = [];
    for (let i = 0; i < 200 && rows.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rows = await budgetRows();
    }
    expect(rows.filter((r: any) => r.kind === 'SALES_ALLOCATION')).toHaveLength(1);
    const again = await reconcileTransportBudget();
    expect(again.salesAllocation.recreated).toBe(0);
    expect((await budgetRows()).length).toBe(rows.length);
  });
});
