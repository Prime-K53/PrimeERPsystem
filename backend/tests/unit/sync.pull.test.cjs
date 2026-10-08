/**
 * P1 pull-gateway tests for GET /api/sync/pull.
 *
 * Verifies that the pull endpoint:
 *   1. Rejects unauthenticated requests with 401
 *   2. Rejects portal_customer tokens with 403 (Admin-only)
 *   3. Rejects non-Admin ERP roles with 403
 *   4. Rejects arbitrary/non-allow-listed tables with 400
 *   5. Rejects invalid `since` cursors with 400
 *   6. Returns paged rows with pagination metadata (offset/limit/count/hasMore)
 *   7. Forwards cursor + pagination to the cloud read (incremental semantics)
 *   8. Returns 502 (never an empty success) when the cloud read fails
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

const adminAuth = () =>
  `Bearer ${makeToken({ id: 'admin-1', role: 'Admin', email: 'admin@test.com' })}`;

describe('P1 - sync pull gateway (GET /api/sync/pull)', () => {
  let app;
  let http;
  beforeAll(() => {
    app = buildApp();
    http = require('axios').create();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    http.get.mockResolvedValue({ data: [] });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/sync/pull').query({ table: 'products' });
    expect(res.status).toBe(401);
  });

  it('rejects portal_customer tokens with 403', async () => {
    const token = makeToken({ id: 'portal-1', role: 'portal_customer', email: 'cust@test.com' });
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', `Bearer ${token}`)
      .query({ table: 'products' });
    expect(res.status).toBe(403);
  });

  it('rejects non-Admin ERP roles with 403', async () => {
    const token = makeToken({ id: 'user-1', role: 'User', email: 'user@test.com' });
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', `Bearer ${token}`)
      .query({ table: 'products' });
    expect(res.status).toBe(403);
  });

  it('rejects tables outside the allow-list with 400', async () => {
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'pg_shadow' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('rejects malformed table names with 400', async () => {
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'products;DROP TABLE products' });
    expect(res.status).toBe(400);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('rejects invalid since cursors with 400', async () => {
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'products', since: 'not-a-timestamp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('returns rows with pagination metadata and hasMore when the page is full', async () => {
    const rows = [
      { id: 'a', data: { id: 'a' }, updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', data: { id: 'b' }, updated_at: '2026-01-02T00:00:00.000Z' },
    ];
    http.get.mockResolvedValue({ data: rows });

    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'products', offset: 0, limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.table).toBe('products');
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.page).toMatchObject({ offset: 0, limit: 2, count: 2, hasMore: true });
  });

  it('marks the final page with hasMore=false', async () => {
    http.get.mockResolvedValue({ data: [{ id: 'a', data: {}, updated_at: '2026-01-01T00:00:00.000Z' }] });

    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'settings', offset: 0, limit: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.page).toMatchObject({ count: 1, hasMore: false });
  });

  it('forwards the incremental cursor and pagination to the cloud read', async () => {
    http.get.mockResolvedValue({ data: [] });

    await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'settings', since: '2026-02-01T00:00:00.000Z', offset: 2000, limit: 500 });

    expect(http.get).toHaveBeenCalledTimes(1);
    const [url, config] = http.get.mock.calls[0];
    expect(url).toContain('/rest/v1/settings');
    expect(config.params.select).toBe('*');
    expect(config.params.updated_at).toBe('gte.2026-02-01T00:00:00.000Z');
    expect(config.params.offset).toBe(2000);
    expect(config.params.limit).toBe(500);
    expect(String(config.params.order)).toContain('updated_at.asc');
  });

  it('clamps unbounded limits to the page maximum', async () => {
    http.get.mockResolvedValue({ data: [] });

    await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'products', limit: 999999 });

    const [, config] = http.get.mock.calls[0];
    expect(config.params.limit).toBe(2000);
  });

  it('returns 502 (never an empty success) when the cloud read fails', async () => {
    const cloudErr = new Error('connection closed');
    cloudErr.response = { status: 502 };
    http.get.mockRejectedValue(cloudErr);

    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', adminAuth())
      .query({ table: 'products' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Cloud pull failed/);
  });
});
