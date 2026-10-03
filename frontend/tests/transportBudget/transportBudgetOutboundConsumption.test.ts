/**
 * transportBudgetOutboundConsumption.test.ts — Phase 8E outbound producer tests.
 * Hermetic: fake repository (real validator semantics via appended payload
 * assertions), real producer logic, no network/IndexedDB.
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

import {
  produceOutboundConsumptionForExpense,
  produceOutboundConsumptionSafely,
  outboundConsumptionIdempotencyKey,
  outboundConsumptionSourceEventId,
  OUTBOUND_CONSUMPTION_METHOD,
  type OutboundConsumptionDeps,
} from '../../services/transportBudgetOutboundConsumption';
import { TransportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../../types/transportBudget';
import type { TransportExpense } from '../../types';

const POSTED_AT = '2026-10-02T09:00:00.000Z';
const BUSINESS_DATE = '2026-10-02';

const line = (overrides: Record<string, unknown> = {}) => ({
  id: 'TEXP-LINE-1',
  classification: 'OUTBOUND_TRANSPORT',
  description: 'Courier delivery',
  amount: 20000,
  supplierId: 'SUP-1',
  accountId: null as unknown as string | null,
  ...overrides,
});

const expense = (overrides: Record<string, unknown> = {}) => ({
  id: 'TEXP-8E-1',
  idempotencyKey: 'TEXPENSE:TEXP-8E-1',
  status: 'POSTED',
  supplierId: 'SUP-1',
  settlementMode: 'AP',
  settlementAccountId: null,
  expenseAccountId: '52610',
  description: 'Outbound test',
  businessDate: BUSINESS_DATE,
  postedAt: POSTED_AT,
  createdAt: POSTED_AT,
  updatedAt: POSTED_AT,
  occurredAt: POSTED_AT,
  totalAmount: 20000,
  currency: 'MWK',
  journalId: 'TJ-TEXP-1',
  reversesExpenseId: null,
  isReversal: false,
  lines: [line()],
  ...overrides,
}) as unknown as TransportExpense;

const createRepo = () => {
  const rows = new Map<string, TransportBudgetEvent>();
  const ops: Array<{ table: string; recordId: string }> = [];
  const store = {
    async get(id: string) {
      const found = rows.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
    async put(event: TransportBudgetEvent) {
      rows.set(event.id, { ...event });
    },
    size() {
      return rows.size;
    },
  };
  const queue = {
    ops,
    async enqueue(table: string, recordId: string, _payload: unknown) {
      void _payload;
      ops.push({ table, recordId });
    },
    async hasPendingMutation() {
      return false;
    },
  };
  const repository = new TransportBudgetRepository(
    store as unknown as ConstructorParameters<typeof TransportBudgetRepository>[0],
    queue as unknown as ConstructorParameters<typeof TransportBudgetRepository>[1],
  );
  return { rows, ops, store, queue, repository };
};

const setup = () => {
  const fake = createRepo();
  let uuidSeq = 0;
  (crypto.randomUUID as unknown as { mockImplementation(fn: () => string): void }).mockImplementation(
    () => `test-outbound-uuid-${String((uuidSeq += 1)).padStart(4, '0')}`,
  );
  const deps: OutboundConsumptionDeps = {
    repository: fake.repository as unknown as OutboundConsumptionDeps['repository'],
    nowIso: () => POSTED_AT,
  };
  return { ...fake, deps };
};

beforeEach(() => {
  vi.clearAllMocks();
});
describe('outbound producer happy paths', () => {
  it('creates one event for one outbound line', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: expense() });
    expect(out.failed).toHaveLength(0);
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0]).toMatchObject({
      kind: 'OUTBOUND_CONSUMPTION',
      amount: -20000,
      sourceAmount: 20000,
      sourceEventId: 'TEXP-8E-1:TEXP-LINE-1',
      allocationRatePercent: null,
      method: 'OUTBOUND_TRANSPORT',
      providerId: 'SUP-1',
      accountSplits: null,
      journalIds: null,
      reversesEventId: null,
      correctsEventId: null,
      businessDate: BUSINESS_DATE,
      occurredAt: POSTED_AT,
      idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-8E-1:TEXP-LINE-1',
    });
  });
  it('reads the persisted occurredAt when postedAt is absent', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, {
      transportExpense: expense({ postedAt: undefined, occurredAt: POSTED_AT }),
    });
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0].occurredAt).toBe(POSTED_AT);
  });
  it('mixed lines emit only transport', async () => {
    const f = setup();
    const src = expense({
      totalAmount: 120000,
      lines: [
        line({ id: 'L-A', classification: 'NON_TRANSPORT', amount: 100000, supplierId: 'SUP-X' }),
        line({ id: 'L-B', amount: 20000, supplierId: 'SUP-1' }),
      ],
    });
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0]).toMatchObject({ amount: -20000, sourceAmount: 20000, providerId: 'SUP-1' });
    expect(out.skipped.some((s) => s.reason === 'non-transport-line')).toBe(true);
  });
  it('two outbound lines make two events', async () => {
    const f = setup();
    const src = expense({
      totalAmount: 50000,
      lines: [
        line({ id: 'L-1', amount: 20000, supplierId: 'SUP-1' }),
        line({ id: 'L-2', amount: 30000, supplierId: 'SUP-2' }),
      ],
    });
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(out.produced).toHaveLength(2);
    expect(out.produced.map((e) => e.amount).sort((a, b) => a - b)).toEqual([-30000, -20000]);
    expect(out.produced.map((e) => e.providerId).sort()).toEqual(['SUP-1', 'SUP-2']);
    expect(out.produced[0].idempotencyKey).not.toBe(out.produced[1].idempotencyKey);
  });
  it('same supplier still makes separate events', async () => {
    const f = setup();
    const src = expense({
      totalAmount: 50000,
      lines: [
        line({ id: 'L-1', amount: 20000, supplierId: 'SUP-1' }),
        line({ id: 'L-2', amount: 30000, supplierId: 'SUP-1' }),
      ],
    });
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(out.produced).toHaveLength(2);
    expect(out.produced.every((e) => e.providerId === 'SUP-1')).toBe(true);
    expect(out.produced[0].idempotencyKey).not.toBe(out.produced[1].idempotencyKey);
  });
});
describe('outbound producer idempotency', () => {
  it('same source twice deduplicates', async () => {
    const f = setup();
    const src = expense();
    const first = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(first.produced).toHaveLength(1);
    const second = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(second.produced).toHaveLength(0);
    expect(second.deduplicated).toHaveLength(1);
    expect(second.deduplicated[0].id).toBe(first.produced[0].id);
    expect(f.store.size()).toBe(1);
  });
  it('same key different id resolves to stored event', async () => {
    const f = setup();
    const src = expense();
    const first = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: src });
    expect(first.produced).toHaveLength(1);
    const retry = await f.repository.appendTransportBudgetEvent({
      id: 'evt-different-id',
      kind: 'OUTBOUND_CONSUMPTION',
      idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-8E-1:TEXP-LINE-1',
      sourceEventId: 'TEXP-8E-1:TEXP-LINE-1',
      sourceAmount: 20000,
      allocationRatePercent: null,
      amount: -20000,
      method: 'OUTBOUND_TRANSPORT',
      providerId: 'SUP-1',
      reversesEventId: null,
      correctsEventId: null,
      businessDate: BUSINESS_DATE,
      occurredAt: POSTED_AT,
    });
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.produced[0].id);
  });
  it('same id different economics rejects', async () => {
    const f = setup();
    await f.repository.appendTransportBudgetEvent({
      id: 'evt-fixed',
      kind: 'OUTBOUND_CONSUMPTION',
      idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-8E-1:TEXP-LINE-1',
      sourceEventId: 'TEXP-8E-1:TEXP-LINE-1',
      sourceAmount: 20000,
      allocationRatePercent: null,
      amount: -20000,
      method: 'OUTBOUND_TRANSPORT',
      providerId: 'SUP-1',
      reversesEventId: null,
      correctsEventId: null,
      businessDate: BUSINESS_DATE,
      occurredAt: POSTED_AT,
    });
    await expect(
      f.repository.appendTransportBudgetEvent({
        id: 'evt-fixed',
        kind: 'OUTBOUND_CONSUMPTION',
        idempotencyKey: 'OUTBOUND_CONSUMPTION:TEXP-8E-1:TEXP-LINE-1',
        sourceEventId: 'TEXP-8E-1:TEXP-LINE-1',
        sourceAmount: 20000,
        allocationRatePercent: null,
        amount: -9999,
        method: 'OUTBOUND_TRANSPORT',
        providerId: 'SUP-1',
        reversesEventId: null,
        correctsEventId: null,
        businessDate: BUSINESS_DATE,
        occurredAt: POSTED_AT,
      }),
    ).rejects.toThrow();
  });
  it('offline replay converges', async () => {
    const f = setup();
    const src = expense();
    const a = await produceOutboundConsumptionSafely(f.deps, { transportExpense: src });
    const b = await produceOutboundConsumptionSafely(f.deps, { transportExpense: src });
    expect(a.produced).toHaveLength(1);
    expect(b.deduplicated).toHaveLength(1);
    expect(f.store.size()).toBe(1);
  });
});
describe('outbound producer exclusions', () => {
  it('ignores DRAFT', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: expense({ status: 'DRAFT' }) });
    expect(out.produced).toHaveLength(0);
    expect(out.skipped[0]?.reason).toBe('not-posted');
    expect(f.store.size()).toBe(0);
  });
  it('ignores VOIDED', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: expense({ status: 'VOIDED' }) });
    expect(out.produced).toHaveLength(0);
    expect(f.store.size()).toBe(0);
  });
  it('ignores reversal by flag', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ isReversal: true, reversesExpenseId: 'TEXP-8E-0' }) },
    );
    expect(out.produced).toHaveLength(0);
    expect(out.skipped[0]?.reason).toBe('reversal-document');
  });
  it('ignores reversal by link', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ reversesExpenseId: 'TEXP-8E-0' }) },
    );
    expect(out.produced).toHaveLength(0);
    expect(out.skipped[0]?.reason).toBe('reversal-document');
  });
  it('fails closed on missing supplier', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ lines: [line({ supplierId: '' })] }) },
    );
    expect(out.produced).toHaveLength(0);
    expect(out.skipped[0]?.reason).toBe('malformed-line');
  });
  it('fails closed on invalid amount', async () => {
    const f = setup();
    for (const amount of [0, -5, Number.NaN]) {
      const out = await produceOutboundConsumptionForExpense(
        f.deps,
        { transportExpense: expense({ lines: [line({ amount })] }) },
      );
      expect(out.produced).toHaveLength(0);
    }
  });
  it('fails closed on bad classification', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ lines: [line({ classification: 'Transport' })] }) },
    );
    expect(out.produced).toHaveLength(0);
    expect(out.skipped[0]?.reason).toBe('malformed-line');
  });
  it('fails closed on missing source id', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: expense({ id: '' }) });
    expect(out.produced).toHaveLength(0);
  });
  it('fails closed on bad dates', async () => {
    const f = setup();
    const badDate = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ businessDate: '2026-13-40' }) },
    );
    expect(badDate.produced).toHaveLength(0);
    // Both timestamp fields invalid => fail closed (never a fabricated time).
    const badPosted = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ postedAt: 'not-a-date', occurredAt: 'not-a-date' }) },
    );
    expect(badPosted.produced).toHaveLength(0);
    // Neither timestamp present => fail closed.
    const missing = await produceOutboundConsumptionForExpense(
      f.deps,
      { transportExpense: expense({ postedAt: undefined, occurredAt: undefined }) },
    );
    expect(missing.produced).toHaveLength(0);
    expect(missing.skipped[0]?.reason).toBe('malformed-source');
  });
});

describe('outbound key helpers', () => {
  it('uses deterministic keys', () => {
    expect(outboundConsumptionIdempotencyKey('TEXP-1', 'L-1')).toBe('OUTBOUND_CONSUMPTION:TEXP-1:L-1');
    expect(outboundConsumptionSourceEventId('TEXP-1', 'L-1')).toBe('TEXP-1:L-1');
    expect(OUTBOUND_CONSUMPTION_METHOD).toBe('OUTBOUND_TRANSPORT');
  });
});

describe('outbound producer isolation', () => {
  it('queues only the budget table with null accounting fields', async () => {
    const f = setup();
    const out = await produceOutboundConsumptionForExpense(f.deps, { transportExpense: expense() });
    expect(out.produced).toHaveLength(1);
    expect(out.produced[0]).toMatchObject({
      accountSplits: null,
      journalIds: null,
      allocationRatePercent: null,
      reversesEventId: null,
      correctsEventId: null,
    });
    expect(f.ops).toHaveLength(1);
    expect(f.ops[0]?.table).toBe('transport_budget_events');
  });
  it('safe wrapper never throws on repository failure', async () => {
    const failing: OutboundConsumptionDeps = {
      repository: {
        appendTransportBudgetEvent: async () => {
          throw new Error('queue unavailable');
        },
      },
      nowIso: () => POSTED_AT,
    };
    const out = await produceOutboundConsumptionSafely(failing, { transportExpense: expense() });
    expect(out.produced).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.reason).toBe('append-failed');
  });
});

