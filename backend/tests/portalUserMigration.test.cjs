/**
 * Phase 5 read-only migration classifier tests — hermetic.
 *
 * Every test runs against in-memory fakes. No live Supabase, no network, no
 * writes. The injected Auth adapter doubles as a mutation tripwire: any
 * classifier call to a mutation method throws, so the read-only guarantee
 * is proven, not assumed.
 */
const migration = require('../services/portalUserMigration.cjs');

const AUTH_A = '22222222-3333-4444-8555-666666666666';
const AUTH_B = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const AUTH_C = '99999999-0000-4111-8222-cccccccccccc';

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeDiscovery({ usersById = {}, usersByEmail = {} } = {}) {
  const calls = [];
  const discovery = {
    calls,
    async getUserById(id) {
      calls.push({ op: 'getUserById', id });
      return usersById[String(id)] || null;
    },
    async findUsersByEmail(email) {
      calls.push({ op: 'findUsersByEmail', email });
      return (usersByEmail[String(email)] || []).slice();
    },
    // Mutation tripwires: must never be invoked by the classifier.
    async createUser() { throw new Error('MUTATION_CALLED:createUser'); },
    async updateUser() { throw new Error('MUTATION_CALLED:updateUser'); },
    async deleteUser() { throw new Error('MUTATION_CALLED:deleteUser'); },
  };
  return discovery;
}

function fakeRepo(rows) {
  return {
    async getAll() { return rows.map((r) => ({ ...r })); },
  };
}

