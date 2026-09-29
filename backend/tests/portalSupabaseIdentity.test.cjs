/**
 * PHASE 1+2 shadow-only Supabase identity tests — hermetic.
 *
 * The Supabase repository is replaced via jest.mock with the in-memory stub
 * (tests/helpers/supabaseRepoStub.cjs), so the REAL
 * services/supabasePortalIdentity.cjs, services/portalAuthService.cjs and
 * routes/portalAuth.cjs code paths run with no network or database.
 *
 * Covered contract (no legacy behavior change):
 *   Mapping    — active-mapped resolves; unmapped/disabled/unknown reject;
 *                duplicate auth_user_id values are REPORTED, never hidden.
 *   Verifier   — JWKS (RS256/ES256 + kid) signature/issuer/audience/expiry
 *                enforced in isolation from JWT_SECRET legacy verification.
 *                HS256/`none`/unknown-kid rejected; mocked JWKS, no network.
 *   Boundary   — sub is never a customer_id; customer_id comes only from
 *                the mapped portal_users row; no mapping ⇒ no authorization.
 *   /me        — allow-list response contains identity/business fields and
 *                MUST NOT contain hashes, secrets, or the auth mapping.
 *   Compat     — legacy login-password + /me flows pass unchanged with the
 *                shadow flag OFF (default).
 */

// ── Env BEFORE any module load (middleware exits without JWT_SECRET) ────────
// NOTE: no symmetric Supabase JWT secret exists by design — Supabase tokens
// verify via JWKS (mocked per-test through the fetchJwks injection point; no network).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-supabase-identity';
process.env.SUPABASE_URL = 'https://test-ref.supabase.co';

