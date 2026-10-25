process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
  instance.create = jest.fn(() => instance);
  return instance;
});

const axios = require('axios');
const cloudSyncStore = require('../../services/cloudSyncStore.cjs');
const guards = require('../../services/examinationSyncGuards.cjs');

const LOCKED_FILTER = 'not.in.(approved,invoiced,completed,paid)';

/**
 * The cloud is mocked by ROUTING ON THE REQUEST rather than by call order.
 * ensureIdempotencyTable() memoizes its probe in module scope, so an
 * ordered-call-count mock would silently depend on test execution order.
 */
const cloud = {
  row: null,
  idempotencyReplayed: false,
  patchImpl: null,
  postImpl: null,
};

const routeGet = (url, config) => {
  const href = String(url);
  const params = (config && config.params) || {};

  if (href.includes('/rest/v1/settings')) {
    return { data: [{ id: 'sync_generation', data: { value: 1 } }] };
  }
  if (href.includes('/rest/v1/idempotency_keys')) {
    // Availability probe: { select: 'id', limit: 0 } with no id filter.
    if (!params.id) return { data: [] };
    return {
      data: cloud.idempotencyReplayed
        ? [{ id: 'idem-uuid', result: cloud.row ? cloud.row.id : null }]
        : [],
    };
  }
  if (params.id && String(params.id).startsWith('eq.')) {
    const wanted = String(params.id).slice(3);
    return { data: cloud.row && String(cloud.row.id) === wanted ? [cloud.row] : [] };
  }
  return { data: [] };
};

beforeEach(() => {
  cloud.row = null;
  cloud.idempotencyReplayed = false;
  cloud.patchImpl = null;
  cloud.postImpl = null;
  axios.get.mockReset();
  axios.post.mockReset();
  axios.patch.mockReset();
  axios.delete.mockReset();
  axios.get.mockImplementation(async (url, config) => routeGet(url, config));
  axios.patch.mockImplementation(async (url, body, config) => (
    cloud.patchImpl ? cloud.patchImpl(url, body, config) : { data: [] }
  ));
  axios.post.mockImplementation(async (url, body) => (
    cloud.postImpl ? cloud.postImpl(url, body) : { data: [] }
  ));
});

const respondRow = (row) => ({ data: [row] });

const batchRow = (overrides = {}) => ({
  id: 'batch-1',
  version: 4,
  updated_at: '2026-03-01T00:00:00Z',
  data: { batch_number: 'BTC-P726/001', status: 'invoiced', invoice_id: 'EXM-001/001' },
  ...overrides,
});

