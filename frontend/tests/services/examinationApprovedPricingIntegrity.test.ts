/**
 * examinationApprovedPricingIntegrity.test.ts
 *
 * Client-side half of the Examination integrity repair: the invoice must be
 * derived from the APPROVED SNAPSHOT rather than from live class rows, the
 * status ladder must not be drivable backwards through the generic
 * updateBatch() entry point, and a void must not credit stock for Service
 * lines that never had stock deducted.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { examinationBatchService } from '../../services/examinationBatchService';
import { enrichInvoiceWithBatchPricing } from '../../utils/examinationInvoicePricing';

type StoreRecord = Map<string, any>;
const stores = new Map<string, StoreRecord>();
const getStore = (name: string) => {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
};
const offlineBatchStore = new Map<string, any>();
const enqueuedOps: any[] = [];

vi.mock('../../services/db', async () => ({
  dbService: {
    getAll: vi.fn(async (storeName: string) => Array.from(getStore(storeName).values())),
    get: vi.fn(async (storeName: string, id: string) => getStore(storeName).get(String(id))),
    put: vi.fn(async (storeName: string, item: any) => {
      getStore(storeName).set(String(item.id), item);
      return String(item.id);
    }),
    delete: vi.fn(async (storeName: string, id: string) => {
      getStore(storeName).delete(String(id));
    }),
    executeAtomicOperation: vi.fn(async (_stores: string[], operation: (tx: any) => Promise<any>) => {
      const tx = {
        objectStore: (storeName: string) => ({
          get: async (id: string) => getStore(storeName).get(String(id)),
          getAll: async () => Array.from(getStore(storeName).values()),
          put: async (item: any) => {
            getStore(storeName).set(String(item.id), item);
            return String(item.id);
          },
        }),
        done: Promise.resolve(),
      };
      return operation(tx);
    }),
    getSetting: vi.fn(async (key: string) => getStore('settings').get(String(key))),
    saveSetting: vi.fn(async (key: string, value: any) => {
      getStore('settings').set(String(key), value);
    }),
  },
}));

vi.mock('../../services/examinationDb', () => ({
  examinationDb: {
    examinationBatches: {
      toArray: vi.fn(async () => Array.from(offlineBatchStore.values())),
      get: vi.fn(async (id: string) => offlineBatchStore.get(String(id))),
      put: vi.fn(async (batch: any) => {
        offlineBatchStore.set(String(batch.id), batch);
        return String(batch.id);
      }),
      bulkPut: vi.fn(async (batches: any[]) => {
        batches.forEach((b) => offlineBatchStore.set(String(b.id), b));
      }),
      delete: vi.fn(async (id: string) => {
        offlineBatchStore.delete(String(id));
      }),
    },
  },
}));

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    enqueue: vi.fn(async (input: any) => {
      enqueuedOps.push(input);
      return { ...input };
    }),
    getAll: vi.fn(async () => []),
  },
}));

vi.mock('../../services/backgroundSyncService', () => ({
  backgroundSyncService: { trigger: vi.fn(async () => null) },
}));

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/notificationService', () => ({
  notificationService: { notify: vi.fn() },
}));

const seedPricing = async () => {
  const { dbService } = await import('../../services/db');
  await dbService.saveSetting('examinationPricingSettings', {
    paper_item_id: 'paper-1',
    paper_unit_cost: 10,
    toner_item_id: 'toner-1',
    toner_unit_cost: 85000,
    conversion_rate: 500,
    constants: { toner_pages_per_unit: 20000 },
    profit_margin: 0,
    active_adjustments: [],
  });
  getStore('schools').set('SCH-1', { id: 'SCH-1', name: 'Test School' });
};

const buildApprovedBatch = async () => {
  const batch = await examinationBatchService.createBatch({
    school_id: 'SCH-1',
    academic_year: '2026',
    name: 'Integrity Batch',
  } as any);
  const cls = await examinationBatchService.addClass(batch.id, {
    class_name: 'Form 1',
    number_of_learners: 80,
  } as any);
  await examinationBatchService.addSubject(cls.id, {
    subject_name: 'Mathematics',
    pages: 12,
    extra_copies: 3,
  } as any);
  await examinationBatchService.calculateBatch(batch.id);
  await examinationBatchService.approveBatch(batch.id);
  return examinationBatchService.getBatch(batch.id) as any;
};

describe('approved pricing is immutable at invoice time', () => {
  beforeEach(async () => {
    stores.clear();
    offlineBatchStore.clear();
    enqueuedOps.length = 0;
    await seedPricing();
  });

  it('invoices the approved snapshot total, not a mutated live class row', async () => {
    const batch = await buildApprovedBatch();
    const approvedTotal = batch.pricing_snapshot.result.totalAmount;
    expect(approvedTotal).toBeGreaterThan(0);

    // Simulate a drifted device (or a stale one that never saw approval) whose
    // live class row now carries a different preview total.
    const drifted = { ...batch };
    drifted.classes = batch.classes.map((c: any) => ({ ...c, live_total_preview: 999_999 }));
    offlineBatchStore.set(String(batch.id), drifted);
    getStore('examinationBatches').set(String(batch.id), drifted);

    const result = await examinationBatchService.generateInvoice(batch.id, {
      invoiceNumber: 'EXM-TEST/001',
      idempotencyKey: 'test-key',
    });

    expect(result.invoice!.totalAmount).toBe(approvedTotal);
    expect(result.invoice!.items[0].total).not.toBe(999_999);
  });

  it('invoices the snapshot fee per learner rather than the live fee', async () => {
    const batch = await buildApprovedBatch();
    const frozenFee = batch.pricing_snapshot.result.classes[0].finalFee;
    const frozenLearners = batch.pricing_snapshot.result.classes[0].learners;

    const drifted = {
      ...batch,
      classes: batch.classes.map((c: any) => ({
        ...c,
        final_fee_per_learner: 4242,
        live_total_preview: 4242 * 80,
      })),
    };
    offlineBatchStore.set(String(batch.id), drifted);
    getStore('examinationBatches').set(String(batch.id), drifted);

    const result = await examinationBatchService.generateInvoice(batch.id, {
      invoiceNumber: 'EXM-TEST/002',
      idempotencyKey: 'test-key-2',
    });

    expect(result.invoice!.items[0].price).toBe(frozenFee);
    expect(result.invoice!.items[0].quantity).toBe(frozenLearners);
  });

  it('carries the snapshot material and adjustment totals', async () => {
    const batch = await buildApprovedBatch();
    const result = await examinationBatchService.generateInvoice(batch.id, {
      invoiceNumber: 'EXM-TEST/003',
      idempotencyKey: 'test-key-3',
    });

    expect(result.invoice!.materialTotal).toBe(batch.pricing_snapshot.result.materialTotal);
    expect(result.invoice!.adjustmentTotal).toBe(batch.pricing_snapshot.result.adjustmentTotal);
  });

  it('refuses to invoice when an approved class is missing rather than under-billing', async () => {
    const batch = await buildApprovedBatch();
    const stripped = { ...batch, classes: [] };
    offlineBatchStore.set(String(batch.id), stripped);
    getStore('examinationBatches').set(String(batch.id), stripped);

    await expect(
      examinationBatchService.generateInvoice(batch.id, {
        invoiceNumber: 'EXM-TEST/004',
        idempotencyKey: 'test-key-4',
      })
    ).rejects.toThrow(/approved class\(es\) are missing/i);
  });

  it('regenerates from the same snapshot without repricing', async () => {
    const batch = await buildApprovedBatch();
    const approvedTotal = batch.pricing_snapshot.result.totalAmount;

    await examinationBatchService.generateInvoice(batch.id, {
      invoiceNumber: 'EXM-TEST/005',
      idempotencyKey: 'test-key-5',
    });

    const regenerated = await examinationBatchService.regenerateInvoice(batch.id, {
      invoiceNumber: 'EXM-TEST/006',
      idempotencyKey: 'test-key-6',
      reason: 'reprint',
    });

    expect(regenerated.invoice!.totalAmount).toBe(approvedTotal);
  });
});

describe('batch status ladder cannot be driven through updateBatch', () => {
  beforeEach(async () => {
    stores.clear();
    offlineBatchStore.clear();
    enqueuedOps.length = 0;
    await seedPricing();
  });

  it('rejects a backwards transition out of a frozen status', async () => {
    const batch = await buildApprovedBatch();

    await expect(
      examinationBatchService.updateBatch(batch.id, { status: 'Calculated' } as any)
    ).rejects.toThrow(/invalid transition/i);
  });

  it('rejects skipping straight from draft to invoiced', async () => {
    const batch: any = await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Ladder Batch',
    } as any);

    await expect(
      examinationBatchService.updateBatch(batch.id, { status: 'Invoiced' } as any)
    ).rejects.toThrow(/invalid transition/i);
  });

  it('rejects an unknown status outright', async () => {
    const batch: any = await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Unknown Status Batch',
    } as any);

    await expect(
      examinationBatchService.updateBatch(batch.id, { status: 'Banana' } as any)
    ).rejects.toThrow(/unknown examination batch status/i);
  });

  it('still allows a non-status field update on a frozen batch', async () => {
    const batch = await buildApprovedBatch();
    const updated: any = await examinationBatchService.updateBatch(batch.id, {
      notes: 'Reviewed by accountant',
    } as any);
    expect(updated.notes).toBe('Reviewed by accountant');
    expect(updated.status).toBe('Approved');
  });

  it('treats a same-status write as a no-op rather than a transition', async () => {
    const batch = await buildApprovedBatch();
    const updated: any = await examinationBatchService.updateBatch(batch.id, {
      status: 'Approved',
      notes: 'still approved',
    } as any);
    expect(updated.status).toBe('Approved');
    expect(updated.notes).toBe('still approved');
  });
});

describe('invoice enrichment preserves the approved snapshot', () => {
  // The enrichment step re-derives invoice figures from the batch. Without the
  // snapshot it recomputes from live class rows, which silently reintroduces a
  // repriced amount after the payload builder already froze the right one.
  const frozenClasses = [
    { classId: 'c1', learners: 80, finalFee: 100, liveTotal: 8000, bomCost: 2000, roundingAdjustment: 50 },
  ];
  const snapshot = {
    result: {
      totalAmount: 8000,
      materialTotal: 2000,
      classes: frozenClasses,
    },
  };
  const driftedBatch = {
    classes: [
      {
        id: 'c1',
        class_name: 'Form 1',
        number_of_learners: 80,
        live_total_preview: 999_999,
        final_fee_per_learner: 12_499,
        material_total_cost: 500_000,
      },
    ],
  };
  const baseInvoice: any = {
    id: 'EXM-ENR/001',
    invoiceNumber: 'EXM-ENR/001',
    totalAmount: 8000,
    subtotal: 7950,
    preRoundingTotalAmount: 7950,
    roundingDifference: 50,
  };

  it('keeps the snapshot total rather than the drifted live total', () => {
    const enriched: any = enrichInvoiceWithBatchPricing(baseInvoice, driftedBatch, snapshot);
    expect(enriched.totalAmount).toBe(8000);
    expect(enriched.total).toBe(8000);
  });

  it('keeps the frozen material total', () => {
    const enriched: any = enrichInvoiceWithBatchPricing(baseInvoice, driftedBatch, snapshot);
    expect(enriched.materialTotal).toBe(2000);
  });

  it('prices each line from the frozen fee, not the live fee', () => {
    const enriched: any = enrichInvoiceWithBatchPricing(baseInvoice, driftedBatch, snapshot);
    expect(enriched.items[0].price).toBe(100);
    expect(enriched.items[0].quantity).toBe(80);
    expect(enriched.items[0].total).toBe(8000);
    expect(enriched.items[0].cost).toBe(25);
  });

  it('preserves the pre-rounding and rounding figures', () => {
    const enriched: any = enrichInvoiceWithBatchPricing(baseInvoice, driftedBatch, snapshot);
    expect(enriched.subtotal).toBe(7950);
    expect(enriched.preRoundingTotalAmount).toBe(7950);
    expect(enriched.roundingDifference).toBe(50);
  });

  it('falls back to live rows when no snapshot is supplied', () => {
    const enriched: any = enrichInvoiceWithBatchPricing(baseInvoice, driftedBatch, null);
    // Live fallback: 12,499 per learner x 80 learners. Rounding is allocated on
    // top of that and does not change the revenue total.
    expect(enriched.totalAmount).toBe(999_920);
  });
});