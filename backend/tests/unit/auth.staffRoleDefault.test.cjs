/**
 * auth.staffRoleDefault.test.cjs
 *
 * Regression: the Supabase grant branch of authService.authenticateUser used
 * to default a missing `user_metadata.role` to 'Admin', so ANY Supabase
 * account without a role claim (e.g. an account created through the project's
 * public signup, which needs no ERP involvement) received a full ERP admin
 * JWT from POST /api/auth/login. Admin must now come only from an explicit
 * Admin role or the super-admin flag.
 */
process.env.JWT_SECRET = 'test-jwt-secret-staff-role';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_PUBLISHABLE_KEY = 'anon-key';

const request = require('supertest');
const express = require('express');

jest.mock('../../services/supabaseRepository.cjs', () => ({
  getAll: jest.fn().mockResolvedValue([]),
  upsert: jest.fn().mockResolvedValue({}),
  getById: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/portalAuthService.cjs', () => ({
  authenticatePortalUser: jest.fn().mockResolvedValue(null),
  isTwoFactorEnabled: jest.fn().mockResolvedValue(false),
  getTwoFactorSecret: jest.fn(),
  verifyTwoFactorToken: jest.fn(),
  createSession: jest.fn(),
  recordLoginHistory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('axios');

const axios = require('axios');
const repo = require('../../services/supabaseRepository.cjs');
const authService = require('../../services/authService.cjs');

const grantAs = (metadata) => axios.post.mockResolvedValue({
  data: { user: { id: 'sb_1', email: 'sb@example.com', user_metadata: metadata } },
});

describe('authenticateUser — Supabase grant never defaults to Admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.getAll.mockResolvedValue([]);
    repo.upsert.mockResolvedValue({});
  });

  it('rejects an account with no role claim', async () => {
    grantAs({ email_verified: true });
    const user = await authService.authenticateUser('sb@example.com', 'pw');
    expect(user).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('admits an explicit Admin role', async () => {
    grantAs({ role: 'Admin' });
    const user = await authService.authenticateUser('sb@example.com', 'pw');
    expect(user.role).toBe('Admin');
  });

  it('admits a super-admin flag even without a role claim', async () => {
    grantAs({ is_super_admin: true });
    const user = await authService.authenticateUser('sb@example.com', 'pw');
    expect(user.role).toBe('Admin');
    expect(user.is_super_admin).toBe(true);
  });

  it('keeps an explicit non-Admin role instead of escalating it', async () => {
    grantAs({ role: 'portal_customer' });
    const user = await authService.authenticateUser('sb@example.com', 'pw');
    expect(user.role).toBe('portal_customer');
  });

  it('POST /api/auth/login does not mint a token for a role-less Supabase account', async () => {
    grantAs({});
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../routes/auth.cjs'));
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sb@example.com', password: 'password1' });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('POST /api/auth/login still mints an Admin token for an explicit Admin', async () => {
    grantAs({ role: 'Admin' });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../routes/auth.cjs'));
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sb@example.com', password: 'password1' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.role).toBe('admin');
  });
});
