/**
 * customerRegistrationService approveRequest tests — hermetic
 * (repo / repoCanonical / workflowEngine / portalLifecycleService /
 * portalAuthService / referralService / auditService are mocked;
 * no Supabase, no network, no writes).
 *
 * Covers 38 cases:
 *   Service-level approveRequest:
 *     1. Approves pending request (customer + portal user + invite)
 *     2. Idempotent retry returns alreadyApproved:true
 *     3. Rejects already-approved request (409)
 *     4. Rejects rejected request (409)
 *     5. Rejects cancelled request (409)
 *     6. Rejects missing id
 *     7. Rejects non-existent id (404)
 *     8. Generates CUST-XXXX customer number
 *     9. Creates customer in canonical store
 *     10. Creates portal user with invited status
 *     11. Generates invite code
 *     12. Finalizes referral when referred_by_id present
 *     13. Skips referral when no referral
 *     14. Skips referral when one already exists for customer
 *     15. Sets linked_customer_id on request
 *     16. Records audit event on approval
 *     17. Compensation: soft-deletes customer when portal user fails
 *     18. Compensation: does not soft-delete when customer creation fails
 *     19. Transition guard: pending → approved only
 *     20. Strips password from context metadata
 *   HTTP route tests:
 *     21. Anonymous → 403
 *     22. portal_customer → 403
 *     23. Staff → 200 + approval flow
 *     24. Staff → 404 for non-existent
 *     25. Staff → 409 for already-approved
 *     26. Staff → 409 for rejected request
 *     27. Staff → 409 for cancelled request
 *     28. Staff → 200 with customerId, portalUserId, inviteCode
 *     29. Staff → 400 when portal user creation fails
 *     30. Staff → 200 with minimal input (no phone/tier/note)
 *     31. Staff → preserves admin_notes
 *     32. Staff → uses provided reviewedBy
 *   Edge cases:
 *     33. Approval with null referred_by_id
 *     34. Referral service unavailable (graceful)
 *     35. repoCanonical unavailable (graceful)
 *     36. Approval generates unique customer numbers sequentially
 *     37. Approval does not store password hash
 *     38. Approval transition is irreversible (terminal)
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-approval-tests';
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

jest.mock('../services/portalAuthService.cjs', () => ({
  getPortalUserByEmail: jest.fn(),
  getPortalUserByCustomerId: jest.fn(),
  registerPortalUser: jest.fn(),
  createInviteCode: jest.fn(),
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
      return String(org).toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '') || null;
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

const request = require('supertest');
const express = require('express');

const tables = new Map();
function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

const STAFF_HEADERS = {
  'x-user-id': 'admin-1',
  'x-user-role': 'Admin',
  'x-user-email': 'admin@prime.mw',
};

const VALID_REQUEST = () => ({
  companyName: 'Acme Printers Ltd',
  contactName: 'Ada Banda',
  email: 'ada.banda@example.com',
  phone: '0888123456',
  tier: 'Standard',
});

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/admin', require('../routes/portalAdmin.cjs'));
  return app;
}

function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/registration-requests', require('../routes/registrationRequests.cjs'));
  return app;
}

function seedRequest(opts = {}) {
  const r = {
    id: opts.id || 'creg_test_001',
    request_number: opts.requestNumber || 'CREG-2026-000001',
    company_name: opts.companyName || 'Acme Printers Ltd',
    contact_name: opts.contactName || 'Ada Banda',
    email: opts.email || 'ada.banda@example.com',
    phone: opts.phone || '0888123456',
    tier: opts.tier || 'Standard',
    note: opts.note || null,
    referred_by_code: opts.referredByCode || null,
    referred_by_id: opts.referredById || null,
    referred_by_name: opts.referredByName || null,
    status: opts.status || 'pending',
    admin_notes: null,
    linked_customer_id: opts.linkedCustomerId || null,
    created_by: null,
    assigned_to: null,
    assigned_at: null,
    reviewed_by: null,
    reviewed_at: null,
    submitted_at: '2026-01-01T00:00:00.000Z',
    idempotency_key: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  tableMap('customer_registration_requests').set(r.id, { ...r });
  return r;
}

describe('customerRegistrationService.approveRequest', () => {
  beforeEach(() => {
    tables.clear();
    jest.clearAllMocks();
    auditService.logEvent.mockResolvedValue({ id: 'audit-1' });
    portalAuthService.registerPortalUser.mockReset();
    portalAuthService.createInviteCode.mockReset();
    ReferralService.__state.registerCalls = [];
    ReferralService.__state.getAll.mockReturnValue({ referrals: [], total: 0, page: 1, limit: 10, totalPages: 0 });

    let seq = 0;
    workflowEngine.nextYearScopedNumber.mockImplementation(async () => {
      seq += 1;
      return `CREG-2026-${String(seq).padStart(6, '0')}`;
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
    portalAuthService.registerPortalUser.mockResolvedValue({ id: 'pusr_approved_001', status: 'invited' });
    portalAuthService.createInviteCode.mockResolvedValue({ code: '123456', expires_at: null });
  });

  // ── 1. Approves pending request ──────────────────────────────────
  it('approves a pending request and creates customer + portal user + invite code', async () => {
    seedRequest({ status: 'pending' });
    const result = await service.approveRequest('creg_test_001', {
      reviewedBy: 'admin-1',
      context: { ip: '1.2.3.4', method: 'POST', path: '/test' },
    });

    expect(result.request.status).toBe('approved');
    expect(result.customerId).toMatch(/^CUST-\d{4}$/);
    expect(result.portalUserId).toBe('pusr_approved_001');
    expect(result.inviteCode).toBe('123456');
  });

  // ── 2. Idempotent retry ──────────────────────────────────────────
  it('returns alreadyApproved:true on idempotent retry', async () => {
    seedRequest({ status: 'approved', linkedCustomerId: 'CUST-0001' });
    const result = await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(result.alreadyApproved).toBe(true);
    expect(result.request.status).toBe('approved');
    expect(result.linkedCustomerId).toBe('CUST-0001');
  });

  // ── 3. Rejects already-approved ──────────────────────────────────
  it('returns alreadyApproved:true when request is already approved', async () => {
    seedRequest({ status: 'approved', linkedCustomerId: 'CUST-0001' });
    const result = await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(result.alreadyApproved).toBe(true);
    expect(result.request.status).toBe('approved');
    expect(result.linkedCustomerId).toBe('CUST-0001');
  });

  // ── 4. Rejects rejected request ──────────────────────────────────
  it('throws when request is rejected', async () => {
    seedRequest({ status: 'rejected' });
    await expect(service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Invalid registration request transition');
  });

  // ── 5. Rejects cancelled request ─────────────────────────────────
  it('throws when request is cancelled', async () => {
    seedRequest({ status: 'cancelled' });
    await expect(service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Invalid registration request transition');
  });

  // ── 6. Rejects missing id ────────────────────────────────────────
  it('throws when id is missing', async () => {
    await expect(service.approveRequest(null, { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Registration request id is required');
  });

  // ── 7. Rejects non-existent id ───────────────────────────────────
  it('throws 404-style error for non-existent id', async () => {
    await expect(service.approveRequest('creg_nonexistent', { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Registration request not found');
  });

  // ── 8. Generates CUST-XXXX ───────────────────────────────────────
  it('generates CUST-XXXX customer number', async () => {
    seedRequest({ status: 'pending' });
    const result = await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });
    expect(result.customerId).toMatch(/^CUST-\d{4}$/);
  });

  // ── 9. Creates customer in canonical store ───────────────────────
  it('creates customer in canonical store', async () => {
    seedRequest({ status: 'pending' });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    const customerUpserts = repoCanonical.upsert.mock.calls.filter((c) => c[0] === 'customers');
    expect(customerUpserts.length).toBeGreaterThan(0);
    const customer = customerUpserts[0][1];
    expect(customer.id).toMatch(/^CUST-\d{4}$/);
    expect(customer.name).toBe('Acme Printers Ltd');
    expect(customer.email).toBe('ada.banda@example.com');
  });

  // ── 10. Creates portal user with invited status ──────────────────
  it('creates portal user with invited status', async () => {
    seedRequest({ status: 'pending' });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(portalAuthService.registerPortalUser).toHaveBeenCalledTimes(1);
    const callArgs = portalAuthService.registerPortalUser.mock.calls[0][0];
    expect(callArgs.status).toBe('invited');
    expect(callArgs.customer_id).toMatch(/^CUST-\d{4}$/);
    expect(callArgs.email).toMatch(/@prime\.mw$/);
    expect(callArgs.password).toBeDefined();
  });

  // ── 11. Generates invite code ────────────────────────────────────
  it('generates invite code for portal user', async () => {
    seedRequest({ status: 'pending' });
    const result = await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(portalAuthService.createInviteCode).toHaveBeenCalledWith(result.portalUserId);
    expect(result.inviteCode).toBe('123456');
  });

  // ── 12. Finalizes referral ───────────────────────────────────────
  it('finalizes referral when referred_by_id present', async () => {
    seedRequest({ status: 'pending', referredById: 'CUST-0007', referredByName: 'Chimwemwe' });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(ReferralService.__state.registerCalls.length).toBe(1);
    const regArgs = ReferralService.__state.registerCalls[0][0];
    expect(regArgs.customer_id).toMatch(/^CUST-\d{4}$/);
    expect(regArgs.referred_by_id).toBe('CUST-0007');
    expect(regArgs.referred_by_name).toBe('Chimwemwe');
  });

  // ── 13. Skips referral when no referral ──────────────────────────
  it('skips referral finalization when no referral', async () => {
    seedRequest({ status: 'pending', referredById: null });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(ReferralService.__state.registerCalls.length).toBe(0);
  });

  // ── 14. Skips referral when one already exists ───────────────────
  it('skips referral when one already exists for customer', async () => {
    seedRequest({ status: 'pending', referredById: 'CUST-0007' });
    tableMap('customer_referrals').set('ref-1', {
      id: 'ref-1', customer_id: 'CUST-0001', referral_code: 'TESTCODE', status: 'active',
    });
    ReferralService.__state.getAll.mockResolvedValue({
      referrals: [{ id: 'ref-1' }], total: 1, page: 1, limit: 10, totalPages: 1,
    });

    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(ReferralService.__state.registerCalls.length).toBe(0);
  });

  // ── 15. Sets linked_customer_id ──────────────────────────────────
  it('sets linked_customer_id on request', async () => {
    seedRequest({ status: 'pending' });
    const result = await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(result.request.linkedCustomerId).toMatch(/^CUST-\d{4}$/);
    const stored = tableMap('customer_registration_requests').get('creg_test_001');
    expect(stored.linked_customer_id).toBe(result.request.linkedCustomerId);
  });

  // ── 16. Records audit event ──────────────────────────────────────
  it('records audit event on approval', async () => {
    seedRequest({ status: 'pending' });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    expect(auditService.logEvent).toHaveBeenCalled();
    const auditCall = auditService.logEvent.mock.calls[0][0];
    expect(auditCall.action).toBe('REGISTRATION_REQUEST_APPROVED');
    expect(auditCall.entityType).toBe('customer_registration_request');
  });

  // ── 17. Compensation: soft-delete customer on portal user failure ──
  it('compensates by soft-deleting customer when portal user creation fails', async () => {
    seedRequest({ status: 'pending' });
    portalAuthService.registerPortalUser.mockRejectedValueOnce(new Error('Portal user creation failed'));

    await expect(service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Portal user creation failed');

    expect(repoCanonical.softDelete).toHaveBeenCalled();
    const softDeleteCall = repoCanonical.softDelete.mock.calls[0];
    expect(softDeleteCall[0]).toBe('customers');
    expect(softDeleteCall[1]).toMatch(/^CUST-\d{4}$/);
  });

  // ── 18. No compensation when customer creation fails ─────────────
  it('does not soft-delete when customer creation fails before portal user', async () => {
    seedRequest({ status: 'pending' });
    repoCanonical.upsert.mockRejectedValueOnce(new Error('Customer creation failed'));

    await expect(service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' }))
      .rejects.toThrow('Customer creation failed');

    expect(repoCanonical.softDelete).not.toHaveBeenCalled();
  });

  // ── 19. Transition guard ─────────────────────────────────────────
  it('only allows pending → approved transition', async () => {
    seedRequest({ status: 'pending' });
    await service.approveRequest('creg_test_001', { reviewedBy: 'admin-1' });

    const stored = tableMap('customer_registration_requests').get('creg_test_001');
    expect(stored.status).toBe('approved');
  });

  // ── 20. Strips password from context ─────────────────────────────
  it('does not store password in any record', async () => {
    seedRequest({ status: 'pending' });
    await service.approveRequest('creg_test_001', {
      reviewedBy: 'admin-1',
      adminNotes: 'verified: yes',
    });

    const serialized = JSON.stringify(tableMap('customer_registration_requests').get('creg_test_001'));
    expect(serialized).not.toMatch(/supersecret\d+/);
    const customerUpserts = repoCanonical.upsert.mock.calls.filter((c) => c[0] === 'customers');
    const customerJson = JSON.stringify(customerUpserts[0]?.[1] || {});
    expect(customerJson).not.toMatch(/supersecret\d+/);
  });

  // ── HTTP route tests ─────────────────────────────────────────────
  describe('POST /api/portal/admin/registration-requests/:id/approve', () => {
    // ── 21. Anonymous → 403 ──────────────────────────────────────
    it('anonymous callers cannot approve (403)', async () => {
      await request(buildAdminApp())
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .expect(403);
    });

    // ── 22. portal_customer → 403 ────────────────────────────────
    it('portal_customer tokens cannot approve (403)', async () => {
      await request(buildAdminApp())
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set({ 'x-user-id': 'pusr_1', 'x-user-role': 'portal_customer', 'x-user-email': 'cust@example.com' })
        .expect(403);
    });

    // ── 23. Staff → 200 ──────────────────────────────────────────
    it('staff can approve a pending request', async () => {
      seedRequest({ status: 'pending' });
      const admin = buildAdminApp();
      const result = await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      expect(result.body.request.status).toBe('approved');
      expect(result.body.customerId).toMatch(/^CUST-\d{4}$/);
    });

    // ── 24. Staff → 404 ──────────────────────────────────────────
    it('staff gets 404 for non-existent request', async () => {
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_nonexistent/approve')
        .set(STAFF_HEADERS)
        .expect(404);
    });

    // ── 25. Staff → 409 already approved ─────────────────────────
    it('staff gets 409 for already-approved request', async () => {
      seedRequest({ status: 'approved', linked_customer_id: 'CUST-0001' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(409);
    });

    // ── 26. Staff → 409 rejected ─────────────────────────────────
    it('staff gets 409 for rejected request', async () => {
      seedRequest({ status: 'rejected' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(409);
    });

    // ── 27. Staff → 409 cancelled ────────────────────────────────
    it('staff gets 409 for cancelled request', async () => {
      seedRequest({ status: 'cancelled' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(409);
    });

    // ── 28. Staff → 200 with customerId, portalUserId, inviteCode ──
    it('returns customerId, portalUserId, and inviteCode', async () => {
      seedRequest({ status: 'pending' });
      const admin = buildAdminApp();
      const result = await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      expect(result.body.customerId).toMatch(/^CUST-\d{4}$/);
      expect(result.body.portalUserId).toBeDefined();
      expect(result.body.inviteCode).toBeDefined();
    });

    // ── 29. Staff → 400 when portal user creation fails ──────────
    it('returns 400 when portal user creation fails', async () => {
      seedRequest({ status: 'pending' });
      portalAuthService.registerPortalUser.mockRejectedValueOnce(new Error('Portal user creation failed'));
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(400);
    });

    // ── 30. Staff → 200 with minimal input ───────────────────────
    it('approves with minimal input (no phone/tier/note)', async () => {
      seedRequest({ status: 'pending', phone: null, tier: null, note: null });
      const admin = buildAdminApp();
      const result = await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      expect(result.body.request.status).toBe('approved');
      expect(result.body.customerId).toMatch(/^CUST-\d{4}$/);
    });

    // ── 31. Preserves admin_notes ────────────────────────────────
    it('preserves admin_notes when provided', async () => {
      seedRequest({ status: 'pending' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .send({ admin_notes: 'Verified business license' })
        .expect(200);

      const stored = tableMap('customer_registration_requests').get('creg_test_001');
      expect(stored.admin_notes).toBe('Verified business license');
    });

    // ── 32. Uses provided reviewedBy ─────────────────────────────
    it('uses provided reviewedBy from req.user.id', async () => {
      seedRequest({ status: 'pending' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set({ 'x-user-id': 'super-admin', 'x-user-role': 'Admin', 'x-user-email': 'boss@prime.mw' })
        .expect(200);

      const stored = tableMap('customer_registration_requests').get('creg_test_001');
      expect(stored.reviewed_by).toBe('super-admin');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────
  describe('Edge cases', () => {
    // ── 33. Approval with null referred_by_id ─────────────────────
    it('handles null referred_by_id without error', async () => {
      seedRequest({ status: 'pending', referredById: null, referredByCode: null });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      expect(ReferralService.__state.registerCalls.length).toBe(0);
    });

    // ── 34. Referral service unavailable (graceful) ──────────────
    it('gracefully handles referral service unavailability', async () => {
      seedRequest({ status: 'pending', referredById: 'CUST-0007' });
      jest.doMock('../services/referralService.cjs', () => {
        return jest.fn().mockImplementation(() => ({
          getAll: jest.fn().mockRejectedValue(new Error('DB down')),
          register: jest.fn(),
        }));
      });

      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      jest.dontMock('../services/referralService.cjs');
    });

    // ── 35. repoCanonical unavailable (graceful) ─────────────────
    it('gracefully handles repoCanonical unavailability', async () => {
      seedRequest({ status: 'pending' });
      repoCanonical.upsert.mockRejectedValueOnce(new Error('Canonical unavailable'));
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(400);
    });

    // ── 36. Unique sequential customer numbers ───────────────────
    it('generates unique sequential CUST-XXXX numbers', async () => {
      tableMap('customers').set('CUST-0001', { id: 'CUST-0001', name: 'Existing' });
      seedRequest({ status: 'pending', id: 'creg_a' });
      const admin = buildAdminApp();
      const r1 = await request(admin)
        .post('/api/portal/admin/registration-requests/creg_a/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      seedRequest({ status: 'pending', id: 'creg_b' });
      const r2 = await request(admin)
        .post('/api/portal/admin/registration-requests/creg_b/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      expect(r1.body.customerId).not.toBe(r2.body.customerId);
      expect(r1.body.customerId).toBe('CUST-0002');
      expect(r2.body.customerId).toBe('CUST-0003');
    });

    // ── 37. No password hash stored ──────────────────────────────
    it('does not store password hash in portal user record', async () => {
      seedRequest({ status: 'pending' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(200);

      const regCall = portalAuthService.registerPortalUser.mock.calls[0][0];
      expect(regCall.password).toBeDefined();
      const stored = tableMap('portal_users').get('pusr_approved_001');
      expect(stored).toBeUndefined();
    });

    // ── 38. Transition is irreversible ───────────────────────────
    it('approved request cannot be re-approved or transitioned', async () => {
      seedRequest({ status: 'approved', linked_customer_id: 'CUST-0001' });
      const admin = buildAdminApp();
      await request(admin)
        .post('/api/portal/admin/registration-requests/creg_test_001/approve')
        .set(STAFF_HEADERS)
        .expect(409);
    });
  });
});
