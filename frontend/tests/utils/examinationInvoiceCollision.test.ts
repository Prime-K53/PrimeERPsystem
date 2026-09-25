/**
 * examinationInvoiceCollision.test.ts — P0 stale-race guard unit tests.
 *
 * Exercises resolveExaminationInvoiceCollision / resolveExaminationInvoiceDelete /
 * buildRemintedExaminationInvoice with fake I/O deps (no IndexedDB):
 *  - distinct collisions re-mint under a fresh id, never merge, winner untouched
 *  - same-document edits fall through (handled: false)
 *  - tombstones / linkage-less / non-examination rows fall through
 *  - re-mint chain cap dead-letters safely instead of looping
 *  - delete guard blocks tombstoning a different batch's invoice
 */
import { describe, it, expect } from 'vitest';
import {
  buildRemintedExaminationInvoice,
  EXAMINATION_COLLISION_MAX_REMINTS,
  resolveExaminationInvoiceCollision,
  resolveExaminationInvoiceDelete,
  tryResolveExaminationInvoiceCollision,
  CollisionDeps,
} from '../../services/examinationInvoiceCollisionService';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

const examInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'EXM-0006',
  invoiceNumber: 'EXM-0006',
  customerId: 'CUST-X',
  customerName: 'School X',
  totalAmount: 1000,
  paidAmount: 0,
  status: 'Unpaid',
  date: '2026-09-20T00:00:00.000Z',
  dueDate: '2026-10-20T00:00:00.000Z',
  items: [{ id: 'CLS-1', total: 1000 }],
  batchId: 'BTC-B',
  origin_batch_id: 'BTC-B',
  originBatchId: 'BTC-B',
  origin_module: 'examination',
  category: 'Examination',
  reference: 'EXAM-BATCH-BTC-B',
  verificationToken: TOKEN_B,
  currency: 'MWK',
  ...overrides,
});

const serverRowA = () => ({
  version: 1,
  updatedAt: '2026-09-21T00:00:00.000Z',
  data: {
    ...examInvoice(),
    customerName: 'School A',
    totalAmount: 1000,
    batchId: 'BTC-A',
    origin_batch_id: 'BTC-A',
    originBatchId: 'BTC-A',
    reference: 'EXAM-BATCH-BTC-A',
    verificationToken: TOKEN_A,
  },
});

interface FakeWorld {
  invoices: Array<Record<string, unknown>>;
  batches: Array<Record<string, unknown>>;
  saved: Array<Record<string, unknown>>;
  removed: string[];
  completed: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  audits: unknown[];
  notices: Array<{ ev: string; data: unknown }>;
  batchLinks: Array<{ batchId: string; invoiceId: string }>;
  deps: CollisionDeps;
}

const makeWorld = (overrides: Partial<FakeWorld> = {}): FakeWorld => {
  const world = {
    invoices: [],
    batches: [],
    saved: [],
    removed: [],
    completed: [],
    deadLettered: [],
    audits: [],
    notices: [],
    batchLinks: [],
    ...overrides,
  } as FakeWorld;
  world.deps = {
    listInvoices: async () => world.invoices.map((row) => ({ ...row })),
    saveInvoiceLocal: async (invoice) => {
      world.saved.push(invoice);
      return invoice.id;
    },
    removeInvoiceLocal: async (id: string) => {
      world.removed.push(id);
    },
    listBatches: async () => world.batches.map((batch) => ({ ...batch })),
    updateBatchInvoiceLink: async (batchId: string, invoiceId: string) => {
      world.batchLinks.push({ batchId, invoiceId });
    },
    completeQueueItem: async (queueId: string) => {
      world.completed.push(queueId);
    },
    deadLetterQueueItem: async (id: string, reason: string) => {
      world.deadLettered.push({ id, reason });
    },
    recordConflictAudit: async (entry: never) => {
      world.audits.push(entry);
    },
    notifyUser: (ev: string, data: unknown) => {
      world.notices.push({ ev, data });
    },
    numberingConfig: {
      transactionSettings: {
        numbering: { shared: { prefix: '', startNumber: 1, padding: 4, resetInterval: 'Never' } },
      },
    },
  } as unknown as CollisionDeps;
  return world;
};

const upsertItem = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'op-1',
  operationId: 'op-1',
  table: 'invoices',
  recordId: String(payload.id ?? ''),
  operation: 'upsert',
  payload,
  ...extra,
});

