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
  TransportBudgetCorrectionError,
  TransportBudgetDuplicateIdError,
} from '../../services/repositories/transportBudgetRepository';
import {
  validateTransportBudgetEvent,
  sameEconomicPayload,
} from '../../services/transportBudgetValidator';

// ---------------------------------------------------------------------------
// Fakes (hermetic local persistence + sync queue, no IndexedDB involved)
// ---------------------------------------------------------------------------

const createStore = (seed: Record<string, unknown>[] = []) => {
  const rows = new Map<string, Record<string, unknown>>(
    seed.map((entry) => [String((entry as { id: string }).id), { ...entry }]),
  );
  return {
    async get(id: string) {
      const found = rows.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
    async put(event: Record<string, unknown>) {
      rows.set(String((event as { id: string }).id), { ...event });
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
    clear() {
      ops.length = 0;
    },
  };
};

// A posted INBOUND_CONSUMPTION with full Phase 7E snapshots. The Landing
// scope is LC-101:GRN-5001; the full consumable (20000) was embedded.
const parentInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-in-001',
  kind: 'INBOUND_CONSUMPTION' as const,
  idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001',
  sourceEventId: 'LC-101:GRN-5001',
  sourceAmount: 20000,
  allocationRatePercent: null,
  amount: -20000,
  method: 'LANDING_COST_FREIGHT',
  providerId: 'SUP-1',
  reversesEventId: null,
  correctsEventId: null,
  businessDate: '2026-08-15',
  occurredAt: '2026-08-15T10:00:00.000Z',
  ...overrides,
});

// Frozen Phase 7D-2 correction shape: positive delta, duplicate-field rule
// (sourceEventId = correctsEventId = original id), posting-date businessDate.
const correctionInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-corr-001',
  kind: 'CONSUMPTION_CORRECTION' as const,
  idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-001',
  sourceEventId: 'evt-in-001',
  sourceAmount: 20000,
  allocationRatePercent: null,
  amount: 2000,
  method: 'LANDING_COST_FREIGHT',
  providerId: 'SUP-1',
  reversesEventId: null,
  correctsEventId: 'evt-in-001',
  businessDate: '2026-10-02',
  occurredAt: '2026-10-02T09:00:00.000Z',
  ...overrides,
});

const setup = (seed: Record<string, unknown>[] = []) => {
  const store = createStore(seed);
  const queue = createQueue();
  const repo = new TransportBudgetRepository(store as never, queue as never);
  return { store, queue, repo };
};

const setupWithParent = async (
  parentOverrides: Record<string, unknown> = {},
) => {
  const { store, queue, repo } = setup();
  const appended = await repo.appendTransportBudgetEvent(
    parentInput(parentOverrides) as never,
  );
  return { store, queue, repo, parent: appended.event };
};