function row(overrides = {}) {
  return {
    id: 'pusr_x', customer_id: 'CUST-0001', email: 'Derived@Prime.Mw',
    status: 'active', password_hash: 'bcrypt-hash-stub',
    auth_user_id: null, last_login_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function ctxWith(discovery, extraRows = []) {
  return { duplicateEmails: new Set(), authIdToPortalUserId: new Map(), authDiscovery: discovery, extraRows };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Classification ─────────────────────────────────────────────────────────

describe('classification', () => {
  test('1: active + no Auth → READY_CREATE', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(
      row({ id: 'pusr_1', last_login_at: '2026-03-01T00:00:00.000Z' }), ctxWith(d));
    expect(res.classification).toBe('READY_CREATE');
    expect(res.migrationStrategy).toBe('LEGACY_LOGIN_HYBRID_MIGRATION');
    expect(d.calls.map((c) => c.op)).toEqual(['findUsersByEmail']);
  });

  test('2: invited + no Auth → READY_CREATE (passwordless strategy)', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(row({ id: 'pusr_2', status: 'invited' }), ctxWith(d));
    expect(res.classification).toBe('READY_CREATE');
    expect(res.migrationStrategy).toBe('PASSWORDLESS_AUTH_PROVISION');
  });

  test('2b: active never-logged-in → review strategy', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(
      row({ id: 'pusr_2b', status: 'active', last_login_at: null }), ctxWith(d));
    expect(res.classification).toBe('READY_CREATE');
    expect(res.migrationStrategy).toBe('PASSWORDLESS_AUTH_PROVISION_REVIEW');
  });

  test('3: disabled → DISABLED_DEFERRED with zero Auth calls', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(
      row({ id: 'pusr_3', status: 'disabled', auth_user_id: AUTH_A }), ctxWith(d));
    expect(res.classification).toBe('DISABLED_DEFERRED');
    expect(res.migrationStrategy).toBe('DEFER_UNTIL_REACTIVATED');
    expect(d.calls).toHaveLength(0);
  });

  test('4: existing mapping + Auth exists → ALREADY_MAPPED', async () => {
    const d = fakeDiscovery({ usersById: { [AUTH_A]: { id: AUTH_A, email: 'derived@prime.mw' } } });
    const res = await migration.classifyPortalUser(
      row({ id: 'pusr_4', auth_user_id: AUTH_A }), ctxWith(d));
    expect(res.classification).toBe('ALREADY_MAPPED');
    expect(res.authMappingState).toBe('MAPPED_VERIFIED');
    expect(res.migrationStrategy).toBe('NO_ACTION_REQUIRED');
  });

  test('5: existing mapping + Auth missing → AUTH_NOT_FOUND_FOR_MAPPING', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(
      row({ id: 'pusr_5', auth_user_id: AUTH_A }), ctxWith(d));
    expect(res.classification).toBe('AUTH_NOT_FOUND_FOR_MAPPING');
    expect(res.authMappingState).toBe('MAPPED_MISSING_AUTH_USER');
    expect(res.migrationStrategy).toBe('MANUAL_REVIEW');
  });

  test('6: exact email Auth match → READY_ADOPT', async () => {
    const d = fakeDiscovery({ usersByEmail: { 'derived@prime.mw': [{ id: AUTH_B, email: 'derived@prime.mw' }] } });
    const res = await migration.classifyPortalUser(row({ id: 'pusr_6' }), ctxWith(d));
    expect(res.classification).toBe('READY_ADOPT');
    expect(res.authCollisionState).toBe('SINGLE_MATCH_UNMAPPED');
  });

  test('7: Auth match mapped elsewhere → AUTH_MAPPING_CONFLICT', async () => {
    const d = fakeDiscovery({ usersByEmail: { 'derived@prime.mw': [{ id: AUTH_B, email: 'derived@prime.mw' }] } });
    const ctx = ctxWith(d);
    ctx.authIdToPortalUserId.set(AUTH_B, 'pusr_other');
    const res = await migration.classifyPortalUser(row({ id: 'pusr_7' }), ctx);
    expect(res.classification).toBe('AUTH_MAPPING_CONFLICT');
    expect(res.migrationStrategy).toBe('MANUAL_REVIEW');
  });

  test('8: multiple Auth matches → EMAIL_AMBIGUOUS', async () => {
    const d = fakeDiscovery({
      usersByEmail: { 'derived@prime.mw': [{ id: AUTH_B, email: 'x' }, { id: AUTH_C, email: 'x' }] },
    });
    const res = await migration.classifyPortalUser(row({ id: 'pusr_8' }), ctxWith(d));
    expect(res.classification).toBe('EMAIL_AMBIGUOUS');
  });

  test('9: duplicate Portal emails → DUPLICATE_PORTAL_EMAIL (no auto-choice)', async () => {
    const d = fakeDiscovery();
    const ctx = ctxWith(d);
    ctx.duplicateEmails.add('derived@prime.mw');
    const a = await migration.classifyPortalUser(row({ id: 'pusr_9a' }), ctx);
    const b = await migration.classifyPortalUser(row({ id: 'pusr_9b', email: 'DERIVED@prime.mw' }), ctx);
    expect(a.classification).toBe('DUPLICATE_PORTAL_EMAIL');
    expect(b.classification).toBe('DUPLICATE_PORTAL_EMAIL');
    expect(d.calls).toHaveLength(0);
  });

  test('10: missing email → EMAIL_MISSING', async () => {
    const d = fakeDiscovery();
    for (const bad of [null, '', '   ']) {
      const res = await migration.classifyPortalUser(row({ id: 'pusr_10', email: bad }), ctxWith(d));
      expect(res.classification).toBe('EMAIL_MISSING');
    }
    expect(d.calls).toHaveLength(0);
  });

  test('11: malformed email → EMAIL_INVALID', async () => {
    const d = fakeDiscovery();
    const res = await migration.classifyPortalUser(row({ id: 'pusr_11', email: 'not-an-email' }), ctxWith(d));
    expect(res.classification).toBe('EMAIL_INVALID');
    expect(d.calls).toHaveLength(0);
  });
});

// ─── Credential-state classification ────────────────────────────────────────

describe('credential state', () => {
  test('12/13: password hash presence exposed as boolean only', async () => {
    const d = fakeDiscovery();
    const withHash = await migration.classifyPortalUser(row({ id: 'p1' }), ctxWith(d));
    const withoutHash = await migration.classifyPortalUser(row({ id: 'p2', password_hash: null }), ctxWith(d));
    expect(withHash.hasLegacyPasswordHash).toBe(true);
    expect(withoutHash.hasLegacyPasswordHash).toBe(false);
  });

  test('14/15: hasEverLoggedIn derived from last_login_at', async () => {
    const d = fakeDiscovery();
    const logged = await migration.classifyPortalUser(
      row({ id: 'p3', last_login_at: '2026-05-01T00:00:00.000Z' }), ctxWith(d));
    const never = await migration.classifyPortalUser(row({ id: 'p4' }), ctxWith(d));
    expect(logged.hasEverLoggedIn).toBe(true);
    expect(never.hasEverLoggedIn).toBe(false);
  });
});

