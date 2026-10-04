/**
 * Printing-contract numbering guard tests for POST /api/sync/ops.
 *
 * Verifies that an assessment_contracts upsert whose contract_number
 * is already held by a different LIVE contract is rejected as a clean,
 * non-retryable failure (so the client dead-letters the op and the user
 * renumbers), while tombstoned rows, free numbers, and a failed probe
 * all let the write through to the normal applyOp path.
 *
 * The uniqueness probe (cloudSyncStore.findRowsByDataField) is the
 * first axios.get of the request: verifyToken verifies these locally
 * signed JWTs without any cloud call, so the mockResolvedValueOnce
 * below always targets the probe.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('axios', () => {
  const instance = {
    get: jest.fn().mockResolvedValue({ data: [] }),
    post: jest.fn().mockResolvedValue({ data: [] }),
    patch: jest.fn().mockResolvedValue({ data: [] }),
    delete: jest.fn(),
  };
  instance.create = jest.fn(() => instance);
  return instance;
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWT_SECRET = 'test-jwt-secret';

function buildApp() {
  const app = express();
  app.use(express.json());

  const { verifyToken } = require('../../middleware/auth.cjs');
  app.use('/api', verifyToken);

  const syncRoutes = require('../../routes/sync.cjs');
  app.use('/api/sync', syncRoutes);

  return app;
}

function adminToken() {
  return jwt.sign({ id: 'admin-1', role: 'Admin', email: 'admin@test.com' }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Printing-contract numbering guard (assessment_contracts)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  const baseOp = {
    table: 'assessment_contracts',
    recordId: 'contract-new',
    operation: 'upsert',
    syncGeneration: 1,
    payload: {
      id: 'contract-new',
      contract_number: 'PC-0001',
      title: 'Printing contract',
      company_id: 'default',
    },
  };

  it('rejects a contract_number already held by a different live contract (non-retryable)', async () => {
    // Uniqueness probe: a live row with a different id holds PC-0001.
    axios.get.mockResolvedValueOnce({
      data: [{ id: 'contract-existing', data: { contract_number: 'PC-0001' } }],
    });

    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [baseOp] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].retryable).toBe(false);
    expect(res.body.results[0].error).toContain('already used by another printing contract');
  });

  it('ignores tombstoned rows when checking contract_number', async () => {
    // The only row holding PC-0001 is a tombstone — the number is free again.
    axios.get.mockResolvedValueOnce({
      data: [{ id: 'contract-old', data: { contract_number: 'PC-0001', deleted: true } }],
    });

    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [baseOp] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
  });

  it('passes a free contract_number through to the write path', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [baseOp] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
  });

  it('never blocks the write when the uniqueness probe fails', async () => {
    // Probe throws (network) — the partial unique index is the atomic
    // backstop, so the write must still be attempted.
    axios.get.mockRejectedValueOnce(new Error('Network Error'));

    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [baseOp] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
  });
});
