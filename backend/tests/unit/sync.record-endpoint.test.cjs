/**
 * Security tests for GET /api/sync/ops/record/:table/:recordId
 *
 * This endpoint exists solely for the ERP invoice-recovery existence check.
 * Verifies:
 *   1. Unauthenticated requests → 401 (global verifyToken + route gate)
 *   2. portal_customer tokens → 403
 *   3. Non-Admin ERP roles (User, Manager) → 403 (Admin-only read)
 *   4. Admin + allowlisted table (invoices) + valid recordId → 200 { exists, record }
 *   5. Admin + any OTHER table (even sync-write-allowed tables like
 *      products / ledger_entries / customers) → 400 'table not allowed'
 *      — the endpoint is NOT a generic record reader; changing :table can
 *      never widen access beyond the recovery read set.
 *   6. Malformed / invalid table names → 400
 *   7. Malformed recordId (un-decodable percent-sequence) → 400 (not 500)
 *   8. No cloud read is issued for rejected requests
 *   9. Existing /api/sync behavior (gateway health, POST /ops gate) is intact
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

const ADMIN_TOKEN = makeToken({ id: 'admin-1', role: 'Admin', email: 'admin@test.com' });

describe('GET /api/sync/ops/record/:table/:recordId — authentication & authorization', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032');

    // The global verifyToken middleware stops unauthenticated callers with
    // 401 before the route handler runs ('Access denied'); the route's own
    // 401 branch ('Unauthenticated') is defense-in-depth. Either 401 body is
    // correct — no data may be returned.
    expect(res.status).toBe(401);
    expect(['Access denied', 'Unauthenticated']).toContain(res.body.error);
  });

  it('rejects portal_customer tokens with 403', async () => {
    const token = makeToken({ id: 'portal-user-1', role: 'portal_customer', email: 'cust@test.com' });

    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.message).toContain('Admin');
  });

  it('rejects legacy User role with 403 (Admin-only read)', async () => {
    const token = makeToken({ id: 'user-1', role: 'User', email: 'user@test.com' });

    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('rejects Manager role with 403 (endpoint is strictly Admin)', async () => {
    const token = makeToken({ id: 'mgr-1', role: 'Manager', email: 'mgr@test.com' });

    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/sync/ops/record — table scoping (no arbitrary table reads)', () => {
  let app;
  const axiosMock = require('axios');

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    axiosMock.get.mockClear();
    axiosMock.get.mockResolvedValue({ data: [] });
  });

  it('serves an Admin a scoped read of an invoices record (absent)', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.record).toBeNull();

    // The cloud read must target the invoices table with the exact record id.
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    const [url, config] = axiosMock.get.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/invoices');
    expect(config.params).toEqual({ select: '*', id: 'eq.INV-P726/032', limit: 1 });
  });

  it('serves an Admin a scoped read of an invoices record (present)', async () => {
    const row = { id: 'INV-P726/032', data: { customerName: 'Kataila Primary School' }, updated_at: '2026-08-01T00:00:00.000Z' };
    axiosMock.get.mockResolvedValueOnce({ data: [row] });

    const res = await request(app)
      .get('/api/sync/ops/record/invoices/INV-P726%2F032')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.record).toEqual(row);
  });

  it('rejects a sync-write-allowed but recovery-unlisted table (products) with 400', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/products/P-001')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('table not allowed');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('rejects sensitive business tables (customers, ledger_entries, bank_transactions) with 400', async () => {
    for (const table of ['customers', 'ledger_entries', 'bank_transactions', 'employees']) {
      const res = await request(app)
        .get(`/api/sync/ops/record/${table}/SOME-ID`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('table not allowed');
    }
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('rejects a malformed table name (pattern violation) with 400', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/products%3Bdrop/x')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid table');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('rejects an upper-case table name with 400', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/INVOICES/INV-P726%2F032')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid table');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('rejects a malformed recordId (un-decodable percent-sequence) with 400, not 500', async () => {
    const res = await request(app)
      .get('/api/sync/ops/record/invoices/%zz')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    // Un-decodable percent-sequences are rejected by the router layer with a
    // 400 BEFORE the handler runs. What matters for safety: no 5xx, no record
    // payload is ever returned, and no cloud read is issued.
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('"exists":true');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('rejects an oversized recordId (>200 chars) with 400 invalid recordId', async () => {
    const longId = 'A'.repeat(201);
    const res = await request(app)
      .get(`/api/sync/ops/record/invoices/${longId}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid recordId');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/sync/ops/record — regression guard for existing sync behavior', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('GET /api/sync/health still reports gateway availability to an Admin', async () => {
    // /api/sync/health sits behind the global verifyToken (existing behavior),
    // so an authenticated Admin is required. This guards that the probe route
    // is still registered and unmodified.
    const res = await request(app)
      .get('/api/sync/health')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cloud).toBe(true);
  });

  it('POST /api/sync/ops still enforces the Admin-only write gate', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .send({ ops: [{ table: 'products', recordId: 'r1', operation: 'upsert', payload: {} }] });

    expect(res.status).toBe(401);
  });

  it('POST /api/sync/ops for an Admin still validates tables per-op', async () => {
    const res = await request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ops: [{ table: 'nonexistent_table_xyz', recordId: 'r1', operation: 'upsert', payload: {} }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toContain('table not allowed');
  });
});
