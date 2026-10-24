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

describe('Printing-contract tombstones', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('rejects stale queued upsert for a deleted contract ID (non-retryable)', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [{
        table: 'assessment_contracts',
        recordId: 'muw72uei-a4m5xlb',
        operation: 'upsert',
        syncGeneration: 1,
        payload: { id: 'muw72uei-a4m5xlb', contract_number: 'PC-P726/022', title: 'stale', company_id: 'default' },
      }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].retryable).toBe(false);
    expect(res.body.results[0].error).toMatch(/permanently deleted/i);
  });

  it('rejects stale queued upsert for a deleted item ID (non-retryable)', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [{
        table: 'assessment_contract_items',
        recordId: 'muw72uek-pvx8fej',
        operation: 'upsert',
        syncGeneration: 1,
        payload: { id: 'muw72uek-pvx8fej', data: { contract_id: 'muw72uei-a4m5xlb' } },
      }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].retryable).toBe(false);
    expect(res.body.results[0].error).toMatch(/permanently deleted/i);
  });

  it('rejects an item whose contract_id is a deleted contract (non-retryable)', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [{
        table: 'assessment_contract_items',
        recordId: 'brand-new-item',
        operation: 'upsert',
        syncGeneration: 1,
        payload: { id: 'brand-new-item', data: { contract_id: 'muyjt81k-ulskisr' } },
      }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].retryable).toBe(false);
    expect(res.body.results[0].error).toMatch(/belongs to a permanently deleted contract/i);
  });

  it('still allows a normal new contract to pass', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [{
        table: 'assessment_contracts',
        recordId: 'new-contract-test',
        operation: 'upsert',
        syncGeneration: 1,
        payload: { id: 'new-contract-test', contract_number: 'PC-TEST-NEW', title: 'Printing contract', company_id: 'default' },
      }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
  });

  it('still allows a legitimate update to a retained contract to pass', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ops: [{
        table: 'assessment_contracts',
        recordId: 'mv9cu3m9-xvztaei',
        operation: 'upsert',
        syncGeneration: 1,
        payload: { id: 'mv9cu3m9-xvztaei', contract_number: 'PC-P726/023', title: 'Testing', company_id: 'default' },
      }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
  });

  it('repeated stale upsert deliveries remain non-retryable', async () => {
    const op = {
      table: 'assessment_contracts',
      recordId: 'mv9chbeg-9h5i09n',
      operation: 'upsert',
      syncGeneration: 1,
      payload: { id: 'mv9chbeg-9h5i09n', contract_number: 'PC-P726/001', title: 'stale', company_id: 'default' },
    };
    const first = await request(app).post('/api/sync/ops').set('Authorization', `Bearer ${adminToken()}`).send({ ops: [op] });
    const second = await request(app).post('/api/sync/ops').set('Authorization', `Bearer ${adminToken()}`).send({ ops: [op] });
    expect(first.body.results[0].retryable).toBe(false);
    expect(second.body.results[0].retryable).toBe(false);
  });
});