/**
 * reversalFoundation.test.ts — Phase 6C foundation tests for the frontend
 * Model A reversal boundary.
 *
 * Scope: PROOF ONLY. No production reversal producer is added here. These
 * tests establish, against the existing Phase 4 repository controls, that:
 *
 *   A. The original SALES_ALLOCATION is retrievable by its deterministic
 *      economic key, with its historical rate/amount/business date, WITHOUT
 *      consulting the current Transport Budget policy.
 *   B. A missing allocation is detected and no allocation/rate is fabricated.
 *   C. The frozen deterministic reversal identity is stable, distinct per
 *      commercial reversal, and excludes the durable-sync `operationId`.
 *   D. `appendReversal()` reuses the existing Phase 4 reversal safeguards.
 *
 * Hermetic: fake store + fake sync queue (no IndexedDB, no network).
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
  TransportBudgetRepository,
  TransportBudgetReversalError,
} from '../../services/repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../../types/transportBudget';

// ─── Frozen identity conventions (Phase 6B, evaluated in this phase) ─────────
// Economic identity of a sale/invoice: `convertedInvoiceId ?? saleId`.
const ALLOCATION_KEY = (economicKey: string) =>
  `SALES_ALLOCATION:${economicKey}`;
// Deterministic full-void reversal identity — derived ONLY from the
// commercial reversal identity, never from the sync queue operationId.
const VOID_REVERSAL_KEY = (economicKey: string) =>
  `REVERSAL:${economicKey}:VOID`;

// ─── Hermetic fakes ─────────────────────────────────────────────────────────

const createStore = (seed: TransportBudgetEvent[] = []) => {
  const rows = new Map<string, TransportBudgetEvent>(
    seed.map((entry) => [entry.id, { ...entry }]),
  );
  return {
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
};

const createQueue = () => {
  const ops: Array<{ table: string; recordId: string }> = [];
  return {
    ops,
    async enqueue(table: string, recordId: string) {
      ops.push({ table, recordId });
    },
    async hasPendingMutation() {
      return false;
    },
  };
};

const allocationEvent = (
  overrides: Partial<TransportBudgetEvent> = {},
): TransportBudgetEvent => ({
  id: 'evt-alloc-1000',
  kind: 'SALES_ALLOCATION',
  idempotencyKey: ALLOCATION_KEY('INV-1000'),
  sourceEventId: 'INV-1000',
  sourceAmount: 500000,
  allocationRatePercent: 3,
  amount: 15000,
  method: null,
  providerId: null,
  accountSplits: null,
  journalIds: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T10:00:00.000Z',
  createdAt: '2026-09-30T10:00:00.000Z',
  ...overrides,
});

const setup = (seed: TransportBudgetEvent[] = []) => {
  const store = createStore(seed);
  const queue = createQueue();
  const repo = new TransportBudgetRepository(store, queue);
  return { store, queue, repo };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Phase 6C-A — historical allocation lookup', () => {
  it('finds the original allocation by its deterministic economic key', async () => {
    const { repo } = setup([allocationEvent()]);
    const found = await repo.findTransportBudgetEventByIdempotencyKey(
      ALLOCATION_KEY('INV-1000'),
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe('evt-alloc-1000');
  });

  it('returns the stored historical rate, amount, business date and source', async () => {
    const { repo } = setup([allocationEvent()]);
    const found = await repo.findTransportBudgetEventByIdempotencyKey(
      ALLOCATION_KEY('INV-1000'),
    );
    expect(found?.allocationRatePercent).toBe(3);
    expect(found?.amount).toBe(15000);
    expect(found?.businessDate).toBe('2026-09-30');
    expect(found?.sourceAmount).toBe(500000);
    expect(found?.sourceEventId).toBe('INV-1000');
  });

  it('does NOT consult the current Transport Budget policy to resolve the original', async () => {
    // A conflicting current policy must never influence historical retrieval.
    localStorage.setItem(
      'nexus_company_config',
      JSON.stringify({ transportBudgetPolicy: { rate: 9, enabled: true } }),
    );
    const { repo } = setup([allocationEvent({ allocationRatePercent: 3 })]);
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const found = await repo.findTransportBudgetEventByIdempotencyKey(
      ALLOCATION_KEY('INV-1000'),
    );
    expect(found?.allocationRatePercent).toBe(3); // historical, not 9
    expect(found?.amount).toBe(15000); // stored verbatim, never recomputed
    expect(getItemSpy).not.toHaveBeenCalled();
  });
});

describe('Phase 6C-B — missing allocation is fail-closed (no fabrication)', () => {
  it('returns null when no allocation exists for the key', async () => {
    const { repo } = setup();
    const found = await repo.findTransportBudgetEventByIdempotencyKey(
      ALLOCATION_KEY('INV-MISSING'),
    );
    expect(found).toBeNull();
  });

  it('does not fabricate an allocation or substitute the current policy rate', async () => {
    localStorage.setItem(
      'nexus_company_config',
      JSON.stringify({ transportBudgetPolicy: { rate: 7.5, enabled: true } }),
    );
    const { store, queue, repo } = setup();
    const found = await repo.findTransportBudgetEventByIdempotencyKey(
      ALLOCATION_KEY('INV-MISSING'),
    );
    expect(found).toBeNull();
    // Fail-closed: nothing was persisted and nothing was queued.
    expect(store.size()).toBe(0);
    expect(queue.ops).toHaveLength(0);
  });
});

describe('Phase 6C-C — deterministic reversal identity', () => {
  it('is stable for the same commercial reversal identity', () => {
    expect(VOID_REVERSAL_KEY('INV-1000')).toBe(
      VOID_REVERSAL_KEY('INV-1000'),
    );
    expect(VOID_REVERSAL_KEY('INV-1000')).toBe('REVERSAL:INV-1000:VOID');
  });

  it('is distinct for different commercial reversal identities', () => {
    expect(VOID_REVERSAL_KEY('INV-1000')).not.toBe(
      VOID_REVERSAL_KEY('INV-1001'),
    );
    // A POS mirror resolves to the mirror invoice id, never the sale id twice.
    expect(VOID_REVERSAL_KEY('SALE-7')).not.toBe(VOID_REVERSAL_KEY('POSINV-7'));
  });

  it('excludes the durable-sync operationId from the business key', () => {
    const operationId =
      (crypto.randomUUID && crypto.randomUUID()) || 'op-random-123';
    const key = VOID_REVERSAL_KEY('INV-1000');
    expect(key).not.toContain(operationId);
    // Deriving twice with a different sync operationId cannot change the key.
    expect(key).toBe(VOID_REVERSAL_KEY('INV-1000'));
  });

  it('the repository dedupes a replayed identical reversal idempotency key', async () => {
    const { store, repo } = setup([allocationEvent()]);
    const reversal = {
      id: 'evt-rev-void-1',
      kind: 'REVERSAL' as const,
      idempotencyKey: VOID_REVERSAL_KEY('INV-1000'),
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -15000,
      method: null,
      providerId: null,
      reversesEventId: 'evt-alloc-1000',
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T12:00:00.000Z',
    };
    const first = await repo.appendReversal(reversal);
    const retry = await repo.appendReversal({ ...reversal, id: 'evt-rev-void-2' });
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
    expect(store.size()).toBe(2); // allocation + exactly one reversal
  });
});

describe('Phase 6C-D — appendReversal reuses Phase 4 safeguards', () => {
  const reversal = (
    overrides: Partial<TransportBudgetEvent> = {},
  ): Partial<TransportBudgetEvent> =>
    ({
      id: 'evt-rev-void-1',
      kind: 'REVERSAL',
      idempotencyKey: VOID_REVERSAL_KEY('INV-1000'),
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -15000,
      method: null,
      providerId: null,
      reversesEventId: 'evt-alloc-1000',
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T12:00:00.000Z',
      ...overrides,
    }) as Partial<TransportBudgetEvent>;

  it('accepts a full reversal linked to the original allocation', async () => {
    const { repo } = setup([allocationEvent()]);
    const result = await repo.appendReversal(reversal() as never);
    expect(result.event.kind).toBe('REVERSAL');
    expect(result.event.reversesEventId).toBe('evt-alloc-1000');
    expect(result.event.amount).toBe(-15000);
  });

  it('reuses the target-existence control (TARGET_MISSING)', async () => {
    const { repo } = setup();
    await expect(repo.appendReversal(reversal() as never)).rejects.toMatchObject({
      name: 'TransportBudgetReversalError',
      code: 'TARGET_MISSING',
    });
  });

  it('reuses the SALES_ALLOCATION-only control (TARGET_NOT_REVERSIBLE)', async () => {
    const { repo } = setup([
      allocationEvent({
        id: 'evt-in-1',
        kind: 'INBOUND_CONSUMPTION',
        idempotencyKey: 'INBOUND_CONSUMPTION:SRC-1',
        sourceEventId: 'SRC-1',
        sourceAmount: null,
        allocationRatePercent: null,
        amount: -5000,
      }),
    ]);
    await expect(
      repo.appendReversal(
        reversal({
          reversesEventId: 'evt-in-1',
          idempotencyKey: VOID_REVERSAL_KEY('SRC-1'),
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_REVERSIBLE' });
  });

  it('reuses the cumulative cap control (CAP_EXCEEDED)', async () => {
    const { repo } = setup([allocationEvent()]);
    await expect(
      repo.appendReversal(reversal({ amount: -15001 }) as never),
    ).rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
  });

  it('rejects non-REVERSAL kinds passed to appendReversal', async () => {
    const { repo } = setup([allocationEvent()]);
    await expect(
      repo.appendReversal({
        ...(allocationEvent() as unknown as Record<string, unknown>),
      } as never),
    ).rejects.toBeInstanceOf(TransportBudgetReversalError);
  });
});
