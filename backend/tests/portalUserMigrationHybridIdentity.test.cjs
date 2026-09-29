/**
 * Phase 5B-2A hybrid-identity tests — hermetic.
 *
 * Focused coverage for provisioning the single active previously-logged-in
 * Portal user (LEGACY_LOGIN_HYBRID_MIGRATION) into a PASSWORDLESS Supabase
 * Auth identity using the existing Phase 4 provisioner semantics.
 *
 * Proves: provisioned without password, mapping persisted, status/login
 * marker/hash untouched, idempotent rerun, no stealing, orphan untouched,
 * no creation payload password, no login/session/MFA side effects.
 *
 * Fully mocked/injected. No network, no database, no live Auth.
 */
const provisioning = require('../services/supabasePortalAuthAdmin.cjs');

const HYBRID_ID = 'pusr_hybrid_1';
const AUTH_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_AUTH = '11111111-2222-4333-8444-555555555555';

function hybridRow(overrides = {}) {
  return {
    id: HYBRID_ID, customer_id: 'CUST-0001', email: 'Hybrid@Prime.Mw',
    password_hash: 'bcrypt-hybrid-original', full_name: 'Hybrid User',
    phone: null, status: 'active', auth_user_id: null,
    last_login_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function memRepo(seed) {
  const store = new Map([[HYBRID_ID, hybridRow()], ...(seed || [])]);
  return {
    store,
    getById: async (id) => store.get(String(id)) || null,
    getByAuthUserId: async (sub) => [...store.values()].find((u) => u.auth_user_id === sub) || null,
    update: async (id, updates) => {
      const cur = store.get(String(id));
      if (!cur) throw new Error('Portal user not found');
      Object.assign(cur, updates);
      return { ...cur };
    },
  };
}

function fakeAdminApi(behavior = {}) {
  const calls = [];
  return {
    calls,
    async createUser(email) {
      calls.push({ op: 'createUser', email });
      if (behavior.createThrow) throw behavior.createThrow;
      if (behavior.taken) return { taken: true };
      return { id: behavior.createdId || AUTH_UUID };
    },
    async getUser(id) {
      calls.push({ op: 'getUser', id });
      if (behavior.getMissing) return null;
      return { id, email: behavior.userEmail || 'hybrid@prime.mw' };
    },
    async listUsersByEmail(email) {
      calls.push({ op: 'listUsersByEmail', email });
      return behavior.listResult !== undefined ? behavior.listResult : [];
    },
  };
}

describe('5B-2A hybrid identity provisioning', () => {
  test('1/2/3: previously-logged-in active user provisioned passwordless + mapped', async () => {
    const repo = memRepo();
    const api = fakeAdminApi();
    const res = await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo });
    expect(res).toEqual({ ok: true, authUserId: AUTH_UUID, idempotent: false });
    expect(repo.store.get(HYBRID_ID).auth_user_id).toBe(AUTH_UUID);
  });

  test('4/5/6: status, login marker, and hash untouched', async () => {
    const repo = memRepo();
    await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: fakeAdminApi(), repo });
    const after = repo.store.get(HYBRID_ID);
    expect(after.status).toBe('active');
    expect(after.last_login_at).toBe('2026-08-01T00:00:00.000Z');
    expect(after.password_hash).toBe('bcrypt-hybrid-original');
  });

  test('7/8: idempotent rerun creates no second identity', async () => {
    const repo = memRepo();
    const api = fakeAdminApi();
    await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo });
    const res = await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo });
    expect(res).toEqual({ ok: true, authUserId: AUTH_UUID, idempotent: true });
    expect(api.calls.filter((c) => c.op === 'createUser')).toHaveLength(1);
  });

  test('9: Auth identity mapped elsewhere cannot be stolen', async () => {
    const repo = memRepo([
      ['pusr_other', { id: 'pusr_other', customer_id: 'CUST-2', email: 'other@prime.mw', status: 'active', auth_user_id: OTHER_AUTH, last_login_at: null }],
    ]);
    const api = fakeAdminApi({ taken: true, listResult: [{ id: OTHER_AUTH, email: 'hybrid@prime.mw' }] });
    await expect(provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo }))
      .rejects.toMatchObject({ code: 'MAPPING_CONFLICT' });
    expect(repo.store.get(HYBRID_ID).auth_user_id).toBeNull();
  });

  test('10: orphan Auth user untouched (zero-match path never listsweeps)', async () => {
    const repo = memRepo();
    const api = fakeAdminApi();
    await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo });
    // Discovery by exact email only; the orphan (unrelated email) is never
    // fetched, modified, or adopted.
    expect(api.calls.filter((c) => c.op === 'getUser')).toHaveLength(0);
    expect(api.calls.filter((c) => c.op === 'listUsersByEmail')).toHaveLength(0);
  });

  test('11: no password sent to Auth creation', async () => {
    const repo = memRepo();
    const api = fakeAdminApi();
    await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: api, repo });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toEqual({ op: 'createUser', email: 'hybrid@prime.mw' });
    expect(JSON.stringify(api.calls)).not.toMatch(/password/i);
  });

  test('12: no login/session/MFA side effects (store surface untouched)', async () => {
    const repo = memRepo();
    const before = JSON.stringify({ ...repo.store.get(HYBRID_ID), auth_user_id: undefined });
    await provisioning.provisionPortalUser({ portalUserId: HYBRID_ID, adminApi: fakeAdminApi(), repo });
    const after = repo.store.get(HYBRID_ID);
    expect(after.status).toBe('active');
    expect(after.last_login_at).toBe('2026-08-01T00:00:00.000Z');
    expect(after.password_hash).toBe('bcrypt-hybrid-original');
    const afterSansMapping = JSON.stringify({ ...after, auth_user_id: undefined });
    expect(afterSansMapping).toBe(before);
    expect(Object.keys(after)).not.toEqual(expect.arrayContaining(['two_factor_secret', 'session']));
  });
});