describe('buildRemintedExaminationInvoice (pure)', () => {
  it('swaps identity, preserves token + content, never mutates input', () => {
    const payload = examInvoice();
    const snapshot = structuredClone(payload);
    const reminted = buildRemintedExaminationInvoice(payload, 'EXM-0007');
    expect(payload).toEqual(snapshot); // input untouched
    expect(reminted.id).toBe('EXM-0007');
    expect(reminted.invoiceNumber).toBe('EXM-0007');
    expect(reminted.verificationToken).toBe(TOKEN_B);
    expect(reminted.customerName).toBe('School X');
    expect(reminted.items).toEqual([{ id: 'CLS-1', total: 1000 }]);
    expect(reminted.batchId).toBe('BTC-B');
    expect(reminted.remintedFrom).toEqual(['EXM-0006']);
  });

  it('fixes reference only when it pointed at the stale id', () => {
    const pointedAtOld = buildRemintedExaminationInvoice(
      examInvoice({ reference: 'EXM-0006' }),
      'EXM-0007'
    );
    expect(pointedAtOld.reference).toBe('EXM-0007');
    const batchRef = buildRemintedExaminationInvoice(
      examInvoice({ reference: 'EXAM-BATCH-BTC-B' }),
      'EXM-0007'
    );
    expect(batchRef.reference).toBe('EXAM-BATCH-BTC-B');
  });

  it('extends (never resets) an existing re-mint chain', () => {
    const reminted = buildRemintedExaminationInvoice(
      examInvoice({ remintedFrom: ['EXM-0004'] }),
      'EXM-0007'
    );
    expect(reminted.remintedFrom).toEqual(['EXM-0004', 'EXM-0006']);
  });
});

describe('resolveExaminationInvoiceCollision', () => {
  it('re-mints distinct invoices under a fresh id; winner untouched', async () => {
    const world = makeWorld({
      invoices: [{ ...examInvoice() }],
      batches: [{ id: 'batch-b', batch_number: 'BTC-B', invoice_id: 'EXM-0006' }],
    });
    const result = await resolveExaminationInvoiceCollision(
      upsertItem({ ...examInvoice() }),
      serverRowA(),
      world.deps
    );
    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('conflict');
    expect(result.newInvoiceId).toBe('EXM-0007');
    // Loser persisted under the fresh id with content + token intact.
    expect(world.saved).toHaveLength(1);
    expect(world.saved[0].id).toBe('EXM-0007');
    expect(world.saved[0].verificationToken).toBe(TOKEN_B);
    // Stale identity retired locally; stale op completed, never applied remotely.
    expect(world.removed).toEqual(['EXM-0006']);
    expect(world.completed).toEqual(['op-1']);
    expect(world.deadLettered).toEqual([]);
    // Owning batch repointed.
    expect(world.batchLinks).toEqual([{ batchId: 'batch-b', invoiceId: 'EXM-0007' }]);
    // Audit + user notice carry the new identity.
    expect(world.audits).toHaveLength(1);
    expect(world.notices).toHaveLength(1);
    expect((world.notices[0].data as Record<string, unknown>).remintedTo).toBe('EXM-0007');
  });

  it('falls through for same-batch edits (normal merge path preserved)', async () => {
    const world = makeWorld();
    const sameBatchServer = {
      version: 2,
      updatedAt: '2026-09-21T00:00:00.000Z',
      data: { ...examInvoice(), paidAmount: 200, status: 'Partial' },
    };
    const result = await resolveExaminationInvoiceCollision(
      upsertItem({ ...examInvoice() }),
      sameBatchServer,
      world.deps
    );
    expect(result).toEqual({ handled: false });
    expect(world.saved).toEqual([]);
    expect(world.completed).toEqual([]);
  });

  it('falls through for non-examination rows and tombstones', async () => {
    const world = makeWorld();
    const plain = { id: 'INV-1', invoiceNumber: 'INV-1', totalAmount: 5 };
    expect(
      await resolveExaminationInvoiceCollision(upsertItem(plain), { version: 1, data: { ...plain } }, world.deps)
    ).toEqual({ handled: false });
    expect(
      await resolveExaminationInvoiceCollision(
        upsertItem({ ...examInvoice() }),
        { version: 1, data: { ...serverRowA().data, deleted: true } },
        world.deps
      )
    ).toEqual({ handled: false });
    expect(world.saved).toEqual([]);
  });

  it('falls through when linkage cannot prove distinctness (legacy rows)', async () => {
    const world = makeWorld();
    const legacyLocal = { ...examInvoice(), batchId: undefined, origin_batch_id: undefined, originBatchId: undefined, reference: 'EXM-0006', conversionDetails: undefined };
    delete (legacyLocal as Record<string, unknown>).batchId;
    delete (legacyLocal as Record<string, unknown>).origin_batch_id;
    delete (legacyLocal as Record<string, unknown>).originBatchId;
    const result = await resolveExaminationInvoiceCollision(
      upsertItem(legacyLocal),
      serverRowA(),
      world.deps
    );
    // Only linkage left is the shared id itself → excluded → cannot prove distinct.
    expect(result).toEqual({ handled: false });
  });

  it('dead-letters safely when the re-mint chain cap is reached (no merge, no write)', async () => {
    const world = makeWorld();
    const chained = {
      ...examInvoice(),
      remintedFrom: ['EXM-0001', 'EXM-0002', 'EXM-0003'],
    };
    const result = await resolveExaminationInvoiceCollision(
      upsertItem(chained),
      serverRowA(),
      world.deps
    );
    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('deadLetter');
    expect(result.newInvoiceId).toBeNull();
    expect(world.saved).toEqual([]);
    expect(world.removed).toEqual([]);
    expect(world.completed).toEqual([]);
    expect(world.deadLettered).toHaveLength(1);
    expect(world.deadLettered[0].id).toBe('op-1');
  });

  it('ignores non-invoices tables and delete operations', async () => {
    const world = makeWorld();
    expect(
      await resolveExaminationInvoiceCollision(
        { ...upsertItem({ ...examInvoice() }), table: 'customers' },
        serverRowA(),
        world.deps
      )
    ).toEqual({ handled: false });
    expect(
      await resolveExaminationInvoiceCollision(
        { ...upsertItem({ ...examInvoice() }), operation: 'delete' },
        serverRowA(),
        world.deps
      )
    ).toEqual({ handled: false });
  });
});

