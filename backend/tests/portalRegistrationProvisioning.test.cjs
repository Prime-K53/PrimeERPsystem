/**
 * Phase 4 registration-provisioning tests — hermetic.
 *
 * Covers the provisioning service (supabasePortalAuthAdmin.cjs) by unit
 * (injected adminApi/repo fakes) and the approval integration end to end
 * (real customerRegistrationService + real provisioning service, Admin API
 * at a mocked axios boundary, stores in memory).
 *
 * Mandatory matrix:
 *   Provisioning 1-12 · identity integrity 13-16 · registration boundary
 *   17-21 · Phase 3 regression via existing suites (reported separately).
 *
 * No network, no database, no real Auth users. Env is stubbed per-test and
 * restored afterwards — never the developer's real .env.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-phase4-provisioning';
process.env.SUPABASE_URL = 'https://test-ref.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_phase4_test_key';

const SAVED_ENV = {};
for (const k of ['PORTAL_SUPABASE_REGISTRATION_PROVISIONING', 'ALLOW_HEADER_AUTH']) {
  SAVED_ENV[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
}
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── In-memory stores ─────────────────────────────────────────────────────────
const tables = new Map(); // envelope tables: customer_registration_requests
const canonical = new Map(); // canonical tables: customers
const portalUsers = new Map(); // portal_users rows

function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

jest.mock('../services/supabaseRepository.cjs', () => ({
  isConfigured: () => false,
  getAll: jest.fn(async (table) => [...tableMap(table).values()]),
  getById: jest.fn(async (table, id) => tableMap(table).get(String(id)) || null),
  upsert: jest.fn(async (table, obj) => {
    tableMap(table).set(String(obj.id), { ...obj });
    return { ...obj };
  }),
  softDelete: jest.fn(async () => null),
  portalEntities: {
    portal_users: {
      getAll: jest.fn(async () => [...portalUsers.values()]),
      getById: jest.fn(async (id) => portalUsers.get(String(id)) || null),
      getByEmail: jest.fn(async (email) =>
        [...portalUsers.values()].find((u) => String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) || null),
      getByCustomerId: jest.fn(async (cid) =>
        [...portalUsers.values()].find((u) => u.customer_id === cid) || null),
      listByCustomerId: jest.fn(async (cid) =>
        [...portalUsers.values()].filter((u) => u.customer_id === cid)),
      getByAuthUserId: jest.fn(async (sub) =>
        [...portalUsers.values()].find((u) => u.auth_user_id === sub) || null),
      upsert: jest.fn(async (row) => {
        portalUsers.set(String(row.id), { ...(portalUsers.get(String(row.id)) || {}), ...row });
        return { ...portalUsers.get(String(row.id)) };
      }),
      update: jest.fn(async (id, updates) => {
        const cur = portalUsers.get(String(id));
        if (!cur) throw new Error('Portal user not found');
        Object.assign(cur, updates);
        return { ...cur };
      }),
    },
    portal_sessions: { getAll: jest.fn(async () => []), getById: jest.fn(async () => null), upsert: jest.fn(async () => null), update: jest.fn(async () => null) },
    portal_password_resets: { getAll: jest.fn(async () => []), getById: jest.fn(async () => null), upsert: jest.fn(async () => null), update: jest.fn(async () => null) },
    portal_login_history: { getAll: jest.fn(async () => []), getById: jest.fn(async () => null), upsert: jest.fn(async () => null) },
  },
}));

jest.mock('../services/supabaseCanonicalRepository.cjs', () => ({
  getById: jest.fn(async (table, id) => (canonical.get(table) || new Map()).get(String(id)) || null),
  getAll: jest.fn(async (table) => [...(canonical.get(table) || new Map()).values()]),
  upsert: jest.fn(async (table, obj) => {
    if (!canonical.has(table)) canonical.set(table, new Map());
    canonical.get(table).set(String(obj.id), { ...obj });
    return { ...obj };
  }),
  softDelete: jest.fn(async () => null),
}));

jest.mock('../services/workflowEngine.cjs', () => ({
  nextYearScopedNumber: jest.fn(async (table, column, prefix) => `${prefix}-2026-000001`),
}));

jest.mock('../services/portalLifecycleService.cjs', () => ({
  publishErpEvent: jest.fn(async () => ({ published: true })),
  adminListRequests: jest.fn(async () => []),
  adminGetRequest: jest.fn(async () => null),
}));

jest.mock('../services/portalAuthService.cjs', () => ({
  ACCESS_TOKEN_EXPIRY: '30m',
  getPortalUserByEmail: jest.fn(async (email) =>
    [...portalUsers.values()].find((u) => String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) || null),
  registerPortalUser: jest.fn(async ({ customer_id, email, password, full_name, phone, status }) => {
    const id = `pusr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const row = {
      id, customer_id, email: String(email).toLowerCase().trim(),
      password_hash: `bcrypt-stub-for:${String(email).toLowerCase().trim()}`,
      full_name: full_name || null, phone: phone || null,
      status: status || 'invited', auth_user_id: null,
    };
    portalUsers.set(id, row);
    return { id, customer_id, email: row.email, full_name: row.full_name, phone: row.phone, status: row.status };
  }),
  createInviteCode: jest.fn(async () => ({ code: '123456', expires_at: null })),
}));

jest.mock('../services/referralService.cjs', () => {
  const MockReferralService = jest.fn().mockImplementation(() => ({
    normalizePhone: (phone) => (phone === null || phone === undefined || phone === '' ? null : String(phone)),
    normalizeEmail: (email) => (email === null || email === undefined ? null : String(email).toLowerCase().trim()),
    normalizeOrg: (org) => (org === null || org === undefined || org === '' ? null : String(org).toLowerCase().trim()),
    checkFraudSignals: jest.fn(async () => []),
    generateReferralCode: jest.fn(async () => 'TESTCODE'),
    register: jest.fn(async () => ({ id: 'ref_1' })),
    _get: jest.fn(async () => null),
    getAll: jest.fn(async () => ({ referrals: [] })),
  }));
  return MockReferralService;
});

jest.mock('../auditService.cjs', () => ({
  auditService: { logEvent: jest.fn(async () => ({ id: 'audit-1' })) },
}));

jest.mock('axios');

const express = require('express');
const request = require('supertest');
const axios = require('axios');

const provisioning = require('../services/supabasePortalAuthAdmin.cjs');
const registration = require('../services/customerRegistrationService.cjs');

const AUTH_UUID_1 = '22222222-3333-4444-8555-666666666666';
const AUTH_UUID_2 = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

// ─── Mock Admin API transport (axios boundary) ───────────────────────────────
const adminState = { mode: 'create-ok', calls: [] };
function resetAdminState() {
  adminState.mode = 'create-ok';
  adminState.calls = [];
}
function adminUrl(path) {
  return `https://test-ref.supabase.co/auth/v1${path}`;
}
axios.post.mockImplementation(async (url, body) => {
  adminState.calls.push({ method: 'POST', url, body });
  if (url === adminUrl('/admin/users')) {
    if (adminState.mode === 'create-fail') {
      const err = new Error('boom');
      err.response = { status: 500, data: { msg: 'internal' } };
      throw err;
    }
    if (adminState.mode === 'create-taken-empty' || adminState.mode === 'create-taken-resolve' || adminState.mode === 'create-taken-ambiguous') {
      const err = new Error('email exists');
      err.response = { status: 422, data: { msg: 'email_exists: Email already registered' } };
      throw err;
    }
    return { data: { id: AUTH_UUID_1, email: body.email } };
  }
  throw new Error(`unexpected POST ${url}`);
});
axios.get.mockImplementation(async (url) => {
  adminState.calls.push({ method: 'GET', url });
  const single = url.match(/\/admin\/users\/([^/?]+)$/);
  if (single) {
    if (adminState.mode === 'get-missing') {
      const err = new Error('not found');
      err.response = { status: 404, data: { msg: 'not found' } };
      throw err;
    }
    return { data: { id: decodeURIComponent(single[1]), email: adminState.userEmail || 'derived@prime.mw' } };
  }
  if (url === adminUrl('/admin/users')) {
    if (adminState.mode === 'create-taken-resolve') {
      return { data: { users: [{ id: AUTH_UUID_2, email: adminState.userEmail }] } };
    }
    if (adminState.mode === 'create-taken-ambiguous') {
      return { data: { users: [{ id: AUTH_UUID_1, email: adminState.userEmail }, { id: AUTH_UUID_2, email: adminState.userEmail }] } };
    }
    return { data: { users: [] } };
  }
  throw new Error(`unexpected GET ${url}`);
});

function seedPortalUser(overrides = {}) {
  const row = {
    id: 'pusr_seed_1', customer_id: 'CUST-0001', email: 'derived@prime.mw',
    password_hash: 'bcrypt-stub-original', full_name: 'Seed User',
    phone: null, status: 'invited', auth_user_id: null,
    ...overrides,
  };
  portalUsers.set(row.id, { ...row });
  return row;
}

function memRepo() {
  return {
    getById: async (id) => portalUsers.get(String(id)) || null,
    getByAuthUserId: async (sub) => [...portalUsers.values()].find((u) => u.auth_user_id === sub) || null,
    update: async (id, updates) => {
      const cur = portalUsers.get(String(id));
      if (!cur) throw new Error('Portal user not found');
      Object.assign(cur, updates);
      return { ...cur };
    },
  };
}

function fakeAdminApi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async createUser(email) {
      calls.push({ op: 'createUser', email });
      if (behavior.createThrow) throw behavior.createThrow;
      if (behavior.taken) return { taken: true };
      return { id: behavior.createdId || AUTH_UUID_1 };
    },
    async getUser(id) {
      calls.push({ op: 'getUser', id });
      if (behavior.getMissing) return null;
      return { id, email: behavior.userEmail || 'derived@prime.mw' };
    },
    async listUsersByEmail(email) {
      calls.push({ op: 'listUsersByEmail', email });
      return behavior.listResult !== undefined ? behavior.listResult : [];
    },
  };
}

beforeEach(() => {
  tables.clear();
  canonical.clear();
  portalUsers.clear();
  jest.clearAllMocks();
  resetAdminState();
  delete process.env.PORTAL_SUPABASE_REGISTRATION_PROVISIONING;
  delete process.env.ALLOW_HEADER_AUTH;
});

// ─── Provisioning unit ──────────────────────────────────────────────────────

describe('provisioning service', () => {
  test('1: new Portal user → creates Auth user + persists UUID', async () => {
    seedPortalUser();
    const api = fakeAdminApi();
    const res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    expect(res).toEqual({ ok: true, authUserId: AUTH_UUID_1, idempotent: false });
    expect(api.calls.filter((c) => c.op === 'createUser')).toHaveLength(1);
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBe(AUTH_UUID_1);
  });

  test('2: repeated provisioning → idempotent (no second create)', async () => {
    seedPortalUser();
    const api = fakeAdminApi();
    await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    const res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    expect(res).toEqual({ ok: true, authUserId: AUTH_UUID_1, idempotent: true });
    expect(api.calls.filter((c) => c.op === 'createUser')).toHaveLength(1);
  });

  test('3: existing auth_user_id → verified, no duplicate Auth user', async () => {
    seedPortalUser({ auth_user_id: AUTH_UUID_1 });
    const api = fakeAdminApi();
    const res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    expect(res.idempotent).toBe(true);
    expect(api.calls.filter((c) => c.op === 'createUser')).toHaveLength(0);
    expect(api.calls.filter((c) => c.op === 'getUser')).toHaveLength(1);
  });

  test('4: existing Auth email → safe resolution to the single match', async () => {
    seedPortalUser();
    const api = fakeAdminApi({ taken: true, listResult: [{ id: AUTH_UUID_2, email: 'derived@prime.mw' }] });
    const res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    expect(res).toEqual({ ok: true, authUserId: AUTH_UUID_2, idempotent: false });
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBe(AUTH_UUID_2);
  });

  test('5: ambiguous Auth identity → fail safely, no mapping written', async () => {
    seedPortalUser();
    const api = fakeAdminApi({ taken: true, listResult: [{ id: AUTH_UUID_1, email: 'derived@prime.mw' }, { id: AUTH_UUID_2, email: 'derived@prime.mw' }] });
    await expect(provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() }))
      .rejects.toMatchObject({ code: 'EMAIL_AMBIGUOUS' });
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBeNull();
  });

  test('6: Auth creation failure → no fake mapping', async () => {
    seedPortalUser();
    const err = new Error('down');
    err.code = 'AUTH_ADMIN_FAILED';
    const api = fakeAdminApi({ createThrow: err });
    await expect(provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() }))
      .rejects.toMatchObject({ code: 'AUTH_ADMIN_FAILED' });
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBeNull();
  });

  test('7: mapping persistence failure → observable/retryable, row unchanged', async () => {
    seedPortalUser();
    const api = fakeAdminApi();
    const badRepo = { ...memRepo(), update: async () => { throw new Error('db down'); } };
    await expect(provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: badRepo }))
      .rejects.toMatchObject({ code: 'MAPPING_PERSIST_FAILED' });
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBeNull();
  });

  test('8: concurrent/repeated create race → single identity, no duplicate business row', async () => {
    seedPortalUser();
    let created = 0;
    const api = {
      calls: [],
      async createUser(email) {
        created += 1;
        if (created === 1) return { id: AUTH_UUID_1 };
        return { taken: true }; // loser sees the winner's email
      },
      async getUser(id) { return { id, email: 'derived@prime.mw' }; },
      async listUsersByEmail() { return [{ id: AUTH_UUID_1, email: 'derived@prime.mw' }]; },
    };
    const [a, b] = await Promise.all([
      provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() }),
      provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() }),
    ]);
    expect(a.authUserId).toBe(AUTH_UUID_1);
    expect(b.authUserId).toBe(AUTH_UUID_1);
    expect(portalUsers.size).toBe(1);
    expect(portalUsers.get('pusr_seed_1').auth_user_id).toBe(AUTH_UUID_1);
  });

  test('9: no password copied from the legacy bcrypt hash', async () => {
    seedPortalUser({ password_hash: 'bcrypt-stub-original' });
    const api = fakeAdminApi();
    await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    expect(api.calls[0].op).toBe('createUser');
    expect(api.calls[0].email).toBe('derived@prime.mw');
    expect(portalUsers.get('pusr_seed_1').password_hash).toBe('bcrypt-stub-original');
  });

  test('10: no password/token material returned or logged', async () => {
    seedPortalUser();
    const api = fakeAdminApi();
    const logged = [];
    const origWarn = console.warn;
    const origError = console.error;
    const origLog = console.log;
    console.warn = (...a) => { logged.push(a.join(' ')); };
    console.error = (...a) => { logged.push(a.join(' ')); };
    console.log = (...a) => { logged.push(a.join(' ')); };
    let res;
    try {
      res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: api, repo: memRepo() });
    } finally {
      console.warn = origWarn;
      console.error = origError;
      console.log = origLog;
    }
    expect(Object.keys(res).sort()).toEqual(['authUserId', 'idempotent', 'ok']);
    expect(JSON.stringify(res)).not.toMatch(/password|secret|token|Bearer|action_link|refresh/i);
    expect(logged.join('\n')).not.toMatch(/password|secret|Bearer|action_link/i);
  });

  test('11: no service-role secret exposed via config or calls', async () => {
    const cfg = provisioning.getAuthAdminConfig();
    expect(cfg.configured).toBe(true);
    expect('serviceKey' in cfg).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain('sb_secret_phase4_test_key');
    seedPortalUser();
    await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: fakeAdminApi(), repo: memRepo() });
    for (const c of adminState.calls) {
      expect(JSON.stringify(c)).not.toContain('sb_secret_phase4_test_key');
    }
  });

  test('12: no Auth tokens returned', async () => {
    seedPortalUser();
    const res = await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: fakeAdminApi(), repo: memRepo() });
    expect(JSON.stringify(res)).not.toMatch(/access_token|refresh_token|action_link/i);
  });
});

// ─── Identity integrity ─────────────────────────────────────────────────────

describe('identity integrity', () => {
  test('13–16: UUID lands only in auth_user_id; ids keep their families; no tenant dimensions', async () => {
    seedPortalUser();
    const before = { ...portalUsers.get('pusr_seed_1') };
    await provisioning.provisionPortalUser({ portalUserId: 'pusr_seed_1', adminApi: fakeAdminApi(), repo: memRepo() });
    const after = portalUsers.get('pusr_seed_1');
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual(['auth_user_id']);
    expect(after.id).toBe('pusr_seed_1');
    expect(after.id).toMatch(/^pusr_/);
    for (const k of Object.keys(after)) {
      expect(k).not.toMatch(/tenant|organization|company_id/i);
    }
  });
});

// ─── Registration boundary (approval integration) ───────────────────────────

const APPLICANT = () => ({
  companyName: 'Zomba Stationers',
  contactName: 'Peter Phiri',
  email: 'peter.phiri@example.com',
  phone: '0999123456',
});

describe('registration boundary', () => {
  test('17: public registration remains PENDING-only (no provisioning)', async () => {
    const record = await registration.createRegistrationRequest(APPLICANT());
    expect(record.status).toBe('pending');
    expect([...tableMap('customers').values()]).toHaveLength(0);
    expect(canonical.get('customers') ? [...canonical.get('customers').values()] : []).toHaveLength(0);
    expect(portalUsers.size).toBe(0);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('18: retired /register remains 410', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/portal/auth', require('../routes/portalAuth.cjs'));
    const res = await request(app)
      .post('/api/portal/auth/register')
      .send({ companyName: 'X', contactName: 'Y', email: 'z@example.com', password: 'secret-1' })
      .expect(410);
    expect(res.body.code).toBe('PORTAL_REGISTER_RETIRED');
  });

  test('19+21: only approval triggers provisioning (flag ON)', async () => {
    process.env.PORTAL_SUPABASE_REGISTRATION_PROVISIONING = 'true';
    const record = await registration.createRegistrationRequest(APPLICANT());
    expect(axios.post).not.toHaveBeenCalled();
    const result = await registration.approveRequest(record.id, { reviewedBy: 'admin-1' });
    expect(result.customerId).toMatch(/^CUST-\d{4}$/);
    expect(result.portalUserId).toMatch(/^pusr_/);
    expect(result.inviteCode).toBe('123456');
    expect(result.provisioning).toEqual({ status: 'provisioned' });
    expect(result.authUserId).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/action_link|refresh_token|access_token|secret/i);
    const row = portalUsers.get(result.portalUserId);
    expect(row.auth_user_id).toBe(AUTH_UUID_1);
    expect(row.id).toMatch(/^pusr_/);
    expect(result.customerId).toMatch(/^CUST-/);
  });

  test('20: flag OFF preserves previous approval behavior exactly', async () => {
    const record = await registration.createRegistrationRequest(APPLICANT());
    const result = await registration.approveRequest(record.id, { reviewedBy: 'admin-1' });
    expect(result.customerId).toMatch(/^CUST-\d{4}$/);
    expect(result.portalUserId).toMatch(/^pusr_/);
    expect(result.inviteCode).toBe('123456');
    expect('provisioning' in result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
    expect(portalUsers.get(result.portalUserId).auth_user_id).toBeNull();
  });

  test('retry: re-approving provisions without duplicating business records', async () => {
    process.env.PORTAL_SUPABASE_REGISTRATION_PROVISIONING = 'true';
    adminState.mode = 'create-fail';
    const record = await registration.createRegistrationRequest(APPLICANT());
    const first = await registration.approveRequest(record.id, { reviewedBy: 'admin-1' });
    expect(first.provisioning).toEqual({ status: 'pending', reason: 'AUTH_ADMIN_FAILED' });
    expect(portalUsers.get(first.portalUserId).auth_user_id).toBeNull();
    const customersBefore = [...canonical.get('customers').values()].length;
    const usersBefore = portalUsers.size;
    adminState.mode = 'create-ok';
    const retry = await registration.approveRequest(record.id, { reviewedBy: 'admin-1' });
    expect(retry.alreadyApproved).toBe(true);
    expect(retry.provisioning).toEqual({ status: 'provisioned' });
    expect([...canonical.get('customers').values()]).toHaveLength(customersBefore);
    expect(portalUsers.size).toBe(usersBefore);
    expect(portalUsers.get(first.portalUserId).auth_user_id).toBe(AUTH_UUID_1);
  });

  test('approve route contract: safe provisioning field, no uuid/tokens/links', async () => {
    process.env.PORTAL_SUPABASE_REGISTRATION_PROVISIONING = 'true';
    process.env.ALLOW_HEADER_AUTH = 'true';
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use('/api/portal/admin', require('../routes/portalAdmin.cjs'));
    const record = await registration.createRegistrationRequest(APPLICANT());
    const res = await request(adminApp)
      .post(`/api/portal/admin/registration-requests/${record.id}/approve`)
      .set({ 'x-user-id': 'admin-1', 'x-user-role': 'Admin', 'x-user-email': 'admin@prime.mw' })
      .send({})
      .expect(200);
    expect(res.body.provisioning).toEqual({ status: 'provisioned' });
    expect(res.body.authUserId).toBeUndefined();
    expect(res.body.auth_user_id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/action_link|refresh_token|access_token|sb_secret/i);
  });
});