// ─── Security ───────────────────────────────────────────────────────────────

describe('security', () => {
  test('16–19: no hash/secret/token/key material in any result', async () => {
    const d = fakeDiscovery({ usersById: { [AUTH_A]: { id: AUTH_A, email: 'e@x.mw' } } });
    const rows = [
      row({ id: 's1', password_hash: 'bcrypt-super-secret', last_login_at: '2026-01-01T00:00:00Z' }),
      row({ id: 's2', status: 'invited', password_hash: 'bcrypt-other' }),
      row({ id: 's3', auth_user_id: AUTH_A }),
    ];
    const report = await migration.dryRunPortalUserMigration({ repo: fakeRepo(rows), authDiscovery: d });
    const dump = JSON.stringify(report);
    expect(dump).not.toContain('bcrypt-super-secret');
    expect(dump).not.toContain('bcrypt-other');
    expect(dump).not.toContain('password_hash');
    expect(dump).not.toContain('two_factor_secret');
    expect(dump).not.toContain('access_token');
    expect(dump).not.toContain('refresh_token');
    expect(dump).not.toContain('sb_secret');
    // Full addresses never appear; only the redacted form does.
    expect(dump).not.toContain('Derived@Prime.Mw');
    expect(dump).not.toContain('derived@prime.mw');
    expect(report.records[0].redactedEmail).toMatch(/^\S\*+@\S+$/);
    expect(report.records[0].mfaState).toBe('UNKNOWN_LIVE_SCHEMA');
  });
});

// ─── Cardinality ────────────────────────────────────────────────────────────

describe('cardinality', () => {
  test('20: users sharing one customer are independently classified', async () => {
    const d = fakeDiscovery();
    const rows = [
      row({ id: 'n1', customer_id: 'CUST-SAME', status: 'active' }),
      row({ id: 'n2', customer_id: 'CUST-SAME', status: 'invited', email: 'other@example.com' }),
      row({ id: 'n3', customer_id: 'CUST-SAME', status: 'disabled', email: 'third@example.com' }),
    ];
    const report = await migration.dryRunPortalUserMigration({ repo: fakeRepo(rows), authDiscovery: d });
    const byId = Object.fromEntries(report.records.map((r) => [r.portalUserId, r.classification]));
    expect(byId).toEqual({ n1: 'READY_CREATE', n2: 'READY_CREATE', n3: 'DISABLED_DEFERRED' });
  });
});

// ─── Read-only guarantee ────────────────────────────────────────────────────

describe('read-only guarantee', () => {
  test('21: mutation tripwires never fire across a mixed dry-run', async () => {
    const d = fakeDiscovery({
      usersById: { [AUTH_A]: { id: AUTH_A, email: 'mapped@example.com' } },
      usersByEmail: { 'adopt@example.com': [{ id: AUTH_B, email: 'adopt@example.com' }] },
    });
    const rows = [
      row({ id: 'r1', email: 'create@example.com' }),
      row({ id: 'r2', email: 'adopt@example.com' }),
      row({ id: 'r3', email: 'mapped@example.com', auth_user_id: AUTH_A }),
      row({ id: 'r4', email: 'mapped@example.com', auth_user_id: AUTH_B }),
      row({ id: 'r5', status: 'disabled', email: 'off@example.com' }),
    ];
    const report = await migration.dryRunPortalUserMigration({ repo: fakeRepo(rows), authDiscovery: d });
    expect(report.total).toBe(5);
    // Tripwires would have thrown on any mutation call — reaching here proves
    // the classifier used only getUserById/findUsersByEmail.
    expect(d.calls.every((c) => c.op === 'getUserById' || c.op === 'findUsersByEmail')).toBe(true);
    // Phase 4-style transport adapts to the same read-only surface.
    const adapted = migration.fromAdminApiReadOnly({
      getUser: async (id) => ({ id }),
      listUsersByEmail: async () => [],
      createUser: async () => { throw new Error('MUTATION_CALLED'); },
    });
    const onlyReads = await migration.classifyPortalUser(row({ id: 'r6', email: 'zz@example.com' }), {
      duplicateEmails: new Set(), authIdToPortalUserId: new Map(), authDiscovery: adapted,
    });
    expect(onlyReads.classification).toBe('READY_CREATE');
  });

  test('21b: missing read surface fails closed', async () => {
    await expect(migration.dryRunPortalUserMigration({
      repo: fakeRepo([row({ id: 'x1' })]),
      authDiscovery: { createUser: async () => ({}) },
    })).rejects.toMatchObject({ code: 'AUTH_DISCOVERY_UNAVAILABLE' });
  });
});

