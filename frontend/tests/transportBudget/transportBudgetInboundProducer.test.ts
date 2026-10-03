/**
 * transportBudgetInboundProducer.test.ts — Phase 7F producer tests.
 *
 * Part A: unit tests against the producer module with a fake repository
 * (§20 eligibility 1–7, amount 8–11, identity 12–17, idempotency key 13,
 * multi-scope 24–25).
 * Part B: repository-level idempotency/convergence with the real Phase 7E
 * repository over fake store/queue (§20 items 18–20).
 * Part C: lifecycle integration through transactionService.processGoodsReceipt
 * with in-memory dbService + mocked durable queue (§20 items 21–24, 26–30).
 *
 * Out of scope by phase contract: CONSUMPTION_CORRECTION and
 * OUTBOUND_CONSUMPTION production (no tests invent them here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const memStores = vi.hoisted(() => ({
  tables: new Map<string, Map<string, any>>(),
}));

vi.mock('../../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      getTable(name).set(String(obj.id), obj);
    },
    delete: async (id: string) => {
      getTable(name).delete(String(id));
    },
  });
  return {
    dbService: {
      getAll: async (table: string) => [...getTable(table).values()],
      get: async (table: string, id: string) => getTable(table).get(String(id)),
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id), obj);
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    enqueue: vi.fn(),
    hasPendingMutation: vi.fn(async () => false),
    recordMetric: vi.fn(),
    dequeue: vi.fn(async () => null),
  },
}));

vi.mock('../../services/backgroundSyncService', () => ({
  backgroundSyncService: { trigger: vi.fn(), syncOnce: vi.fn() },
}));

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  produceInboundConsumptionForGrn,
  produceInboundConsumptionSafely,
  inboundConsumptionIdempotencyKey,
  inboundConsumptionSourceEventId,
  INBOUND_CONSUMPTION_METHOD,
} from '../../services/transportBudgetInboundConsumption';
import { TransportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import { transportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import { transactionService } from '../../services/transactionService';
import { roundMoney } from '../../utils/roundingUtils';

const NOW = '2026-10-02T09:00:00.000Z';

const freightEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'LCC-1',
  landingCostId: 'LC-101',
  kind: 'GRN',
  billId: null,
  grnId: 'GRN-456',
  amount: 20000,
  sourceAmount: 20000,
  method: 'VALUE',
  providerId: 'SUP-FREIGHT',
  accountSplits: [],
  journalIds: [],
  at: '2026-09-15T10:00:00.000Z',
  taxTreatment: 'NONE',
  taxAmount: 0,
  ...overrides,
});

const freightLine = (overrides: Record<string, unknown> = {}) => ({
  id: 'LC-101',
  category: 'Freight',
  description: 'Inbound freight',
  amount: 20000,
  providerId: 'SUP-FREIGHT',
  ...overrides,
});

const inputFor = (
  events: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) => ({
  grnId: 'GRN-456',
  grnDate: '2026-09-15',
  landingCosts: [freightLine()],
  events,
  ...over,
});

const fakeRepo = () => {
  const calls: any[] = [];
  return {
    calls,
    async appendTransportBudgetEvent(eventInput: any) {
      calls.push(eventInput);
      return {
        event: { ...eventInput, id: eventInput.id || 'evt-new', createdAt: NOW },
        deduplicated: false,
      };
    },
  };
};

const depsFor = (repo: any) => ({ repository: repo, nowIso: () => NOW });

beforeEach(() => {
  vi.clearAllMocks();
  memStores.tables.clear();
  // Sequential physical ids: the global setup pins crypto.randomUUID to one
  // constant, which would collide distinct appends sharing one store.
  // Production uses real UUIDs; tests mint unique ones per append so
  // idempotency converges on the economic key (the actual contract).
  uuidSeq = 0;
  (crypto.randomUUID as any).mockImplementation(
    () =>
      `uuid-${++uuidSeq}-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`,
  );
});

let uuidSeq = 0;

const drainHooks = () => new Promise((resolve) => setTimeout(resolve, 50));

// ---------------------------------------------------------------------------
// Part A — eligibility (§20.1–7)
// ---------------------------------------------------------------------------

describe('inbound producer — eligibility', () => {
  it('1. GRN Freight consumption creates one inbound Transport event', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent()]),
    );
    expect(outcome.produced).toHaveLength(1);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(repo.calls).toHaveLength(1);
  });

  it('2. non-Freight Landing Cost does not create one', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      {
        ...inputFor([freightEvent({ landingCostId: 'LC-102' })]),
        landingCosts: [
          freightLine(),
          { id: 'LC-102', category: 'Customs', amount: 5000, providerId: 'SUP-X' },
        ],
      },
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.skipped).toEqual([
      { scope: 'LC-102:GRN-456', reason: 'non-freight' },
    ]);
  });

  it('3. non-GRN LandingConsumptionEvents do not create one', async () => {
    const repo = fakeRepo();
    for (const kind of ['BILL', 'CORRECTION', 'REVERSAL']) {
      const outcome = await produceInboundConsumptionForGrn(
        depsFor(repo),
        inputFor([freightEvent({ kind })]),
      );
      expect(outcome.produced).toHaveLength(0);
      expect(outcome.skipped[0]?.reason).toBe('not-grn-kind');
    }
    // A GRN-kind row that carries a billId is not a GRN consumption fact.
    const billed = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ billId: 'BILL-1' })]),
    );
    expect(billed.produced).toHaveLength(0);
    expect(billed.skipped[0]?.reason).toBe('billed-event');
  });

  it('4. draft GRN (no committed events) creates none', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([]),
    );
    expect(outcome).toMatchObject({ produced: [], failed: [] });
    expect(repo.calls).toHaveLength(0);
  });

  it('5. unconsumed Freight (line present, no event) creates none', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([], {
        landingCosts: [freightLine(), freightLine({ id: 'LC-102' })],
      }),
    );
    expect(outcome.produced).toHaveLength(0);
    expect(repo.calls).toHaveLength(0);
  });

  it('6. zero consumption creates none (fails closed, no fabrication)', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: 0 })]),
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.skipped).toEqual([
      { scope: 'LC-101:GRN-456', reason: 'non-positive-amount' },
    ]);
  });

  it('7. negative authoritative consumption is rejected (fails closed)', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: -500 })]),
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe('non-positive-amount');
  });

  it('unknown landingCostId and missing provider fail closed (never invented)', async () => {
    const repo = fakeRepo();
    const unknown = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ landingCostId: 'LC-999' })]),
    );
    expect(unknown.skipped).toEqual([
      { scope: 'LC-999:GRN-456', reason: 'unknown-line' },
    ]);
    const noProvider = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ providerId: '' })]),
    );
    expect(noProvider.skipped).toEqual([
      { scope: 'LC-101:GRN-456', reason: 'missing-provider' },
    ]);
    expect(repo.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part A — amount (§20.8–11) and identity (§20.12–17)
// ---------------------------------------------------------------------------

describe('inbound producer — amount and identity', () => {
  it('8/9. amount mirrors negative authoritative consumption; sourceAmount mirrors positive', async () => {
    const repo = fakeRepo();
    await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: 20000, sourceAmount: 20000 })]),
    );
    expect(repo.calls[0]).toMatchObject({ amount: -20000, sourceAmount: 20000 });
  });

  it('10. no independent freight calculation occurs (PO/header totals ignored)', async () => {
    const repo = fakeRepo();
    // Even with unrelated totals around, the event mirrors the fact only.
    await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: 20000, sourceAmount: 25000 })]),
    );
    expect(repo.calls[0]).toMatchObject({ amount: -20000, sourceAmount: 25000 });
  });

  it('11. canonical money rounding occurs exactly once', async () => {
    const repo = fakeRepo();
    await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: 19999.995, sourceAmount: 19999.995 })]),
    );
    expect(repo.calls[0].amount).toBe(-roundMoney(19999.995));
    expect(repo.calls[0].sourceAmount).toBe(roundMoney(19999.995));
  });

  it('12–17. exact event contract fields', async () => {
    const repo = fakeRepo();
    await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent()]),
    );
    expect(repo.calls[0]).toMatchObject({
      kind: 'INBOUND_CONSUMPTION',
      amount: -20000,
      sourceAmount: 20000,
      sourceEventId: 'LC-101:GRN-456',
      method: 'LANDING_COST_FREIGHT',
      providerId: 'SUP-FREIGHT',
      allocationRatePercent: null,
      reversesEventId: null,
      correctsEventId: null,
      businessDate: '2026-09-15',
      occurredAt: '2026-09-15T10:00:00.000Z',
      idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-456',
    });
  });

  it('key builders follow the frozen identity', () => {
    expect(inboundConsumptionIdempotencyKey('LC-123', 'GRN-456')).toBe(
      'INBOUND_CONSUMPTION:LC-123:GRN-456',
    );
    expect(inboundConsumptionSourceEventId('LC-123', 'GRN-456')).toBe(
      'LC-123:GRN-456',
    );
    expect(INBOUND_CONSUMPTION_METHOD).toBe('LANDING_COST_FREIGHT');
  });

  it('occurredAt falls back to nowIso when the landing timestamp is unusable', async () => {
    const repo = fakeRepo();
    await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ at: 'not-a-time' })]),
    );
    expect(repo.calls[0].occurredAt).toBe(NOW);
  });

  it('24/25. one event per scope; second event for one scope is detected, never aggregated', async () => {
    const repo = fakeRepo();
    const outcome = await produceInboundConsumptionForGrn(
      depsFor(repo),
      inputFor([freightEvent({ amount: 12000 }), freightEvent({ id: 'LCC-2', amount: 8000 })]),
    );
    expect(outcome.produced).toHaveLength(1);
    expect(outcome.produced[0].amount).toBe(-12000);
    expect(outcome.skipped).toEqual([
      { scope: 'LC-101:GRN-456', reason: 'duplicate-scope' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Part B — idempotency over the real Phase 7E repository (§20.18–20)
// ---------------------------------------------------------------------------

describe('inbound producer — idempotency over the Phase 7E repository', () => {
  const createStore = (seed: any[] = []) => {
    const rows = new Map(seed.map((e: any) => [String(e.id), { ...e }]));
    return {
      async get(id: string) {
        const found = rows.get(String(id));
        return found ? { ...found } : undefined;
      },
      async getAll() {
        return [...rows.values()].map((e) => ({ ...e }));
      },
      async put(event: any) {
        rows.set(String(event.id), { ...event });
      },
    };
  };
  const createQueue = () => ({
    async enqueue() {},
    async hasPendingMutation() {
      return false;
    },
  });
  const input = inputFor([freightEvent()]);

  it('18. same GRN producer retry creates no duplicate', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    const first = await produceInboundConsumptionForGrn(depsFor(repo), input);
    const retry = await produceInboundConsumptionForGrn(depsFor(repo), input);
    expect(first.produced).toHaveLength(1);
    expect(retry.produced).toHaveLength(0);
    expect(retry.deduplicated).toHaveLength(1);
    expect(retry.deduplicated[0].idempotencyKey).toBe(
      'INBOUND_CONSUMPTION:LC-101:GRN-456',
    );
  });

  it('19. different physical ID with same key resolves existing', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await produceInboundConsumptionForGrn(depsFor(repo), input);
    const retry = await repo.appendTransportBudgetEvent({
      ...(firstEventShape()),
      id: 'evt-other-physical-id',
    } as never);
    expect(retry.deduplicated).toBe(true);
    function firstEventShape() {
      return {
        kind: 'INBOUND_CONSUMPTION',
        idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-456',
        sourceEventId: 'LC-101:GRN-456',
        sourceAmount: 20000,
        allocationRatePercent: null,
        amount: -20000,
        method: 'LANDING_COST_FREIGHT',
        providerId: 'SUP-FREIGHT',
        reversesEventId: null,
        correctsEventId: null,
        businessDate: '2026-09-15',
        occurredAt: '2026-09-15T10:00:00.000Z',
      };
    }
  });

  it('20. concurrent duplicate attempts converge', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    const [a, b] = await Promise.all([
      produceInboundConsumptionForGrn(depsFor(repo), input),
      produceInboundConsumptionForGrn(depsFor(repo), input),
    ]);
    const produced = [...a.produced, ...b.produced];
    const deduped = [...a.deduplicated, ...b.deduplicated];
    expect(produced).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    expect(produced[0].id).toBe(deduped[0].id);
  });
});

// ---------------------------------------------------------------------------
// Part C — lifecycle integration through processGoodsReceipt (§20.21–24)
// ---------------------------------------------------------------------------

const ACC = {
  merchandise: 'ACC-11410',
  rawMaterials: 'ACC-11420',
  accountsPayable: 'ACC-21110',
  purchases: 'ACC-51100',
  bank: 'ACC-11210',
  defaultExpense: 'ACC-52000',
};

function coaFixture(): any[] {
  const acc = (code: string, name: string, account_type: string, extra: any = {}) => ({
    id: `ACC-${code}`,
    code,
    account_number: code,
    name,
    account_type,
    type: account_type === 'ASSET' ? 'Asset' : account_type === 'EXPENSE' ? 'Expense' : 'Liability',
    normal_balance: account_type === 'ASSET' || account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    parent_account_id: null,
    is_active: true,
    allow_posting: true,
    ...extra,
  });
  return [
    acc('11400', 'Inventory', 'ASSET', { allow_posting: false }),
    acc('11410', 'Merchandise Inventory', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('11420', 'Raw Materials', 'ASSET', { parent_account_id: 'ACC-11400' }),
    acc('21110', 'Trade Creditors', 'LIABILITY'),
    acc('51100', 'Purchases', 'EXPENSE'),
    acc('52000', 'Other Expenses', 'EXPENSE'),
    acc('11210', 'Bank', 'ASSET'),
  ];
}

const SUPPLIERS = {
  goods: { id: 'SUP-GOODS', name: 'Goods Supplier', balance: 0 },
  freight: { id: 'SUP-FREIGHT', name: 'Speedy Freight Ltd', balance: 0 },
};

function seed(poOver: any = {}, tag = 'T0') {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', [
    { id: 'ST-1', name: 'Branded Pens', type: 'Stationery', inventoryRole: 'sellable', stock: 0, cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000 },
  ]);
  putAll('accounts', coaFixture());
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('purchases', [
    {
      id: `PO-${tag}`,
      supplierId: SUPPLIERS.goods.id,
      supplierName: SUPPLIERS.goods.name,
      status: 'Ordered',
      total: 1000000,
      totalAmount: 1000000,
      items: [{ itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 }],
      landingCosts: [{ id: `LC-${tag}`, category: 'Freight', description: 'Inbound freight', amount: 20000, providerId: SUPPLIERS.freight.id }],
      ...poOver,
    },
  ]);
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'accounts', 'vatTransactions']) {
    if (!memStores.tables.has(t)) memStores.tables.set(t, new Map());
  }
  return tag;
}

function grnFixture(over: any = {}, tag = 'T0') {
  return {
    id: `GRN-${tag}`,
    purchaseOrderId: `PO-${tag}`,
    date: '2026-09-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    landingAllocationMethod: 'VALUE',
    items: [
      { itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', orderedQty: 100, quantityReceived: 100, quantityRejected: 0, warehouseId: 'WH-MAIN', cost: 10000, cost_price: 10000, unitPrice: 10000, price: 10000 },
    ],
    landingCosts: [
      { id: `LC-${tag}`, category: 'Freight', description: 'Inbound freight', amount: 20000, providerId: SUPPLIERS.freight.id },
    ],
    ...over,
  };
}

const transportEvents = () =>
  transportBudgetRepository.listTransportBudgetEvents({
    kind: 'INBOUND_CONSUMPTION',
  });

async function waitForTransportCount(n: number) {
  await vi.waitFor(async () => {
    const events = await transportEvents();
    expect(events).toHaveLength(n);
  });
}

describe('inbound producer — GRN lifecycle integration', () => {
  it('21. producer runs only after successful Landing consumption persistence', async () => {
    seed({}, 'T21');
    const res: any = await transactionService.processGoodsReceipt(grnFixture({}, 'T21'));
    expect(res.success).toBe(true);
    expect(res.grnConsumptionEvents).toHaveLength(1);
    await waitForTransportCount(1);
    const [event] = await transportEvents();
    // References the persisted Landing event scope (post-commit fact).
    expect(event.sourceEventId).toBe('LC-T21:GRN-T21');
    expect(event).toMatchObject({
      kind: 'INBOUND_CONSUMPTION',
      amount: -20000,
      sourceAmount: 20000,
      method: 'LANDING_COST_FREIGHT',
      providerId: 'SUP-FREIGHT',
      businessDate: '2026-09-15',
      idempotencyKey: 'INBOUND_CONSUMPTION:LC-T21:GRN-T21',
    });
    expect(typeof event.occurredAt).toBe('string');
    await drainHooks();
  });

  it('22. failed Transport append does not corrupt Landing Cost posting', async () => {
    seed({}, 'T22');
    // Fail ONLY the transport store write for the whole hook window;
    // every Landing store still works.
    const memTables = memStores.tables;
    const { dbService } = await import('../../services/db');
    const originalPut = (dbService as any).put;
    (dbService as any).put = async (table: string, obj: any) => {
      if (table === 'transportBudgetEvents') {
        throw new Error('transient transport outage');
      }
      if (!memTables.has(table)) memTables.set(table, new Map());
      memTables.get(table)!.set(String(obj.id), obj);
    };
    try {
      const res: any = await transactionService.processGoodsReceipt(grnFixture({}, 'T22'));
      expect(res.success).toBe(true);
      expect(res.grnConsumptionEvents).toHaveLength(1);
      // Drain the floating hook while the outage is still active: it must
      // fail closed without touching the committed Landing state.
      await drainHooks();
      await drainHooks();
      // Landing persisted despite the transport outage.
      const po = await (dbService as any).get('purchases', 'PO-T22');
      expect(po.landingConsumption).toHaveLength(1);
      expect(await transportEvents()).toHaveLength(0);
    } finally {
      (dbService as any).put = originalPut;
    }
    await drainHooks();
  });

  it('23. retry after transient failure converges to exactly one event', async () => {
    seed({}, 'T23');
    const { produceInboundConsumptionSafely } = await import(
      '../../services/transportBudgetInboundConsumption'
    );
    const grn = grnFixture({}, 'T23');
    const res: any = await transactionService.processGoodsReceipt(grn);
    expect(res.success).toBe(true);
    // Deterministic re-invocation with the committed fact converges.
    const persistedPO: any = await (
      await import('../../services/db')
    ).dbService.get('purchases', 'PO-T23');
    const retry = await produceInboundConsumptionSafely(
      {
        repository: transportBudgetRepository,
        nowIso: () => NOW,
      },
      {
        grnId: grn.id,
        grnDate: grn.date,
        landingCosts: grn.landingCosts,
        events: persistedPO.landingConsumption,
      },
    );
    await waitForTransportCount(1);
    const events = await transportEvents();
    expect(events).toHaveLength(1);
    expect(retry.produced.length + retry.deduplicated.length).toBe(1);
    await drainHooks();
  });

  it('24. multiple Freight scopes produce one event each; non-Freight produces none', async () => {
    seed(
      {
        landingCosts: [
          { id: 'LC-T24A', category: 'Freight', description: 'Freight A', amount: 12000, providerId: SUPPLIERS.freight.id },
          { id: 'LC-T24B', category: 'Freight', description: 'Freight B', amount: 8000, providerId: SUPPLIERS.freight.id },
          { id: 'LC-T24C', category: 'Customs', description: 'Customs', amount: 5000, providerId: SUPPLIERS.freight.id },
        ],
      },
      'T24',
    );
    const res: any = await transactionService.processGoodsReceipt(
      grnFixture(
        {
          landingCosts: [
            { id: 'LC-T24A', category: 'Freight', description: 'Freight A', amount: 12000, providerId: SUPPLIERS.freight.id },
            { id: 'LC-T24B', category: 'Freight', description: 'Freight B', amount: 8000, providerId: SUPPLIERS.freight.id },
            { id: 'LC-T24C', category: 'Customs', description: 'Customs', amount: 5000, providerId: SUPPLIERS.freight.id },
          ],
        },
        'T24',
      ),
    );
    expect(res.success).toBe(true);
    await waitForTransportCount(2);
    const events = await transportEvents();
    const byKey = new Map(events.map((e: any) => [e.idempotencyKey, e]));
    // Entitlement splits the freight lines across the receipt basis; each
    // scope maps its own persisted Landing amount (no aggregation).
    expect(byKey.has('INBOUND_CONSUMPTION:LC-T24A:GRN-T24')).toBe(true);
    expect(byKey.has('INBOUND_CONSUMPTION:LC-T24B:GRN-T24')).toBe(true);
    expect(byKey.has('INBOUND_CONSUMPTION:LC-T24C:GRN-T24')).toBe(false);
    for (const e of events as any[]) {
      expect(e.amount).toBeLessThan(0);
      expect(e.sourceAmount).toBeGreaterThan(0);
      expect(e.amount).toBe(-(e.sourceAmount as number));
    }
    await drainHooks();
  });

  it('26–30. landing/accounting/customer state shows no producer side effects', async () => {
    seed({}, 'T26');
    await transactionService.processGoodsReceipt(grnFixture({}, 'T26'));
    await waitForTransportCount(1);
    const ledgerRows: any[] = [
      ...(memStores.tables.get('ledger') ?? new Map()).values(),
    ];
    // Pure Landing legs only: goods + one freight group, no transport legs.
    expect(ledgerRows).toHaveLength(2);
    expect(
      ledgerRows.every((e: any) => String(e.id).startsWith('LG-GRN-')),
    ).toBe(true);
    // Provider subledgers exact: freight provider K20,000, goods K1,000,000.
    expect(memStores.tables.get('suppliers')!.get('SUP-FREIGHT')?.balance).toBe(20000);
    expect(memStores.tables.get('suppliers')!.get('SUP-GOODS')?.balance).toBe(1000000);
    // No customer/AR/invoice artifacts created by the producer.
    expect(memStores.tables.get('purchaseInvoices')?.size ?? 0).toBe(0);
    const events = await transportEvents();
    expect(events[0]).toMatchObject({
      allocationRatePercent: null,
      reversesEventId: null,
      correctsEventId: null,
      accountSplits: null,
      journalIds: null,
    });
    await drainHooks();
  });
});
