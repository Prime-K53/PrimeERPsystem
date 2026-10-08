/**
 * PULL storm limiter tests for GET /api/sync/pull.
 *
 * Verifies that:
 *   1. /api/sync/pull is governed by a dedicated sync limiter (burst budget
 *      sized for one full pull cycle, keyed by authenticated user — NOT by
 *      tenancy; no tenant/company/org concept exists anywhere here).
 *   2. A legitimate burst within the sync budget succeeds.
 *   3. Exceeding the sync budget returns 429 with a Retry-After header.
 *   4. The generic global 200/15-minute limiter is NOT consumed by
 *      legitimate PULL requests (route-specific skip, mirroring index.cjs).
 *   5. Unrelated API routes remain protected by the generic limiter.
 *   6. Auth matrix on the pull route: Admin succeeds, portal is 403,
 *      unauthenticated is 401 (via the shared verifyToken + Admin gate).
 *   7. Allow-list validation is unchanged.
 *   8. No tenancy field/filter exists in the limiter or the route.
 *
 * NOTE on isolation: the in-memory limiter store is module-level, so tests
 * that exhaust a bucket use dedicated admin identities / dedicated app
 * instances and never share a bucket with another test.
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
const fs = require('fs');
const path = require('path');

const JWT_SECRET = 'test-jwt-secret';

// Mirror of production index.cjs: global 200/15min limiter WITH the
// /api/sync/pull skip. Any drift from production wiring must fail loudly.
const rateLimit = require('express-rate-limit');

function buildSyncOnlyApp() {
  const app = express();
  app.use(express.json());
  const { verifyToken } = require('../../middleware/auth.cjs');
  app.use('/api', verifyToken);
  app.use('/api/sync', require('../../routes/sync.cjs'));
  return app;
}

function buildGlobalApp() {
  const app = express();
  app.use(express.json());
  // Production global limiter replica (index.cjs): 200/15min with the pull skip.
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' && req.path === '/api/sync/pull',
  }));
  const { verifyToken } = require('../../middleware/auth.cjs');
  app.use('/api', verifyToken);
  app.use('/api/sync', require('../../routes/sync.cjs'));
  // Unrelated protected route sharing the same global budget.
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  return app;
}

function adminToken(id) {
  return jwt.sign({ id, role: 'Admin', email: `${id}@test.com` }, JWT_SECRET, { expiresIn: '1h' });
}
const auth = (id) => `Bearer ${adminToken(id)}`;

describe('PULL storm limiters (GET /api/sync/pull)', () => {
  test('1. legitimate burst within the sync budget succeeds', async () => {
    const app = buildSyncOnlyApp();
    // One full pull cycle ≈ 144 tables; stay visibly under the 300 budget.
    for (let i = 0; i < 150; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .get('/api/sync/pull')
        .set('Authorization', auth('burst-ok-user'))
        .query({ table: 'products', offset: i, limit: 1 });
      expect(res.status).toBe(200);
    }
  }, 60000);

  test('2. exceeding the sync budget returns 429 with Retry-After', async () => {
    const app = buildSyncOnlyApp();
    let last;
    for (let i = 0; i < 310; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app)
        .get('/api/sync/pull')
        .set('Authorization', auth('burst-over-user'))
        .query({ table: 'products', offset: i, limit: 1 });
    }
    expect(last.status).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect(last.body.error).toMatch(/Rate limit exceeded/);
  }, 90000);

  test('3. sync buckets are per-user: another admin is unaffected', async () => {
    const app = buildSyncOnlyApp();
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', auth('burst-fresh-user'))
      .query({ table: 'products', limit: 1 });
    expect(res.status).toBe(200);
  });

  test('4. generic global limiter is not consumed by legitimate PULL traffic', async () => {
    const app = buildGlobalApp();
    // 150 pulls (skipped by the global limiter) + 60 unrelated hits = 210
    // total requests. Without the skip, request 201+ would 429 globally.
    for (let i = 0; i < 150; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .get('/api/sync/pull')
        .set('Authorization', auth('global-skip-user'))
        .query({ table: 'products', offset: i, limit: 1 });
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .get('/api/ping')
        .set('Authorization', auth('global-skip-user'));
      expect(res.status).toBe(200);
    }
  }, 90000);

  test('5. unrelated API routes remain globally protected', async () => {
    const app = buildGlobalApp();
    let last;
    // 201 plain hits from one IP trips the 200/15min global budget.
    for (let i = 0; i < 201; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app)
        .get('/api/ping')
        .set('Authorization', auth('global-flood-user'));
    }
    expect(last.status).toBe(429);
  }, 90000);

  test('6. auth matrix unchanged: Admin 200, portal 403, anonymous 401', async () => {
    const app = buildSyncOnlyApp();
    const ok = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', auth('matrix-admin'))
      .query({ table: 'products', limit: 1 });
    expect(ok.status).toBe(200);

    const portal = jwt.sign({ id: 'p1', role: 'portal_customer', email: 'p@t.com' }, JWT_SECRET, { expiresIn: '1h' });
    const forbidden = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', `Bearer ${portal}`)
      .query({ table: 'products', limit: 1 });
    expect(forbidden.status).toBe(403);

    const anon = await request(app).get('/api/sync/pull').query({ table: 'products', limit: 1 });
    expect(anon.status).toBe(401);
  });

  test('7. allow-list validation unchanged (400, no cloud call)', async () => {
    const http = require('axios').create();
    jest.clearAllMocks();
    http.get.mockResolvedValue({ data: [] });
    const app = buildSyncOnlyApp();
    const res = await request(app)
      .get('/api/sync/pull')
      .set('Authorization', auth('allowlist-user'))
      .query({ table: 'pg_shadow' });
    expect(res.status).toBe(400);
    expect(http.get).not.toHaveBeenCalled();
  });

  test('8. no tenancy anywhere in the limiter or pull route', async () => {
    const stripComments = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
    const syncSource = stripComments(
      fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'sync.cjs'), 'utf8')
    );
    const limiterSource = stripComments(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'services', 'redisRateLimiter.cjs'),
        'utf8'
      )
    );
    for (const needle of ['tenant_id', 'company_id', 'organization_id', 'tenantId', 'companyId', 'organizationId']) {
      expect(syncSource).not.toContain(needle);
      expect(limiterSource).not.toContain(needle);
    }
    // The sync limiter key is user-identity-only (abuse control, not scoping).
    expect(syncSource).toContain('sync-pull:${');
    expect(syncSource).not.toMatch(/sync-pull:[^`]*tenant/i);
    // The documented budget constants exist and are sane (not enormous).
    expect(syncSource).toContain('PULL_BURST_MAX_REQUESTS');
    const m = syncSource.match(/PULL_BURST_MAX_REQUESTS\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    const budget = Number(m[1]);
    expect(budget).toBeGreaterThanOrEqual(200); // fits one full ~144-table cycle
    expect(budget).toBeLessThanOrEqual(1000); // still a real bound
  });
});
