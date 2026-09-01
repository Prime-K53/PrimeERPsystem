/**
 * auth.role-model.test.cjs
 *
 * Regression tests for the Prime ERP Admin-only role model.
 * Covers:
 *   - backend/middleware/roles.cjs          canonical role helpers
 *   - backend/middleware/auth.cjs           verifyToken + requireRole
 *   - backend/routes/sync.cjs               POST /api/sync/ops
 *   - GET /api/payment-requests             Admin-only
 *
 * Run: npx jest backend/tests/unit/auth.role-model.test.cjs --forceExit
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-role-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.ALLOW_HEADER_AUTH = 'false';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');

beforeEach(() => { jest.resetModules(); });

/** Build a minimal Express app: verifyToken → routes */
function buildErpApp() {
  jest.resetModules();
  jest.doMock('axios', () => {
    const instance = {
      get: jest.fn().mockResolvedValue({ data: [] }),
      post: jest.fn().mockResolvedValue({ data: [] }),
      patch: jest.fn().mockResolvedValue({ data: [] }),
      delete: jest.fn(),
    };
    instance.create = jest.fn(() => instance);
    return instance;
  });

  const app = express();
  app.use(express.json());

  const { verifyToken, requireRole } = require('../../middleware/auth.cjs');
  app.use('/api', verifyToken);

  app.use('/api/sync', require('../../routes/sync.cjs'));

  // Mirror of the inline GET /api/payment-requests route in index.cjs
  app.get('/api/payment-requests', requireRole('Admin'), (req, res) => {
    res.json([{ id: 'pr-1', status: 'requested' }]);
  });

  return app;
}

/** Build a token signed with the test JWT_SECRET */
function makeBackendToken(payload) {
  return jwt.sign({ role: 'Admin', username: 'admin@test.com', ...payload }, 'test-jwt-secret-for-role-tests', { expiresIn: '1h' });
}

// ─── Canonical role helpers ─────────────────────────────────────────────────

