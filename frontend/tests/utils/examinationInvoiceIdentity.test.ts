/**
 * examinationInvoiceIdentity.test.ts — regression for the cross-device
 * Examination-Batch → Invoice bug (canonical-record inconsistency).
 *
 * Covers implementation phases 1–3 + 5 + 7 (frontend):
 *  1. EXM numbers are minted from the canonical invoices collection —
 *     SALE-* rows must not control the EXM sequence, existing EXM rows
 *     (either id or invoiceNumber spelling) must advance it, sequential
 *     conversions are distinct, and a simulated second device generating
 *     against the synced collection never reuses an ID.
 *  2/3. mapExaminationPayloadToInvoice is authoritative: Invoice.id ===
 *     Invoice.invoiceNumber, never an opaque local-exam-invoice-* id, and
 *     always carries a verificationToken (minted once, never regenerated).
 *     persistExaminationInvoiceToFinance cannot enqueue an untokened invoice
 *     on either the normal or the fallback path.
 *  5. Detail/deep-link resolution is deterministic: exact id first, exact
 *     invoiceNumber second (slash-safe), never fuzzy.
 *  7. Canonical fields survive field-level merge (Device B pull/realtime).
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
import {
  bumpTrailingDocumentSequence,
  generateNextExaminationInvoiceNumber,
} from '../../utils/helpers';
import {
  buildExaminationInvoiceViewState,
  findInvoiceByIdOrNumber,
  findOwningExaminationBatchId,
  getExaminationBatchLinkage,
  isDistinctExaminationInvoiceCollision,
  isShadowExaminationInvoiceId,
  resolveExaminationInvoiceNavigationKey,
} from '../../utils/invoiceIdentity';
import {
  ensureInvoiceVerificationToken,
  VERIFICATION_TOKEN_HEX_LENGTH,
} from '../../utils/invoiceVerification';
import {
  mapExaminationPayloadToInvoice,
  persistExaminationInvoiceToFinance,
} from '../../services/examinationInvoiceSyncService';
import { ExaminationGeneratedInvoicePayload } from '../../services/examinationBatchService';
import { examinationBatchService } from '../../services/examinationBatchService';
import { fieldLevelMerge } from '../../services/syncConflictResolver';
import { api } from '../../services/api';
import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';

const sharedConfig = (overrides: Record<string, unknown> = {}): CompanyConfig =>
  ({
    transactionSettings: {
      numbering: {
        shared: {
          prefix: '',
          startNumber: 1,
          padding: 4,
          resetInterval: 'Never',
          ...overrides,
        },
      },
    },
  } as CompanyConfig);

const TOKEN_64 = /^[0-9a-f]{64}$/;

const buildPayload = (overrides: Partial<ExaminationGeneratedInvoicePayload> = {}) =>
  ({
    id: 'EXM-0001',
    backendInvoiceId: 'EXM-0001',
    invoiceNumber: 'EXM-0001',
    date: '2026-09-20T00:00:00.000Z',
    dueDate: '2026-10-20T00:00:00.000Z',
    customerId: 'CUST-1',
    customerName: 'School A',
    subtotal: 1000,
    totalAmount: 1000,
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
    batchId: 'BTC-001',
    schoolName: 'School A',
    origin_module: 'examination',
    origin_batch_id: 'BTC-001',
    ...overrides,
  } as ExaminationGeneratedInvoicePayload);

describe('Phase 1 — EXM numbering scans the canonical invoices namespace', () => {
  it('starts the EXM sequence when no invoices exist', () => {
    expect(generateNextExaminationInvoiceNumber([], sharedConfig())).toBe('EXM-0001');
  });

  it('ignores SALE-* (and other non-EXM) rows when advancing EXM', () => {
    const salesLike = [{ id: 'SALE-0001' }, { id: 'SALE-0099' }, { id: 'INV-P726/0007' }];
    expect(generateNextExaminationInvoiceNumber(salesLike, sharedConfig())).toBe('EXM-0001');
  });

  it('advances past existing EXM invoices (id spelling)', () => {
    const invoices = [{ id: 'EXM-0001' }, { id: 'EXM-0002' }];
    expect(generateNextExaminationInvoiceNumber(invoices, sharedConfig())).toBe('EXM-0003');
  });

  it('advances past existing EXM invoices (invoiceNumber spelling)', () => {
    const invoices = [{ id: 'SOMETHING-ELSE', invoiceNumber: 'EXM-0005' }];
    expect(generateNextExaminationInvoiceNumber(invoices, sharedConfig())).toBe('EXM-0006');
  });

  it('gives two sequential conversions distinct numbers', () => {
    const first = generateNextExaminationInvoiceNumber([], sharedConfig());
    const second = generateNextExaminationInvoiceNumber([{ id: first }], sharedConfig());
    expect(first).not.toBe(second);
    expect(second).toBe('EXM-0002');
  });

  it('simulated cross-device generation against the synced collection never reuses an ID', () => {
    // Device A mints against the shared collection and syncs first.
    const deviceA = generateNextExaminationInvoiceNumber([], sharedConfig());
    const synced = [{ id: deviceA, invoiceNumber: deviceA }];
    // Device B mints later against the same collection INCLUDING A's row.
    const deviceB = generateNextExaminationInvoiceNumber(synced, sharedConfig());
    expect(deviceB).not.toBe(deviceA);
    // Reverse ordering: a device that already holds B's row mints past it.
    const deviceA2 = generateNextExaminationInvoiceNumber(
      [{ id: deviceB, invoiceNumber: deviceB }],
      sharedConfig()
    );
    expect(deviceA2).not.toBe(deviceB);
  });

  it('preserves the configured shared extension (slash numbers)', () => {
    const config = sharedConfig({ extension: 'P726' });
    expect(generateNextExaminationInvoiceNumber([], config)).toBe('EXM-P726/0001');
    expect(
      generateNextExaminationInvoiceNumber([{ id: 'EXM-P726/0001' }], config)
    ).toBe('EXM-P726/0002');
  });

  it('collision loop bumps past a taken candidate the sequence scan missed', () => {
    // Daily reset: yesterday's rows are excluded from the max scan, but the
    // candidate must still not collide with a known-taken number.
    const config = sharedConfig({ resetInterval: 'Daily' });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const next = generateNextExaminationInvoiceNumber(
      [{ id: 'EXM-0001', date: yesterday.toISOString() }],
      config
    );
    expect(next).toBe('EXM-0002');
  });

  it('bumps trailing numeric runs without touching prefix/extension', () => {
    expect(bumpTrailingDocumentSequence('EXM-0001')).toBe('EXM-0002');
    expect(bumpTrailingDocumentSequence('EXM-P726/0001')).toBe('EXM-P726/0002');
    expect(bumpTrailingDocumentSequence('EXM-2026-000123')).toBe('EXM-2026-000124');
    expect(bumpTrailingDocumentSequence('EXM-ABC')).toBeNull();
  });
});

describe('Phase 2/3 — canonical invoice identity + token at mapping time', () => {
  it('maps to Invoice.id === Invoice.invoiceNumber (canonical EXM number)', () => {
    const invoice = mapExaminationPayloadToInvoice(buildPayload());
    expect(invoice.id).toBe('EXM-0001');
    expect(invoice.invoiceNumber).toBe('EXM-0001');
  });

  it('never surfaces an opaque local-exam-invoice-* identity', () => {
    const invoice = mapExaminationPayloadToInvoice(
      buildPayload({ id: 'local-exam-invoice-12345-abcde' })
    );
    expect(invoice.id).toBe('EXM-0001');
    expect(String(invoice.id)).not.toContain('local-exam-invoice-');
    expect(isShadowExaminationInvoiceId(invoice.id)).toBe(false);
  });

  it('always carries a verificationToken (existing token never regenerated)', () => {
    const fresh = mapExaminationPayloadToInvoice(buildPayload());
    expect(String(fresh.verificationToken)).toMatch(TOKEN_64);

    const existing = 'a'.repeat(64);
    const kept = mapExaminationPayloadToInvoice({
      ...buildPayload(),
      verificationToken: existing,
    } as unknown as ExaminationGeneratedInvoicePayload);
    expect(kept.verificationToken).toBe(existing);
  });

  it('ensureInvoiceVerificationToken is idempotent and 64-hex', () => {
    const minted = ensureInvoiceVerificationToken({} as { verificationToken?: string });
    expect(String(minted.verificationToken)).toMatch(TOKEN_64);
    expect(String(minted.verificationToken)).toHaveLength(VERIFICATION_TOKEN_HEX_LENGTH);
    const kept = ensureInvoiceVerificationToken({ verificationToken: 'b'.repeat(64) });
    expect(kept.verificationToken).toBe('b'.repeat(64));
  });
});

describe('Phase 3 — persistence/queue can never carry an untokened examination invoice', () => {
  beforeEach(() => {
    vi.mocked(dbService.get).mockResolvedValue(null);
    vi.mocked(dbService.executeAtomicOperation).mockImplementation(async (_stores: never, op: (tx: never) => Promise<never>) =>
      op({ objectStore: () => ({ delete: vi.fn(), get: vi.fn(), put: vi.fn() }) } as never)
    );
    vi.mocked(dbService.put).mockResolvedValue('EXM-0001');
    vi.mocked(api.finance.saveInvoice).mockResolvedValue({ success: true });
    vi.mocked(transactionService.processInvoice).mockResolvedValue({ success: true });
  });

  it('normal path saves a tokened invoice and reports the persisted id', async () => {
    const result = await persistExaminationInvoiceToFinance(buildPayload());
    expect(result.synced).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.invoiceId).toBe('EXM-0001');

    const saved = vi.mocked(api.finance.saveInvoice).mock.calls[0][0] as Record<string, unknown>;
    expect(String(saved.id)).toBe('EXM-0001');
    expect(String(saved.invoiceNumber)).toBe('EXM-0001');
    expect(String(saved.verificationToken)).toMatch(TOKEN_64);
  });

  it('fallback path (save throws) still puts/processes a tokened invoice', async () => {
    vi.mocked(api.finance.saveInvoice).mockRejectedValue(new Error('gateway offline'));

    const result = await persistExaminationInvoiceToFinance(buildPayload());
    expect(result.synced).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.invoiceId).toBe('EXM-0001');

    const putPayload = vi.mocked(dbService.put).mock.calls[0][1] as Record<string, unknown>;
    expect(String(putPayload.verificationToken)).toMatch(TOKEN_64);
    const processed = vi.mocked(transactionService.processInvoice).mock.calls[0][0] as Record<string, unknown>;
    expect(String(processed.verificationToken)).toMatch(TOKEN_64);
    // Fallback preserves the canonical identity (never the shadow id).
    expect(String(putPayload.id)).toBe('EXM-0001');
  });
});

describe('Phase 4 — single canonical navigation key', () => {
  it('prefers persisted sync id, then canonical number, never shadow ids', () => {
    expect(
      resolveExaminationInvoiceNavigationKey({
        syncInvoiceId: 'EXM-0002',
        invoiceNumber: 'EXM-0002',
        id: 'EXM-0002',
      })
    ).toBe('EXM-0002');
    expect(
      resolveExaminationInvoiceNavigationKey({ invoiceNumber: 'EXM-P726/0001' })
    ).toBe('EXM-P726/0001');
  });

  it('rejects shadow ids and throwaway numeric ids', () => {
    expect(
      resolveExaminationInvoiceNavigationKey({
        syncInvoiceId: null,
        invoiceNumber: null,
        id: 'local-exam-invoice-1729-abcde',
      })
    ).toBeNull();
    expect(
      resolveExaminationInvoiceNavigationKey({
        syncInvoiceId: undefined,
        invoiceNumber: undefined,
        id: 1758745600123,
      })
    ).toBeNull();
    // Shadow sync id falls through to the canonical number.
    expect(
      resolveExaminationInvoiceNavigationKey({
        syncInvoiceId: 'local-exam-invoice-1-x',
        invoiceNumber: 'EXM-0007',
      })
    ).toBe('EXM-0007');
    expect(resolveExaminationInvoiceNavigationKey(null)).toBeNull();
  });

  it('builds a canonical view state', () => {
    expect(buildExaminationInvoiceViewState('EXM-0009')).toEqual({
      action: 'view',
      type: 'Invoice',
      id: 'EXM-0009',
      filterInvoiceId: 'EXM-0009',
      source: 'examination',
    });
  });
});

describe('Phase 5 — deterministic detail/deep-link resolution', () => {
  const rows = [
    { id: 'EXM-0001', invoiceNumber: 'EXM-0001', customerName: 'School A' },
    { id: 'EXM-P726/0001', invoiceNumber: 'EXM-P726/0001', customerName: 'School B' },
    { id: 'INV-P726/023', invoiceNumber: 'INV-P726/023', customerName: 'School C' },
  ];

  it('resolves exact id first', () => {
    expect(findInvoiceByIdOrNumber(rows, 'EXM-0001')).toBe(rows[0]);
  });

  it('falls back to exact invoiceNumber (covers number-bearing deep-links)', () => {
    const byNumberOnly = [{ id: 'ULID-aaa', invoiceNumber: 'EXM-0042' }];
    expect(findInvoiceByIdOrNumber(byNumberOnly, 'EXM-0042')).toBe(byNumberOnly[0]);
  });

  it('handles slash-containing numbers exactly', () => {
    expect(findInvoiceByIdOrNumber(rows, 'EXM-P726/0001')).toBe(rows[1]);
    expect(findInvoiceByIdOrNumber(rows, 'INV-P726/023')).toBe(rows[2]);
    // A truncated slash segment must NOT resolve.
    expect(findInvoiceByIdOrNumber(rows, 'EXM-P726')).toBeUndefined();
  });

  it('never fuzzy-matches (name/notes/reference do not open documents)', () => {
    expect(findInvoiceByIdOrNumber(rows, 'School A')).toBeUndefined();
    expect(findInvoiceByIdOrNumber(rows, 'EXM')).toBeUndefined();
    expect(findInvoiceByIdOrNumber(rows, '')).toBeUndefined();
    expect(findInvoiceByIdOrNumber(rows, 'EXM-9999')).toBeUndefined();
    expect(findInvoiceByIdOrNumber([], 'EXM-0001')).toBeUndefined();
  });
});

describe('Phase 7 — canonical fields survive field-level merge (Device B pull)', () => {
  it('keeps identity + token + items + batch keys through merge', () => {
    const local = {
      id: 'EXM-0001',
      invoiceNumber: 'EXM-0001',
      verificationToken: 'c'.repeat(64),
      items: [{ id: 'CLS-1', total: 1000 }],
      batchId: 'BTC-001',
      origin_batch_id: 'BTC-001',
      originBatchId: 'BTC-001',
      totalAmount: 1000,
      _updatedAt: '2026-09-20T00:00:00.000Z',
      version: 1,
    };
    const remote = {
      ...local,
      totalAmount: 1000,
      updated_at: '2026-09-21T00:00:00.000Z',
      serverUpdatedAt: '2026-09-21T00:00:00.000Z',
      version: 2,
    };
    const merged = fieldLevelMerge(local, remote) as Record<string, unknown>;
    expect(merged.id).toBe('EXM-0001');
    expect(merged.invoiceNumber).toBe('EXM-0001');
    expect(merged.verificationToken).toBe('c'.repeat(64));
    expect(merged.items).toEqual([{ id: 'CLS-1', total: 1000 }]);
    expect(merged.batchId).toBe('BTC-001');
    expect(merged.origin_batch_id).toBe('BTC-001');
    expect(Number(merged.version)).toBe(2);
  });
});

describe('P0 — batch linkage and distinct-collision assessment (pure)', () => {
  const examRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'EXM-0006',
    invoiceNumber: 'EXM-0006',
    origin_module: 'examination',
    category: 'Examination',
    batchId: 'BTC-B',
    origin_batch_id: 'BTC-B',
    reference: 'EXAM-BATCH-BTC-B',
    verificationToken: 'b'.repeat(64),
    ...overrides,
  });

  it('extracts batch keys across spellings, strips EXM-BATCH-, uppercases', () => {
    expect(getExaminationBatchLinkage(examRow()).sort()).toEqual(['BTC-B']);
    expect(
      getExaminationBatchLinkage({ reference: 'exam-batch-btc-9', origin_module: 'examination' })
    ).toEqual(['BTC-9']);
    expect(
      getExaminationBatchLinkage({
        batchId: 'BTC-1',
        conversionDetails: { sourceNumber: 'BTC-1' },
      }).sort()
    ).toEqual(['BTC-1']);
    expect(getExaminationBatchLinkage({})).toEqual([]);
    expect(getExaminationBatchLinkage(null)).toEqual([]);
  });

  it('detects disjoint examination batches sharing one id', () => {
    const serverA = {
      ...examRow(),
      batchId: 'BTC-A',
      origin_batch_id: 'BTC-A',
      reference: 'EXAM-BATCH-BTC-A',
      verificationToken: 'a'.repeat(64),
    };
    expect(isDistinctExaminationInvoiceCollision(examRow(), serverA)).toBe(true);
  });

  it('does not fire for same-batch edits (payments, status changes)', () => {
    const edited = { ...examRow(), paidAmount: 200, status: 'Partial' };
    expect(isDistinctExaminationInvoiceCollision(edited, examRow())).toBe(false);
  });

  it('does not fire for non-examination rows, tombstones, or linkage-less rows', () => {
    const plain = { id: 'EXM-0006', invoiceNumber: 'EXM-0006', totalAmount: 5 };
    expect(isDistinctExaminationInvoiceCollision(examRow(), plain)).toBe(false);
    expect(isDistinctExaminationInvoiceCollision(plain, examRow())).toBe(false);
    expect(
      isDistinctExaminationInvoiceCollision(examRow(), { ...examRow(), deleted: true })
    ).toBe(false);
    // Only linkage left is the shared id itself → excluded → cannot prove distinct.
    const legacyLocal = { ...examRow(), reference: 'EXM-0006' };
    delete (legacyLocal as Record<string, unknown>).batchId;
    delete (legacyLocal as Record<string, unknown>).origin_batch_id;
    const legacyServer = { ...legacyLocal, verificationToken: 'a'.repeat(64) };
    expect(isDistinctExaminationInvoiceCollision(legacyLocal, legacyServer)).toBe(false);
  });

  it('finds the owning batch by invoice link + linkage intersection only', () => {
    const batches = [
      { id: 'batch-b', batch_number: 'BTC-B', invoice_id: 'EXM-0006' },
      { id: 'batch-a', batch_number: 'BTC-A', invoice_id: 'EXM-0006' },
      { id: 'batch-c', batch_number: 'BTC-C', invoice_id: 'EXM-0009' },
    ];
    expect(findOwningExaminationBatchId(batches, ['BTC-B'], 'EXM-0006')).toBe('batch-b');
    // Winner's batch also references the id but has no linkage intersection.
    expect(findOwningExaminationBatchId(batches, ['BTC-B'], 'EXM-0009')).toBeNull();
    expect(findOwningExaminationBatchId(batches, [], 'EXM-0006')).toBeNull();
    expect(findOwningExaminationBatchId(batches, ['BTC-Z'], 'EXM-0006')).toBeNull();
    expect(findOwningExaminationBatchId(null, ['BTC-B'], 'EXM-0006')).toBeNull();
  });
});

describe('P0 — persist pre-flight re-mints on same-id occupant (synchronous)', () => {
  const occupant = {
    id: 'EXM-0006',
    invoiceNumber: 'EXM-0006',
    origin_module: 'examination',
    batchId: 'BTC-OTHER',
    origin_batch_id: 'BTC-OTHER',
    reference: 'EXAM-BATCH-BTC-OTHER',
    verificationToken: 'a'.repeat(64),
    totalAmount: 1000,
  };

  beforeEach(() => {
    vi.mocked(dbService.get).mockImplementation(async (store: never, id: string) => {
      // Keyed get: occupant exists ONLY under its own canonical id.
      if (String(store) === 'invoices' && String(id) === 'EXM-0006') return occupant as never;
      return null as never;
    });
    vi.mocked(dbService.getAll).mockImplementation(async (store: never) => {
      if (String(store) === 'invoices') return [occupant] as never;
      return [] as never;
    });
    vi.mocked(api.finance.saveInvoice).mockResolvedValue({ success: true });
    vi.mocked(examinationBatchService.listBatches).mockResolvedValue([
      { id: 'batch-b-uuid', batch_number: 'BTC-001', invoice_id: 'EXM-0006' },
    ] as never);
    vi.mocked(examinationBatchService.updateBatch).mockResolvedValue({} as never);
  });

  it('re-mints locally, returns the fresh identity, repoints the owning batch', async () => {
    // Freshly minted EXM-0006 collides with a different batch's occupant.
    const colliding = buildPayload({ id: 'EXM-0006', invoiceNumber: 'EXM-0006' });
    const result = await persistExaminationInvoiceToFinance(colliding, {
      companyConfig: sharedConfig(),
    });
    expect(result.synced).toBe(true);
    // Fresh number minted past the occupant (EXM-0006 taken → EXM-0007).
    expect(result.invoiceId).toBe('EXM-0007');
    const saved = vi.mocked(api.finance.saveInvoice).mock.calls[0][0] as Record<string, unknown>;
    expect(String(saved.id)).toBe('EXM-0007');
    expect(String(saved.invoiceNumber)).toBe('EXM-0007');
    expect(String(saved.verificationToken)).toMatch(/^[0-9a-f]{64}$/);
    // Owning batch repointed; occupant batch untouched (updateBatch once, ours).
    expect(vi.mocked(examinationBatchService.updateBatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(examinationBatchService.updateBatch).mock.calls[0][0]).toBe('batch-b-uuid');
    expect(
      (vi.mocked(examinationBatchService.updateBatch).mock.calls[0][1] as Record<string, unknown>)
        .invoice_id
    ).toBe('EXM-0007');
  });

  it('proceeds unchanged when the occupant is the same batch (idempotent retry)', async () => {
    const sameBatchOccupant = { ...occupant, batchId: 'BTC-001', origin_batch_id: 'BTC-001', reference: 'EXAM-BATCH-BTC-001' };
    vi.mocked(dbService.get).mockImplementation(async (store: never, id: string) => {
      if (String(store) === 'invoices' && String(id) === 'EXM-0001') return sameBatchOccupant as never;
      return null as never;
    });
    const result = await persistExaminationInvoiceToFinance(buildPayload(), {
      companyConfig: sharedConfig(),
    });
    expect(result.synced).toBe(true);
    expect(result.invoiceId).toBe('EXM-0001');
    expect(vi.mocked(examinationBatchService.updateBatch)).not.toHaveBeenCalled();
  });
});
