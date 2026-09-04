/**
 * Sync Generation Tests
 *
 * Tests the company reset generation feature:
 *  1. Server rejects operations with stale syncGeneration
 *  2. Server accepts operations with current syncGeneration
 *  3. Server rejects operations with missing syncGeneration after a reset
 *  4. Server accepts operations with no generation when server is at generation 1
 *  5. GET /api/sync/generation returns current generation
 *  6. POST /api/sync/reset increments generation (admin only)
 *  7. Non-admin cannot call reset
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.JWT_SECRET = 'test-jwt-secret';

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
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

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

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Sync Generation — stale operation rejection', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.resetAllMocks(); });

  const adminToken = makeToken({ id: 'admin-1', role: 'Admin', email: 'admin@test.com' });
  const respond = (body, status = 200) => ({ status, data: Array.isArray(body) ? body : [body] });

  describe('applyOp — generation check', () => {
    it('accepts an operation with syncGeneration matching server generation (gen 1)', async () => {
      axios.get
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 1 } }))
        .mockResolvedValueOnce(respond([]));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-1',
        table: 'products',
        recordId: 'prod-1',
        operation: 'upsert',
        payload: { id: 'prod-1', name: 'Test' },
        syncGeneration: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.stale).toBeUndefined();
    });

    it('rejects an operation with syncGeneration lower than server generation', async () => {
      axios.get.mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 2 } }));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-2',
        table: 'products',
        recordId: 'prod-2',
        operation: 'upsert',
        payload: { id: 'prod-2', name: 'Old' },
        syncGeneration: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.reason).toBe('SYNC_GENERATION_STALE');
      expect(result.retryable).toBe(false);
    });

    it('rejects an operation with NO syncGeneration after a reset (server at gen 2)', async () => {
      axios.get.mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 2 } }));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-3',
        table: 'customers',
        recordId: 'cust-1',
        operation: 'upsert',
        payload: { id: 'cust-1', name: 'No Gen' },
      });

      expect(result.ok).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.reason).toBe('SYNC_GENERATION_MISSING');
      expect(result.retryable).toBe(false);
    });

    it('accepts an operation with NO syncGeneration when server is at generation 1 (backward compat)', async () => {
      axios.get
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 1 } }))
        .mockResolvedValueOnce(respond([]));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-4',
        table: 'customers',
        recordId: 'cust-2',
        operation: 'upsert',
        payload: { id: 'cust-2', name: 'Compat' },
      });

      expect(result.ok).toBe(true);
      expect(result.stale).toBeUndefined();
    });

    it('accepts an operation with syncGeneration equal to server generation (gen 3)', async () => {
      axios.get
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 3 } }))
        .mockResolvedValueOnce(respond([]));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-5',
        table: 'products',
        recordId: 'prod-5',
        operation: 'upsert',
        payload: { id: 'prod-5', name: 'Gen3' },
        syncGeneration: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.stale).toBeUndefined();
    });

    it('rejects an operation from generation 1 when server is at generation 3', async () => {
      axios.get.mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 3 } }));

      const result = await require('../../services/cloudSyncStore.cjs').applyOp({
        operationId: 'op-6',
        table: 'products',
        recordId: 'prod-6',
        operation: 'upsert',
        payload: { id: 'prod-6', name: 'Old Gen1' },
        syncGeneration: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.reason).toBe('SYNC_GENERATION_STALE');
      expect(result.retryable).toBe(false);
    });
  });

  describe('GET /api/sync/generation', () => {
    it('returns current generation from settings table', async () => {
      axios.get.mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 5 } }));

      const res = await request(app)
        .get('/api/sync/generation')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.generation).toBe(5);
    });

    it('returns generation 1 when settings row is absent', async () => {
      axios.get.mockResolvedValueOnce(respond([]));

      const res = await request(app)
        .get('/api/sync/generation')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.generation).toBe(1);
    });

    it('requires authentication', async () => {
      const res = await request(app).get('/api/sync/generation');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/sync/reset', () => {
    it('increments generation and returns new value (admin)', async () => {
      axios.get
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 1 } }))
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 1 }, updated_at: '2026-01-01T00:00:00Z', version: 1 }))
        .mockResolvedValueOnce(respond({ id: 'sync_generation', data: { value: 2 }, updated_at: '2026-01-02T00:00:00Z', version: 2 }));

      const res = await request(app)
        .post('/api/sync/reset')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.previousGeneration).toBe(1);
      expect(res.body.generation).toBe(2);
    });

    it('rejects non-admin users with 403', async () => {
      const userToken = makeToken({ id: 'user-1', role: 'User', email: 'user@test.com' });

      const res = await request(app)
        .post('/api/sync/reset')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin role required to reset company data');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).post('/api/sync/reset');
      expect(res.status).toBe(401);
    });

    it('rejects portal_customer with 403', async () => {
      const portalToken = makeToken({ id: 'portal-1', role: 'portal_customer', email: 'portal@test.com' });

      const res = await request(app)
        .post('/api/sync/reset')
        .set('Authorization', `Bearer ${portalToken}`);

      expect(res.status).toBe(403);
    });
  });
});