const NOW = '2026-10-02T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §19 event shape (1–10)
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — event shape', () => {
  it('1. accepts a correction with valid shape', () => {
    const result = validateTransportBudgetEvent(correctionInput(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.kind).toBe('CONSUMPTION_CORRECTION');
      expect(result.event.amount).toBe(2000);
      expect(result.event.correctsEventId).toBe('evt-in-001');
      expect(result.event.sourceEventId).toBe('evt-in-001');
    }
  });

  it('2. rejects a correction with zero amount', () => {
    expect(
      validateTransportBudgetEvent({ ...correctionInput(), amount: 0 }, NOW)
        .ok,
    ).toBe(false);
  });

  it('3. rejects a correction with negative amount', () => {
    expect(
      validateTransportBudgetEvent({ ...correctionInput(), amount: -2000 }, NOW)
        .ok,
    ).toBe(false);
  });

  it('4. rejects a correction without correctsEventId', () => {
    const result = validateTransportBudgetEvent(
      { ...correctionInput(), correctsEventId: null },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'MISSING_CORRECTION_LINK'),
      ).toBe(true);
    }
  });

  it('5. rejects a correction without sourceEventId', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), sourceEventId: null },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('6. rejects a correction when sourceEventId != correctsEventId', () => {
    const result = validateTransportBudgetEvent(
      { ...correctionInput(), sourceEventId: 'evt-in-999' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) =>
            i.code === 'MISSING_CORRECTION_LINK' &&
            i.field === 'sourceEventId',
        ),
      ).toBe(true);
    }
  });

  it('7. rejects a correction carrying reversesEventId', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), reversesEventId: 'evt-in-001' },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('8. rejects a correction with null provider', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), providerId: null },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('9. rejects a correction with null method', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), method: null },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('10. rejects a correction with null sourceAmount', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), sourceAmount: null },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects a correction with a non-freight method', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), method: 'OUTBOUND_TRANSPORT' },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects a correction carrying allocationRatePercent', () => {
    expect(
      validateTransportBudgetEvent(
        { ...correctionInput(), allocationRatePercent: 3 },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects correctsEventId on every other kind', () => {    for (const base of [
      { ...parentInput(), kind: 'SALES_ALLOCATION' as const },
      { ...parentInput(), kind: 'REVERSAL' as const },
      parentInput(),
    ]) {
      expect(
        validateTransportBudgetEvent(
          { ...base, correctsEventId: 'evt-in-001' },
          NOW,
        ).ok,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §19 target linkage (11–17) — repository level
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — target linkage', () => {
  it('11. appends a correction targeting a valid INBOUND event', async () => {
    const { repo } = await setupWithParent();
    const result = await repo.appendCorrection(correctionInput() as never);
    expect(result.deduplicated).toBe(false);
    expect(result.event.kind).toBe('CONSUMPTION_CORRECTION');
    expect(result.event.amount).toBe(2000);
  });

  it('12. rejects a correction targeting SALES_ALLOCATION', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent({
      id: 'evt-alloc-001',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:INV-0001',
      sourceEventId: 'INV-0001',
      sourceAmount: 500000,
      allocationRatePercent: 3,
      amount: 15000,
      method: null,
      providerId: null,
      reversesEventId: null,
      correctsEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);
    await expect(
      repo.appendCorrection(
        correctionInput({
          sourceEventId: 'evt-alloc-001',
          correctsEventId: 'evt-alloc-001',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_CORRECTIBLE' });
  });

  it('13. rejects a correction targeting REVERSAL', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent({
      id: 'evt-alloc-001',
      kind: 'SALES_ALLOCATION',
      idempotencyKey: 'SALES_ALLOCATION:INV-0001',
      sourceEventId: 'INV-0001',
      sourceAmount: 500000,
      allocationRatePercent: 3,
      amount: 15000,
      method: null,
      providerId: null,
      reversesEventId: null,
      correctsEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T10:00:00.000Z',
    } as never);
    await repo.appendTransportBudgetEvent({
      id: 'evt-rev-001',
      kind: 'REVERSAL',
      idempotencyKey: 'REVERSAL:evt-alloc-001:1',
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -15000,
      method: null,
      providerId: null,
      reversesEventId: 'evt-alloc-001',
      correctsEventId: null,
      businessDate: '2026-09-30',
      occurredAt: '2026-09-30T12:00:00.000Z',
    } as never);
    await expect(
      repo.appendCorrection(
        correctionInput({
          sourceEventId: 'evt-rev-001',
          correctsEventId: 'evt-rev-001',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_CORRECTIBLE' });
  });

  it('14. rejects a correction targeting CONSUMPTION_CORRECTION (no chains)', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(correctionInput() as never);
    await expect(
      repo.appendCorrection(
        correctionInput({
          id: 'evt-corr-002',
          idempotencyKey: 'CONSUMPTION_CORRECTION:evt-corr-001',
          sourceEventId: 'evt-corr-001',
          correctsEventId: 'evt-corr-001',
          amount: 500,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_CORRECTIBLE' });
  });

  it('15. rejects a correction targeting an OUTBOUND event', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(
      parentInput({
        id: 'evt-out-001',
        kind: 'OUTBOUND_CONSUMPTION',
        idempotencyKey: 'OUTBOUND:DLV-1',
        sourceEventId: 'DLV-1',
        sourceAmount: 3000,
        amount: -3000,
      }) as never,
    );
    await expect(
      repo.appendCorrection(
        correctionInput({
          sourceEventId: 'evt-out-001',
          correctsEventId: 'evt-out-001',
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_CORRECTIBLE' });
  });

  it('16. rejects a correction with a missing target', async () => {
    const { repo } = setup();
    await expect(
      repo.appendCorrection(correctionInput() as never),
    ).rejects.toMatchObject({ code: 'TARGET_MISSING' });
  });

  it('17. rejects a correction that targets itself', () => {
    expect(
      validateTransportBudgetEvent(
        {
          ...correctionInput(),
          id: 'evt-same',
          sourceEventId: 'evt-same',
          correctsEventId: 'evt-same',
        },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('appendCorrection rejects non-correction kinds', async () => {
    const { repo } = setup();
    await expect(
      repo.appendCorrection(parentInput() as never),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_CORRECTIBLE' });
  });
});

// ---------------------------------------------------------------------------
// §19 amount + single-correction (18–22)
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — amount and cardinality', () => {
  it('18. accepts a partial correction (+2,000 on -20,000)', async () => {
    const { repo } = await setupWithParent();
    const result = await repo.appendCorrection(correctionInput() as never);
    expect(result.event.amount).toBe(2000);
    // Net consumption is -18,000.
    const events = await repo.listTransportBudgetEvents();
    const net = events.reduce((sum, e) => sum + Number(e.amount), 0);
    expect(net).toBe(-18000);
  });

  it('19. accepts an exact full correction (+20,000 on -20,000, net 0)', async () => {
    const { repo } = await setupWithParent();
    const result = await repo.appendCorrection(
      correctionInput({ amount: 20000 }) as never,
    );
    expect(result.event.amount).toBe(20000);
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
  });

  it('20. rejects a correction greater than the original (+20,001)', async () => {
    const { repo } = await setupWithParent();
    await expect(
      repo.appendCorrection(correctionInput({ amount: 20001 }) as never),
    ).rejects.toMatchObject({ code: 'CORRECTION_CAP_EXCEEDED' });
  });

  it('21. rejects a correction that would deepen consumption', async () => {
    // Negative deltas are not corrections at all (validator sign rule).
    expect(
      validateTransportBudgetEvent({ ...correctionInput(), amount: -1 }, NOW)
        .ok,
    ).toBe(false);
  });

  it('22. rejects a second correction against the same original', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(correctionInput() as never);
    await expect(
      repo.appendCorrection(
        correctionInput({
          id: 'evt-corr-002',
          idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-001:2',
          amount: 500,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_CORRECTED' });
    // Exactly one correction row exists.
    const total = await repo.getCorrectionTotal('evt-in-001');
    expect(total).toEqual({ total: 2000, count: 1 });
  });
});

// ---------------------------------------------------------------------------
// §19 idempotency (23–26)
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — idempotency', () => {
  it('23. same ID + same economics dedupes', async () => {
    const { repo } = await setupWithParent();
    const first = await repo.appendCorrection(correctionInput() as never);
    const retry = await repo.appendCorrection(correctionInput() as never);
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
  });

  it('24. same ID + changed economics rejects', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(correctionInput() as never);
    await expect(
      repo.appendCorrection(
        correctionInput({ amount: 3000 }) as never,
      ),
    ).rejects.toBeInstanceOf(TransportBudgetDuplicateIdError);
  });

  it('25. different ID + same correction key resolves existing', async () => {
    const { repo } = await setupWithParent();
    const first = await repo.appendCorrection(correctionInput() as never);
    const retry = await repo.appendCorrection(
      correctionInput({ id: 'evt-corr-other' }) as never,
    );
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
  });

  it('26. concurrent same-key attempts converge to one row', async () => {
    const { repo } = await setupWithParent();
    const [a, b] = await Promise.all([
      repo.appendCorrection(correctionInput() as never),
      repo.appendCorrection(
        correctionInput({ id: 'evt-corr-race' }) as never,
      ),
    ]);
    expect(a.event.id).toBe(b.event.id);
    const total = await repo.getCorrectionTotal('evt-in-001');
    expect(total.count).toBe(1);
  });

  it('sameEconomicPayload distinguishes correction retries from conflicts', () => {
    const a = correctionInput();
    const b = { ...correctionInput(), createdAt: '2026-10-03T00:00:00Z' };
    expect(sameEconomicPayload(a as never, b as never)).toBe(true);
    expect(
      sameEconomicPayload(
        a as never,
        { ...correctionInput(), correctsEventId: 'evt-in-999' } as never,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §19 source cap (27–31)
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — source cap', () => {
  it('27. accepts inbound at the source cap', async () => {
    const { repo } = setup();
    const result = await repo.appendTransportBudgetEvent(
      parentInput() as never,
    );
    expect(result.deduplicated).toBe(false);
  });

  it('28. rejects inbound above the source cap', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(parentInput() as never);
    await expect(
      repo.appendTransportBudgetEvent(
        parentInput({
          id: 'evt-in-002',
          idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001:2',
          amount: -5000,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CAP_EXCEEDED' });
  });

  it('29. a correction releases source capacity for a later inbound', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(
      correctionInput({ amount: 20000 }) as never,
    );
    // Net is 0; a fresh -5,000 for the same scope fits the 20,000 cap.
    const result = await repo.appendTransportBudgetEvent(
      parentInput({
        id: 'evt-in-002',
        idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001:2',
        amount: -5000,
      }) as never,
    );
    expect(result.deduplicated).toBe(false);
  });

  it('30. a correction cannot be used to bypass the source cap', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(correctionInput() as never); // +2,000
    // Net is 18,000 of a 20,000 cap: only 2,000 remains.
    await expect(
      repo.appendTransportBudgetEvent(
        parentInput({
          id: 'evt-in-002',
          idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001:2',
          amount: -5000,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CAP_EXCEEDED' });
    const ok = await repo.appendTransportBudgetEvent(
      parentInput({
        id: 'evt-in-003',
        idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001:3',
        amount: -2000,
      }) as never,
    );
    expect(ok.deduplicated).toBe(false);
  });

  it('31. concurrent source operations remain serialized (one winner)', async () => {
    const { repo } = setup();
    const first = parentInput();
    const second = parentInput({
      id: 'evt-in-002',
      idempotencyKey: 'INBOUND_CONSUMPTION:LC-101:GRN-5001:2',
      amount: -5000,
    });
    const outcomes = await Promise.allSettled([
      repo.appendTransportBudgetEvent(first as never),
      repo.appendTransportBudgetEvent(second as never),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // -20,000 fills the 20,000 cap, so the -5,000 must lose (order varies).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('snapshot-less legacy inbound rows bypass the cap check unchanged', async () => {
    const { repo } = setup();
    const legacy = parentInput({
      id: 'evt-legacy-001',
      idempotencyKey: 'INBOUND:LEGACY-1',
      sourceEventId: null,
      sourceAmount: null,
      method: null,
      providerId: null,
    });
    const result = await repo.appendTransportBudgetEvent(legacy as never);
    expect(result.deduplicated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §19 dates (32–34)
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — business dates', () => {
  it('32. correction uses the posting businessDate', async () => {
    const { repo } = await setupWithParent();
    const result = await repo.appendCorrection(correctionInput() as never);
    expect(result.event.businessDate).toBe('2026-10-02');
  });

  it('33. correction occurredAt is the posting timestamp', async () => {
    const { repo } = await setupWithParent();
    const result = await repo.appendCorrection(correctionInput() as never);
    expect(result.event.occurredAt).toBe('2026-10-02T09:00:00.000Z');
  });

  it('34. original inbound businessDate remains unchanged', async () => {
    const { repo } = await setupWithParent();
    await repo.appendCorrection(correctionInput() as never);
    const parent = await repo.getTransportBudgetEvent('evt-in-001');
    expect(parent?.businessDate).toBe('2026-08-15');
  });

  it('rejects a correction backdated before the original period', async () => {
    const { repo } = await setupWithParent();
    await expect(
      repo.appendCorrection(
        correctionInput({ businessDate: '2026-08-14' }) as never,
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
  });
});

// ---------------------------------------------------------------------------
// Phase 7G-1 — partial-scope source snapshot (locked amendment):
// correction.sourceAmount copies the parent inbound sourceAmount
// (capitalizable ceiling), NOT abs(parent amount).
// ---------------------------------------------------------------------------

describe('transportBudgetCorrection — partial-scope snapshot (7G-1)', () => {
  const partialParent = (overrides: Record<string, unknown> = {}) =>
    parentInput({
      id: 'evt-in-P1',
      idempotencyKey: 'INBOUND_CONSUMPTION:LC-P1:GRN-P1',
      sourceEventId: 'LC-P1:GRN-P1',
      sourceAmount: 100000,
      amount: -30000,
      ...overrides,
    });

  const partialCorrection = (overrides: Record<string, unknown> = {}) =>
    correctionInput({
      id: 'evt-corr-P1',
      idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-P1',
      sourceEventId: 'evt-in-P1',
      sourceAmount: 100000,
      amount: 30000,
      correctsEventId: 'evt-in-P1',
      ...overrides,
    });

  it('accepts a correction carrying the parent source snapshot (100000)', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(partialParent() as never);
    const result = await repo.appendCorrection(partialCorrection() as never);
    expect(result.deduplicated).toBe(false);
    expect(result.event).toMatchObject({
      kind: 'CONSUMPTION_CORRECTION',
      amount: 30000,
      sourceAmount: 100000,
      sourceEventId: 'evt-in-P1',
      correctsEventId: 'evt-in-P1',
    });
    // Net consumption is zero.
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
  });

  it('rejects a correction carrying abs(amount) instead of the snapshot (30000)', async () => {
    // Shape-only validator still passes (equality is contextual to the
    // target); the repository rejects with the locked snapshot rule.
    expect(
      validateTransportBudgetEvent(
        partialCorrection({ sourceAmount: 30000 }) as never,
        NOW,
      ).ok,
    ).toBe(true);
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(partialParent() as never);
    await expect(
      repo.appendCorrection(
        partialCorrection({ sourceAmount: 30000 }) as never,
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
  });

  it('retains the amount cap under the new snapshot rule (+30001 rejected)', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(partialParent() as never);
    await expect(
      repo.appendCorrection(
        partialCorrection({ amount: 30001 }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CORRECTION_CAP_EXCEEDED' });
  });

  it('cap arithmetic unchanged: correction snapshot does not inflate the ceiling', async () => {
    const { repo } = setup();
    await repo.appendTransportBudgetEvent(partialParent() as never);
    await repo.appendCorrection(partialCorrection() as never);
    // Net is zero against a 100000 ceiling; a further 80000 fits.
    const second = await repo.appendTransportBudgetEvent(
      partialParent({
        id: 'evt-in-P2',
        idempotencyKey: 'INBOUND_CONSUMPTION:LC-P1:GRN-P1:2',
        amount: -80000,
      }) as never,
    );
    expect(second.deduplicated).toBe(false);
    // Net would be 110000 > 100000: rejected. The correction row's own
    // sourceAmount (100000) contributed nothing to the ceiling — the cap
    // reads INBOUND rows only.
    await expect(
      repo.appendTransportBudgetEvent(
        partialParent({
          id: 'evt-in-P3',
          idempotencyKey: 'INBOUND_CONSUMPTION:LC-P1:GRN-P1:3',
          amount: -30000,
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CAP_EXCEEDED' });
    const events = await repo.listTransportBudgetEvents();
    expect(events.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(-80000);
  });
});