describe('examination sync guards — pure rules', () => {
  describe('buildBatchUpsertPrecondition', () => {
    it('excludes locked statuses so a stale device cannot reprice a frozen batch', () => {
      expect(guards.buildBatchUpsertPrecondition({ status: 'Draft' }))
        .toEqual({ filters: { 'data->>status': 'in.(draft)' } });
      expect(guards.buildBatchUpsertPrecondition({ status: 'Calculated' }))
        .toEqual({ filters: { 'data->>status': 'in.(draft,calculated)' } });
    });

    it('permits approval only from a pre-approval status', () => {
      expect(guards.buildBatchUpsertPrecondition({ status: 'Approved' }))
        .toEqual({ filters: { 'data->>status': 'in.(draft,calculated,approved)' } });
    });

    it('permits invoicing only from an approved batch', () => {
      expect(guards.buildBatchUpsertPrecondition({ status: 'Invoiced' }))
        .toEqual({ filters: { 'data->>status': 'in.(approved,invoiced)' } });
    });

    it('normalises casing and surrounding whitespace', () => {
      expect(guards.buildBatchUpsertPrecondition({ status: '  INVOICED ' }))
        .toEqual({ filters: { 'data->>status': 'in.(approved,invoiced)' } });
    });

    it('falls back to excluding locked statuses for an unknown status', () => {
      expect(guards.buildBatchUpsertPrecondition({ status: 'Banana' }))
        .toEqual({ filters: { 'data->>status': LOCKED_FILTER } });
    });

    it('emits no precondition when the payload carries no status', () => {
      expect(guards.buildBatchUpsertPrecondition({ batch_number: 'X' })).toBeNull();
      expect(guards.buildBatchUpsertPrecondition(null)).toBeNull();
    });
  });

  describe('buildBatchDeletePrecondition', () => {
    it('always excludes every financially committed status', () => {
      expect(guards.buildBatchDeletePrecondition())
        .toEqual({ filters: { 'data->>status': LOCKED_FILTER } });
    });
  });

  describe('isLockedStatus', () => {
    it('treats approved, invoiced, completed and paid as frozen', () => {
      ['approved', 'Invoiced', 'COMPLETED', ' paid '].forEach((s) => {
        expect(guards.isLockedStatus(s)).toBe(true);
      });
      expect(guards.isLockedStatus('calculated')).toBe(false);
      expect(guards.isLockedStatus('')).toBe(false);
    });
  });

  describe('validateInvoicePayloadShape', () => {
    const examInvoice = (overrides = {}) => ({
      id: 'EXM-001/001',
      invoiceNumber: 'EXM-001/001',
      originModule: 'examination',
      batchId: 'BTC-P726/001',
      ...overrides,
    });

    it('accepts a well-formed examination invoice', () => {
      expect(guards.validateInvoicePayloadShape({ payload: examInvoice() })).toBeNull();
    });

    it('ignores non-examination invoices entirely', () => {
      expect(guards.validateInvoicePayloadShape({ payload: { id: 'INV-9', originModule: 'sales' } })).toBeNull();
      expect(guards.validateInvoicePayloadShape({ payload: { id: 'INV-9' } })).toBeNull();
    });

    it('rejects an examination invoice without an EXM identity', () => {
      const err = guards.validateInvoicePayloadShape({ payload: examInvoice({ id: 'INV-9', invoiceNumber: 'INV-9' }) });
      expect(err).toMatch(/INVOICE_IDENTITY_MISSING/);
    });

    it('rejects an examination invoice with no batch linkage', () => {
      const err = guards.validateInvoicePayloadShape({ payload: examInvoice({ batchId: '', originBatchId: undefined }) });
      expect(err).toMatch(/INVOICE_BATCH_LINK_MISSING/);
    });

    it('does not re-validate a tombstone payload', () => {
      expect(guards.validateInvoicePayloadShape({ payload: examInvoice({ deleted: true }) })).toBeNull();
    });

    it('leaves examination invoices raised from JOBS alone', () => {
      // createInvoiceFromJobs uses a plain sales number and carries no batch
      // link. It is outside the batch-invoice identity contract and must not
      // be blocked by it.
      expect(guards.validateInvoicePayloadShape({
        payload: { id: 'INV-5001', invoiceNumber: 'INV-5001', originModule: 'examination' },
      })).toBeNull();
    });
  });

  describe('invoice identity readers', () => {
    it('reads the batch link from either the camelCase or snake_case column', () => {
      expect(guards.readInvoiceBatchId({ originBatchId: 'BTC-1' })).toBe('BTC-1');
      expect(guards.readInvoiceBatchId({ origin_batch_id: 'BTC-2' })).toBe('BTC-2');
      expect(guards.readInvoiceBatchId({ batchId: 'BTC-3' })).toBe('BTC-3');
      expect(guards.readInvoiceBatchId({})).toBeNull();
    });

    it('recognises an examination invoice by either origin-module spelling', () => {
      expect(guards.isExaminationInvoice({ originModule: 'examination' })).toBe(true);
      expect(guards.isExaminationInvoice({ origin_module: 'Examination' })).toBe(true);
      expect(guards.isExaminationInvoice({ originModule: 'sales' })).toBe(false);
      expect(guards.isExaminationInvoice({})).toBe(false);
    });

    it('accepts only EXM- prefixed invoice numbers', () => {
      expect(guards.readInvoiceNumber({ id: 'EXM-001/001' })).toBe('EXM-001/001');
      expect(guards.readInvoiceNumber({ id: 'exm-001/002' })).toBe('EXM-001/002');
      expect(guards.readInvoiceNumber({ id: 'INV-9' })).toBeNull();
    });
  });

  describe('validateInvoicePostingBoundary', () => {
    const examInvoice = (overrides = {}) => ({
      id: 'EXM-001/001',
      invoiceNumber: 'EXM-001/001',
      originModule: 'examination',
      batchId: 'BTC-1',
      ...overrides,
    });

    it('is inert while the posting boundary is disabled', () => {
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: examInvoice() },
        { postingEnabled: false }
      )).toBeNull();
    });

    it('rejects a client-originated Examination invoice once enabled', () => {
      const error = guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: examInvoice() },
        { postingEnabled: true }
      );
      expect(error).toMatch(/EXAM_POSTING_BOUNDARY/);
    });

    it('accepts a row the server itself stamped', () => {
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: examInvoice({ postedBy: 'server' }) },
        { postingEnabled: true }
      )).toBeNull();
    });

    it('never touches non-Examination invoices or tombstones', () => {
      const enabled = { postingEnabled: true };
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: { id: 'INV-9', originModule: 'sales' } }, enabled
      )).toBeNull();
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'delete', payload: examInvoice({ deleted: true }) }, enabled
      )).toBeNull();
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: examInvoice({ deleted: true }) }, enabled
      )).toBeNull();
    });

    it('leaves examination JOBS invoices alone (no batch-link contract)', () => {
      // createInvoiceFromJobs uses a plain sales number and carries no batchId.
      // Blocking it would break job invoicing, so the boundary must skip it.
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: { id: 'INV-5001', originModule: 'examination' } },
        { postingEnabled: true }
      )).toBeNull();
    });

    it('rejects a JOBS-shaped invoice that still claims a batch link', () => {
      expect(guards.validateInvoicePostingBoundary(
        { operation: 'upsert', payload: { id: 'INV-5002', originModule: 'examination', batchId: 'BTC-1' } },
        { postingEnabled: true }
      )).toMatch(/EXAM_POSTING_BOUNDARY/);
    });
  });

  describe('validateLedgerPostingBoundary', () => {
    const examLedger = (overrides = {}) => ({
      id: 'LG-INV-EXM-001/001',
      referenceId: 'EXM-001/001',
      debitAccountId: 'ACC-11310',
      creditAccountId: 'ACC-41200',
      amount: 1000,
      ...overrides,
    });

    it('is inert while the posting boundary is disabled', () => {
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', recordId: 'LG-INV-EXM-001/001', payload: examLedger() },
        { postingEnabled: false }
      )).toBeNull();
    });

    it('rejects an EXM ledger write once the server owns posting', () => {
      const error = guards.validateLedgerPostingBoundary(
        { operation: 'upsert', recordId: 'LG-INV-EXM-001/001', payload: examLedger() },
        { postingEnabled: true }
      );
      expect(error).toMatch(/EXAM_LEDGER_POSTING_BOUNDARY/);
    });

    it('detects an Examination ledger row by its origin module', () => {
      const enabled = { postingEnabled: true };
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: { id: 'LG-1', originModule: 'examination' } }, enabled
      )).toMatch(/EXAM_LEDGER_POSTING_BOUNDARY/);
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: { id: 'LG-2', origin_module: 'examination_reversal' } }, enabled
      )).toMatch(/EXAM_LEDGER_POSTING_BOUNDARY/);
    });

    it('rejects deleting committed Examination ledger history', () => {
      // Void reversal is the RPC's job; a client delete through the gateway
      // would silently remove the audit trail.
      const enabled = { postingEnabled: true };
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'delete', payload: { id: 'LG-INV-EXM-001/001' } }, enabled
      )).toMatch(/EXAM_LEDGER_POSTING_BOUNDARY/);
      // A delete op can arrive with no payload at all; the recordId must still
      // identify the row.
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'delete', recordId: 'LG-INV-EXM-001/001', payload: null }, enabled
      )).toMatch(/EXAM_LEDGER_POSTING_BOUNDARY/);
    });

    it('never touches non-Examination ledger traffic', () => {
      const enabled = { postingEnabled: true };
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: { id: 'LG-INV-2026/501', referenceId: 'INV-2026/501' } }, enabled
      )).toBeNull();
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: { id: 'LG-PAY-9', originModule: 'payments' } }, enabled
      )).toBeNull();
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'delete', payload: { id: 'LG-PAY-9' } }, enabled
      )).toBeNull();
    });

    it('ignores empty or malformed payloads', () => {
      const enabled = { postingEnabled: true };
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: null }, enabled
      )).toBeNull();
      expect(guards.validateLedgerPostingBoundary(
        { operation: 'upsert', payload: 'not-an-object' }, enabled
      )).toBeNull();
    });
  });
});