describe('backend/middleware/roles.cjs — canonical role model', () => {
  let roles;
  beforeAll(() => {
    roles = require('../../middleware/roles.cjs');
  });

  test.each([
    ['admin', true],
    ['Admin', true],
    ['ADMIN', true],
    ['portal_customer', false],
    ['', false],
    ['User', false],
    ['Clerk', false],
    ['Manager', false],
    ['random', false],
    [null, false],
    [undefined, false],
    [123, false],
  ])('isAdmin(%p) = %p', (input, expected) => {
    expect(roles.isAdmin(input)).toBe(expected);
  });

  test.each([
    ['portal_customer', true],
    ['Portal_Customer', true],
    ['PORTAL_CUSTOMER', true],
    ['admin', false],
    ['', false],
    ['User', false],
  ])('isPortalCustomer(%p) = %p', (input, expected) => {
    expect(roles.isPortalCustomer(input)).toBe(expected);
  });

  test.each([
    ['admin', 'admin'],
    ['Admin', 'admin'],
    ['ADMIN', 'admin'],
    ['portal_customer', 'portal_customer'],
    ['PORTAL_CUSTOMER', 'portal_customer'],
    ['User', 'user'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('normalize(%p) = %p', (input, expected) => {
    expect(roles.normalize(input)).toBe(expected);
  });

  test('resolveRole returns ROLE_ADMIN for valid admin user', () => {
    expect(roles.resolveRole({ role: 'Admin' })).toBe('admin');
    expect(roles.resolveRole({ role: 'admin' })).toBe('admin');
  });

  test('resolveRole returns ROLE_PORTAL_CUSTOMER for portal customer', () => {
    expect(roles.resolveRole({ role: 'portal_customer' })).toBe('portal_customer');
  });

  test('resolveRole returns ROLE_ANONYMOUS for null/undefined', () => {
    expect(roles.resolveRole(null)).toBe('anonymous');
    expect(roles.resolveRole(undefined)).toBe('anonymous');
    expect(roles.resolveRole({})).toBe('anonymous');
    expect(roles.resolveRole({ role: '' })).toBe('anonymous');
  });
});

// ─── requireRole middleware ──────────────────────────────────────────────────

describe('requireRole — Admin-only gate', () => {
  let app;

  beforeAll(() => {
    app = buildErpApp();
  });

  test('401 when no token is provided', () => {
    return request(app)
      .get('/api/payment-requests')
      .expect(401);
  });

  test('403 when user role is portal_customer', () => {
    const token = jwt.sign(
      { id: 'cust-1', role: 'portal_customer', email: 'cust@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('401 when user role is empty string (treated as unauthenticated)', () => {
    const token = jwt.sign(
      { id: 'user-1', role: '', email: 'user@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  test('403 for legacy non-Admin role (User)', () => {
    const token = jwt.sign(
      { id: 'user-1', role: 'User', email: 'user@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .then((res) => {
        expect(res.body.error).toBe('Insufficient permissions');
      });
  });

  test('200 when user role is Admin', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'Admin' });
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  test('200 when user role is lowercase admin', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'admin' });
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  test('200 when user role is uppercase ADMIN', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'ADMIN' });
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

// ─── POST /api/sync/ops ─────────────────────────────────────────────────────

describe('POST /api/sync/ops — Admin-only gateway', () => {
  let app;

  beforeAll(() => {
    app = buildErpApp();
  });

  const validOp = { table: 'products', recordId: 'prod-1', operation: 'upsert', payload: { name: 'Test' } };

  test('401 when no token is provided', () => {
    return request(app)
      .post('/api/sync/ops')
      .send({ ops: [validOp] })
      .expect(401)
      .then((res) => {
        // Global verifyToken returns 401 with 'Access denied' / 'No
        // authentication token provided' before reaching the sync
        // route handler.
        expect(res.status).toBe(401);
      });
  });

  test('403 when role is portal_customer', () => {
    const token = jwt.sign(
      { id: 'cust-1', role: 'portal_customer', email: 'cust@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(403)
      .then((res) => {
        expect(res.body.message).toContain('Admin');
      });
  });

  test('401 when role is empty string (treated as unauthenticated)', () => {
    const token = jwt.sign(
      { id: 'user-1', role: '', email: 'user@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(401);
  });

  test('403 when role is User (legacy non-Admin)', () => {
    const token = jwt.sign(
      { id: 'user-1', role: 'User', email: 'user@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(403)
      .then((res) => {
        expect(res.body.message).toContain('Admin');
      });
  });

  test('403 when role is Accountant (legacy non-Admin)', () => {
    const token = jwt.sign(
      { id: 'acc-1', role: 'Accountant', email: 'acc@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(403);
  });

  test('403 for unknown role', () => {
    const token = jwt.sign(
      { id: 'rando-1', role: 'random_role', email: 'rando@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(403);
  });

  test('200 when role is Admin (table not allowed passes through to table validation)', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'Admin' });
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [{ table: 'nonexistent_table_xyz', recordId: 'r1', operation: 'upsert', payload: {} }] })
      .expect(200)
      .then((res) => {
        expect(res.body.results[0].error).toContain('table not allowed');
      });
  });

  test('200 when role is lowercase admin', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'admin' });
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [{ table: 'nonexistent_table_xyz', recordId: 'r1', operation: 'upsert', payload: {} }] })
      .expect(200);
  });

  test('401 for expired token', () => {
    const token = jwt.sign(
      { id: 'admin-1', role: 'Admin', email: 'admin@test.com' },
      'test-jwt-secret-for-role-tests',
      { expiresIn: '-1s' }
    );
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', `Bearer ${token}`)
      .send({ ops: [validOp] })
      .expect(401);
  });

  test('401 for invalid token', () => {
    return request(app)
      .post('/api/sync/ops')
      .set('Authorization', 'Bearer invalid.token.here')
      .send({ ops: [validOp] })
      .expect(401);
  });
});

// ─── GET /api/payment-requests ──────────────────────────────────────────────

describe('GET /api/payment-requests — Admin-only', () => {
  let app;

  beforeAll(() => {
    app = buildErpApp();
  });

  test('401 when no token is provided', () => {
    return request(app)
      .get('/api/payment-requests')
      .expect(401);
  });

  test('403 when role is portal_customer', () => {
    const token = jwt.sign(
      { id: 'cust-1', role: 'portal_customer', email: 'cust@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('403 for legacy non-Admin role (User)', () => {
    const token = jwt.sign(
      { id: 'user-1', role: 'User', email: 'user@test.com' },
      'test-jwt-secret-for-role-tests'
    );
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  test('200 when role is Admin', () => {
    const token = makeBackendToken({ id: 'admin-1', role: 'Admin' });
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  test('401 for invalid token', () => {
    return request(app)
      .get('/api/payment-requests')
      .set('Authorization', 'Bearer invalid.token.here')
      .expect(401);
  });
});

// ─── Supabase JWT verification path ────────────────────────────────────────

describe('verifyToken — Supabase JWT role resolution', () => {
  function buildTestAppWithMockedAxios(mockAxiosResponse) {
    jest.resetModules();
    jest.doMock('axios', () => {
      const instance = {
        get: jest.fn().mockResolvedValue({ data: mockAxiosResponse }),
      };
      instance.create = jest.fn(() => instance);
      return instance;
    });

    const app = express();
    app.use(express.json());
    const { verifyToken } = require('../../middleware/auth.cjs');
    app.use('/api', verifyToken);
    app.get('/api/test', (req, res) => res.json({ role: req.user.role, isSuperAdmin: req.user.isSuperAdmin }));
    return app;
  }

  test('Supabase user with role=admin in metadata is treated as Admin', () => {
    const app = buildTestAppWithMockedAxios({
      id: 'sb-admin-1',
      email: 'sb-admin@test.com',
      user_metadata: { role: 'admin', is_super_admin: false },
    });
    const sbToken = jwt.sign({ foo: 'bar' }, 'any-jwt');
    return request(app)
      .get('/api/test')
      .set('Authorization', `Bearer ${sbToken}`)
      .expect(200)
      .then((res) => {
        expect(res.body.role).toBe('Admin');
      });
  });

  test('Supabase user with is_super_admin=true is treated as Admin even without role metadata', () => {
    const app = buildTestAppWithMockedAxios({
      id: 'sb-super-1',
      email: 'super@test.com',
      user_metadata: { is_super_admin: true },
    });
    const sbToken = jwt.sign({ foo: 'bar' }, 'any-jwt');
    return request(app)
      .get('/api/test')
      .set('Authorization', `Bearer ${sbToken}`)
      .expect(200)
      .then((res) => {
        expect(res.body.role).toBe('Admin');
        expect(res.body.isSuperAdmin).toBe(true);
      });
  });

  test('Supabase user with role=portal_customer in metadata is treated as portal_customer', () => {
    const app = buildTestAppWithMockedAxios({
      id: 'sb-cust-1',
      email: 'cust@test.com',
      user_metadata: { role: 'portal_customer' },
    });
    const sbToken = jwt.sign({ foo: 'bar' }, 'any-jwt');
    return request(app)
      .get('/api/test')
      .set('Authorization', `Bearer ${sbToken}`)
      .expect(200)
      .then((res) => {
        expect(res.body.role).toBe('portal_customer');
      });
  });

  test('Supabase user with no role metadata and not super_admin falls back to portal_customer', () => {
    const app = buildTestAppWithMockedAxios({
      id: 'sb-orphan-1',
      email: 'orphan@test.com',
      user_metadata: {},
    });
    const sbToken = jwt.sign({ foo: 'bar' }, 'any-jwt');
    return request(app)
      .get('/api/test')
      .set('Authorization', `Bearer ${sbToken}`)
      .expect(200)
      .then((res) => {
        // No Admin role metadata → must NOT be treated as Admin.
        expect(res.body.role).toBe('portal_customer');
      });
  });
});