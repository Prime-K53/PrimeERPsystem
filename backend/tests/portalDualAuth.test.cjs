/**
 * Phase 3 authoritative dual-auth tests — hermetic.
 *
 * Exercises the SINGLE Portal authentication decision point
 * (middleware/portalAuth.cjs verifyPortalToken, flag-gated by
 * PORTAL_SUPABASE_DUAL_AUTH, default OFF) over real routers:
 *
 *   Step A — valid legacy Portal JWT → accepted as legacy, Supabase never runs.
 *   Step B — legacy failure + dual ON → JWKS Supabase path; sub →
 *            portal_users.auth_user_id → mapped ACTIVE row → req.portalUser
 *            built ONLY from the DB row (never from JWT claims).
 *   Step C — neither family → existing generic 401 (no family/mapping/crypto
 *            disclosure).
 *
 * Covered matrix (see test names for numbers):
 *   Legacy 1-3 · Supabase 4-14 · cross-family 15-20 · identity integrity
 *   21-24 · /me 25-28 · ownership 29-30 · flag-OFF rollback · /refresh
 *   legacy-only guard · route boundaries (Portal vs staff vs portal-admin).
 *
 * Hermetic: supabaseRepository is the in-memory stub, JWKS is a deterministic
 * mocked axios response (no network), no database, no Supabase users. Staff
 * Supabase fallbacks are disabled (no service/anon keys in this file's env).
 * Env is stubbed per-test and restored afterwards — never the real .env.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-portal-dual-auth';
process.env.SUPABASE_URL = 'https://test-ref.supabase.co';
for (const k of [
  'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_URL', 'SUPABASE_JWT_ISSUER', 'SUPABASE_JWT_AUDIENCE',
]) delete process.env[k];

const SAVED_DUAL = Object.prototype.hasOwnProperty.call(process.env, 'PORTAL_SUPABASE_DUAL_AUTH')
  ? process.env.PORTAL_SUPABASE_DUAL_AUTH
  : undefined;
afterAll(() => {
  if (SAVED_DUAL === undefined) delete process.env.PORTAL_SUPABASE_DUAL_AUTH;
  else process.env.PORTAL_SUPABASE_DUAL_AUTH = SAVED_DUAL;
});

jest.mock('../services/supabaseRepository.cjs', () =>
  require('./helpers/supabaseRepoStub.cjs').repo
);
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
jest.mock('axios');

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const repoStub = require('./helpers/supabaseRepoStub.cjs');
const portalAuthMw = require('../middleware/portalAuth.cjs');
const staffAuth = require('../middleware/auth.cjs');
const identity = require('../services/supabasePortalIdentity.cjs');

const ISS = 'https://test-ref.supabase.co/auth/v1';
const AUD = 'authenticated';
const MAPPED_SUB = '11111111-2222-4333-8444-555555555555';
const OTHER_SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ── Deterministic JWKS fixture ───────────────────────────────────────────────
const RSA_KID = 'rsa-dual-key-1';
const EC_KID = 'ec-dual-key-1';
const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaPrivatePem = rsaKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const ecPrivatePem = ecKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const MOCK_JWKS = {
  keys: [
    { ...rsaKeys.publicKey.export({ format: 'jwk' }), kid: RSA_KID, alg: 'RS256', use: 'sig' },
    { ...ecKeys.publicKey.export({ format: 'jwk' }), kid: EC_KID, alg: 'ES256', use: 'sig' },
  ],
};

function signSupa(payload, overrides = {}) {
  return jwt.sign(payload, rsaPrivatePem, {
    algorithm: 'RS256',
    keyid: RSA_KID,
    issuer: ISS,
    audience: AUD,
    expiresIn: '5m',
    ...overrides,
  });
}
const legacyToken = (user) => portalAuthMw.generatePortalToken(user);
const staffToken = (user) => staffAuth.generateToken(user);

const LEGACY_USER = { id: 'pusr_leg_1', customer_id: 'CUST-LEG', email: 'legacy@example.com' };

// ── Apps ─────────────────────────────────────────────────────────────────────
function buildBusinessApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.get('/ping', (req, res) => {
    res.json({
      id: req.portalUser.id,
      customer_id: req.portalUser.customer_id,
      email: req.portalUser.email,
      family: req.portalAuthFamily || null,
    });
  });
  // Ownership probe mirroring existing service semantics: a Portal identity
  // may only see its own customer scope.
  router.get('/customers/:cid/orders', (req, res) => {
    if (req.portalUser.customer_id !== req.params.cid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ customer_id: req.params.cid, orders: [] });
  });
  app.use('/api/portal', portalAuthMw.verifyPortalToken, router);
  return app;
}

function buildStaffProbeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/staff-probe', staffAuth.verifyToken, staffAuth.requireRole('Admin'), (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function buildPortalAuthApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/auth', require('../routes/portalAuth.cjs'));
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/admin', require('../routes/portalAdmin.cjs'));
  return app;
}

function seedMappedDualUser(overrides = {}) {
  return repoStub.seedUser({
    id: 'pusr_dual_1',
    customer_id: 'CUST-DUAL',
    email: 'dual@example.com',
    full_name: 'Dual User',
    phone: '+265111222333',
    status: 'active',
    auth_user_id: MAPPED_SUB,
    ...overrides,
  });
}

beforeEach(() => {
  repoStub.reset();
  process.env.PORTAL_SUPABASE_DUAL_AUTH = 'true';
  identity.clearJwksCache();
  require('axios').get.mockResolvedValue({ data: JSON.parse(JSON.stringify(MOCK_JWKS)) });
  require('axios').get.mockClear();
  // First fetch per test happens lazily inside the middleware; resolve now so
  // per-test axios call counts stay deterministic.
  require('axios').get.mockResolvedValue({ data: JSON.parse(JSON.stringify(MOCK_JWKS)) });
});

// ─── Legacy family ──────────────────────────────────────────────────────────

describe('legacy family (dual ON)', () => {
  test('1: valid legacy Portal JWT → route succeeds as legacy', async () => {
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${legacyToken(LEGACY_USER)}`)
      .expect(200);
    expect(res.body).toEqual({
      id: 'pusr_leg_1', customer_id: 'CUST-LEG', email: 'legacy@example.com', family: 'legacy',
    });
  });

  test('2: expired legacy JWT → rejected', async () => {
    const expired = jwt.sign(
      { ...LEGACY_USER, role: 'portal_customer' },
      portalAuthMw.JWT_SECRET,
      { expiresIn: '-10s' }
    );
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
    expect(res.body.error).toBe('Token expired');
  });

  test('3: invalid legacy signature → rejected', async () => {
    const forged = jwt.sign(
      { ...LEGACY_USER, role: 'portal_customer' },
      'wrong-secret',
      { expiresIn: '5m' }
    );
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });
});

// ─── Supabase family ────────────────────────────────────────────────────────

describe('supabase family (dual ON)', () => {
  test('4: valid Supabase JWT + mapped active user → succeeds (family supabase)', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(200);
    expect(res.body).toEqual({
      id: 'pusr_dual_1', customer_id: 'CUST-DUAL', email: 'dual@example.com', family: 'supabase',
    });
  });

  test('5: valid Supabase JWT + unmapped sub → rejected (no disclosure)', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: OTHER_SUB })}`)
      .expect(401);
    expect(res.body).toEqual({ error: 'Invalid token', message: 'The provided authentication token is invalid' });
  });

  test('6: valid Supabase JWT + invited user → rejected', async () => {
    seedMappedDualUser({ status: 'invited' });
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
  });

  test('7: valid Supabase JWT + disabled user → rejected', async () => {
    seedMappedDualUser({ status: 'disabled' });
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
  });

  test('8: wrong issuer → rejected', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB }, { issuer: 'https://evil.example.com/auth/v1' })}`)
      .expect(401);
  });

  test('9: wrong audience → rejected', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB }, { audience: 'someone-else' })}`)
      .expect(401);
  });

  test('10: expired Supabase JWT → rejected', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB }, { expiresIn: '-10s' })}`)
      .expect(401);
  });

  test('11: invalid signature → rejected', async () => {
    seedMappedDualUser();
    const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const roguePem = rogue.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const token = jwt.sign({ sub: MAPPED_SUB }, roguePem, {
      algorithm: 'RS256', keyid: RSA_KID, issuer: ISS, audience: AUD, expiresIn: '5m',
    });
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  test('12: unsupported HS256 (untrusted signature) → rejected', async () => {
    seedMappedDualUser();
    const token = jwt.sign({ sub: MAPPED_SUB }, 'some-other-secret', {
      algorithm: 'HS256', issuer: ISS, audience: AUD, expiresIn: '5m',
    });
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  test('13: invalid/missing UUID sub → rejected', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: 'CUST-DUAL' })}`)
      .expect(401);
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({})}`)
      .expect(401);
  });

  test('14: unknown kid → rejected after exactly one bounded JWKS refresh', async () => {
    seedMappedDualUser();
    const token = jwt.sign({ sub: MAPPED_SUB }, rsaPrivatePem, {
      algorithm: 'RS256', keyid: 'rotated-not-cached', issuer: ISS, audience: AUD, expiresIn: '5m',
    });
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    // Initial load + exactly one rotation refresh — no fetch loop.
    expect(require('axios').get.mock.calls.length).toBe(2);
  });
});

// ─── Cross-family isolation ─────────────────────────────────────────────────

describe('cross-family isolation (dual ON)', () => {
  test('15: staff JWT → Portal route rejected (role gate intact)', async () => {
    const token = staffToken({ id: 'staff-1', username: 'boss@prime.mw', role: 'Admin', email: 'boss@prime.mw' });
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.error).toBe('Invalid token role');
  });

  test('16: legacy Portal JWT → staff route remains rejected', async () => {
    await request(buildStaffProbeApp())
      .get('/api/staff-probe')
      .set('Authorization', `Bearer ${legacyToken(LEGACY_USER)}`)
      .expect(403);
  });

  test('17: Supabase Portal JWT → staff route remains rejected', async () => {
    seedMappedDualUser();
    await request(buildStaffProbeApp())
      .get('/api/staff-probe')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
  });

  test('18: forged staff-style JWT (untrusted signature) with role=portal_customer → rejected', async () => {
    // NOTE: staff and Portal logins share JWT_SECRET, so a correctly-signed
    // portal_customer token IS a legacy Portal token by definition (see test
    // 20 — legacy semantics are preserved). This test proves a token merely
    // CLAIMING staff provenance without a trusted signature enters neither
    // family.
    const forged = jwt.sign(
      { id: 'staff-1', customer_id: 'CUST-LEG', email: 'boss@prime.mw', role: 'portal_customer' },
      'untrusted-staff-secret',
      { expiresIn: '5m' }
    );
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  test('19: Supabase JWT with role=Admin claim + mapped active user → succeeds as Portal identity (claim ignored)', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB, role: 'Admin' })}`)
      .expect(200);
    expect(res.body.customer_id).toBe('CUST-DUAL');
    expect(res.body.family).toBe('supabase');
  });

  test('19b: Supabase JWT with role=Admin claim + unmapped sub → rejected', async () => {
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: OTHER_SUB, role: 'Admin' })}`)
      .expect(401);
  });

  test('20: legacy JWT with forged customer_id keeps exact legacy semantics', async () => {
    const token = legacyToken({ id: 'pusr_leg_1', customer_id: 'CUST-FORGED', email: 'legacy@example.com' });
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.customer_id).toBe('CUST-FORGED');
    expect(res.body.family).toBe('legacy');
  });
});

// ─── Identity integrity (Supabase claims never become identity) ─────────────

describe('identity integrity (dual ON)', () => {
  test('21: forged customer_id → DB-derived customer_id', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB, customer_id: 'CUST-EVIL' })}`)
      .expect(200);
    expect(res.body.customer_id).toBe('CUST-DUAL');
  });

  test('22: forged Portal id → ignored', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB, id: 'pusr_forged_9' })}`)
      .expect(200);
    expect(res.body.id).toBe('pusr_dual_1');
  });

  test('23: forged email → ignored for identity mapping', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB, email: 'evil@example.com' })}`)
      .expect(200);
    expect(res.body.email).toBe('dual@example.com');
    expect(res.body.id).toBe('pusr_dual_1');
  });

  test('24: arbitrary role claim → ignored for Portal identity', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB, role: 'superuser' })}`)
      .expect(200);
    expect(res.body.customer_id).toBe('CUST-DUAL');
    expect(res.body.family).toBe('supabase');
  });
});

// ─── /me for both families ──────────────────────────────────────────────────

describe('/me (dual ON)', () => {
  const EXPECTED_ME = {
    id: 'pusr_dual_1',
    customer_id: 'CUST-DUAL',
    email: 'dual@example.com',
    full_name: 'Dual User',
    phone: '+265111222333',
    status: 'active',
    email_confirmed: true,
    mfa_enrolled: false,
    last_login_at: null,
  };

  test('25: legacy /me → nine-field contract', async () => {
    repoStub.seedUser({
      id: 'pusr_leg_me', customer_id: 'CUST-LEG', email: 'legacy@example.com',
      full_name: 'Legacy Me', phone: '+265999000111', status: 'active',
    });
    const token = legacyToken({ id: 'pusr_leg_me', customer_id: 'CUST-LEG', email: 'legacy@example.com' });
    const res = await request(buildPortalAuthApp())
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ ...EXPECTED_ME, id: 'pusr_leg_me', customer_id: 'CUST-LEG', email: 'legacy@example.com', full_name: 'Legacy Me', phone: '+265999000111' });
  });

  test('26: supabase /me → same nine-field contract', async () => {
    seedMappedDualUser();
    const res = await request(buildPortalAuthApp())
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(200);
    expect(res.body).toEqual(EXPECTED_ME);
  });

  test('27: neither family → unauthorized', async () => {
    await request(buildPortalAuthApp()).get('/api/portal/auth/me').expect(401);
    await request(buildPortalAuthApp())
      .get('/api/portal/auth/me')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  test('28: /me exposes no secrets, mapping, or token material', async () => {
    seedMappedDualUser({ two_factor_enabled: true, two_factor_confirmed: true });
    const token = signSupa({ sub: MAPPED_SUB });
    const res = await request(buildPortalAuthApp())
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    for (const forbidden of ['password_hash', 'two_factor_secret', 'two_factor_enabled', 'two_factor_confirmed', 'auth_user_id', 'access_token', 'refresh_token', 'data', 'version']) {
      expect(res.body[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(res.body)).not.toContain(token.slice(-20));
    expect(res.body.mfa_enrolled).toBe(true);
  });
});

// ─── Ownership + flag-OFF + refresh + boundaries ────────────────────────────

describe('ownership (dual ON)', () => {
  test('29: own customer scope allowed (supabase family)', async () => {
    seedMappedDualUser();
    const res = await request(buildBusinessApp())
      .get('/api/portal/customers/CUST-DUAL/orders')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(200);
    expect(res.body.customer_id).toBe('CUST-DUAL');
  });

  test('30: cross-customer access rejected (supabase family)', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/customers/CUST-OTHER/orders')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(403);
  });
});

describe('flag OFF (rollback state)', () => {
  beforeEach(() => {
    delete process.env.PORTAL_SUPABASE_DUAL_AUTH;
  });

  test('supabase JWT → rejected when dual OFF; legacy still works', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
    const res = await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${legacyToken(LEGACY_USER)}`)
      .expect(200);
    expect(res.body.family).toBe('legacy');
  });

  test('explicit false behaves like absent', async () => {
    process.env.PORTAL_SUPABASE_DUAL_AUTH = 'false';
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
  });
});

describe('/refresh stays legacy-only (dual ON)', () => {
  test('supabase JWT as refresh_token → rejected', async () => {
    seedMappedDualUser();
    const res = await request(buildPortalAuthApp())
      .post('/api/portal/auth/refresh')
      .send({ refresh_token: signSupa({ sub: MAPPED_SUB }) })
      .expect(401);
    expect(res.body.error).toBe('Invalid or expired refresh token');
  });

  test('opaque unknown refresh token → same legacy rejection (semantics unchanged)', async () => {
    const res = await request(buildPortalAuthApp())
      .post('/api/portal/auth/refresh')
      .send({ refresh_token: 'deadbeef'.repeat(12) })
      .expect(401);
    expect(res.body.error).toBe('Invalid or expired refresh token');
  });
});

describe('route boundaries (dual ON)', () => {
  test('portal business route accepts valid supabase JWT', async () => {
    seedMappedDualUser();
    await request(buildBusinessApp())
      .get('/api/portal/ping')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(200);
  });

  test('staff probe rejects the same supabase portal JWT; accepts staff JWT', async () => {
    seedMappedDualUser();
    await request(buildStaffProbeApp())
      .get('/api/staff-probe')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(401);
    const token = staffToken({ id: 'staff-1', username: 'boss@prime.mw', role: 'Admin', email: 'boss@prime.mw' });
    await request(buildStaffProbeApp())
      .get('/api/staff-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  test('portal-admin requires staff: supabase portal identity → 403, staff JWT → 200', async () => {
    seedMappedDualUser();
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set('Authorization', `Bearer ${signSupa({ sub: MAPPED_SUB })}`)
      .expect(403);
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set('Authorization', `Bearer ${legacyToken(LEGACY_USER)}`)
      .expect(403);
    const token = staffToken({ id: 'staff-1', username: 'boss@prime.mw', role: 'Admin', email: 'boss@prime.mw' });
    await request(buildAdminApp())
      .get('/api/portal/admin/registration-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
