/**
 * customerRegistrationService unit tests — hermetic (repo / workflowEngine /
 * portalLifecycleService / referralService / auditService are mocked; no
 * Supabase, no network, no writes).
 *
 * Business-rule focus:
 *   - CREATE: valid submission → exactly ONE pending request, ZERO
 *     customers, ZERO portal_users, ZERO tokens, NO password storage.
 *   - Invalid referral codes are rejected; valid codes are retained WITHOUT
 *     finalizing referral attribution.
 *   - Duplicate pending email/phone is rejected; official-customer matches
 *     are rejected via the existing fraud mechanism.
 *   - Lifecycle: pending → rejected | cancelled; terminal states immutable;
 *     race-guard re-reads before write.
 *   - No tenant/company partitioning fields are introduced.
 *   - Audit records carry safe metadata only.
 */

jest.mock('../services/supabaseRepository.cjs', () => ({
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

jest.mock('../services/referralService.cjs', () => {
  const state = { fraudSignals: [], registerCalls: [] };
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
    checkFraudSignals: jest.fn(async () => state.fraudSignals),
    generateReferralCode: jest.fn(async () => 'TESTCODE'),
    register: jest.fn(async (...args) => {
      state.registerCalls.push(args);
      return { id: 'ref_1' };
    }),
  }));
  MockReferralService.__state = state;
  return MockReferralService;
});

jest.mock('../auditService.cjs', () => ({
  auditService: { logEvent: jest.fn() },
}));

const repo = require('../services/supabaseRepository.cjs');
const workflowEngine = require('../services/workflowEngine.cjs');
const portalLifecycle = require('../services/portalLifecycleService.cjs');
const ReferralService = require('../services/referralService.cjs');
const { auditService } = require('../auditService.cjs');
const service = require('../services/customerRegistrationService.cjs');