const SAVED_ENV = {};
function takeEnv(keys) {
  for (const key of keys) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
// Supabase env vars are set only while THIS suite runs and restored after.
takeEnv(['VITE_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWT_ISSUER', 'SUPABASE_JWT_AUDIENCE', 'PORTAL_SUPABASE_SHADOW']);

jest.mock('../services/supabaseRepository.cjs', () =>
  require('./helpers/supabaseRepoStub.cjs').repo
);
// The shadow middleware has no fetch-injection parameter (Express signature),
// so its internal axios JWKS fetch is stubbed at the module boundary here.
// Verifier unit tests above inject a mock fetcher directly instead.
jest.mock('axios');

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const repoStub = require('./helpers/supabaseRepoStub.cjs');
const identity = require('../services/supabasePortalIdentity.cjs');

const SUPABASE_ISSUER = 'https://test-ref.supabase.co/auth/v1';
const SUPABASE_AUDIENCE = 'authenticated';
const MAPPED_SUB = '11111111-2222-4333-8444-555555555555';
const OTHER_SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ── Deterministic JWKS fixture (generated once per run, never leaves it) ───
// RSA + EC keypairs stand in for a GoTrue JWKS document. The mock fetcher
// below is injected into every verifier call — no network is ever touched.
const RSA_KID = 'rsa-test-key-1';
const EC_KID = 'ec-test-key-1';
const OCT_KID = 'oct-ignored-key-1';
const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaPrivatePem = rsaKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const ecPrivatePem = ecKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const MOCK_JWKS = {
  keys: [
    { ...rsaKeys.publicKey.export({ format: 'jwk' }), kid: RSA_KID, alg: 'RS256', use: 'sig' },
    { ...ecKeys.publicKey.export({ format: 'jwk' }), kid: EC_KID, alg: 'ES256', use: 'sig' },
    // Symmetric material must be ignored at import: it can never back a key.
    { kty: 'oct', kid: OCT_KID, alg: 'HS256', use: 'sig', k: Buffer.from('test-oct-secret-material').toString('base64url') },
  ],
};

let fetchCount = 0;
const mockFetchJwks = async () => {
  fetchCount += 1;
  return JSON.parse(JSON.stringify(MOCK_JWKS));
};
const jwksOpts = () => ({ fetchJwks: mockFetchJwks });

function signAsymmetric({ key, alg, kid, payload, overrides = {} }) {
  return jwt.sign(payload, key, {
    algorithm: alg,
    keyid: kid,
    issuer: SUPABASE_ISSUER,
    audience: SUPABASE_AUDIENCE,
    expiresIn: '5m',
    ...overrides,
  });
}
const signRSA = (payload, overrides = {}) =>
  signAsymmetric({ key: rsaPrivatePem, alg: 'RS256', kid: RSA_KID, payload, overrides });
const signEC = (payload, overrides = {}) =>
  signAsymmetric({ key: ecPrivatePem, alg: 'ES256', kid: EC_KID, payload, overrides });

let app;
let portalAuthRoutes;
let generatePortalToken;

beforeAll(() => {
  portalAuthRoutes = require('../routes/portalAuth.cjs');
  ({ generatePortalToken } = require('../middleware/portalAuth.cjs'));
  app = express();
  app.use(express.json());
  app.use('/api/portal/auth', portalAuthRoutes);
});

afterAll(() => {
  restoreEnv();
});

beforeEach(() => {
  repoStub.reset();
  delete process.env.PORTAL_SUPABASE_SHADOW;
  identity.clearJwksCache();
  fetchCount = 0;
  require('axios').get.mockResolvedValue({ data: JSON.parse(JSON.stringify(MOCK_JWKS)) });
});

// ─── Shadow flag: default OFF ───────────────────────────────────────────────

describe('shadow flag', () => {
  test('disabled by default (unset, empty, and non-true values)', () => {
    delete process.env.PORTAL_SUPABASE_SHADOW;
    expect(identity.isShadowEnabled()).toBe(false);
    process.env.PORTAL_SUPABASE_SHADOW = '';
    expect(identity.isShadowEnabled()).toBe(false);
    process.env.PORTAL_SUPABASE_SHADOW = 'false';
    expect(identity.isShadowEnabled()).toBe(false);
    process.env.PORTAL_SUPABASE_SHADOW = 'TRUE';
    expect(identity.isShadowEnabled()).toBe(true);
    delete process.env.PORTAL_SUPABASE_SHADOW;
  });

  test('shadow middleware is a pass-through no-op when OFF', async () => {
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };
    try {
      const req = { method: 'GET', url: '/x', headers: {}, portalUser: { id: 'pusr_test_1', customer_id: 'CUST-001' } };
      let nextCalled = false;
      await identity.supabaseShadowMiddleware(req, {}, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
      expect(logged.filter(l => l.includes('PortalSupabaseShadow'))).toHaveLength(0);
    } finally {
      console.log = origLog;
    }
  });
});

// ─── Mapping / resolver ─────────────────────────────────────────────────────

describe('resolvePortalIdentity', () => {
  test('active mapped user resolves with row-owned customer_id', async () => {
    repoStub.seedUser({ id: 'pusr_mapped_1', customer_id: 'CUST-900', email: 'mapped@example.com', auth_user_id: MAPPED_SUB });
    const { user, reason } = await identity.resolvePortalIdentity(MAPPED_SUB);
    expect(reason).toBeNull();
    expect(user.id).toBe('pusr_mapped_1');
    expect(user.customer_id).toBe('CUST-900');
    expect(user.email).toBe('mapped@example.com');
    expect(user.customer_id).not.toBe(MAPPED_SUB);
  });

  test('active unmapped user does not resolve through Supabase identity', async () => {
    repoStub.seedUser();
    const { user, reason } = await identity.resolvePortalIdentity(OTHER_SUB);
    expect(user).toBeNull();
    expect(reason).toBe('UNMAPPED');
  });

  test('disabled mapped user is rejected', async () => {
    repoStub.seedUser({ id: 'pusr_off_1', status: 'disabled', auth_user_id: MAPPED_SUB });
    const { user, reason } = await identity.resolvePortalIdentity(MAPPED_SUB);
    expect(user).toBeNull();
    expect(reason).toBe('NOT_ACTIVE');
  });

  test('invited mapped user is rejected (must activate first)', async () => {
    repoStub.seedUser({ id: 'pusr_inv_1', status: 'invited', auth_user_id: MAPPED_SUB });
    const { user, reason } = await identity.resolvePortalIdentity(MAPPED_SUB);
    expect(user).toBeNull();
    expect(reason).toBe('NOT_ACTIVE');
  });

  test('unknown sub is rejected', async () => {
    repoStub.seedUser({ auth_user_id: MAPPED_SUB });
    const { user, reason } = await identity.resolvePortalIdentity('99999999-8888-4777-8666-555555555555');
    expect(user).toBeNull();
    expect(reason).toBe('UNMAPPED');
  });

  test('malformed and missing subs are rejected without lookup', async () => {
    for (const bad of [null, undefined, '', 'not-a-uuid', 'CUST-001', 'pusr_test_1']) {
      const { user, reason } = await identity.resolvePortalIdentity(bad);
      expect(user).toBeNull();
      expect(['MISSING_SUB', 'MALFORMED_SUB']).toContain(reason);
    }
  });

  test('resolved user never carries secrets or the auth mapping', async () => {
    repoStub.seedUser({ auth_user_id: MAPPED_SUB });
    const { user } = await identity.resolvePortalIdentity(MAPPED_SUB);
    expect(user.auth_user_id).toBeUndefined();
    expect(user.password_hash).toBeUndefined();
    expect(user.two_factor_secret).toBeUndefined();
  });
});

describe('mapping report (read-only)', () => {
  test('counts status x mapping and flags N:1 anomalies', async () => {
    repoStub.seedUser({ id: 'pusr_a1', customer_id: 'CUST-A', email: 'a@x.com', status: 'active' });
    repoStub.seedUser({ id: 'pusr_a2', customer_id: 'CUST-A', email: 'b@x.com', status: 'active', auth_user_id: MAPPED_SUB });
    repoStub.seedUser({ id: 'pusr_i1', customer_id: 'CUST-B', email: 'c@x.com', status: 'invited' });
    repoStub.seedUser({ id: 'pusr_d1', customer_id: 'CUST-C', email: 'd@x.com', status: 'disabled', auth_user_id: OTHER_SUB });
    const report = await identity.getPortalAuthMappingReport();
    expect(report.counts.total).toBe(4);
    expect(report.counts.activeMapped).toBe(1);
    expect(report.counts.activeUnmapped).toBe(1);
    expect(report.counts.invitedUnmapped).toBe(1);
    expect(report.counts.disabledMapped).toBe(1);
    expect(report.multiUserCustomers).toEqual([{ customer_id: 'CUST-A', portal_user_ids: ['pusr_a1', 'pusr_a2'] }]);
    expect(report.legacyActiveUnmappedIds).toEqual(['pusr_a1']);
    // Read-only: nothing repaired, nothing populated.
    expect(report.duplicateAuthUserIds).toEqual([]);
  });

  test('duplicate auth_user_id values are reported, never silently resolved', async () => {
    repoStub.seedUser({ id: 'pusr_dup_1', customer_id: 'CUST-1', email: 'one@x.com', auth_user_id: MAPPED_SUB });
    repoStub.seedUser({ id: 'pusr_dup_2', customer_id: 'CUST-2', email: 'two@x.com', auth_user_id: MAPPED_SUB });
    const report = await identity.getPortalAuthMappingReport();
    expect(report.duplicateAuthUserIds).toEqual([
      { auth_user_id: MAPPED_SUB.toLowerCase(), portal_user_ids: ['pusr_dup_1', 'pusr_dup_2'] },
    ]);
  });

  test('malformed auth_user_id values are reported', async () => {
    repoStub.seedUser({ id: 'pusr_bad_1', email: 'bad@x.com', auth_user_id: 'legacy-string-not-a-uuid' });
    const report = await identity.getPortalAuthMappingReport();
    expect(report.malformedAuthUserIds).toEqual([{ id: 'pusr_bad_1', value: 'legacy-string-not-a-uuid' }]);
  });

  test('duplicate emails are reported', async () => {
    repoStub.seedUser({ id: 'pusr_e1', email: 'Same@x.com', customer_id: 'CUST-1' });
    repoStub.seedUser({ id: 'pusr_e2', email: 'same@X.com', customer_id: 'CUST-2' });
    const report = await identity.getPortalAuthMappingReport();
    expect(report.duplicateEmails).toEqual([{ email: 'same@x.com', portal_user_ids: ['pusr_e1', 'pusr_e2'] }]);
  });
});

describe('N:1 list primitive (no behavior change)', () => {
  test('listByCustomerId returns every row; getByCustomerId keeps first-row semantics', async () => {
    const portalAuthService = require('../services/portalAuthService.cjs');
    repoStub.seedUser({ id: 'pusr_n1', customer_id: 'CUST-N', email: 'n1@x.com' });
    repoStub.seedUser({ id: 'pusr_n2', customer_id: 'CUST-N', email: 'n2@x.com' });
    const all = await portalAuthService.listPortalUsersByCustomerId('CUST-N');
    expect(all.map(u => u.id).sort()).toEqual(['pusr_n1', 'pusr_n2']);
    const single = await portalAuthService.getPortalUserByCustomerId('CUST-N');
    expect(['pusr_n1', 'pusr_n2']).toContain(single.id);
    expect(await portalAuthService.listPortalUsersByCustomerId('CUST-EMPTY')).toEqual([]);
  });
});

// ─── JWT verifier: JWKS/asymmetric (isolated from JWT_SECRET) ─────────────────

describe('verifySupabasePortalToken (JWKS)', () => {
  test('valid RSA signature/issuer/audience/expiry accepted with sub', async () => {
    const res = await identity.verifySupabasePortalToken(signRSA({ sub: MAPPED_SUB }), jwksOpts());
    expect(res.ok).toBe(true);
    expect(res.sub).toBe(MAPPED_SUB);
  });

  test('valid EC signature accepted', async () => {
    const res = await identity.verifySupabasePortalToken(signEC({ sub: MAPPED_SUB }), jwksOpts());
    expect(res.ok).toBe(true);
    expect(res.sub).toBe(MAPPED_SUB);
  });

  test('wrong issuer rejected', async () => {
    const token = signRSA({ sub: MAPPED_SUB }, { issuer: 'https://evil.example.com/auth/v1' });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('WRONG_ISSUER');
  });

  test('wrong audience rejected', async () => {
    const token = signRSA({ sub: MAPPED_SUB }, { audience: 'someone-else' });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('WRONG_AUDIENCE');
  });

  test('expired token rejected', async () => {
    const token = signRSA({ sub: MAPPED_SUB }, { expiresIn: '-10s' });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('EXPIRED');
  });

  test('invalid RSA signature rejected', async () => {
    const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const roguePem = rogue.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const token = signAsymmetric({ key: roguePem, alg: 'RS256', kid: RSA_KID, payload: { sub: MAPPED_SUB } });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('INVALID_SIGNATURE');
  });

  test('HS256 explicitly rejected (never falls back to symmetric)', async () => {
    const token = jwt.sign({ sub: MAPPED_SUB }, 'some-other-secret', {
      algorithm: 'HS256', issuer: SUPABASE_ISSUER, audience: SUPABASE_AUDIENCE, expiresIn: '5m',
    });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('UNSUPPORTED_ALGORITHM');
  });

  test('HS384/HS512 and none explicitly rejected', async () => {
    for (const alg of ['HS384', 'HS512']) {
      const token = jwt.sign({ sub: MAPPED_SUB }, 'some-other-secret', {
        algorithm: alg, issuer: SUPABASE_ISSUER, audience: SUPABASE_AUDIENCE, expiresIn: '5m',
      });
      const res = await identity.verifySupabasePortalToken(token, jwksOpts());
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('UNSUPPORTED_ALGORITHM');
    }
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: MAPPED_SUB, iss: SUPABASE_ISSUER, aud: SUPABASE_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    const resNone = await identity.verifySupabasePortalToken(unsigned, jwksOpts());
    expect(resNone.ok).toBe(false);
    expect(resNone.reason).toBe('UNSUPPORTED_ALGORITHM');
  });

  test('symmetric oct JWK in JWKS can never back a key (HS256+kid rejected)', async () => {
    const token = jwt.sign({ sub: MAPPED_SUB }, Buffer.from('test-oct-secret-material'), {
      algorithm: 'HS256', keyid: OCT_KID, issuer: SUPABASE_ISSUER, audience: SUPABASE_AUDIENCE, expiresIn: '5m',
    });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('UNSUPPORTED_ALGORITHM');
  });

  test('key-type/algorithm family mismatch rejected (RS256 header on EC key)', async () => {
    // Signed with the RSA private key but pointed at the EC kid: the header
    // claims RS256 while the selected key is EC — rejected before crypto.
    const token = signAsymmetric({ key: rsaPrivatePem, alg: 'RS256', kid: EC_KID, payload: { sub: MAPPED_SUB } });
    const res = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('UNSUPPORTED_ALGORITHM');
  });

  test('unknown kid triggers exactly one refresh, then rejection (bounded)', async () => {
    const token = signAsymmetric({ key: rsaPrivatePem, alg: 'RS256', kid: 'rotated-key-not-cached', payload: { sub: MAPPED_SUB } });
    const first = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(first.ok).toBe(false);
    expect(first.reason).toBe('UNKNOWN_KID');
    expect(fetchCount).toBe(2); // initial load + exactly one rotation refresh
    const second = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('UNKNOWN_KID');
    expect(fetchCount).toBeLessThanOrEqual(4); // no fetch loop
  });

  test('JWKS unavailable fails closed', async () => {
    const token = signRSA({ sub: MAPPED_SUB });
    const res = await identity.verifySupabasePortalToken(token, {
      fetchJwks: async () => { throw new Error('network down'); },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('JWKS_UNAVAILABLE');
  });

  test('missing JWKS configuration fails closed (NOT_CONFIGURED)', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedJwks = process.env.SUPABASE_JWKS_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_JWKS_URL;
    identity.clearJwksCache();
    try {
      const res = await identity.verifySupabasePortalToken(signRSA({ sub: MAPPED_SUB }), jwksOpts());
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('NOT_CONFIGURED');
      expect(fetchCount).toBe(0);
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedJwks !== undefined) process.env.SUPABASE_JWKS_URL = savedJwks;
      identity.clearJwksCache();
    }
  });

  test('cached key reused without refetch', async () => {
    const first = await identity.verifySupabasePortalToken(signRSA({ sub: MAPPED_SUB }), jwksOpts());
    expect(first.ok).toBe(true);
    expect(fetchCount).toBe(1);
    const second = await identity.verifySupabasePortalToken(signEC({ sub: OTHER_SUB }), jwksOpts());
    expect(second.ok).toBe(true);
    expect(fetchCount).toBe(1);
  });

  test('malformed and missing tokens rejected', async () => {
    expect((await identity.verifySupabasePortalToken('not-a-token', jwksOpts())).reason).toBe('MALFORMED');
    expect((await identity.verifySupabasePortalToken(null, jwksOpts())).reason).toBe('MISSING_TOKEN');
    expect((await identity.verifySupabasePortalToken('', jwksOpts())).reason).toBe('MISSING_TOKEN');
  });

  test('missing / non-UUID sub rejected', async () => {
    expect((await identity.verifySupabasePortalToken(signRSA({}), jwksOpts())).reason).toBe('MISSING_SUB');
    expect((await identity.verifySupabasePortalToken(signRSA({ sub: 'CUST-001' }), jwksOpts())).reason).toBe('MALFORMED_SUB');
  });

  test('forged customer_id claim in JWT is ignored — identity comes only from DB row', async () => {
    repoStub.seedUser({ id: 'pusr_mapped_1', customer_id: 'CUST-900', email: 'mapped@example.com', auth_user_id: MAPPED_SUB });
    const token = signRSA({ sub: MAPPED_SUB, customer_id: 'CUST-EVIL', email: 'evil@example.com', role: 'authenticated' });
    const verified = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(verified.ok).toBe(true);
    expect(verified.sub).toBe(MAPPED_SUB);
    // The verifier result must not surface the forged business identity.
    expect(verified.customer_id).toBeUndefined();
    const { user, reason } = await identity.resolvePortalIdentity(verified.sub);
    expect(reason).toBeNull();
    expect(user.id).toBe('pusr_mapped_1');
    expect(user.customer_id).toBe('CUST-900');
    expect(user.customer_id).not.toBe('CUST-EVIL');
  });

  test('forged Portal user id claim in JWT is ignored — mapping uses sub only', async () => {
    repoStub.seedUser({ id: 'pusr_real_1', customer_id: 'CUST-REAL', email: 'real@example.com', auth_user_id: MAPPED_SUB });
    const token = signRSA({ sub: MAPPED_SUB, id: 'pusr_forged_9', customer_id: 'CUST-FORGED' });
    const verified = await identity.verifySupabasePortalToken(token, jwksOpts());
    expect(verified.ok).toBe(true);
    const { user, reason } = await identity.resolvePortalIdentity(verified.sub);
    expect(reason).toBeNull();
    expect(user.id).toBe('pusr_real_1');
    expect(user.id).not.toBe('pusr_forged_9');
    expect(user.customer_id).toBe('CUST-REAL');
  });

  test('legacy portal JWT (JWT_SECRET/HS256) is NOT accepted as a Supabase token', async () => {
    const legacy = generatePortalToken({ id: 'pusr_test_1', customer_id: 'CUST-001', email: 'known@example.com' });
    const res = await identity.verifySupabasePortalToken(legacy, jwksOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('UNSUPPORTED_ALGORITHM');
  });
});

// ─── /me contract ───────────────────────────────────────────────────────────

describe('GET /api/portal/auth/me contract', () => {
  test('returns allow-listed identity/business fields only', async () => {
    repoStub.seedUser({
      id: 'pusr_me_1', customer_id: 'CUST-ME', email: 'me@example.com',
      full_name: 'Me User', phone: '+265111222333', status: 'active',
      two_factor_enabled: true, two_factor_confirmed: true,
      last_login_at: '2026-01-01T00:00:00.000Z', auth_user_id: MAPPED_SUB,
    });
    const token = generatePortalToken({ id: 'pusr_me_1', customer_id: 'CUST-ME', email: 'me@example.com' });
    const res = await request(app).get('/api/portal/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'pusr_me_1',
      customer_id: 'CUST-ME',
      email: 'me@example.com',
      full_name: 'Me User',
      phone: '+265111222333',
      status: 'active',
      email_confirmed: true,
      mfa_enrolled: true,
      last_login_at: '2026-01-01T00:00:00.000Z',
    });
  });

  test('never exposes hashes, secrets, mapping, or envelopes', async () => {
    repoStub.seedUser({ auth_user_id: MAPPED_SUB, two_factor_enabled: true, two_factor_confirmed: true });
    const token = generatePortalToken({ id: 'pusr_test_1', customer_id: 'CUST-001', email: 'known@example.com' });
    const res = await request(app).get('/api/portal/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const forbidden of ['password_hash', 'two_factor_secret', 'two_factor_enabled', 'two_factor_confirmed', 'auth_user_id', 'data', 'version']) {
      expect(res.body[forbidden]).toBeUndefined();
    }
    expect(res.body.mfa_enrolled).toBe(true);
  });
});

// ─── Legacy compatibility (shadow OFF) ──────────────────────────────────────

describe('legacy compatibility', () => {
  test('login-password flow unchanged with shadow OFF', async () => {
    repoStub.seedUser();
    const res = await request(app)
      .post('/api/portal/auth/login-password')
      .send({ email: 'known@example.com', password: repoStub.DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Login successful');
    expect(res.body.user).toEqual({
      id: 'pusr_test_1',
      customer_id: 'CUST-001',
      email: 'known@example.com',
      full_name: 'Known User',
      phone: '+265999000111',
    });
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');
    expect(res.body.expires_in).toBe('30m');
  });
});

// ─── Shadow middleware (explicitly enabled) ─────────────────────────────────

describe('shadow middleware when enabled', () => {
  test('AGREE is logged with safe fields only; request still passes through', async () => {
    process.env.PORTAL_SUPABASE_SHADOW = 'true';
    repoStub.seedUser({ id: 'pusr_test_1', customer_id: 'CUST-001', email: 'known@example.com', auth_user_id: MAPPED_SUB });
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };
    try {
      const token = signRSA({ sub: MAPPED_SUB });
      const req = {
        method: 'GET', originalUrl: '/api/portal/dashboard', correlationId: 'corr-1',
        headers: { authorization: `Bearer ${token}` },
        portalUser: { id: 'pusr_test_1', customer_id: 'CUST-001', email: 'known@example.com', role: 'portal_customer' },
      };
      let nextCalled = false;
      await identity.supabaseShadowMiddleware(req, {}, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
      const shadowLines = logged.filter(l => l.includes('PortalSupabaseShadow'));
      expect(shadowLines).toHaveLength(1);
      const payload = JSON.parse(shadowLines[0].slice(shadowLines[0].indexOf('{')));
      expect(payload.agreement).toBe('AGREE');
      expect(payload.shadowCustomerId).toBe('CUST-001');
      // The raw token must never appear in shadow logs.
      expect(shadowLines[0].includes(token)).toBe(false);
    } finally {
      console.log = origLog;
      delete process.env.PORTAL_SUPABASE_SHADOW;
    }
  });

  test('customer mismatch is categorized without affecting the request', async () => {
    process.env.PORTAL_SUPABASE_SHADOW = 'true';
    repoStub.seedUser({ id: 'pusr_test_1', customer_id: 'CUST-OTHER', email: 'known@example.com', auth_user_id: MAPPED_SUB });
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };
    try {
      const token = signRSA({ sub: MAPPED_SUB });
      const req = {
        method: 'GET', originalUrl: '/api/portal/invoices', correlationId: null,
        headers: { authorization: `Bearer ${token}` },
        portalUser: { id: 'pusr_test_1', customer_id: 'CUST-001', email: 'known@example.com', role: 'portal_customer' },
      };
      let nextCalled = false;
      await identity.supabaseShadowMiddleware(req, {}, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
      const shadowLines = logged.filter(l => l.includes('PortalSupabaseShadow'));
      expect(shadowLines).toHaveLength(1);
      const payload = JSON.parse(shadowLines[0].slice(shadowLines[0].indexOf('{')));
      expect(payload.agreement).toBe('MISMATCH');
      expect(payload.mismatchCategory).toBe('customer-id');
    } finally {
      console.log = origLog;
      delete process.env.PORTAL_SUPABASE_SHADOW;
    }
  });
});