// ─── Determinism + aggregates ───────────────────────────────────────────────

describe('determinism and aggregates', () => {
  const fixture = () => ([
    row({ id: 'z-active', status: 'active', email: 'a1@example.com', last_login_at: '2026-02-01T00:00:00Z' }),
    row({ id: 'a-invited', status: 'invited', email: 'b2@example.com' }),
    row({ id: 'm-disabled', status: 'disabled', email: 'c3@example.com' }),
    row({ id: 'm-mapped', status: 'active', email: 'd4@example.com', auth_user_id: AUTH_A }),
    row({ id: 'm-unmapped-auth', status: 'active', email: 'e5@example.com', auth_user_id: AUTH_C }),
    row({ id: 'm-adopt', status: 'active', email: 'f6@example.com' }),
    row({ id: 'm-bad', status: 'active', email: 'not-an-email' }),
    row({ id: 'm-missing', status: 'active', email: '' }),
  ]);

  function discoveryFor() {
    return fakeDiscovery({
      usersById: { [AUTH_A]: { id: AUTH_A, email: 'd4@example.com' } },
      usersByEmail: { 'f6@example.com': [{ id: AUTH_B, email: 'f6@example.com' }] },
    });
  }

  test('22: identical input in any order → identical output', async () => {
    const fwd = await migration.dryRunPortalUserMigration({ repo: fakeRepo(fixture()), authDiscovery: discoveryFor() });
    const rev = await migration.dryRunPortalUserMigration({ repo: fakeRepo(fixture().reverse()), authDiscovery: discoveryFor() });
    expect(JSON.stringify(rev)).toBe(JSON.stringify(fwd));
    expect(fwd.records.map((r) => r.portalUserId)).toEqual([
      'a-invited', 'm-adopt', 'm-bad', 'm-disabled', 'm-mapped', 'm-missing', 'm-unmapped-auth', 'z-active',
    ]);
  });

  test('23: totals reconcile exactly', async () => {
    const report = await migration.dryRunPortalUserMigration({ repo: fakeRepo(fixture()), authDiscovery: discoveryFor() });
    expect(report.total).toBe(8);
    expect(report.byStatus).toEqual({ active: 6, invited: 1, disabled: 1 });
    expect(report.byClassification).toEqual({
      READY_CREATE: 2, // z-active + a-invited
      READY_ADOPT: 1, // m-adopt
      ALREADY_MAPPED: 1, // m-mapped
      AUTH_NOT_FOUND_FOR_MAPPING: 1, // m-unmapped-auth
      EMAIL_INVALID: 1, // m-bad
      EMAIL_MISSING: 1, // m-missing
      DISABLED_DEFERRED: 1, // m-disabled
    });
    expect(report.byMigrationStrategy).toEqual({
      LEGACY_LOGIN_HYBRID_MIGRATION: 1, // z-active
      PASSWORDLESS_AUTH_PROVISION: 1, // a-invited
      DEFER_UNTIL_REACTIVATED: 1, // m-disabled
      NO_ACTION_REQUIRED: 1, // m-mapped
      MANUAL_REVIEW: 3, // m-unmapped-auth + m-bad + m-missing
      PASSWORDLESS_AUTH_PROVISION_REVIEW: 1, // m-adopt
    });
    expect(report.manualReviewCount).toBe(3);
    expect(report.manualReview).toEqual(['m-bad', 'm-missing', 'm-unmapped-auth']);
  });
});