// ─── In-memory envelope store (per-table Map) ───────────────────────────────
const tables = new Map();
function tableMap(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

function upsertsTo(table) {
  return repo.upsert.mock.calls.filter((c) => c[0] === table);
}

const VALID_INPUT = () => ({
  companyName: 'Acme Printers Ltd',
  contactName: 'Ada Banda',
  email: 'ada.banda@example.com',
  phone: '0888123456',
  tier: 'Standard',
});

describe('customerRegistrationService', () => {
  beforeEach(() => {
    tables.clear();
    jest.clearAllMocks();
    ReferralService.__state.fraudSignals = [];
    ReferralService.__state.registerCalls = [];
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
    repo.softDelete.mockImplementation(async (table, id) => {
      tableMap(table).delete(String(id));
      return { id };
    });
  });

  describe('CREATE — one pending request, nothing else', () => {
    it('creates exactly one pending request with a CREG-YYYY-###### number', async () => {
      const record = await service.createRegistrationRequest(VALID_INPUT());

      expect(record.status).toBe('pending');
      expect(record.request_number).toMatch(/^CREG-2026-\d{6}$/);
      expect(record.id).toMatch(/^creg_/);
      expect(upsertsTo('customer_registration_requests')).toHaveLength(1);
    });

    it('normalizes email and preserves server-side referral as null when absent', async () => {
      const record = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        email: '  ADA.Banda@Example.COM ',
      });
      expect(record.email).toBe('ada.banda@example.com');
      expect(record.referred_by_code).toBeNull();
      expect(record.referred_by_id).toBeNull();
    });

    it('creates ZERO customers rows', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      expect(upsertsTo('customers')).toHaveLength(0);
      expect([...tableMap('customers').values()]).toHaveLength(0);
    });

    it('creates ZERO portal_users rows', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      expect(upsertsTo('portal_users')).toHaveLength(0);
      expect([...tableMap('portal_users').values()]).toHaveLength(0);
    });

    it('public DTO exposes no credential, user, or customer material', async () => {
      const record = await service.createRegistrationRequest(VALID_INPUT());
      const dto = service.toPublicDto(record);
      expect(Object.keys(dto).sort()).toEqual(['requestNumber', 'status', 'submittedAt'].sort());
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toMatch(/token|password|portal_user|customer_id/i);
    });

    it('never stores password material even when the legacy form sends it', async () => {
      const record = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        password: 'supersecret123',
        password_hash: 'should-never-persist',
        refresh_token: 'should-never-persist',
        customer_id: 'CUST-9999',
      });
      expect(record.password).toBeUndefined();
      expect(record.password_hash).toBeUndefined();
      expect(record.passwordHash).toBeUndefined();
      expect(record.refresh_token).toBeUndefined();
      expect(record.customer_id).toBeUndefined();
      const stored = tableMap('customer_registration_requests').get(record.id);
      expect(JSON.stringify(stored)).not.toMatch(/supersecret123|should-never-persist/i);
    });

    it('introduces no tenant/company partitioning fields', async () => {
      const record = await service.createRegistrationRequest(VALID_INPUT());
      expect(record.tenant_id).toBeUndefined();
      expect(record.organization_id).toBeUndefined();
      expect(record.company_id).toBeUndefined();
    });

    it('pending requests do not appear in customer queries', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      const customers = await repo.getAll('customers');
      expect(customers).toHaveLength(0);
    });
  });

  describe('REFERRAL handling — retain, never finalize', () => {
    beforeEach(() => {
      tableMap('customer_referrals').set('ref-1', {
        id: 'ref-1',
        referral_code: 'PRIME42X',
        referred_by_id: 'CUST-0007',
        referred_by_name: 'Chimwemwe',
      });
      tableMap('customers').set('CUST-0007', { id: 'CUST-0007', name: 'Chimwemwe Print Shop' });
    });

    it('rejects an invalid referral code and creates nothing', async () => {
      await expect(
        service.createRegistrationRequest({ ...VALID_INPUT(), referredByCode: 'NOPE1234' })
      ).rejects.toThrow('Invalid referral code');
      expect(upsertsTo('customer_registration_requests')).toHaveLength(0);
    });

    it('retains a valid referral code in normalized form with resolved identity', async () => {
      const record = await service.createRegistrationRequest({
        ...VALID_INPUT(),
        referredByCode: ' prime42x ',
      });
      expect(record.referred_by_code).toBe('PRIME42X');
      expect(record.referred_by_id).toBe('CUST-0007');
      expect(record.referred_by_name).toBe('Chimwemwe Print Shop');
    });

    it('does NOT finalize referral attribution at submission', async () => {
      await service.createRegistrationRequest({ ...VALID_INPUT(), referredByCode: 'PRIME42X' });
      expect(ReferralService.__state.registerCalls).toHaveLength(0);
      expect(upsertsTo('customer_referrals')).toHaveLength(0);
    });
  });

  describe('DUPLICATE protection', () => {
    it('rejects a second pending request for the same email (normalized)', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      await expect(
        service.createRegistrationRequest({ ...VALID_INPUT(), email: ' ADA.BANDA@example.com ' })
      ).rejects.toThrow(/pending registration request already exists/i);
      expect(upsertsTo('customer_registration_requests')).toHaveLength(1);
    });

    it('rejects a second pending request for the same phone (normalized)', async () => {
      await service.createRegistrationRequest(VALID_INPUT());
      await expect(
        service.createRegistrationRequest({
          ...VALID_INPUT(),
          email: 'someone.else@example.com',
          phone: '+265 888 123 456',
        })
      ).rejects.toThrow(/pending registration request already exists/i);
    });

    it('rejects when the applicant already exists as an official customer', async () => {
      ReferralService.__state.fraudSignals = [
        { type: 'duplicate_email', severity: 'high', matchedCustomerId: 'CUST-0001' },
      ];
      await expect(service.createRegistrationRequest(VALID_INPUT())).rejects.toThrow(
        'An account with these details already exists'
      );
      expect(upsertsTo('customer_registration_requests')).toHaveLength(0);
    });
  });

  describe('LIFECYCLE — strict terminal transitions', () => {
    it('reject changes pending → rejected with reviewer stamp', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const rejected = await service.rejectRequest(created.id, {
        reviewedBy: 'admin-1',
        adminNotes: 'Duplicate of CUST-0003',
      });
      expect(rejected.status).toBe('rejected');
      expect(rejected.reviewed_by).toBe('admin-1');
      expect(rejected.reviewed_at).toBeTruthy();
      expect(rejected.admin_notes).toBe('Duplicate of CUST-0003');
    });

    it('reject requires admin_notes (duplicates are rejected, not DUPLICATE-state)', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await expect(service.rejectRequest(created.id, { reviewedBy: 'admin-1' })).rejects.toThrow(
        /admin_notes is required/i
      );
    });

    it('double reject cannot mutate terminal state', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      await service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'nope' });
      await expect(
        service.rejectRequest(created.id, { reviewedBy: 'admin-2', adminNotes: 'again' })
      ).rejects.toThrow(/Invalid registration request transition: rejected → rejected/);
      const stored = tableMap('customer_registration_requests').get(created.id);
      expect(stored.reviewed_by).toBe('admin-1');
    });

    it('cancel changes pending → cancelled', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      const cancelled = await service.cancelRequest(created.id, {});
      expect(cancelled.status).toBe('cancelled');
    });

    it('approved is terminal', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      tableMap('customer_registration_requests').set(created.id, { ...created, status: 'approved' });
      await expect(
        service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'x' })
      ).rejects.toThrow(/Invalid registration request transition: approved → rejected/);
      await expect(service.cancelRequest(created.id, {})).rejects.toThrow(
        /Invalid registration request transition: approved → cancelled/
      );
    });

    it('detects a concurrent terminal transition between read and write (race guard)', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      // Simulate a concurrent winner: flip the row after the service's first
      // read by racing an external write through the same store.
      const originalGetById = repo.getById.getMockImplementation();
      let calls = 0;
      repo.getById.mockImplementation(async (table, id) => {
        if (table === 'customer_registration_requests' && String(id) === created.id) {
          calls += 1;
          if (calls === 2) {
            tableMap(table).set(String(id), { ...tableMap(table).get(String(id)), status: 'rejected' });
          }
        }
        return originalGetById(table, id);
      });
      await expect(
        service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'race' })
      ).rejects.toThrow(/Invalid registration request transition/);
    });
  });

  describe('AUDIT — safe metadata only', () => {
    it('logs creation without password/token material', async () => {
      await service.createRegistrationRequest({ ...VALID_INPUT(), password: 'supersecret123' });
      expect(auditService.logEvent).toHaveBeenCalled();
      const payload = auditService.logEvent.mock.calls[0][0];
      expect(payload.action).toBe('REGISTRATION_REQUEST_CREATED');
      expect(payload.entityType).toBe('customer_registration_request');
      expect(JSON.stringify(payload)).not.toMatch(/supersecret123|token|secret|hash/i);
    });

    it('logs rejection', async () => {
      const created = await service.createRegistrationRequest(VALID_INPUT());
      auditService.logEvent.mockClear();
      await service.rejectRequest(created.id, { reviewedBy: 'admin-1', adminNotes: 'spam' });
      const actions = auditService.logEvent.mock.calls.map((c) => c[0].action);
      expect(actions).toContain('REGISTRATION_REQUEST_REJECTED');
    });
  });
});
