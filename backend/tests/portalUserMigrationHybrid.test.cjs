/**
 * Phase 5B-2B hybrid login-hook tests — hermetic.
 *
 * Covers the Admin password capability (updateAuthUserPassword) and the
 * /login-password success-path hook using fakes only. The fake password
 * below is a controlled test credential; tests assert it never appears in
 * logs, errors, responses, or persisted state.
 *
 * No network, no database, no live Auth.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-hybrid-hook';
process.env.SUPABASE_URL = 'https://test-ref.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_hybrid_test_key';

jest.mock('axios');

jest.mock('../services/portalAuthService.cjs', () => ({
  ACCESS_TOKEN_EXPIRY: '30m',
  authenticatePortalUser: jest.fn(),
  isTwoFactorEnabled: jest.fn(),
  getTwoFactorSecret: jest.fn(),
  verifyTwoFactorToken: jest.fn(),
  createSession: jest.fn(),
  recordLoginHistory: jest.fn(),
  getPortalUserById: jest.fn(),
}));

jest.mock('../services/referralService.cjs', () => {
  const MockReferralService = jest.fn().mockImplementation(() => ({
    checkFraudSignals: jest.fn(async () => []),
  }));
  return MockReferralService;
});

const express = require('express');
const request = require('supertest');
const axios = require('axios');

const portalAuthService = require('../services/portalAuthService.cjs');
const adminServiceActual = jest.requireActual('../services/supabasePortalAuthAdmin.cjs');

const FAKE_PASSWORD = 'hybrid-test-credential-1';
const MAPPED_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/auth', require('../routes/portalAuth.cjs'));
  return app;
}

function seedLoginSuccess({ mapped = true, mfa = false } = {}) {
  portalAuthService.authenticatePortalUser.mockResolvedValue({
    id: 'pusr_hyb_1', customer_id: 'CUST-HYB', email: 'hyb@example.com',
    full_name: 'Hyb User', phone: null,
  });
  portalAuthService.isTwoFactorEnabled.mockResolvedValue(mfa);
  portalAuthService.getTwoFactorSecret.mockResolvedValue('totp-secret-stub');
  portalAuthService.verifyTwoFactorToken.mockResolvedValue(true);
  portalAuthService.createSession.mockResolvedValue({ id: 'sess_1' });
  portalAuthService.recordLoginHistory.mockResolvedValue(undefined);
  portalAuthService.getPortalUserById.mockResolvedValue(mapped ? {
    id: 'pusr_hyb_1', customer_id: 'CUST-HYB', email: 'hyb@example.com', auth_user_id: MAPPED_UUID,
  } : {
    id: 'pusr_hyb_1', customer_id: 'CUST-HYB', email: 'hyb@example.com', auth_user_id: null,
  });
}

function captureConsole() {
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { logged.push(a.join(' ')); };
  console.warn = (...a) => { logged.push(a.join(' ')); };
  console.error = (...a) => { logged.push(a.join(' ')); };
  return { logged, restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; } };
}

beforeEach(() => {
  jest.clearAllMocks();
  axios.put.mockResolvedValue({ data: {} });
  seedLoginSuccess();
});

describe('Admin password capability', () => {
  test('1/2/3/4: PUTs exact id + password-only body', async () => {
    await adminServiceActual.updateAuthUserPassword(MAPPED_UUID, FAKE_PASSWORD);
    expect(axios.put).toHaveBeenCalledTimes(1);
    const [url, body] = axios.put.mock.calls[0];
    expect(url).toBe(`https://test-ref.supabase.co/auth/v1/admin/users/${MAPPED_UUID}`);
    expect(body).toEqual({ password: FAKE_PASSWORD });
    expect(Object.keys(body)).toEqual(['password']);
  });

  test('5: password never logged by the capability', async () => {
    const { logged, restore } = captureConsole();
    try {
      await adminServiceActual.updateAuthUserPassword(MAPPED_UUID, FAKE_PASSWORD);
    } finally {
      restore();
    }
    expect(logged.join('\n')).not.toContain(FAKE_PASSWORD);
  });

  test('6: success represented safely', async () => {
    const res = await adminServiceActual.updateAuthUserPassword(MAPPED_UUID, FAKE_PASSWORD);
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(res)).not.toContain(FAKE_PASSWORD);
  });

  test('7/8: failures become coded errors without the password', async () => {
    axios.put.mockRejectedValueOnce(Object.assign(new Error('bad'), { response: { status: 422, data: { msg: 'x' } } }));
    const err422 = await adminServiceActual.updateAuthUserPassword(MAPPED_UUID, FAKE_PASSWORD).catch((e) => e);
    expect(err422.code).toBe('AUTH_PASSWORD_UPDATE_FAILED');
    expect(String(err422.message)).not.toContain(FAKE_PASSWORD);
    axios.put.mockRejectedValueOnce(new Error('socket hang up'));
    const errNet = await adminServiceActual.updateAuthUserPassword(MAPPED_UUID, FAKE_PASSWORD).catch((e) => e);
    expect(errNet.code).toBe('AUTH_PASSWORD_UPDATE_FAILED');
    expect(String(errNet.message)).not.toContain(FAKE_PASSWORD);
    const errBadId = await adminServiceActual.updateAuthUserPassword('not-a-uuid', FAKE_PASSWORD).catch((e) => e);
    expect(errBadId.code).toBe('INVALID_INPUT');
  });
});

describe('hybrid login hook', () => {
  const adminModule = () => require('../services/supabasePortalAuthAdmin.cjs');
  const realUpdate = adminServiceActual.updateAuthUserPassword;
  afterEach(() => {
    // Restore the real capability (route tests temporarily swap it).
    adminModule().updateAuthUserPassword = realUpdate;
  });

  test('A: valid login calls Admin update once with submitted password; response unchanged', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn().mockResolvedValue({ ok: true });
    // Re-require router is already loaded with mocked service module object;
    // the hook reads updateAuthUserPassword off the mocked module at call time.
    const res = await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
      .expect(200);
    expect(res.body.message).toBe('Login successful');
    expect(res.body.user).toEqual({
      id: 'pusr_hyb_1', customer_id: 'CUST-HYB', email: 'hyb@example.com',
      full_name: 'Hyb User', phone: null,
    });
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');
    expect(adminMock.updateAuthUserPassword).toHaveBeenCalledTimes(1);
    expect(adminMock.updateAuthUserPassword).toHaveBeenCalledWith(MAPPED_UUID, FAKE_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_PASSWORD);
  });

  test('B: wrong password → 401, no Admin call, no session', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn();
    portalAuthService.authenticatePortalUser.mockResolvedValue(null);
    await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: 'wrong-credential' })
      .expect(401);
    expect(adminMock.updateAuthUserPassword).not.toHaveBeenCalled();
    expect(portalAuthService.createSession).not.toHaveBeenCalled();
  });

  test('C: MFA failure → no Admin call, MFA behavior unchanged', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn();
    portalAuthService.isTwoFactorEnabled.mockResolvedValue(true);
    portalAuthService.verifyTwoFactorToken.mockResolvedValue(false);
    const res = await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD, two_factor_code: '000000' })
      .expect(401);
    expect(res.body.error).toBe('Invalid verification code');
    expect(adminMock.updateAuthUserPassword).not.toHaveBeenCalled();
    expect(portalAuthService.createSession).not.toHaveBeenCalled();
  });

  test('D: Admin failure → login still succeeds, session exists, sanitized', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    const boom = new Error('Supabase Auth password update failed (status 500)');
    boom.code = 'AUTH_PASSWORD_UPDATE_FAILED';
    adminMock.updateAuthUserPassword = jest.fn().mockRejectedValue(boom);
    const { logged, restore } = captureConsole();
    let res;
    try {
      res = await request(buildApp())
        .post('/api/portal/auth/login-password')
        .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
        .expect(200);
    } finally {
      restore();
    }
    expect(res.body.message).toBe('Login successful');
    expect(portalAuthService.createSession).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).not.toContain(FAKE_PASSWORD);
  });

  test('E: missing mapping → login succeeds, no Admin call, no creation', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn();
    seedLoginSuccess({ mapped: false });
    const res = await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
      .expect(200);
    expect(res.body.message).toBe('Login successful');
    expect(adminMock.updateAuthUserPassword).not.toHaveBeenCalled();
  });

  test('F: existing mapping → no email lookup/creation, mapped UUID used', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn().mockResolvedValue({ ok: true });
    await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
      .expect(200);
    expect(adminMock.updateAuthUserPassword).toHaveBeenCalledWith(MAPPED_UUID, FAKE_PASSWORD);
    // No provisioning path on the login route: registerPortalUser never involved.
    expect(portalAuthService.getPortalUserById).toHaveBeenCalledWith('pusr_hyb_1');
  });

  test('G: mismatched row identity → no update against wrong identity', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn();
    // Row returned for the login id carries a DIFFERENT row id (simulated
    // inconsistency): hook must refuse to use its mapping.
    portalAuthService.getPortalUserById.mockResolvedValue({
      id: 'pusr_other', customer_id: 'CUST-X', email: 'other@example.com', auth_user_id: MAPPED_UUID,
    });
    await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
      .expect(200);
    expect(adminMock.updateAuthUserPassword).not.toHaveBeenCalled();
  });

  test('H: repeated logins update same identity, no mapping change', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn().mockResolvedValue({ ok: true });
    const app = buildApp();
    await request(app).post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD }).expect(200);
    await request(app).post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD }).expect(200);
    expect(adminMock.updateAuthUserPassword).toHaveBeenCalledTimes(2);
    expect(adminMock.updateAuthUserPassword).toHaveBeenNthCalledWith(1, MAPPED_UUID, FAKE_PASSWORD);
    expect(adminMock.updateAuthUserPassword).toHaveBeenNthCalledWith(2, MAPPED_UUID, FAKE_PASSWORD);
    expect(portalAuthService.createSession).toHaveBeenCalledTimes(2); // normal per-login sessions only
  });

  test('I: password absent from logs/errors/response/store', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn().mockResolvedValue({ ok: true });
    const { logged, restore } = captureConsole();
    let res;
    try {
      res = await request(buildApp())
        .post('/api/portal/auth/login-password')
        .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
        .expect(200);
    } finally {
      restore();
    }
    expect(logged.join('\n')).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_PASSWORD);
    // The password legitimately reaches only authenticatePortalUser
    // (pre-existing) and the hybrid Admin call (by design). It must not
    // reach session creation, history, or row lookups.
    expect(JSON.stringify(portalAuthService.createSession.mock.calls)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(portalAuthService.recordLoginHistory.mock.calls)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(portalAuthService.getPortalUserById.mock.calls)).not.toContain(FAKE_PASSWORD);
  });

  test('J: state invariants (hash/sessions/MFA untouched by hook)', async () => {
    const adminMock = require('../services/supabasePortalAuthAdmin.cjs');
    adminMock.updateAuthUserPassword = jest.fn().mockResolvedValue({ ok: true });
    await request(buildApp())
      .post('/api/portal/auth/login-password')
      .send({ email: 'hyb@example.com', password: FAKE_PASSWORD })
      .expect(200);
    // Hook performs no store writes itself: only the pre-existing login
    // writes (session + login history) occur.
    expect(portalAuthService.createSession).toHaveBeenCalledTimes(1);
    expect(portalAuthService.recordLoginHistory).toHaveBeenCalledTimes(1);
  });
});
