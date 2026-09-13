/**
 * authBoundary.security.test.cjs
 *
 * Authentication-boundary regression suite (penetration-audit Phase 20).
 *
 * Proves, without a browser and without touching real data:
 *   1. verifyToken denies unauthenticated requests (401) and accepts a
 *      valid backend JWT.
 *   2. requireRole denies unauthenticated with 401 and an authenticated
 *      caller with the wrong role with 403 (denial, never auth failure).
 *   3. The staff-only portal-admin surface rejects anonymous callers and
 *      portal_customer JWTs (which share JWT_SECRET with staff JWTs),
 *      including the destructive company-wipe endpoint.
 *   4. Public document verification needs no credential and establishes no
 *      ERP session.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-boundary-tests';

const request = require('supertest');
const express = require('express');

jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getAll: jest.fn().mockResolvedValue([]),
  getAllFlat: jest.fn().mockResolvedValue([]),
  getById: jest.fn().mockResolvedValue(null),
  upsert: jest.fn().mockResolvedValue({}),
  softDelete: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/portalAuthService.cjs', () => ({
  getPortalUserByEmail: jest.fn(),
  getPortalUserById: jest.fn(),
  getPortalUserByCustomerId: jest.fn(),
  registerPortalUser: jest.fn(),
  updatePortalUser: jest.fn(),
  updatePassword: jest.fn(),
  revokeAllSessions: jest.fn(),
  createInviteCode: jest.fn(),
  setPortalUserStatus: jest.fn(),
}));
jest.mock('../../services/portalLifecycleService.cjs', () => ({
  adminListRequests: jest.fn().mockResolvedValue([]),
  getInboxRequests: jest.fn().mockResolvedValue([]),
  subscribeAdmin: jest.fn(),
}));
jest.mock('../../services/customerRegistrationService.cjs', () => ({}));
jest.mock('../../services/bannerImageService.cjs', () => ({
  BannerImageError: class BannerImageError extends Error {},
  processBannerImage: jest.fn(),
}));

const { verifyToken, requireRole, generateToken } = require('../../middleware/auth.cjs');
const portalAdminRoutes = require('../../routes/portalAdmin.cjs');

const tokenFor = (role, extra = {}) => generateToken({
  id: `usr_${role}`,
  username: `${role}@example.com`,
  role,
  email: `${role}@example.com`,
  ...extra,
});

const mockRes = () => {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

describe('verifyToken — unauthenticated requests are denied', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = mockRes();
    let nextCalled = false;
    await verifyToken({ path: '/dashboard', headers: {}, method: 'GET' }, res, () => { nextCalled = true; });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('returns 401 for a malformed/garbage bearer token', async () => {
    const res = mockRes();
    let nextCalled = false;
    await verifyToken(
      { path: '/dashboard', headers: { authorization: 'Bearer not-a-jwt' }, method: 'GET' },
      res,
      () => { nextCalled = true; },
    );
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('accepts a valid backend JWT and populates req.user', async () => {
    const res = mockRes();
    let nextCalled = false;
    const req = { path: '/dashboard', headers: { authorization: `Bearer ${tokenFor('Admin')}` }, method: 'GET' };
    await verifyToken(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user.role).toBe('Admin');
  });
});

describe('requireRole — authorization denial is 403, not 401', () => {
  it('returns 401 when there is no authenticated user', () => {
    const res = mockRes();
    requireRole('Admin')({}, res, () => { throw new Error('must not pass'); });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for an authenticated portal customer', () => {
    const res = mockRes();
    requireRole('Admin')({ user: { role: 'portal_customer' } }, res, () => { throw new Error('must not pass'); });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an authenticated legacy role not in the allow-list', () => {
    const res = mockRes();
    requireRole('Admin')({ user: { role: 'Clerk' } }, res, () => { throw new Error('must not pass'); });
    expect(res.statusCode).toBe(403);
  });

  it('passes an authenticated Admin (case-insensitive)', () => {
    const res = mockRes();
    let nextCalled = false;
    requireRole('Admin')({ user: { role: 'admin' } }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

describe('portal-admin surface — staff only', () => {
  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/portal/admin', portalAdminRoutes);
    return app;
  };

  it('denies anonymous callers (403, no data)', async () => {
    const res = await request(buildApp()).get('/api/portal/admin/requests');
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('length');
  });

  it('denies a portal_customer JWT even though it shares JWT_SECRET', async () => {
    const res = await request(buildApp())
      .get('/api/portal/admin/requests')
      .set('Authorization', `Bearer ${tokenFor('portal_customer')}`);
    expect(res.status).toBe(403);
  });

  it('denies a portal_customer JWT on the destructive company wipe', async () => {
    const res = await request(buildApp())
      .post('/api/portal/admin/company/delete')
      .set('Authorization', `Bearer ${tokenFor('portal_customer')}`);
    expect(res.status).toBe(403);
    expect(res.body.ok).toBeUndefined();
  });

  it('allows an Admin JWT through the gate to the handler', async () => {
    const res = await request(buildApp())
      .get('/api/portal/admin/requests')
      .set('Authorization', `Bearer ${tokenFor('Admin')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('public document verification — no auth, no session', () => {
  it('serves an unknown document with the generic 404 and no cookies', async () => {
    const app = express();
    app.use('/api/public/documents', require('../../routes/documentVerify.cjs'));
    const res = await request(app).get('/api/public/documents/verify/invoice/INV-NOPE?t=deadbeef');
    expect(res.status).toBe(404);
    expect(res.body.verified).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
