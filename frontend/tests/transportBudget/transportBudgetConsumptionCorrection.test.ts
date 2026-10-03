/**
 * transportBudgetConsumptionCorrection.test.ts — Phase 7G producer tests.
 *
 * Part A: unit tests against the producer module with a fake repository
 * (§13 eligibility 1–5, parent resolution 6–8, payload 9–20, source snapshot).
 * Part B: idempotency/amount over the real Phase 7E repository (§13 items
 * 21–26) — full, partial, over-correction, precision.
 * Part C: lifecycle integration through correctLandingConsumption with
 * in-memory dbService (§13 post-commit behavior, partial critical case,
 * hook ordering, no accounting side effects).
 * Part D: static sync/backend boundary guards (§13 items 27–28).
 *
 * Out of scope: OUTBOUND production, recovery scanners, bill paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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
  produceConsumptionCorrectionForLandingCorrection,
  produceConsumptionCorrectionSafely,
} from '../../services/transportBudgetConsumptionCorrection';
import { TransportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import { transportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import { transactionService } from '../../services/transactionService';

const NOW = '2026-10-02T09:00:00.000Z';
const POSTING_DAY = '2026-10-02';

let uuidSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  memStores.tables.clear();
  // Sequential physical ids: the global setup pins crypto.randomUUID to one
  // constant, which would collide distinct appends sharing one store.
  uuidSeq = 0;
  (crypto.randomUUID as any).mockImplementation(
    () => `uuid-${++uuidSeq}-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`,
  );
});

const drainHooks = () => new Promise((resolve) => setTimeout(resolve, 50));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const parentInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-in-7G',
  kind: 'INBOUND_CONSUMPTION' as const,
  idempotencyKey: 'INBOUND_CONSUMPTION:LC-7G:GRN-7G',
  sourceEventId: 'LC-7G:GRN-7G',
  sourceAmount: 100000,
  allocationRatePercent: null,
  amount: -30000,
  method: 'LANDING_COST_FREIGHT',
  providerId: 'SUP-F',
  reversesEventId: null,
  correctsEventId: null,
  businessDate: '2026-09-15',
  occurredAt: '2026-09-15T10:00:00.000Z',
  ...overrides,
});

const landingCorrection = (overrides: Record<string, unknown> = {}) => ({
  id: 'LCC-7G',
  landingCostId: 'LC-7G',
  kind: 'CORRECTION',
  billId: null,
  grnId: 'GRN-7G',
  amount: -30000,
  sourceAmount: 100000,
  method: 'VALUE',
  providerId: 'SUP-F',
  accountSplits: [],
  journalIds: [],
  at: `${POSTING_DAY}T09:00:00.000Z`,
  correctsEventId: 'LCC-ORIG-7G',
  taxTreatment: 'NONE',
  taxAmount: 0,
  ...overrides,
});

// Fake repository: in-memory rows + real append semantics are NOT replicated;
// the fake only records inputs and resolves parents by scope.
const fakeRepo = (parents: any[] = []) => {
  const calls: any[] = [];
  return {
    calls,
    async appendCorrection(eventInput: any) {
      calls.push(eventInput);
      return {
        event: { ...eventInput, id: eventInput.id || 'evt-corr-new', createdAt: NOW },
        deduplicated: false,
      };
    },
    async listTransportBudgetEvents(filter: any = {}) {
      return parents.filter(
        (e: any) =>
          (filter.kind === undefined || e.kind === filter.kind) &&
          (filter.sourceEventId === undefined || e.sourceEventId === filter.sourceEventId),
      );
    },
  };
};

const depsFor = (repo: any) => ({ repository: repo, nowIso: () => NOW });

// ---------------------------------------------------------------------------
// Part A — eligibility (§13.1–5)
// ---------------------------------------------------------------------------

describe('correction producer — eligibility', () => {
  it('1. valid Landing CORRECTION produces a Transport correction', async () => {
    const repo = fakeRepo([parentInput()]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(outcome.produced).toHaveLength(1);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(repo.calls).toHaveLength(1);
  });

  it('2. non-CORRECTION events are ignored', async () => {
    const repo = fakeRepo([parentInput()]);
    for (const kind of ['GRN', 'BILL', 'REVERSAL']) {
      const outcome = await produceConsumptionCorrectionForLandingCorrection(
        depsFor(repo),
        { correction: landingCorrection({ kind }) },
      );
      expect(outcome.produced).toHaveLength(0);
      expect(outcome.skipped[0]?.reason).toBe('not-correction-kind');
    }
    expect(repo.calls).toHaveLength(0);
  });

  it('3. positive/zero/invalid correction amounts are rejected', async () => {
    const repo = fakeRepo([parentInput()]);
    for (const amount of [0, 5000, NaN, '30000', null, undefined]) {
      const outcome = await produceConsumptionCorrectionForLandingCorrection(
        depsFor(repo),
        { correction: landingCorrection({ amount }) },
      );
      expect(outcome.produced).toHaveLength(0);
      expect(outcome.skipped[0]?.reason).toBe('non-negative-amount');
    }
    expect(repo.calls).toHaveLength(0);
  });

  it('4/5. missing landingCostId / grnId are rejected', async () => {
    const repo = fakeRepo([parentInput()]);
    const noLine = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection({ landingCostId: '' }) },
    );
    expect(noLine.skipped).toEqual([
      { scope: '?:GRN-7G', reason: 'missing-line-id' },
    ]);
    const noGrn = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection({ grnId: '' }) },
    );
    expect(noGrn.skipped[0]?.reason).toBe('missing-grn-id');
    expect(repo.calls).toHaveLength(0);
  });

  it('unusable posting timestamp fails closed (never invented)', async () => {
    const repo = fakeRepo([parentInput()]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection({ at: 'not-a-time' }) },
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe('invalid-timestamp');
  });
});

// ---------------------------------------------------------------------------
// Part A — parent resolution (§13.6–8)
// ---------------------------------------------------------------------------

describe('correction producer — parent resolution', () => {
  it('6. scope resolves exactly one inbound parent', async () => {
    const repo = fakeRepo([parentInput(), parentInput({ id: 'evt-other', sourceEventId: 'LC-X:GRN-X', idempotencyKey: 'INBOUND_CONSUMPTION:LC-X:GRN-X' })]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(outcome.produced).toHaveLength(1);
    expect(repo.calls[0].correctsEventId).toBe('evt-in-7G');
  });

  it('7. missing Transport parent fails closed with retry identity', async () => {
    const repo = fakeRepo([]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].reason).toBe('missing-parent');
    expect(outcome.failed[0].error).toContain('LC-7G:GRN-7G');
    expect(outcome.failed[0].error).toContain('LCC-7G');
  });

  it('8. ambiguous parents fail closed (never chooses)', async () => {
    const repo = fakeRepo([
      parentInput(),
      parentInput({ id: 'evt-in-7G-2', idempotencyKey: 'INBOUND_CONSUMPTION:LC-7G:GRN-7G:2' }),
    ]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.failed[0]?.reason).toBe('ambiguous-parent');
  });

  it('invalid parent snapshot fails closed (never invents defaults)', async () => {
    const repo = fakeRepo([parentInput({ providerId: null })]);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(outcome.failed[0]?.reason).toBe('invalid-parent-snapshot');
  });
});

// ---------------------------------------------------------------------------
// Part A — payload (§13.9–20)
// ---------------------------------------------------------------------------

describe('correction producer — payload', () => {
  it('emits the exact frozen payload from parent snapshots', async () => {
    const repo = fakeRepo([parentInput()]);
    await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(repo.calls[0]).toMatchObject({
      kind: 'CONSUMPTION_CORRECTION',
      amount: 30000,
      sourceEventId: 'evt-in-7G',
      correctsEventId: 'evt-in-7G',
      sourceAmount: 100000,
      method: 'LANDING_COST_FREIGHT',
      providerId: 'SUP-F',
      allocationRatePercent: null,
      reversesEventId: null,
      businessDate: POSTING_DAY,
      occurredAt: `${POSTING_DAY}T09:00:00.000Z`,
      idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-7G',
    });
  });

  it('copies parent sourceAmount even when it differs from abs(amount)', async () => {
    const repo = fakeRepo([parentInput()]);
    await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    // Locked 7G-1 semantics: snapshot copy, NOT abs(correction.amount)
    // re-derivation (both are 30000/100000 here by construction).
    expect(repo.calls[0].sourceAmount).toBe(100000);
    expect(repo.calls[0].sourceAmount).toBe(
      (parentInput() as { sourceAmount: number }).sourceAmount,
    );
  });

  it('businessDate derives from the correction posting timestamp, not the GRN period', async () => {
    const repo = fakeRepo([parentInput({ businessDate: '2026-08-01' })]);
    await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      { correction: landingCorrection() },
    );
    expect(repo.calls[0].businessDate).toBe(POSTING_DAY);
    expect(repo.calls[0].businessDate).not.toBe('2026-08-01');
  });
});

// ---------------------------------------------------------------------------
// Part B — idempotency/amount over the real Phase 7E repository
// ---------------------------------------------------------------------------

describe('correction producer — idempotency over the Phase 7E repository', () => {
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
  const seedParent = async (repo: any, over: Record<string, unknown> = {}) => {
    await repo.appendTransportBudgetEvent(parentInput(over) as never);
  };
  const inputFor = (over: Record<string, unknown> = {}) => ({
    correction: landingCorrection(over),
  });

  it('21/22. repeated invocation converges (second dedupes)', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await seedParent(repo);
    const first = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      inputFor(),
    );
    const retry = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      inputFor(),
    );
    expect(first.produced).toHaveLength(1);
    expect(retry.produced).toHaveLength(0);
    expect(retry.deduplicated).toHaveLength(1);
    expect(retry.deduplicated[0].idempotencyKey).toBe(
      'CONSUMPTION_CORRECTION:evt-in-7G',
    );
  });

  it('23. a different key targeting the same parent hits ALREADY_CORRECTED', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await seedParent(repo);
    await produceConsumptionCorrectionForLandingCorrection(depsFor(repo), inputFor());
    // A non-producer path using a different economic key for the same parent
    // fails closed (the producer itself always reuses the parent key, which
    // dedupes instead — see the previous test).
    await expect(
      repo.appendCorrection({
        kind: 'CONSUMPTION_CORRECTION',
        id: 'evt-corr-other-key',
        idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-7G:other',
        sourceEventId: 'evt-in-7G',
        sourceAmount: 100000,
        allocationRatePercent: null,
        amount: 500,
        method: 'LANDING_COST_FREIGHT',
        providerId: 'SUP-F',
        reversesEventId: null,
        correctsEventId: 'evt-in-7G',
        businessDate: POSTING_DAY,
        occurredAt: `${POSTING_DAY}T10:00:00.000Z`,
      } as never),
    ).rejects.toMatchObject({ code: 'ALREADY_CORRECTED' });
  });

  it('24. full release of a partial parent is exact (+30000 on -30000/100000)', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await seedParent(repo);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      inputFor({ amount: -30000 }),
    );
    expect(outcome.produced[0]).toMatchObject({ amount: 30000, sourceAmount: 100000 });
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((s: number, e: any) => s + Number(e.amount), 0)).toBe(0);
  });

  it('25. over-correction is rejected by the ledger backstop', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await seedParent(repo);
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      inputFor({ amount: -30001 }),
    );
    expect(outcome.produced).toHaveLength(0);
    expect(outcome.failed[0]?.reason).toBe('append-failed');
    expect(outcome.failed[0]?.error).toMatch(/would exceed original consumption/);
  });

  it('26. correction amount retains 2dp precision against a partial parent', async () => {
    const repo = new TransportBudgetRepository(createStore() as never, createQueue() as never);
    await seedParent(repo, { amount: -19999.99, sourceAmount: 20000 });
    const outcome = await produceConsumptionCorrectionForLandingCorrection(
      depsFor(repo),
      inputFor({ amount: -19999.99 }),
    );
    expect(outcome.produced[0]?.amount).toBe(19999.99);
    expect(outcome.produced[0]?.sourceAmount).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Part C — lifecycle integration through correctLandingConsumption
// ---------------------------------------------------------------------------

const SUPPLIERS = {
  goods: { id: 'SUP-GOODS', name: 'Goods Supplier', balance: 0 },
  freight: { id: 'SUP-FREIGHT', name: 'Speedy Freight Ltd', balance: 0 },
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
    acc('21210', 'VAT Position', 'LIABILITY'),
    acc('51100', 'Purchases', 'EXPENSE'),
    acc('52000', 'Other Expenses', 'EXPENSE'),
    acc('11210', 'Bank', 'ASSET'),
  ];
}

function seed7G(tag: string, lineAmount: number) {
  memStores.tables.clear();
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('inventory', [
    { id: 'ST-1', name: 'Branded Pens', type: 'Stationery', inventoryRole: 'sellable', stock: 0, cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000 },
    { id: 'RM-1', name: 'A4 Paper', type: 'Raw Material', stock: 0, cost: 1000, cost_price: 1000, cost_per_unit: 1000, costPrice: 1000, normalizedCP: 1000 },
  ]);
  putAll('accounts', coaFixture());
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('purchases', [
    {
      id: `PO-${tag}`,
      supplierId: SUPPLIERS.goods.id,
      supplierName: SUPPLIERS.goods.name,
      status: 'Ordered',
      total: 3000000,
      totalAmount: 3000000,
      items: [
        { itemId: 'ST-1', name: 'Branded Pens', type: 'Stationery', quantity: 100, cost: 10000 },
        { itemId: 'RM-1', name: 'A4 Paper', type: 'Raw Material', quantity: 100, cost: 20000 },
      ],
      landingCosts: [{ id: `LC-${tag}`, category: 'Freight', description: 'Inbound freight', amount: lineAmount, providerId: SUPPLIERS.freight.id }],
    },
  ]);
  for (const t of ['ledger', 'goodsReceipts', 'purchaseInvoices', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'vatTransactions']) {
    if (!memStores.tables.has(t)) memStores.tables.set(t, new Map());
  }
}

function grnLine(itemId: string, qty: number, unitCost: number, type: string) {
  return {
    itemId, name: itemId, type, orderedQty: qty, quantityReceived: qty, quantityRejected: 0,
    warehouseId: 'WH-MAIN', cost: unitCost, cost_price: unitCost, unitPrice: unitCost, price: unitCost,
  };
}

function grn7G(tag: string, grnId: string, lines: any[], qtys: [number, number]) {
  return {
    id: grnId,
    purchaseOrderId: `PO-${tag}`,
    date: '2026-09-15',
    supplierId: SUPPLIERS.goods.id,
    supplierName: SUPPLIERS.goods.name,
    status: 'Draft',
    landingAllocationMethod: 'VALUE',
    items: [
      { ...grnLine('ST-1', qtys[0], 10000, 'Stationery') },
      { ...grnLine('RM-1', qtys[1], 20000, 'Raw Material') },
    ],
    landingCosts: lines,
  };
}

const listCorrections = () =>
  transportBudgetRepository.listTransportBudgetEvents({
    kind: 'CONSUMPTION_CORRECTION',
  });

async function waitForCorrections(n: number) {
  await vi.waitFor(async () => {
    expect(await listCorrections()).toHaveLength(n);
  });
}

describe('correction producer — post-commit lifecycle integration', () => {
  it('runs only after the Landing correction commits; retries converge', async () => {
    seed7G('G1', 100000);
    const line = { id: 'LC-G1', category: 'Freight', description: 'F', amount: 100000, providerId: SUPPLIERS.freight.id };
    await transactionService.processGoodsReceipt(grn7G('G1', 'GRN-G1', [line], [100, 100]));
    // Wait for the 7F inbound (proves the hook chain is live in this file).
    await vi.waitFor(async () => {
      expect(
        await transportBudgetRepository.listTransportBudgetEvents({ kind: 'INBOUND_CONSUMPTION' }),
      ).toHaveLength(1);
    });
    const res: any = await transactionService.correctLandingConsumption({
      purchaseOrderId: 'PO-G1', landingCostId: 'LC-G1', grnId: 'GRN-G1', reason: '7G integration',
    });
    expect(res.success).toBe(true);
    // Return carries the committed correction event (7F grnConsumptionEvents pattern).
    expect(res.correctionEvent).toMatchObject({ kind: 'CORRECTION', grnId: 'GRN-G1', landingCostId: 'LC-G1' });
    // Landing durable first: the CORRECTION row exists before we observe transport.
    const { dbService } = await import('../../services/db');
    const po: any = await dbService.get('purchases', 'PO-G1');
    expect(po.landingConsumption.filter((e: any) => e.kind === 'CORRECTION')).toHaveLength(1);
    await waitForCorrections(1);
    const [correction] = await listCorrections();
    const [parent] = await transportBudgetRepository.listTransportBudgetEvents({
      kind: 'INBOUND_CONSUMPTION',
    });
    expect(correction).toMatchObject({
      kind: 'CONSUMPTION_CORRECTION',
      amount: 100000,
      sourceAmount: 100000,
      sourceEventId: parent.id,
      correctsEventId: parent.id,
      method: 'LANDING_COST_FREIGHT',
      providerId: 'SUP-FREIGHT',
      allocationRatePercent: null,
      reversesEventId: null,
      idempotencyKey: `CONSUMPTION_CORRECTION:${parent.id}`,
    });
    expect(correction.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof correction.occurredAt).toBe('string');
    // Deterministic retry converges (no second economic correction).
    const { produceConsumptionCorrectionSafely } = await import(
      '../../services/transportBudgetConsumptionCorrection'
    );
    const retry = await produceConsumptionCorrectionSafely(
      { repository: transportBudgetRepository, nowIso: () => NOW },
      { correction: po.landingConsumption.find((e: any) => e.kind === 'CORRECTION') },
    );
    expect(retry.produced).toHaveLength(0);
    expect(retry.deduplicated).toHaveLength(1);
    await drainHooks();
  });

  it('partial critical case: -80000/300000 parent yields +80000/300000 correction', async () => {
    seed7G('G2', 300000);
    const mkLines = () => [
      { id: 'LC-G2', category: 'Freight', description: 'F', amount: 300000, providerId: SUPPLIERS.freight.id },
    ];
    await transactionService.processGoodsReceipt(grn7G('G2', 'GRN-G2A', mkLines(), [40, 20]));
    await transactionService.processGoodsReceipt(grn7G('G2', 'GRN-G2B', mkLines(), [60, 80]));
    await vi.waitFor(async () => {
      expect(
        await transportBudgetRepository.listTransportBudgetEvents({ kind: 'INBOUND_CONSUMPTION' }),
      ).toHaveLength(2);
    });
    const res: any = await transactionService.correctLandingConsumption({
      purchaseOrderId: 'PO-G2', landingCostId: 'LC-G2', grnId: 'GRN-G2A', reason: '7G partial',
    });
    expect(res.success).toBe(true);
    await waitForCorrections(1);
    const [correction] = await listCorrections();
    const parents = await transportBudgetRepository.listTransportBudgetEvents({
      kind: 'INBOUND_CONSUMPTION',
    });
    const parentA = parents.find((p: any) => p.sourceEventId === 'LC-G2:GRN-G2A') as any;
    expect(parentA.amount).toBe(-80000);
    expect(parentA.sourceAmount).toBe(300000);
    // Locked 7G-1 semantics: snapshot copy, NOT abs(amount).
    expect(correction.amount).toBe(80000);
    expect(correction.sourceAmount).toBe(300000);
    expect(correction.sourceEventId).toBe(parentA.id);
    expect(correction.correctsEventId).toBe(parentA.id);
    // Net across the ledger: -80000 -220000 +80000 = -220000.
    const all = await transportBudgetRepository.listTransportBudgetEvents();
    expect(all.reduce((s: number, e: any) => s + Number(e.amount), 0)).toBe(-220000);
    await drainHooks();
  });

  it('transport hook adds no accounting side effects', async () => {
    seed7G('G3', 100000);
    const line = { id: 'LC-G3', category: 'Freight', description: 'F', amount: 100000, providerId: SUPPLIERS.freight.id };
    await transactionService.processGoodsReceipt(grn7G('G3', 'GRN-G3', [line], [100, 100]));
    const ledgerBefore: number = [...(memStores.tables.get('ledger') ?? new Map()).values()].length;
    await transactionService.correctLandingConsumption({
      purchaseOrderId: 'PO-G3', landingCostId: 'LC-G3', grnId: 'GRN-G3', reason: '7G side effects',
    });
    await waitForCorrections(1);
    // Only Landing mirror/VAT/WAC legs were added by the correction itself;
    // the Transport hook writes to transportBudgetEvents alone.
    const transportRows: any[] = [
      ...(memStores.tables.get('transportBudgetEvents') ?? new Map()).values(),
    ];
    expect(transportRows.filter((e: any) => e.kind === 'CONSUMPTION_CORRECTION')).toHaveLength(1);
    const ledgerAfter: any[] = [
      ...(memStores.tables.get('ledger') ?? new Map()).values(),
    ];
    expect(
      ledgerAfter.every((e: any) => String(e.id).startsWith('LG-GRN-') || String(e.id).startsWith('LG-LCB')),
    ).toBe(true);
    expect(ledgerAfter.length).toBeGreaterThan(ledgerBefore);
    await drainHooks();
  });
});

// ---------------------------------------------------------------------------
// Part D — static sync/backend boundary guards (§13.27–28)
// ---------------------------------------------------------------------------

describe('correction producer — local boundary guards', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const readSrc = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('27/28. no backend/sync producer path exists', () => {
    for (const rel of ['backend/routes/sync.cjs', 'backend/index.cjs']) {
      const src = readSrc(rel);
      expect(src).not.toContain('produceConsumptionCorrection');
      expect(src).not.toContain('CONSUMPTION_CORRECTION');
    }
    const txSrc = readSrc('frontend/services/transactionService.ts');
    expect(txSrc).toContain('produceConsumptionCorrectionSafely');
    // Exactly one production hook site (the dynamic import + call pair).
    const hookSites = txSrc.match(
      /produceConsumptionCorrectionSafely\(defaultConsumptionCorrectionDeps/g,
    ) || [];
    expect(hookSites).toHaveLength(1);
  });
});