describe('examination batch writes — atomic status precondition', () => {
  it('sends the status precondition on the SAME PATCH that writes the row', async () => {
    let seenParams = null;
    cloud.patchImpl = (url, body, config) => {
      seenParams = config.params;
      return respondRow(batchRow({ version: 5 }));
    };

    const result = await cloudSyncStore.upsertRow(
      'examination_batches',
      'batch-1',
      { id: 'batch-1', _version: 4, status: 'Calculated', classes: [] },
      '2026-03-02T00:00:00Z',
      guards.buildBatchUpsertPrecondition({ status: 'Calculated' })
    );

    expect(result.conflicted).toBeUndefined();
    expect(seenParams).toEqual({
      id: 'eq.batch-1',
      version: 'eq.4',
      'data->>status': 'in.(draft,calculated)',
    });
  });

  it('rejects a stale device repricing an invoiced batch without any second write', async () => {
    cloud.row = batchRow();
    // PostgREST returns [] because WHERE status in (draft,calculated) matches nothing.
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.upsertRow(
      'examination_batches',
      'batch-1',
      { id: 'batch-1', _version: 1, status: 'Calculated', classes: [{ id: 'c1', live_total_preview: 999999 }] },
      '2026-03-02T00:00:00Z',
      guards.buildBatchUpsertPrecondition({ status: 'Calculated' })
    );

    expect(result.conflicted).toBe(true);
    expect(result.businessRule).toBe(true);
    expect(result.conflictType).toBe('BATCH_STATUS_PRECONDITION_FAILED');
    // A mergeable snapshot must accompany the rejection so the client can
    // reconcile without a blind retry.
    expect(result.server).toMatchObject({ id: 'batch-1', version: 4 });
    expect(result.server.data.status).toBe('invoiced');
    // Critically: no unconditional POST fallback may run.
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('classifies an ordinary version race as mergeable, not a business rejection', async () => {
    cloud.row = batchRow({
      version: 9,
      data: { batch_number: 'BTC-P726/001', status: 'calculated' },
    });
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.upsertRow(
      'examination_batches',
      'batch-1',
      { id: 'batch-1', _version: 8, status: 'Calculated' },
      '2026-03-02T00:00:00Z',
      guards.buildBatchUpsertPrecondition({ status: 'Calculated' })
    );

    // Status satisfies the filter, so the zero-row result is purely a version race.
    expect(result.conflictType).toBe('version_conflict');
    expect(result.businessRule).toBeUndefined();
    expect(result.server.version).toBe(9);
  });
});

describe('examination tombstone — must not bypass business rules', () => {
  it('rejects a tombstone against an invoiced batch and returns a mergeable server snapshot', async () => {
    cloud.row = batchRow();
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.softDeleteRow(
      'examination_batches',
      'batch-1',
      '2026-03-02T00:00:00Z',
      guards.buildBatchDeletePrecondition()
    );

    expect(result.conflicted).toBe(true);
    expect(result.conflictType).toBe('BATCH_TOMBSTONE_FORBIDDEN');
    expect(result.businessRule).toBe(true);
    // The client conflict path requires BOTH conflict and server, otherwise the
    // op retries forever instead of surfacing.
    expect(result.server).toMatchObject({ id: 'batch-1', version: 4 });
    expect(result.server.data.invoice_id).toBe('EXM-001/001');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('still allows a draft batch to be tombstoned', async () => {
    cloud.row = {
      id: 'batch-2',
      version: 2,
      updated_at: '2026-03-01T00:00:00Z',
      data: { batch_number: 'BTC-P726/002', status: 'draft' },
    };
    let seenParams = null;
    cloud.patchImpl = (url, body, config) => {
      seenParams = config.params;
      return respondRow({
        id: 'batch-2',
        version: 3,
        updated_at: '2026-03-02T00:00:00Z',
        data: { batch_number: 'BTC-P726/002', status: 'draft', deleted: true },
      });
    };

    const result = await cloudSyncStore.softDeleteRow(
      'examination_batches',
      'batch-2',
      '2026-03-02T00:00:00Z',
      guards.buildBatchDeletePrecondition()
    );

    expect(result.deleted).toBe(true);
    expect(seenParams['data->>status']).toBe(LOCKED_FILTER);
  });

  it('does not fall through to an unconditional POST when the guard rejects', async () => {
    cloud.row = batchRow();
    cloud.patchImpl = () => {
      throw Object.assign(new Error('conflict'), { response: { status: 409, data: 'conflict' } });
    };

    const result = await cloudSyncStore.softDeleteRow(
      'examination_batches',
      'batch-1',
      '2026-03-02T00:00:00Z',
      guards.buildBatchDeletePrecondition()
    );

    expect(result.conflictType).toBe('BATCH_TOMBSTONE_FORBIDDEN');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns a mergeable snapshot on a plain delete version conflict too', async () => {
    // Regression: the delete conflict path used to omit `server`, and the client
    // requires both `conflict` and `server` before it will surface a conflict.
    cloud.row = {
      id: 'batch-3',
      version: 11,
      updated_at: '2026-03-01T00:00:00Z',
      data: { batch_number: 'BTC-P726/003', status: 'draft' },
    };
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.softDeleteRow(
      'examination_batches',
      'batch-3',
      '2026-03-02T00:00:00Z',
      guards.buildBatchDeletePrecondition()
    );

    expect(result.conflicted).toBe(true);
    expect(result.conflictType).toBe('version_conflict');
    expect(result.server).toMatchObject({ id: 'batch-3', version: 11 });
  });
});

describe('applyOp — examination conflict surfacing', () => {
  const examOp = (overrides = {}) => ({
    operationId: `op-exam-${Math.random().toString(36).slice(2, 9)}`,
    table: 'examination_batches',
    recordId: 'batch-1',
    operation: 'upsert',
    syncGeneration: 1,
    ...overrides,
  });

  it('reports a business rejection as non-retryable so it surfaces instead of looping', async () => {
    cloud.row = batchRow();
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.applyOp(examOp({
      payload: { id: 'batch-1', status: 'Calculated', _version: 4 },
      precondition: guards.buildBatchUpsertPrecondition({ status: 'Calculated' }),
    }));

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.businessRule).toBe(true);
    // Non-retryable is the key property: a retry cannot make this write legal.
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/approved pricing is immutable/i);
    expect(result.server).toMatchObject({ id: 'batch-1' });
  });

  it('keeps a genuine version race retryable', async () => {
    cloud.row = batchRow({
      version: 7,
      data: { batch_number: 'BTC-P726/001', status: 'calculated' },
    });
    cloud.patchImpl = () => ({ data: [] });

    const result = await cloudSyncStore.applyOp(examOp({
      payload: { id: 'batch-1', status: 'Calculated', _version: 3 },
      precondition: guards.buildBatchUpsertPrecondition({ status: 'Calculated' }),
    }));

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.businessRule).toBeUndefined();
    expect(result.server.version).toBe(7);
  });

  it('accepts a legal transition end to end', async () => {
    cloud.row = batchRow({ version: 4, data: { batch_number: 'BTC-P726/001', status: 'approved' } });
    cloud.patchImpl = () => respondRow(batchRow({ version: 5, data: { status: 'invoiced' } }));

    const result = await cloudSyncStore.applyOp(examOp({
      payload: { id: 'batch-1', status: 'Invoiced', invoice_id: 'EXM-001/009', _version: 4 },
      precondition: guards.buildBatchUpsertPrecondition({ status: 'Invoiced' }),
    }));

    expect(result.ok).toBe(true);
    expect(result.version).toBe(5);
  });

  it('treats a duplicate delivery of an already-applied operation as a no-op replay', async () => {
    cloud.row = batchRow();
    cloud.idempotencyReplayed = true;

    const result = await cloudSyncStore.applyOp(examOp({
      operationId: 'op-exam-duplicate',
      payload: { id: 'batch-1', status: 'Invoiced', _version: 4 },
    }));

    expect(result.ok).toBe(true);
    expect(result.replayed).toBe(true);
    expect(result.id).toBe('batch-1');
    // The replay must not issue a second write.
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejects an operation with no sync generation as stale', async () => {
    const result = await cloudSyncStore.applyOp(examOp({
      syncGeneration: undefined,
      payload: { id: 'batch-1', status: 'Invoiced' },
    }));

    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('SYNC_GENERATION_MISSING');
  });

  it('rejects an unsupported operation type before touching the cloud', async () => {
    const result = await cloudSyncStore.applyOp(examOp({
      operation: 'patch',
      payload: { id: 'batch-1', status: 'Invoiced' },
    }));

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(axios.patch).not.toHaveBeenCalled();
  });
});