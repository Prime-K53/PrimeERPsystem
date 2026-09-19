/**
 * portalLoginEmailBusinessName.test.cjs — portal login emails are ALWAYS
 * derived from the Business Name, never a contact/person name, and never
 * initials.
 *
 * Covers:
 *  - resolvePortalEmailBusinessName priority (business > company > legacy
 *    name; contact fields are never read)
 *  - approval flow derives the portal email from company_name even though a
 *    contact_name is present
 *  - bulk regenerate uses the stored business_name, not the legacy name
 *  - per-customer regenerate prefers the stored business over a
 *    request-supplied (contact) name
 *  - single-character leading words are fused, never emitted as initials
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-portal-email-tests';
process.env.ALLOW_HEADER_AUTH = 'true';

jest.mock('../../services/supabaseRepository.cjs', () => ({
  getById: jest.fn(),
  getAll: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
}));
jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getById: jest.fn(),
  getAll: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
}));

jest.mock('../../services/workflowEngine.cjs', () => ({
  nextYearScopedNumber: jest.fn(async () => 'CREG-2026-000001'),
}));

jest.mock('../../services/portalLifecycleService.cjs', () => ({
  publishErpEvent: jest.fn(async () => ({ published: true })),
}));

jest.mock('../../services/portalAuthService.cjs', () => ({
  getPortalUserByEmail: jest.fn(async () => null),
  getPortalUserByCustomerId: jest.fn(async () => null),
  getPortalUserById: jest.fn(async () => null),
  registerPortalUser: jest.fn(async (u) => ({ id: 'pusr_001', status: 'invited', ...u })),
  updatePortalUser: jest.fn(async (id, patch) => ({ id, ...patch })),
  createInviteCode: jest.fn(async () => ({ code: '123456', expires_at: null })),
  syncCustomerPortalData: jest.fn(async () => undefined),
}));

jest.mock('../../services/referralService.cjs', () => {
  const MockReferralService = jest.fn().mockImplementation(() => ({
    normalizePhone: (p) => p,
    normalizeEmail: (e) => e,
    normalizeOrg: (o) => o,
    checkFraudSignals: jest.fn(async () => []),
    generateReferralCode: jest.fn(async () => 'TESTCODE'),
    register: jest.fn(async () => ({ id: 'ref_1' })),
    getAll: jest.fn(async () => ({ referrals: [], total: 0, page: 1, limit: 10, totalPages: 0 })),
  }));
  return MockReferralService;
});

jest.mock('../../auditService.cjs', () => ({
  auditService: { logEvent: jest.fn(async () => ({ id: 'audit-1' })) },
}));

const request = require('supertest');
const express = require('express');
const repo = require('../../services/supabaseRepository.cjs');
const repoCanonical = require('../../services/supabaseCanonicalRepository.cjs');
const portalAuthService = require('../../services/portalAuthService.cjs');
const service = require('../../services/customerRegistrationService.cjs');
const portalAdminRouter = require('../../routes/portalAdmin.cjs');

// In-memory request store (registration requests live in `repo`, not canonical).
const requestTables = new Map();
function requestTable(name) {
  if (!requestTables.has(name)) requestTables.set(name, new Map());
  return requestTables.get(name);
}

const STAFF_HEADERS = {
  'x-user-id': 'admin-1',
  'x-user-role': 'Admin',
  'x-user-email': 'admin@prime.mw',
};

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/admin', portalAdminRouter);
  return app;
}

describe('resolvePortalEmailBusinessName', () => {
  it('prefers business fields over company and legacy name', () => {
    expect(
      service.resolvePortalEmailBusinessName({
        business_name: 'Acme Printers Ltd',
        company_name: 'Other Co',
        name: 'Ada Banda',
      })
    ).toBe('Acme Printers Ltd');
    expect(
      service.resolvePortalEmailBusinessName({ companyName: 'Zed Milling', name: 'Ada Banda' })
    ).toBe('Zed Milling');
    expect(service.resolvePortalEmailBusinessName({ name: 'Legacy Shop' })).toBe('Legacy Shop');
  });

  it('never reads contact fields', () => {
    expect(
      service.resolvePortalEmailBusinessName({ contact_name: 'Ada Banda', contactName: 'Ada Banda', full_name: 'Ada Banda' })
    ).toBe('');
    expect(
      service.resolvePortalEmailBusinessName({ business_name: 'Acme', contact_name: 'Ada Banda' })
    ).toBe('Acme');
  });

  it('passes plain strings through trimmed', () => {
    expect(service.resolvePortalEmailBusinessName('  Acme Printers  ')).toBe('Acme Printers');
    expect(service.resolvePortalEmailBusinessName(null)).toBe('');
  });
});

describe('portal login email derivation (business-first)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestTables.clear();
    repo.getById.mockImplementation(async (table, id) => requestTable(table).get(String(id)) || null);
    repo.getAll.mockImplementation(async (table) => [...requestTable(table).values()]);
    repo.upsert.mockImplementation(async (table, obj) => {
      requestTable(table).set(String(obj.id), { ...obj });
      return { ...obj };
    });
    repo.softDelete.mockImplementation(async (table, id) => {
      requestTable(table).delete(String(id));
      return { id };
    });
    portalAuthService.getPortalUserByEmail.mockResolvedValue(null);
    portalAuthService.getPortalUserByCustomerId.mockResolvedValue(null);
    portalAuthService.registerPortalUser.mockImplementation(async (u) => ({ id: 'pusr_001', status: 'invited', ...u }));
    portalAuthService.updatePortalUser.mockImplementation(async (id, patch) => ({ id, ...patch }));
    portalAuthService.createInviteCode.mockResolvedValue({ code: '123456', expires_at: null });
    portalAuthService.syncCustomerPortalData.mockResolvedValue(undefined);
    repoCanonical.upsert.mockImplementation(async (table, obj) => ({ ...obj }));
  });

  it('approval derives the email from company_name, not contact_name', async () => {
    repoCanonical.getAll.mockResolvedValue([]);
    const created = await service.createRegistrationRequest({
      companyName: 'Acme Printers Ltd',
      contactName: 'Ada Banda',
      email: 'ada.banda@example.com',
      phone: '0888123456',
    });
    await service.approveRequest(created.id, { reviewedBy: 'admin-1' });
    expect(portalAuthService.registerPortalUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'acme@prime.mw' })
    );
  });

  it('bulk regenerate uses stored business_name over the legacy name', async () => {
    repoCanonical.getAll.mockResolvedValue([
      { id: 'CUST-0001', name: 'Ada Banda', business_name: 'Acme Printers Ltd', phone: '0888123456' },
    ]);
    const app = buildAdminApp();
    const res = await request(app)
      .post('/api/portal/admin/customers/bulk-regenerate')
      .set(STAFF_HEADERS)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].email).toBe('acme@prime.mw');
  });

  it('per-customer regenerate prefers stored business over a contact name', async () => {
    const customer = { id: 'CUST-0007', name: 'Ada Banda', business_name: 'Zambeef Milling' };
    repoCanonical.getAll.mockResolvedValue([customer]);
    portalAuthService.getPortalUserByCustomerId.mockResolvedValue({
      id: 'pusr_007',
      customer_id: 'CUST-0007',
      email: 'old@prime.mw',
    });
    const app = buildAdminApp();
    const res = await request(app)
      .post('/api/portal/admin/customers/CUST-0007/regenerate-credentials')
      .set(STAFF_HEADERS)
      .send({ name: 'Ada Banda' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('zambeef@prime.mw');
  });

  it('never emits a single-character (initial-like) local part', async () => {
    repoCanonical.getAll.mockResolvedValue([
      { id: 'CUST-0009', name: 'A Banda Traders', business_name: 'A Banda Traders' },
    ]);
    const app = buildAdminApp();
    const res = await request(app)
      .post('/api/portal/admin/customers/bulk-regenerate')
      .set(STAFF_HEADERS)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    const local = String(res.body.results[0].email).split('@')[0];
    expect(local.length).toBeGreaterThan(1);
    expect(local).toBe('abanda');
  });
});
