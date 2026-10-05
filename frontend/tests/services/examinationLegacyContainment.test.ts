/**
 * examinationLegacyContainment.test.ts — legacy job/group paths stay
 * non-canonical: they may keep working for history, but must never mint
 * EXM-series numbers or batch-linked invoices that could compete with the
 * canonical batch invoice identity (id === invoiceNumber, EXM-*).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { examinationJobService } from '../../services/examinationJobService';

const stores = new Map<string, Map<string, any>>();
const getStore = (name: string) => {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
};
const processedInvoices: any[] = [];

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async (storeName: string) => Array.from(getStore(storeName).values())),
    get: vi.fn(async (storeName: string, id: string) => getStore(storeName).get(String(id))),
    put: vi.fn(async (storeName: string, item: any) => {
      getStore(storeName).set(String(item.id), item);
      return String(item.id);
    }),
    delete: vi.fn(async () => undefined),
    getSetting: vi.fn(async () => undefined),
    saveSetting: vi.fn(async () => undefined),
    executeAtomicOperation: vi.fn(async (_s: string[], op: (tx: any) => Promise<any>) => op({})),
  },
}));

const jobStore = new Map<string, any>();
vi.mock('../../services/examinationDb', () => ({
  examinationDb: {
    examinationJobs: {
      toArray: vi.fn(async () => Array.from(jobStore.values())),
      get: vi.fn(async (id: string) => jobStore.get(String(id))),
      put: vi.fn(async (job: any) => {
        jobStore.set(String(job.id), job);
        return String(job.id);
      }),
    },
    examinationJobSubjects: {
      toArray: vi.fn(async () => []),
      put: vi.fn(async () => undefined),
    },
    examinationInvoiceGroups: {
      toArray: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    },
    examinationRecurringProfiles: {
      toArray: vi.fn(async () => []),
    },
  },
}));

vi.mock('../../services/documentNumberService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/documentNumberService')>();
  return {
    ...original,
    generateNextSalesInvoiceNumber: vi.fn(async () => 'INV-LEGACY-001'),
  };
});

vi.mock('../../services/transactionService', () => ({
  transactionService: {
    processInvoice: vi.fn(async (invoice: any) => {
      processedInvoices.push(invoice);
      return { id: invoice.id };
    }),
  },
}));

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('legacy examination containment', () => {
  beforeEach(() => {
    stores.clear();
    jobStore.clear();
    processedInvoices.length = 0;
    getStore('customers').set('SCH-1', { id: 'SCH-1', name: 'Legacy School' });
    jobStore.set('job-1', {
      id: 'job-1',
      school_id: 'SCH-1',
      number_of_learners: 50,
      final_amount: 25000,
      production_cost: 20000,
      total_pages: 500,
      status: 'Calculated',
      pricing_locked: true,
      inventory_deducted: true,
      sub_account_name: '',
    });
  });

  it('legacy job invoicing mints INV-series, never EXM or batch linkage', async () => {
    const result = await (examinationJobService as any).createInvoiceForJobs(['job-1'], 'SCH-1');
    expect(processedInvoices).toHaveLength(1);
    const invoice = processedInvoices[0];
    expect(String(invoice.id)).toMatch(/^INV-/);
    expect(String(invoice.id)).not.toMatch(/^EXM-/i);
    // No canonical batch linkage: must not claim a batch or EXM identity.
    expect(invoice.origin_batch_id ?? invoice.originBatchId ?? invoice.batchId).toBeFalsy();
    expect(invoice.originModule).toBe('examination');
    expect(result).toBeDefined();
    // The job is marked with the INV invoice, not an EXM one.
    const job = jobStore.get('job-1');
    expect(String(job.invoice_id)).toMatch(/^INV-/);
  });
});
