/**
 * syncSchemaMissing.test.cjs
 *
 * A sync op that targets a table missing from the deployed schema (e.g.
 * `contract_documents` before migration 0049 is applied) must:
 *   - stay NON-retryable (retrying cannot fix a missing table),
 *   - be flagged `schemaMissing` with a documented recovery path, and
 *   - never be reported as a generic dead-letter with no explanation.
 *
 * Mocked axios — no network, no credentials, no writes.
 */
const missingError = () => {
  const err = new Error('Request failed with status code 404');
  err.response = {
    status: 404,
    data: {
      code: 'PGRST205',
      message: "Could not find the table 'public.contract_documents' in the schema cache",
    },
  };
  return err;
};

jest.mock('axios', () => {
  const instance = {
    get: jest.fn(async () => ({ data: [] })),
    post: jest.fn(async () => { throw missingError(); }),
    patch: jest.fn(async () => { throw missingError(); }),
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

describe('sync op against a missing table', () => {
  it('classifies PGRST205 as a permanent schema failure with a recovery path', async () => {
    const result = await cloudSyncStore.applyOp({
      table: 'contract_documents',
      operation: 'upsert',
      recordId: 'SCH-1',
      syncGeneration: 1,
      payload: { id: 'SCH-1', contentHash: 'a'.repeat(64) },
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.schemaMissing).toBe(true);
    expect(result.error).toMatch(/PGRST205|schema cache/i);
    expect(result.recovery).toMatch(/migration/i);
    expect(result.recovery).toMatch(/dead-letter/i);
  });

  it('does not flag an ordinary 4xx (RLS/validation) as a schema failure', async () => {
    const instance = require('axios').__instance;
    instance.get.mockImplementationOnce(async () => ({ data: [] }));
    instance.post.mockImplementationOnce(async () => {
      const err = new Error('Request failed with status code 403');
      err.response = { status: 403, data: { code: '42501', message: 'permission denied for table contract_documents' } };
      throw err;
    });

    const result = await cloudSyncStore.applyOp({
      table: 'contract_documents',
      operation: 'upsert',
      recordId: 'SCH-2',
      syncGeneration: 1,
      payload: { id: 'SCH-2', contentHash: 'b'.repeat(64) },
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.schemaMissing).toBeUndefined();
    expect(result.recovery).toBeUndefined();
  });
});
