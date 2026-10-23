/**
 * contractDocumentSyncClassification.test.cjs
 *
 * A deterministic database rejection must be SURFACED, never retried.
 *
 * PostgREST answers HTTP 409 for both a lost optimistic-concurrency race
 * (retryable — re-reading the row resolves it) and a deterministic rejection:
 * a unique violation (23505) or a trigger refusal (P0001, e.g. the
 * contract-document immutability trigger). Classifying every 409 as retryable
 * re-sends a write that can never succeed, forever.
 *
 * Mocked axios — no network, no credentials, no writes.
 */
const state = { postError: null, getResponse: { data: [] } };

jest.mock('axios', () => {
  const instance = {
    get: jest.fn(async () => state.getResponse),
    post: jest.fn(async () => {
      if (state.postError) throw state.postError;
      return { data: [{ id: 'SCH-1', data: {}, version: 1 }] };
    }),
    patch: jest.fn(async () => {
      if (state.postError) throw state.postError;
      return { data: [{ id: 'SCH-1', data: {}, version: 2 }] };
    }),
    delete: jest.fn(async () => ({ data: [] })),
  };
  const mock = () => instance;
  mock.create = () => instance;
  mock.__instance = instance;
  return mock;
});

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SECRET_KEY = 'test-secret';

const cloudSyncStore = require('../services/cloudSyncStore.cjs');

const httpError = (status, body) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: body };
  return err;
};

const apply = () => cloudSyncStore.applyOp({
  operationId: 'op-1',
  table: 'contract_documents',
  recordId: 'SCH-cid-1-v1',
  operation: 'upsert',
  syncGeneration: 1,
  payload: {
    id: 'SCH-cid-1-v1',
    contract_id: 'cid-1',
    documentType: 'printing_contract_schedule',
    documentNumber: 'PC-1',
    documentVersion: 1,
    status: 'VALID',
    contentHash: 'a'.repeat(64),
  },
});

beforeEach(() => {
  state.postError = null;
  state.getResponse = { data: [] };
});

describe('sync error classification for contract documents', () => {
  it('treats a unique violation (23505) as permanent and surfaces it', async () => {
    state.postError = httpError(409, {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_contract_documents_schedule_identity"',
      details: null,
      hint: null,
    });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictType).toBe('unique_violation');
  });

  it('treats a trigger refusal (P0001) as permanent and surfaces it', async () => {
    state.postError = httpError(409, {
      code: 'P0001',
      message: 'contract_documents: issued content is immutable (id=SCH-cid-1-v1)',
      details: null,
      hint: null,
    });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictType).toBe('trigger_rejected');
    expect(result.conflictReason).toMatch(/immutable/i);
  });

  it('keeps a 409 without a SQLSTATE retryable (optimistic-concurrency race)', async () => {
    state.postError = httpError(409, { message: 'conflict' });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.conflictType).toBeUndefined();
  });

  it('keeps a 5xx retryable', async () => {
    state.postError = httpError(500, { message: 'internal error' });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('keeps a network failure retryable', async () => {
    state.postError = new Error('socket hang up');
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('treats a 400 as permanent', async () => {
    state.postError = httpError(400, { code: '22P02', message: 'invalid input syntax for type integer' });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('treats a raised trigger exception (400 + P0001) as a labelled permanent failure', async () => {
    // PostgREST maps RAISE EXCEPTION (SQLSTATE P0001) to HTTP 400, not 409.
    // The database's contract-document immutability trigger refuses writes that
    // way, so the gateway must recognise it, keep it permanent and label it.
    state.postError = httpError(400, {
      code: 'P0001',
      message: 'contract_documents: issued content is immutable (id=SCH-cid-1-v1)',
      details: null,
      hint: null,
    });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictType).toBe('trigger_rejected');
    // The database's own message is preserved for diagnosis.
    expect(result.conflictReason).toMatch(/immutable/i);
  });

  it('does not label an ordinary 400 as a trigger rejection', async () => {
    state.postError = httpError(400, { code: 'PGRST106', message: 'unexpected parameter' });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.conflictType).toBeUndefined();
  });

  it('reports a missing table as a schema condition with a recovery path', async () => {
    state.postError = httpError(404, {
      code: 'PGRST205',
      message: "Could not find the table 'public.contract_documents' in the schema cache",
    });
    const result = await apply();
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.schemaMissing).toBe(true);
    expect(result.recovery).toMatch(/migration/i);
  });
});
