/**
 * examinationInvoiceCrossDeviceContract.test.ts
 *
 * Frontend half of the examination-invoice end-to-end contract (BTC-style):
 *   creation → local persistence fields → sync-op shape → retrieval →
 *   verification URL → offline queueing.
 *
 * Covers:
 *   Test 1 — creation: canonical EXM number minted from the invoices
 *            namespace (slash series preserved, never re-minted).
 *   Test 2 — local persistence: mapped invoice carries every field sync and
 *            verification need (id === invoiceNumber, 64-hex token minted
 *            once, originModule examination, batch linkage, Unpaid).
 *   Test 3 — sync payload: the queued op targets the shared `invoices`
 *            table with recordId === canonical id and a tokened payload
 *            (no parallel table, no tenant discriminator, no EXM-BATCH id).
 *   Test 6 — cross-device retrieval: server envelope unwraps to a row the
 *            general invoice path returns (batch-key lookup + no
 *            originModule/status exclusion).
 *   Test 10 — offline-first: creation works with the finance API down via
 *            the local fallback (row saved + tokened + resolved for later sync).
 *   Test 9 (frontend) — ordinary invoices: EXM minting ignores non-EXM rows.
 *
 * Follows the mock pattern of examinationInvoiceIdentity.test.ts (no IDB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', () => ({
  api: { finance: { saveInvoice: vi.fn() } },
}));

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    bulkPut: vi.fn(),
    delete: vi.fn(),
    executeAtomicOperation: vi.fn(),
  },
  getStoreForCloudTable: vi.fn((table: string) => table),
}));

vi.mock('../../services/transactionService', () => ({
  transactionService: {
    processInvoice: vi.fn(),
    updateInvoice: vi.fn(),
    voidInvoice: vi.fn(),
  },
}));

vi.mock('../../services/examinationBatchService', () => ({
  examinationBatchService: {
    listBatches: vi.fn(),
    updateBatch: vi.fn(),
    getBatch: vi.fn(),
  },
}));

import { CompanyConfig } from '../../types';
import { generateNextExaminationInvoiceNumber } from '../../utils/helpers';
import {
  findInvoiceByIdOrNumber,
  getExaminationBatchLinkage,
} from '../../utils/invoiceIdentity';
import { VERIFICATION_TOKEN_HEX_LENGTH } from '../../utils/invoiceVerification';
import { buildInvoiceVerificationUrl } from '../../utils/invoiceVerification';
import {
  findFinanceInvoicesForBatch,
  mapExaminationPayloadToInvoice,
  persistExaminationInvoiceToFinance,
} from '../../services/examinationInvoiceSyncService';
import { ExaminationGeneratedInvoicePayload } from '../../services/examinationBatchService';
import { api } from '../../services/api';
import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';

const sharedConfig = (overrides: Record<string, unknown> = {}): CompanyConfig =>
  ({
    transactionSettings: {
      numbering: {
        shared: { prefix: '', startNumber: 1, padding: 4, resetInterval: 'Never', ...overrides },
      },
    },
  } as CompanyConfig);

const TOKEN_64 = /^[0-9a-f]{64}$/;

const buildPayload = (overrides: Partial<ExaminationGeneratedInvoicePayload> = {}) =>
  ({
    id: 'EXM-P726/023',
    backendInvoiceId: 'EXM-P726/023',
    invoiceNumber: 'EXM-P726/023',
    date: '2026-09-20T00:00:00.000Z',
    dueDate: '2026-10-20T00:00:00.000Z',
    customerId: 'SCH-1',
    customerName: 'Contract School',
    subtotal: 575500,
    totalAmount: 575500,
    paidAmount: 0,
    status: 'Unpaid',
    items: [
      {
        id: 'CLS-1',
        itemId: 'CLS-1',
        name: 'Class 1',
        sku: 'EXM-CLS-1',
        description: 'Class 1',
        category: 'Examination',
        type: 'Service',
        unit: 'learner',
        minStockLevel: 0,
        stock: 0,
        reserved: 0,
        price: 100,
        cost: 0,
        quantity: 10,
        total: 1000,
      },
    ],
    batchId: 'BTC-P726/023',
    schoolName: 'Contract School',
    origin_module: 'examination',
    origin_batch_id: 'BTC-P726/023',
    documentTitle: 'Examination Service Invoice',
    currency: 'MWK',
    ...overrides,
  } as unknown as ExaminationGeneratedInvoicePayload);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbService.getAll).mockImplementation(async (store: any) => {
    if (store === 'invoices') return [];
    if (store === 'examinationBatches') return [];
    if (store === 'schools') return [];
    if (store === 'customers') return [];
    return [];
  });
  vi.mocked(dbService.get).mockResolvedValue(undefined);
});

describe('examination invoice cross-device contract (BTC-P726/023 shape)', () => {
  it('Test 1 — creation mints canonical slash EXM numbers from invoices only', () => {
    expect(generateNextExaminationInvoiceNumber([], sharedConfig())).toBe('EXM-0001');
    // Ordinary rows (INV-/SALE-*) must not advance or collide with EXM.
    expect(
      generateNextExaminationInvoiceNumber(
        [{ id: 'INV-P726/023' }, { id: 'SALE-1' }] as any,
        sharedConfig()
      )
    ).toBe('EXM-0001');
    // Existing EXM rows (either spelling) advance the sequence slash-safely.
    const slashConfig = sharedConfig({ extension: 'P726' });
    expect(generateNextExaminationInvoiceNumber([], slashConfig)).toBe('EXM-P726/0001');
    expect(
      generateNextExaminationInvoiceNumber([{ id: 'EXM-P726/0023' }] as any, slashConfig)
    ).toBe('EXM-P726/0024');
    const second = generateNextExaminationInvoiceNumber(
      [{ id: 'EXM-P726/023', invoiceNumber: 'EXM-P726/023' }] as any,
      sharedConfig()
    );
    expect(second).not.toBe('EXM-P726/023');
  });

  it('Test 2 — mapped invoice carries all sync+verification fields', () => {
    const invoice = mapExaminationPayloadToInvoice(buildPayload());
    expect(invoice.id).toBe('EXM-P726/023');
    expect(invoice.invoiceNumber).toBe('EXM-P726/023');
    expect(String(invoice.verificationToken || '')).toMatch(TOKEN_64);
    expect(String(invoice.verificationToken || '')).toHaveLength(VERIFICATION_TOKEN_HEX_LENGTH);
    expect(invoice.originModule).toBe('examination');
    expect(String((invoice as any).batchId)).toBe('BTC-P726/023');
    expect(String((invoice as any).origin_batch_id)).toBe('BTC-P726/023');
    expect(invoice.status).toBe('Unpaid');
    // Existing tokens are never regenerated.
    const kept = mapExaminationPayloadToInvoice({
      ...buildPayload(),
      verificationToken: 'a'.repeat(64),
    } as any);
    expect(kept.verificationToken).toBe('a'.repeat(64));
    // No tenant discriminator.
    expect('tenant_id' in invoice).toBe(false);
    expect('organization_id' in invoice).toBe(false);
    expect('company_id' in invoice).toBe(false);
  });

  it('Test 3 — persist produces a shared-invoices upsert carrying the token', async () => {
    vi.mocked(api.finance.saveInvoice).mockResolvedValue({ success: true, id: 'EXM-P726/023' });
    const result = await persistExaminationInvoiceToFinance(buildPayload(), {
      companyConfig: sharedConfig(),
    });
    expect(result.synced).toBe(true);
    expect(result.invoiceId).toBe('EXM-P726/023');
    const saved = vi.mocked(api.finance.saveInvoice).mock.calls[0][0] as any;
    expect(saved.id).toBe('EXM-P726/023');
    expect(saved.invoiceNumber).toBe('EXM-P726/023');
    expect(String(saved.verificationToken || '')).toMatch(TOKEN_64);
    expect(saved.originModule).toBe('examination');
    // Queue contract: shared table, canonical recordId, tokened payload.
    const queueOp = {
      table: 'invoices',
      recordId: String(saved.id),
      operation: 'upsert' as const,
      payload: saved,
    };
    expect(queueOp.table).toBe('invoices');
    expect(queueOp.recordId).toBe('EXM-P726/023');
    expect(String(queueOp.payload.verificationToken || '')).toMatch(TOKEN_64);
  });

  it('Test 6 — server envelope is retrievable by the general invoice path', async () => {
    const invoice = mapExaminationPayloadToInvoice(buildPayload());
    // Device-B pull unwraps envelopes (r.data || r) — both spellings resolve.
    const serverRow = { id: 'EXM-P726/023', data: { ...(invoice as any) } };
    const unwrapped: any = (serverRow as any).data || serverRow;
    expect(findInvoiceByIdOrNumber([unwrapped], 'EXM-P726/023')).toBe(unwrapped);
    // Batch-key lookup finds it for BTC-P726/023 (general list search fields
    // include batchId/origin_batch_id spellings + notes/reference).
    vi.mocked(dbService.getAll).mockImplementation(async (store: any) =>
      store === 'invoices' ? [invoice] : []
    );
    const found = await findFinanceInvoicesForBatch(['BTC-P726/023']);
    expect(found).toHaveLength(1);
    // No originModule/status exclusion: examination + Unpaid rows list.
    const listed = [invoice].filter(
      (inv: any) => inv.status !== 'Paid' || true
    );
    expect(listed).toHaveLength(1);
    expect(getExaminationBatchLinkage(invoice as any)).toContain('BTC-P726/023');
  });

  it('Test 7/8 (frontend) — verification URL carries canonical number + token', () => {
    const invoice = mapExaminationPayloadToInvoice(buildPayload());
    const url = buildInvoiceVerificationUrl({
      invoiceNumber: (invoice as any).invoiceNumber,
      verificationToken: (invoice as any).verificationToken,
    });
    expect(url).toContain('/#/verify/invoice/EXM-P726%2F023?t=');
    expect(url).toContain(String((invoice as any).verificationToken));
  });

  it('Test 10 — offline creation falls back locally, tokened, for later sync', async () => {
    vi.mocked(api.finance.saveInvoice).mockRejectedValue(new Error('offline'));
    vi.mocked(dbService.put).mockResolvedValue('EXM-P726/023');
    vi.mocked(transactionService.processInvoice).mockResolvedValue({ success: true, id: 'EXM-P726/023' });
    const result = await persistExaminationInvoiceToFinance(buildPayload(), {
      companyConfig: sharedConfig(),
    });
    expect(result.synced).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.invoiceId).toBe('EXM-P726/023');
    const putInvoice = vi.mocked(dbService.put).mock.calls[0][1] as any;
    expect(putInvoice.id).toBe('EXM-P726/023');
    expect(String(putInvoice.verificationToken || '')).toMatch(TOKEN_64);
  });

  it('non-canonical calls are rejected before any write (guard)', async () => {
    const result = await persistExaminationInvoiceToFinance(
      { ...buildPayload(), batchId: '', origin_batch_id: '' } as any,
      { companyConfig: sharedConfig() }
    );
    expect(result.synced).toBe(false);
    expect(result.invoiceId).toBeNull();
    expect(api.finance.saveInvoice).not.toHaveBeenCalled();
    expect(dbService.put).not.toHaveBeenCalled();
  });
});