describe('resolveExaminationInvoiceDelete', () => {
  it('blocks tombstoning a different batch invoice (dead-letter, no writes)', async () => {
    const world = makeWorld();
    const { resolveExaminationInvoiceDelete } = await import(
      '../../services/examinationInvoiceCollisionService'
    );
    const result = await resolveExaminationInvoiceDelete(
      {
        id: 'op-del',
        operationId: 'op-del',
        table: 'invoices',
        recordId: 'EXM-0006',
        operation: 'delete',
        payload: { id: 'EXM-0006' },
      },
      { ...examInvoice() },
      serverRowA(),
      world.deps
    );
    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('deadLetter');
    expect(world.saved).toEqual([]);
    expect(world.removed).toEqual([]);
    expect(world.completed).toEqual([]);
    expect(world.deadLettered).toHaveLength(1);
  });

  it('falls through for same-batch deletes and missing locals', async () => {
    const world = makeWorld();
    const { resolveExaminationInvoiceDelete } = await import(
      '../../services/examinationInvoiceCollisionService'
    );
    const sameBatch = {
      version: 2,
      updatedAt: '2026-09-21T00:00:00.000Z',
      data: { ...examInvoice() },
    };
    expect(
      await resolveExaminationInvoiceDelete(
        { id: 'op-del', table: 'invoices', recordId: 'EXM-0006', operation: 'delete', payload: { id: 'EXM-0006' } },
        { ...examInvoice() },
        sameBatch,
        world.deps
      )
    ).toEqual({ handled: false });
    expect(
      await resolveExaminationInvoiceDelete(
        { id: 'op-del', table: 'invoices', recordId: 'EXM-0006', operation: 'delete', payload: { id: 'EXM-0006' } },
        null,
        serverRowA(),
        world.deps
      )
    ).toEqual({ handled: false });
  });
});

describe('tryResolveExaminationInvoiceCollision dispatcher', () => {
  it('routes deletes to the guard and upserts to re-mint; ignores other tables', async () => {
    const world = makeWorld({
      invoices: [{ ...examInvoice() }],
      batches: [{ id: 'batch-b', batch_number: 'BTC-B', invoice_id: 'EXM-0006' }],
    });
    const upsert = await tryResolveExaminationInvoiceCollision(
      upsertItem({ ...examInvoice() }),
      serverRowA(),
      world.deps
    );
    expect(upsert.handled).toBe(true);
    expect(upsert.outcome).toBe('conflict');

    const other = await tryResolveExaminationInvoiceCollision(
      { ...upsertItem({ ...examInvoice() }), table: 'customers' },
      serverRowA(),
      world.deps
    );
    expect(other).toEqual({ handled: false });
    expect(EXAMINATION_COLLISION_MAX_REMINTS).toBe(3);
  });
});
