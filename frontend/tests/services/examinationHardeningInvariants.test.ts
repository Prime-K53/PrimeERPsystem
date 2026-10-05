/**
 * examinationHardeningInvariants.test.ts — production-hardening invariants
 * for the examination batch workflow (EXAM-2026.1).
 *
 * Covers: canonical pricing constants, calculation versioning, immutable
 * snapshots, locked-batch guards, no-recalc invoice generation, one-active-
 * invoice concurrency, patch isolation, legacy containment, no-tax
 * accounting shape, token stability, and production-release idempotency.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { examinationBatchService } from '../../services/examinationBatchService';
import {
  persistExaminationInvoiceToFinance,
  mapExaminationPayloadToInvoice,
} from '../../services/examinationInvoiceSyncService';
import { ExaminationProductionService } from '../../services/examinationProductionService';
import { EXAM_PRICING_ENGINE_VERSION } from '../../src/domain/examination/pricingEngine';
import { EXAM_TONER_PAGES_PER_UNIT } from '../../src/domain/examination/pricingEngine';

type StoreRecord = Map<string, any>;
const stores = new Map<string, StoreRecord>();
const getStore = (name: string) => {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
};
const offlineBatchStore = new Map<string, any>();
const enqueuedOps: any[] = [];
const savedInvoices: any[] = [];

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
    executeAtomicOperation: vi.fn(async (storeNames: string[], operation: (tx: any) => Promise<any>) => {
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

vi.mock('../../services/api', () => ({
  api: {
    finance: {
      saveInvoice: vi.fn(async (invoice: any) => {
        savedInvoices.push(invoice);
        return { id: invoice.id };
      }),
    },
  },
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
    paper_item_name: 'A4 Paper 80gsm',
    paper_unit_cost: 10,
    toner_item_id: 'toner-1',
    toner_item_name: 'HP Universal Toner',
    toner_unit_cost: 85000,
    conversion_rate: 500,
    constants: { toner_pages_per_unit: 20000 },
    profit_margin: 0,
    active_adjustments: [],
  });
  getStore('marketAdjustments').set('adj10', {
    id: 'adj10',
    name: 'Test 10%',
    type: 'PERCENTAGE',
    value: 10,
    percentage: 10,
    active: true,
    is_active: true,
    isActive: true,
  });
  getStore('schools').set('SCH-1', { id: 'SCH-1', name: 'Test School' });
};

const buildPricedBatch = async () => {
  const batch = await examinationBatchService.createBatch({
    school_id: 'SCH-1',
    academic_year: '2026',
    name: 'Invariant Batch',
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
  return examinationBatchService.calculateBatch(batch.id);
};

describe('examination hardening invariants', () => {
  beforeEach(async () => {
    stores.clear();
    offlineBatchStore.clear();
    enqueuedOps.length = 0;
    savedInvoices.length = 0;
    await seedPricing();
  });

  it('publishes the canonical engine version and toner yield', () => {
    expect(EXAM_PRICING_ENGINE_VERSION).toBe('EXAM-2026.1');
    expect(EXAM_TONER_PAGES_PER_UNIT).toBe(20000);
  });

  it('stamps calculation version, engine and snapshot on calculate', async () => {
    // createBatch (unversioned) -> addClass (v1) -> addSubject (v2) -> calculateBatch (v3):
    // every successful recalculation mints a new version.
    const batch: any = await buildPricedBatch();
    expect(batch.calculation_version).toBe(3);
    expect(batch.pricing_engine_version).toBe('EXAM-2026.1');
    expect(batch.total_amount).toBe(8000);
    const snapshot = batch.pricing_snapshot;
    expect(snapshot.engineVersion).toBe('EXAM-2026.1');
    expect(snapshot.calculationVersion).toBe(3);
    expect(snapshot.provenance).toBe('CANONICAL');
    expect(snapshot.inputs.tonerPagesPerUnit).toBe(20000);
    expect(snapshot.inputs.adjustments).toHaveLength(1);
    expect(snapshot.result.totalAmount).toBe(8000);
    expect(snapshot.result.classes[0].liveTotal).toBe(8000);
  });

  it('bumps the calculation version on every recalculation', async () => {
    const first: any = await buildPricedBatch();
    expect(first.calculation_version).toBe(3);
    const cls = first.classes[0];
    await examinationBatchService.addSubject(cls.id, {
      subject_name: 'English',
      pages: 8,
      extra_copies: 0,
    } as any);
    const second: any = await examinationBatchService.getBatch(first.id);
    expect(second.calculation_version).toBe(4);
    expect(second.pricing_snapshot.calculationVersion).toBe(4);
  });

  it('locks pricing once approved', async () => {
    const batch: any = await buildPricedBatch();
    const approved: any = (await examinationBatchService.approveBatch(batch.id)).batch;
    expect(approved.status).toBe('Approved');
    expect(approved.approved_calculation_version).toBe(3);
    await expect(examinationBatchService.calculateBatch(batch.id)).rejects.toThrow(/immutable/i);
    await expect(
      examinationBatchService.addClass(batch.id, { class_name: 'X', number_of_learners: 1 } as any)
    ).rejects.toThrow(/immutable/i);
    await expect(
      examinationBatchService.updateClassPricing(approved.classes[0].id, { cost_per_learner: 9999 } as any, true)
    ).rejects.toThrow(/immutable/i);
    await expect(
      examinationBatchService.updateClassFinancialMetrics(approved.classes[0].id, { live_total_preview: 1 })
    ).rejects.toThrow(/immutable/i);
  });

  it('approve is idempotent and pins the version', async () => {
    const batch: any = await buildPricedBatch();
    const first: any = (await examinationBatchService.approveBatch(batch.id)).batch;
    const second: any = (await examinationBatchService.approveBatch(batch.id)).batch;
    expect(second.approved_calculation_version).toBe(first.approved_calculation_version);
  });

  it('invoice generation fails closed on Draft', async () => {
    const batch: any = await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Draft Batch',
    } as any);
    await expect(examinationBatchService.generateInvoice(batch.id)).rejects.toThrow(/approved/i);
  });

  it('invoice consumes the approved snapshot and never reprices', async () => {
    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    // Change global pricing AFTER approval: invoice must ignore it.
    const { dbService } = await import('../../services/db');
    await dbService.saveSetting('examinationPricingSettings', {
      paper_unit_cost: 1000,
      toner_unit_cost: 8500000,
      conversion_rate: 500,
      constants: { toner_pages_per_unit: 20000 },
      profit_margin: 0,
      active_adjustments: [],
    });
    const result = await examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-001' });
    expect(result.invoice?.totalAmount).toBe(8000);
    expect(result.invoice?.items[0].total).toBe(8000);
    expect((result.invoice as any)?.calculationVersion).toBe(3);
    const stored: any = await examinationBatchService.getBatch(batch.id);
    expect(stored.status).toBe('Invoiced');
    expect(stored.invoice_id).toBe('EXM-INV-001');
    expect(stored.invoiced_calculation_version).toBe(3);
    expect(stored.total_amount).toBe(8000);
  });

  it('regeneration reissues the same totals with a new number', async () => {
    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    const first = await examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-001' });
    // A second generate on an invoiced batch that already has an invoice_id
    // is blocked — regeneration (void + reissue) is the only path.
    await expect(
      examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-002' })
    ).rejects.toThrow(/approved/i);
    const regen = await examinationBatchService.regenerateInvoice(batch.id, {
      invoiceNumber: 'EXM-INV-002',
      reason: 'test',
    });
    expect(regen.previousInvoiceId).toBe('EXM-INV-001');
    expect(regen.invoice?.totalAmount).toBe(first.invoice?.totalAmount);
    expect(regen.invoice?.id).toBe('EXM-INV-002');
    const stored: any = await examinationBatchService.getBatch(batch.id);
    expect(stored.invoice_id).toBe('EXM-INV-002');
  });

  it('refuses a second active invoice for one batch (rival wins fail-closed)', async () => {
    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    const generated = await examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-001' });
    // A rival device committed a different active invoice for the same batch.
    getStore('invoices').set('EXM-RIVAL-1', {
      id: 'EXM-RIVAL-1',
      invoiceNumber: 'EXM-RIVAL-1',
      originModule: 'examination',
      batchId: (generated.invoice as any).batchId,
      origin_batch_id: (generated.invoice as any).origin_batch_id,
      status: 'Unpaid',
      verificationToken: 'a'.repeat(64),
    });
    const retry = await examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-009' }).catch((e: Error) => e);
    // generate is blocked (invoice_id set); persist directly to test the guard.
    const { api } = await import('../../services/api');
    (api.finance.saveInvoice as any).mockClear();
    const outcome = await persistExaminationInvoiceToFinance({
      ...(generated.invoice as any),
      id: 'EXM-INV-009',
      invoiceNumber: 'EXM-INV-009',
    } as any);
    expect(retry).toBeInstanceOf(Error);
    expect(outcome.synced).toBe(false);
    expect(outcome.message).toMatch(/already has active invoice EXM-RIVAL-1/i);
    expect(api.finance.saveInvoice).not.toHaveBeenCalled();
  });

  it('canonical invoice carries no tax and keeps totals integrity', async () => {
    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    const generated = await examinationBatchService.generateInvoice(batch.id, { invoiceNumber: 'EXM-INV-001' });
    const { mapExaminationPayloadToInvoice } = await import('../../services/examinationInvoiceSyncService');
    const invoice = mapExaminationPayloadToInvoice(generated.invoice as any) as Record<string, any>;
    const taxKeys = Object.keys(invoice).filter((key) => /tax|vat/i.test(key));
    expect(taxKeys).toEqual([]);
    expect(invoice.totalAmount).toBe(8000);
    expect(invoice.id).toBe(invoice.invoiceNumber);
    expect(String(invoice.verificationToken || '')).toMatch(/^[0-9a-f]{64}$/);
    // Token stability: mapping an already-tokened payload preserves the token.
    const again = mapExaminationPayloadToInvoice({ ...(generated.invoice as any), verificationToken: invoice.verificationToken } as any) as Record<string, any>;
    expect(again.verificationToken).toBe(invoice.verificationToken);
  });

  it('patch batches never mutate the parent financial history', async () => {
    const parent: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(parent.id);
    const before = JSON.stringify(await examinationBatchService.getBatch(parent.id));
    const patch = await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Patch for Invariant Batch',
      type: 'Patch',
      parent_batch_id: parent.id,
    } as any);
    const patchClass = await examinationBatchService.addClass(patch.id, {
      class_name: 'Patch Class',
      number_of_learners: 10,
    } as any);
    await examinationBatchService.addSubject(patchClass.id, { subject_name: 'Extra', pages: 4 } as any);
    await examinationBatchService.calculateBatch(patch.id);
    await examinationBatchService.approveBatch(patch.id);
    await examinationBatchService.generateInvoice(patch.id, { invoiceNumber: 'EXM-PATCH-001' });
    const after = JSON.stringify(await examinationBatchService.getBatch(parent.id));
    expect(after).toBe(before);
    const storedPatch: any = await examinationBatchService.getBatch(patch.id);
    expect(storedPatch.invoice_id).toBe('EXM-PATCH-001');
    expect(storedPatch.status).toBe('Invoiced');
  });

  it('recalculate skips locked batches', async () => {    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Open Batch',
    } as any);
    const result = await examinationBatchService.recalculateNonInvoicedBatches({ includeApproved: true } as any);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const untouched: any = await examinationBatchService.getBatch(batch.id);
    expect(untouched.calculation_version).toBe(3);
  });

  it('locked batches cannot be deleted or settings-synced', async () => {
    const batch: any = await buildPricedBatch();
    await examinationBatchService.approveBatch(batch.id);
    await expect(examinationBatchService.deleteBatch(batch.id)).rejects.toThrow(/immutable/i);
    const stillThere: any = await examinationBatchService.getBatch(batch.id);
    expect(stillThere.status).toBe('Approved');
    await expect(
      examinationBatchService.syncPricingToBatch(batch.id, {
        settings: {},
        adjustments: [],
        triggerSource: 'PRICING_SETTINGS_SYNC',
      } as any)
    ).rejects.toThrow(/immutable/i);
    // Draft batches can still be deleted.
    const draft: any = await examinationBatchService.createBatch({
      school_id: 'SCH-1',
      academic_year: '2026',
      name: 'Disposable',
    } as any);
    await examinationBatchService.deleteBatch(draft.id);
    await expect(examinationBatchService.getBatch(draft.id)).rejects.toThrow();
  });

  it('production release is idempotent per batch + calculation version', async () => {
    const service = new ExaminationProductionService();
    const workOrderFn = vi.fn();
    const snapshotFor = (version: number) => ({
      engineVersion: 'EXAM-2026.1',
      calculationVersion: version,
      provenance: 'CANONICAL',
      inputs: {
        classes: [
          {
            classId: 'c-1',
            className: 'F1',
            learners: 80,
            subjects: [{ name: 'Math', pages: 12, extraCopies: 3 }],
          },
        ],
      },
      result: { classes: [] },
    });
    const payload: any = {
      batchId: 'B-REL-1',
      batchName: 'Release Batch',
      schoolName: 'Test School',
      calculationVersion: 3,
      approvedVersion: 3,
      batchStatus: 'Approved',
      snapshot: snapshotFor(3),
      subjects: [],
    };
    const first = await service.sendBatchToProduction(payload, workOrderFn);
    expect(first).toHaveLength(1);
    expect(first[0].subject).toBe('Math');
    // Snapshot-derived quantities, not payload-passed ones.
    expect(first[0].totalSheets).toBe(498);
    expect(first[0].totalPages).toBe(996);
    expect(workOrderFn).toHaveBeenCalledTimes(1);
    const second = await service.sendBatchToProduction(payload, workOrderFn);
    expect(second).toHaveLength(1);
    expect(workOrderFn).toHaveBeenCalledTimes(1);
    const upgraded = {
      ...payload,
      calculationVersion: 4,
      approvedVersion: 4,
      snapshot: snapshotFor(4),
    };
    const third = await service.sendBatchToProduction(upgraded, workOrderFn);
    expect(third).toHaveLength(1);
    expect(workOrderFn).toHaveBeenCalledTimes(2);
    expect(service.getJobsByBatch('B-REL-1').filter((job) => job.superseded)).toHaveLength(1);
  });

  it('production release ignores live/decoy values and uses only the snapshot', async () => {
    const service = new ExaminationProductionService();
    const workOrderFn = vi.fn();
    const snapshot: any = {
      engineVersion: 'EXAM-2026.1',
      calculationVersion: 5,
      provenance: 'CANONICAL',
      inputs: {
        classes: [
          {
            classId: 'c-1',
            className: 'F1',
            learners: 80,
            subjects: [{ name: 'Math', pages: 12, extraCopies: 3 }],
          },
        ],
      },
      result: { classes: [] },
    };
    const jobs = await service.sendBatchToProduction(
      {
        batchId: 'B-REL-2',
        batchName: 'Release Batch',
        schoolName: 'Test School',
        calculationVersion: 5,
        approvedVersion: 5,
        batchStatus: 'Approved',
        snapshot,
        // Decoy live values: must never leak into production work.
        subjects: [
          { subject: 'Tampered', className: 'Nope', pages: 999, candidates: 1, extraCopies: 0, baseSheets: 0, totalSheets: 1, totalPages: 1, productionCopies: 1 },
        ],
      } as any,
      workOrderFn
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].subject).toBe('Math');
    expect(jobs[0].totalSheets).toBe(498);
    expect(jobs[0].totalPages).toBe(996);
  });
});
