/**
 * Phase 3 operational-gate regression tests — hermetic.
 *
 * Proves the two pre-dual-auth gates are closed WITHOUT touching:
 *   - Supabase JWKS verification (services/supabasePortalIdentity.cjs)
 *   - legacy Portal password login / /refresh / /logout
 *   - registration-request business rules, auth_user_id schema, RLS, MFA.
 *
 * Gate 1 — legacy self-registration retired (Tests A–D):
 *   POST /api/portal/auth/register → 410 Gone + stable machine-readable code,
 *   creates NO customer / portal user / session / token, echoes NO password.
 *   POST /api/portal/registration-requests still creates exactly one PENDING
 *   request with ZERO credential material.
 *
 * Gate 2 — header authentication fail-closed (Tests F–I):
 *   With ALLOW_HEADER_AUTH=false, header-only requests are rejected on both
 *   the staff verifyToken path and the portal-admin path. Header auth is
 *   accepted only when explicitly enabled in this controlled file (loopback
 *   supertest origin). Normal staff JWT authentication is unaffected.
 *
 * No test reads the developer's real backend/.env: ALLOW_HEADER_AUTH and
 * JWT_SECRET are stubbed per-test and restored afterwards. No network, no
 * database, no Supabase users.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-phase3-gates';

const SAVED_ALLOW_HEADER_AUTH = Object.prototype.hasOwnProperty.call(process.env, 'ALLOW_HEADER_AUTH')
  ? process.env.ALLOW_HEADER_AUTH
  : undefined;

function setAllowHeaderAuth(value) {
  if (value === undefined) delete process.env.ALLOW_HEADER_AUTH;
  else process.env.ALLOW_HEADER_AUTH = value;
}

afterAll(() => {
  setAllowHeaderAuth(SAVED_ALLOW_HEADER_AUTH);
});

jest.mock('../services/supabaseRepository.cjs', () => ({
  getById: jest.fn(),
  getAll: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
}));

jest.mock('../services/supabaseCanonicalRepository.cjs', () => ({
  getById: jest.fn(),
  getAll: jest.fn(),
  upsert: jest.fn(),
}));

jest.mock('../services/workflowEngine.cjs', () => ({
  nextYearScopedNumber: jest.fn(),
}));

jest.mock('../services/portalLifecycleService.cjs', () => ({
  publishErpEvent: jest.fn(),
  adminListRequests: jest.fn(),
  adminGetRequest: jest.fn(),
}));

jest.mock('../services/portalAuthService.cjs', () => ({
  ACCESS_TOKEN_EXPIRY: '30m',
  getPortalUserByEmail: jest.fn(),
  getPortalUserByCustomerId: jest.fn(),
  registerPortalUser: jest.fn(),
  syncCustomerPortalData: jest.fn(),
  createSession: jest.fn(),
}));

jest.mock('../services/referralService.cjs', () => {
  const state = { fraudSignals: [] };
  const MockReferralService = jest.fn().mockImplementation(() => ({
    checkFraudSignals: jest.fn(async () => state.fraudSignals),
    generateReferralCode: jest.fn(async () => 'TESTCODE'),
    register: jest.fn(async () => ({ id: 'ref_1' })),
    _get: jest.fn(async () => null),
  }));
  MockReferralService.__state = state;
  return MockReferralService;
});

jest.mock('../auditService.cjs', () => ({
  auditService: { logEvent: jest.fn() },
}));

const request = require('supertest');
const express = require('express');

const repo = require('../services/supabaseRepository.cjs');
const workflowEngine = require('../services/workflowEngine.cjs');
const portalLifecycle = require('../services/portalLifecycleService.cjs');
const portalAuthService = require('../services/portalAuthService.cjs');
const { auditService } = require('../auditService.cjs');
const staffAuth = require('../middleware/auth.cjs');

const tables = new Map();
function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

function buildLegacyAuthApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/auth', require('../routes/portalAuth.cjs'));
  return app;
}

function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/registration-requests', require('../routes/registrationRequests.cjs'));
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/admin', require('../routes/portalAdmin.cjs'));
  return app;
}

function buildStaffProbeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/probe', staffAuth.verifyToken, (req, res) => {
    res.json({ ok: true, authMode: req.authMode || 'api' });
  });
  return app;
}

const staffHeaders = {
  'x-user-id': 'admin-1',
  'x-user-role': 'Admin',
  'x-user-email': 'admin@prime.mw',
};

const staffJwt = () => staffAuth.generateToken({
  id: 'admin-1',
  username: 'admin@prime.mw',
  role: 'Admin',
  email: 'admin@prime.mw',
});

beforeEach(() => {
  tables.clear();
  jest.clearAllMocks();
  auditService.logEvent.mockResolvedValue({ id: 'audit-1' });
  portalLifecycle.publishErpEvent.mockResolvedValue({ published: true });

  let seq = 0;
  workflowEngine.nextYearScopedNumber.mockImplementation(async (table, column, prefix) => {
    seq += 1;
    return `${prefix}-2026-${String(seq).padStart(6, '0')}`;
  });

  repo.getAll.mockImplementation(async (table) => [...tableMap(table).values()]);
  repo.getById.mockImplementation(async (table, id) => tableMap(table).get(String(id)) || null);
  repo.upsert.mockImplementation(async (table, obj) => {
    tableMap(table).set(String(obj.id), { ...obj });
    return { ...obj };
  });

  portalAuthService.getPortalUserByEmail.mockResolvedValue(null);
  portalAuthService.registerPortalUser.mockImplementation(async (args) => ({ id: 'pusr_x', ...args }));
  portalAuthService.syncCustomerPortalData.mockResolvedValue(null);
  portalAuthService.createSession.mockResolvedValue({ id: 'sess_1' });
});

// ─── Gate 1: legacy /register retired ────────────────────────────────────────

describe('gate 1 — legacy POST /api/portal/auth/register retired', () => {
  test('A: unauthenticated request returns 410', async () => {
    await request(buildLegacyAuthApp())
      .post('/api/portal/auth/register')
      .send({
        companyName: 'Legacy Co',
        contactName: 'Legacy User',
        email: 'legacy@example.com',
        password: 'legacy-pass-1',
      })
      .expect(410);
  });

  test('B: response identifies the legacy path as retired', async () => {
    const res = await request(buildLegacyAuthApp())
      .post('/api/portal/auth/register')
      .send({
        companyName: 'Legacy Co',
        contactName: 'Legacy User',
        email: 'legacy@example.com',
        password: 'legacy-pass-1',
      })
      .expect(410);
    expect(res.body.code).toBe('PORTAL_REGISTER_RETIRED');
    expect(JSON.stringify(res.body)).toMatch(/registration-requests/);
  });

  test('C: rejected registration creates no customer/user/session/token', async () => {
    const res = await request(buildLegacyAuthApp())
      .post('/api/portal/auth/register')
      .send({
        companyName: 'Legacy Co',
        contactName: 'Legacy User',
        email: 'legacy@example.com',
        password: 'legacy-pass-1',
        phone: '0999000111',
      })
      .expect(410);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.refresh_token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/legacy-pass-1/);
    expect(portalAuthService.registerPortalUser).not.toHaveBeenCalled();
    expect(portalAuthService.syncCustomerPortalData).not.toHaveBeenCalled();
    expect(portalAuthService.createSession).not.toHaveBeenCalled();
  });

  test('D: registration-request flow still creates only a pending request', async () => {
    const res = await request(buildPublicApp())
      .post('/api/portal/registration-requests')
      .send({
        companyName: 'Zomba Stationers',
        contactName: 'Peter Phiri',
        email: 'peter.phiri@example.com',
        phone: '0999123456',
      })
      .expect(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.requestNumber).toMatch(/^CREG-2026-\d{6}$/);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.refresh_token).toBeUndefined();
    expect(res.body.portal_user).toBeUndefined();
    expect(res.body.customer_id).toBeUndefined();
    const stored = [...tableMap('customer_registration_requests').values()];
    expect(stored).toHaveLength(1);
    expect([...tableMap('customers').values()]).toHaveLength(0);
    expect([...tableMap('portal_users').values()]).toHaveLength(0);
  });
});

// ─── Gate 2: header authentication fail-closed ───────────────────────────────

describe('gate 2 — header authentication fail-closed', () => {
  test('F: header-only staff request rejected when ALLOW_HEADER_AUTH=false', async () => {
    setAllowHeaderAuth('false');
    await request(buildStaffProbeApp())
      .get('/api/probe')
      .set(staffHeaders)
      .expect(401);
  });

  test('G: header auth accepted only when explicitly enabled (controlled env)', async () => {
    setAllowHeaderAuth('true');
    const res = await request(buildStaffProbeApp())
      .get('/api/probe')
      .set(staffHeaders)
      .expect(200);
    expect(res.body.authMode).toBe('header');
    setAllowHeaderAuth('false');
    await request(buildStaffProbeApp())
      .get('/api/probe')
      .set(staffHeaders)
      .expect(401);
  });

  test('H: portal-admin cannot authorize from header alone when disabled', async () => {
    setAllowHeaderAuth('false');
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set(staffHeaders)
      .expect(403);
    // Anonymous callers stay rejected too.
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .expect(403);
  });

  test('H2: portal-admin header auth honored only when explicitly enabled', async () => {
    setAllowHeaderAuth('true');
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set(staffHeaders)
      .expect(200);
    setAllowHeaderAuth('false');
  });

  test('I: normal staff JWT authentication unaffected by disabled header auth', async () => {
    setAllowHeaderAuth('false');
    const probe = await request(buildStaffProbeApp())
      .get('/api/probe')
      .set('Authorization', `Bearer ${staffJwt()}`)
      .expect(200);
    expect(probe.body.ok).toBe(true);
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set('Authorization', `Bearer ${staffJwt()}`)
      .expect(200);
  });
});
