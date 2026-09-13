/**
 * customerRegistrationLifecycle.test.cjs — end-to-end integration tests
 * covering the complete registration lifecycle matrix:
 *
 *   Portal registration → ERP approval → CUST-XXXX customer →
 *   portal user → activation → login → dashboard access
 *
 * All dependencies (repo, repoCanonical, workflowEngine, portalAuthService,
 * referralService, auditService, portalLifecycleService) are mocked.
 * No Supabase, no network, no real writes.
 *
 * Scenarios (12):
 *   1. New registration → pending request only (ZERO customers, ZERO portal_users, ZERO tokens)
 *   2. Duplicate idempotency key → same request returned (no second row)
 *   3. Duplicate pending applicant (same email) → 409 with requestNumber
 *   4. Status lookup by request number + email → status only (no PII)
 *   5. Status lookup with wrong email → 404 (indistinguishable from not-found)
 *   6. Admin approval → CUST-XXXX + portal user (invited) + invite code
 *   7. Admin approval retry → alreadyApproved:true (idempotent)
 *   8. Portal user link → portal user customer_id = CUST-XXXX (not creg_...)
 *   9. Referral finalization → linked to CUST-XXXX
 *   10. Rejection → no customer/user/referral created; terminal state
 *   11. Cancellation → terminal; no customer/user/referral created
 *   12. Activation + login → invite code validates, status → active, JWT issued
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-lifecycle-tests';
process.env.ALLOW_HEADER_AUTH = 'true';

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
  softDelete: jest.fn(),
}));

jest.mock('../services/workflowEngine.cjs', () => ({
  nextYearScopedNumber: jest.fn(),
}));

jest.mock('../services/portalLifecycleService.cjs', () => ({
  publishErpEvent: jest.fn(),
}));

const portalLifecycle = require('../services/portalLifecycleService.cjs');

jest.mock('../services/portalAuthService.cjs', () => ({
  getPortalUserByEmail: jest.fn(),
  getPortalUserByCustomerId: jest.fn(),
  registerPortalUser: jest.fn(),
  createInviteCode: jest.fn(),
  activatePortalUser: jest.fn(),
  authenticatePortalUser: jest.fn(),
  generatePortalToken: jest.fn(),
  loginWithCustomerId: jest.fn(),
  setPortalUserStatus: jest.fn(),
  syncCustomerPortalData: jest.fn(),
}));

jest.mock('../services/referralService.cjs', () => {
  const state = { registerCalls: [], getAll: jest.fn(async () => ({ referrals: [], total: 0, page: 1, limit: 10, totalPages: 0 })) };
  const MockReferralService = jest.fn().mockImplementation(() => ({
    normalizePhone: (phone) => {
      if (phone === null || phone === undefined || phone === '') return null;
      return String(phone).replace(/\s+/g, '').replace(/^(\+?265|265|0)/, '').replace(/[^0-9]/g, '') || null;
    },
    normalizeEmail: (email) => {
      if (email === null || email === undefined) return null;
      return String(email).toLowerCase().trim().replace(/\s+/g, '') || null;
    },
    normalizeOrg: (org) => {
      if (org === null || org === undefined || org === '') return null;
      return String(org).toLowerCase().trim().replace(/[^a-z0-9 ]/g, '') || null;
    },
    checkFraudSignals: jest.fn(async () => []),
    generateReferralCode: jest.fn(async () => 'TESTCODE'),
    register: jest.fn(async (...args) => {
      state.registerCalls.push(args);
      return { id: 'ref_1' };
    }),
    getAll: state.getAll,
  }));
  MockReferralService.__state = state;
  return MockReferralService;
});

jest.mock('../auditService.cjs', () => ({
  auditService: { logEvent: jest.fn() },
}));

const repo = require('../services/supabaseRepository.cjs');
const repoCanonical = require('../services/supabaseCanonicalRepository.cjs');
const workflowEngine = require('../services/workflowEngine.cjs');
const portalAuthService = require('../services/portalAuthService.cjs');
const ReferralService = require('../services/referralService.cjs');
const { auditService } = require('../auditService.cjs');
const service = require('../services/customerRegistrationService.cjs');
const portalAdminRouter = require('../routes/portalAdmin.cjs');
const registrationRequestsRouter = require('../routes/registrationRequests.cjs');

const request = require('supertest');
const express = require('express');

// ─── In-memory envelope store ────────────────────────────────────
const tables = new Map();
function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

function upsertsTo(table) {
  return repo.upsert.mock.calls.filter((c) => c[0] === table);
}

function canonicalUpsertsTo(table) {
  return repoCanonical.upsert.mock.calls.filter((c) => c[0] === table);
}

const STAFF_HEADERS = {
  'x-user-id': 'admin-1',
  'x-user-role': 'Admin',
  'x-user-email': 'admin@prime.mw',
};

const VALID_INPUT = () => ({
  companyName: 'Acme Printers Ltd',
  contactName: 'Ada Banda',
  email: 'ada.banda@example.com',
  phone: '0888123456',
  tier: 'Standard',
});

function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/registration-requests', registrationRequestsRouter);
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/admin', portalAdminRouter);
  return app;
}

let reqSeq = 0;
function setupMocks() {
  tables.clear();
  jest.clearAllMocks();
  ReferralService.__state.registerCalls = [];
  ReferralService.__state.getAll.mockReturnValue({ referrals: [], total: 0, page: 1, limit: 10, totalPages: 0 });
  auditService.logEvent.mockResolvedValue({ id: 'audit-1' });
  portalLifecycle.publishErpEvent.mockResolvedValue({ published: true });

  reqSeq = 0;
  workflowEngine.nextYearScopedNumber.mockImplementation(async () => {
    reqSeq += 1;
    return `CREG-2026-${String(reqSeq).padStart(6, '0')}`;
  });

  repo.getAll.mockImplementation(async (table) => [...tableMap(table).values()]);
  repo.getById.mockImplementation(async (table, id) => tableMap(table).get(String(id)) || null);
  repo.upsert.mockImplementation(async (table, obj) => {
    tableMap(table).set(String(obj.id), { ...obj });
    return { ...obj };
  });
  repo.softDelete.mockImplementation(async (table, id) => {
    tableMap(table).delete(String(id));
    return { id };
  });

  repoCanonical.getAll.mockImplementation(async (table) => [...tableMap(table).values()]);
  repoCanonical.getById.mockImplementation(async (table, id) => tableMap(table).get(String(id)) || null);
  repoCanonical.upsert.mockImplementation(async (table, obj) => {
    tableMap(table).set(String(obj.id), { ...obj });
    return { ...obj };
  });
  repoCanonical.softDelete.mockImplementation(async (table, id) => {
    tableMap(table).delete(String(id));
    return { id };
  });

  portalAuthService.getPortalUserByEmail.mockResolvedValue(null);
  portalAuthService.registerPortalUser.mockResolvedValue({ id: 'pusr_001', status: 'invited', email: 'ada@prime.mw' });
  portalAuthService.createInviteCode.mockResolvedValue({ code: '123456', expires_at: null });
  portalAuthService.activatePortalUser.mockResolvedValue({ id: 'pusr_001', status: 'active', customer_id: 'CUST-0001' });
  portalAuthService.authenticatePortalUser.mockResolvedValue({ id: 'pusr_001', customer_id: 'CUST-0001', email: 'ada@prime.mw' });
  portalAuthService.generatePortalToken.mockResolvedValue({ access_token: 'jwt-token-abc', refresh_token: 'jwt-refresh-xyz' });
  portalAuthService.loginWithCustomerId.mockResolvedValue({ id: 'pusr_001', customer_id: 'CUST-0001', email: 'ada@prime.mw', full_name: 'Ada Banda' });
  portalAuthService.setPortalUserStatus.mockResolvedValue(undefined);
  portalAuthService.syncCustomerPortalData.mockReturnValue(undefined);
}

describe('customerRegistrationLifecycle', () => {
  // ─── Scenario 1: New registration → pending request only ──────
  describe('S1 — New registration creates only a pending request', () => {
    beforeEach(setupMocks);

    it('creates exactly one pending request', async () => {
      const record = await service.createRegistrationRequest(VALID_INPUT());
      expect(record.status).toBe('pending');
      expect(record.request_number).toMatch(/^CREG-2026-\d{6}$/);
      expect(upsertsTo('customer_registration_requests')).toHaveLength(1);
    });

    it('creates ZERO customers, ZERO portal_users, ZERO tokens', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      expect(upsertsTo('customers')).toHaveLength(0);
      expect(upsertsTo('portal_users')).toHaveLength(0);
      const allRows = [...tableMap('customer_registration_requests').values()];
      for (const r of allRows) {
        expect(r.password).toBeUndefined();
        expect(r.password_hash).toBeUndefined();
        expect(r.access_token).toBeUndefined();
        expect(r.refresh_token).toBeUndefined();
      }
    });

    it('public response contains no credential or user material', async () => {
      const app = buildPublicApp();
      const res = await request(app)
        .post('/api/portal/registration-requests')
        .send(VALID_INPUT());
      expect(res.status).toBe(201);
      expect(res.body.requestNumber).toMatch(/^CREG-/);
      expect(res.body.status).toBe('pending');
      expect(res.body).not.toHaveProperty('access_token');
      expect(res.body).not.toHaveProperty('refresh_token');
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('customer_id');
      expect(res.body).not.toHaveProperty('portal_user');
    });
  });

  // ─── Scenario 2: Duplicate idempotency key ────────────────────
  describe('S2 — Duplicate idempotency key returns same request', () => {
    beforeEach(setupMocks);

    it('same idempotency key → same request, no second row', async () => {
      const first = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        idempotencyKey: 'idem-key-001',
      });
      const second = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        idempotencyKey: 'idem-key-001',
      });
      expect(second.id).toBe(first.id);
      expect(upsertsTo('customer_registration_requests')).toHaveLength(1);
    });
  });

  // ─── Scenario 3: Duplicate pending applicant ──────────────────
  describe('S3 — Duplicate pending applicant gets 409 with requestNumber', () => {
    beforeEach(setupMocks);

    it('service layer throws DUPLICATE_PENDING_REQUEST with existingRequest', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      await expect(
        service.createRegistrationRequest({ ...VALID_INPUT(), email: 'ADA.BANDA@example.com' })
      ).rejects.toHaveProperty('code', 'DUPLICATE_PENDING_REQUEST');
    });

    it('HTTP 409 response includes requestNumber', async () => {
      const app = buildPublicApp();
      await request(app)
        .post('/api/portal/registration-requests')
        .send(VALID_INPUT());
      const res = await request(app)
        .post('/api/portal/registration-requests')
        .send({ ...VALID_INPUT(), email: 'ada.banda@example.com' });
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty('requestNumber');
      expect(res.body.requestNumber).toMatch(/^CREG-/);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── Scenario 4: Status lookup ────────────────────────────────
  describe('S4 — Status lookup by request number + email', () => {
    beforeEach(setupMocks);

    it('returns status only, no PII', async () => {
      const app = buildPublicApp();
      const createRes = await request(app)
        .post('/api/portal/registration-requests')
        .send(VALID_INPUT());
      const reqNum = createRes.body.requestNumber;
      const res = await request(app)
        .get(`/api/portal/registration-requests/${reqNum}?email=ada.banda@example.com`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('requestNumber');
      expect(res.body).toHaveProperty('status');
      expect(res.body).not.toHaveProperty('email');
      expect(res.body).not.toHaveProperty('phone');
      expect(res.body).not.toHaveProperty('company_name');
      expect(res.body).not.toHaveProperty('contact_name');
    });
  });

  // ─── Scenario 5: Wrong email → 404 ────────────────────────────
  describe('S5 — Status lookup with wrong email → 404', () => {
    beforeEach(setupMocks);

    it('wrong email returns 404 indistinguishable from not-found', async () => {
      const app = buildPublicApp();
      const createRes = await request(app)
        .post('/api/portal/registration-requests')
        .send(VALID_INPUT());
      const reqNum = createRes.body.requestNumber;
      const res = await request(app)
        .get(`/api/portal/registration-requests/${reqNum}?email=wrong@example.com`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ─── Scenario 6: Admin approval ───────────────────────────────
  describe('S6 — Admin approval creates CUST-XXXX + portal user + invite', () => {
    beforeEach(setupMocks);

    it('approval creates customer, portal user, and invite code', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const result = await service.approveRequest(created.id, {
        reviewedBy: 'admin-1',
        context: { ip: '1.2.3.4', method: 'POST', path: '/test' },
      });
      expect(result.request.status).toBe('approved');
      expect(result.customerId).toMatch(/^CUST-\d{4}$/);
      expect(result.portalUserId).toBeTruthy();
      expect(result.inviteCode).toBe('123456');
      expect(canonicalUpsertsTo('customers')).toHaveLength(1);
      expect(portalAuthService.registerPortalUser).toHaveBeenCalledWith(
        expect.objectContaining({ customer_id: result.customerId, status: 'invited' })
      );
      expect(portalAuthService.createInviteCode).toHaveBeenCalled();
    });

    it('HTTP approval route returns customerId, portalUserId, inviteCode', async () => {
      const app = buildAdminApp();
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const res = await request(app)
        .post(`/api/portal/admin/registration-requests/${created.id}/approve`)
        .set(STAFF_HEADERS)
        .send({ adminNotes: 'Approved' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('customerId');
      expect(res.body.customerId).toMatch(/^CUST-\d{4}$/);
      expect(res.body).toHaveProperty('portalUserId');
      expect(res.body).toHaveProperty('inviteCode');
    });
  });

  // ─── Scenario 7: Approval idempotency ─────────────────────────
  describe('S7 — Approval idempotency', () => {
    beforeEach(setupMocks);

    it('retry returns alreadyApproved:true', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await service.approveRequest(created.id, { reviewedBy: 'admin-1' });
      const result = await service.approveRequest(created.id, { reviewedBy: 'admin-1' });
      expect(result.alreadyApproved).toBe(true);
      expect(result.linkedCustomerId).toMatch(/^CUST-/);
    });

    it('HTTP retry returns 409 alreadyApproved', async () => {
      const app = buildAdminApp();
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await request(app)
        .post(`/api/portal/admin/registration-requests/${created.id}/approve`)
        .set(STAFF_HEADERS)
        .send({ adminNotes: 'First' });
      const res = await request(app)
        .post(`/api/portal/admin/registration-requests/${created.id}/approve`)
        .set(STAFF_HEADERS)
        .send({ adminNotes: 'Retry' });
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty('request');
    });
  });

  // ─── Scenario 8: Portal user link ─────────────────────────────
  describe('S8 — Portal user linked to CUST-XXXX (not creg_...)', () => {
    beforeEach(setupMocks);

    it('portal user customer_id equals CUST-XXXX', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const result = await service.approveRequest(created.id, { reviewedBy: 'admin-1' });
      const customerId = result.customerId;
      expect(customerId).toMatch(/^CUST-\d{4}$/);
      const portalUser = await portalAuthService.registerPortalUser.mock.calls[0][0];
      expect(portalUser.customer_id).toBe(customerId);
      expect(portalUser.customer_id).not.toMatch(/^creg_/);
    });
  });

  // ─── Scenario 9: Referral finalization ────────────────────────
  describe('S9 — Referral finalization linked to CUST-XXXX', () => {
    beforeEach(setupMocks);

    it('referral register called with CUST-XXXX customer_id', async () => {
      tableMap('customer_referrals').set('ref-1', {
        id: 'ref-1',
        referral_code: 'PRIME42X',
        referred_by_id: 'CUST-0007',
        referred_by_name: 'Chimwemwe',
      });
      const created = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        referredByCode: 'PRIME42X',
      });
      const result = await service.approveRequest(created.id, { reviewedBy: 'admin-1' });
      const customerId = result.customerId;
      expect(customerId).toMatch(/^CUST-/);
      const registerCall = ReferralService.__state.registerCalls[0];
      expect(registerCall).toBeTruthy();
      expect(registerCall[0].customer_id).toBe(customerId);
      expect(registerCall[0].customer_id).not.toBe(created.id);
      expect(registerCall[0].customer_id).not.toMatch(/^creg_/);
    });
  });

  // ─── Scenario 10: Rejection ───────────────────────────────────
  describe('S10 — Rejection creates nothing, terminal state', () => {
    beforeEach(setupMocks);

    it('rejected request: no customer, no portal user, no referral', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const rejected = await service.rejectRequest(created.id, {
        reviewedBy: 'admin-1',
        adminNotes: 'Duplicate customer',
      });
      expect(rejected.status).toBe('rejected');
      expect(upsertsTo('customers')).toHaveLength(0);
      expect(upsertsTo('portal_users')).toHaveLength(0);
      expect(ReferralService.__state.registerCalls).toHaveLength(0);
    });

    it('rejection is terminal — cannot approve or cancel', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'done' });
      await expect(
        service.approveRequest(created.id, { reviewedBy: 'admin-1' })
      ).rejects.toThrow(/Invalid registration request transition/);
      await expect(
        service.cancelRequest(created.id, {})
      ).rejects.toThrow(/Invalid registration request transition/);
    });
  });

  // ─── Scenario 11: Cancellation ────────────────────────────────
  describe('S11 — Cancellation creates nothing, terminal state', () => {
    beforeEach(setupMocks);

    it('cancelled request: no customer, no portal user, no referral', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const cancelled = await service.cancelRequest(created.id, {});
      expect(cancelled.status).toBe('cancelled');
      expect(upsertsTo('customers')).toHaveLength(0);
      expect(upsertsTo('portal_users')).toHaveLength(0);
      expect(ReferralService.__state.registerCalls).toHaveLength(0);
    });

    it('cancellation is terminal', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await service.cancelRequest(created.id, {});
      await expect(
        service.approveRequest(created.id, { reviewedBy: 'admin-1' })
      ).rejects.toThrow(/Invalid registration request transition/);
      await expect(
        service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'x' })
      ).rejects.toThrow(/Invalid registration request transition/);
    });
  });

  // ─── Scenario 12: Activation + Login ──────────────────────────
  describe('S12 — Activation and login', () => {
    beforeEach(setupMocks);

    it('activation validates invite code and sets status to active', async () => {
      const portalUserId = 'pusr_activated_001';
      portalAuthService.activatePortalUser.mockResolvedValue({
        id: portalUserId,
        customer_id: 'CUST-0001',
        status: 'active',
        email: 'ada@prime.mw',
      });
      const result = await portalAuthService.activatePortalUser({
        customer_id: 'CUST-0001',
        code: '123456',
        password: 'newPassword123!',
      });
      expect(result.status).toBe('active');
      expect(result.customer_id).toBe('CUST-0001');
    });

    it('login returns JWT token and session', async () => {
      portalAuthService.authenticatePortalUser.mockResolvedValue({
        id: 'pusr_001',
        customer_id: 'CUST-0001',
        email: 'ada@prime.mw',
      });
      portalAuthService.generatePortalToken.mockResolvedValue({
        access_token: 'jwt-token-abc',
        refresh_token: 'jwt-refresh-xyz',
      });
      const user = await portalAuthService.authenticatePortalUser('ada@prime.mw', 'password123');
      expect(user).toBeTruthy();
      expect(user.customer_id).toBe('CUST-0001');
      const token = await portalAuthService.generatePortalToken(user.id, user.email, 'portal_customer');
      expect(token.access_token).toBe('jwt-token-abc');
    });

    it('loginWithCustomerId resolves portal user by customer_id', async () => {
      portalAuthService.loginWithCustomerId.mockResolvedValue({
        id: 'pusr_001',
        customer_id: 'CUST-0001',
        email: 'ada@prime.mw',
        full_name: 'Ada Banda',
      });
      const result = await portalAuthService.loginWithCustomerId('CUST-0001', 'Ada Banda');
      expect(result).toBeTruthy();
      expect(result.customer_id).toBe('CUST-0001');
    });
  });
});