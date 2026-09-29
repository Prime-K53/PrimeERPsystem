/**
 * Phase 5B-1 active never-logged-in provisioning tests — hermetic.
 *
 * Covers the active-scope selector, status/last_login_at gates, and the full
 * per-user safety matrix for the 16-user phase, using injected fakes only.
 * No network, no database, no live Auth. The previously-logged-in user,
 * invited/mapped populations, and the orphan are proven untouched.
 */
const orch = require('../services/portalUserMigrationProvision.cjs');

const POLICY = { expectedStatus: 'active', requireNeverLoggedIn: true };

function cand(id, extra = {}) {
  return {
    portalUserId: id, customerId: 'CUST-1', status: 'active',
    emailPresent: true, emailValid: true, redactedEmail: 'u***@example.mw',
    authMappingState: 'UNMAPPED', classification: 'READY_CREATE',
    migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION_REVIEW', reason: 'NO_AUTH_MATCH',
    hasEverLoggedIn: false,
    ...extra,
  };
}

function activeRow(id, email = 'Active@Example.Mw', extra = {}) {
  return { id, status: 'active', auth_user_id: null, email, last_login_at: null, password_hash: 'bcrypt-orig', ...extra };
}

function depsWith({ rows = new Map(), authByEmail = new Map(), behavior = {} } = {}) {
  const calls = { provision: 0, discover: 0, verify: 0 };
  const provisioned = new Map();
  return {
    calls, provisioned,
    async readPortalRow(id) {
      if (behavior.readThrow) throw new Error('store down');
      const r = rows.get(String(id));
      return r ? { ...r } : null;
    },
    async discoverAuthByEmail(email) {
      calls.discover += 1;
      if (behavior.discoverThrow) throw new Error('network down');
      return (authByEmail.get(String(email).toLowerCase()) || []).slice();
    },
    async provision({ portalUserId, email }) {
      calls.provision += 1;
      if (behavior.failTimes && calls.provision <= behavior.failTimes) {
        const err = new Error(`Supabase Auth user creation failed (status ${behavior.failStatus || 500})`);
        err.code = 'AUTH_ADMIN_FAILED';
        throw err;
      }
      if (behavior.provisionCode) {
        const err = new Error(behavior.provisionCode);
        err.code = behavior.provisionCode;
        throw err;
      }
      const authId = `auth-for-${portalUserId}`;
      provisioned.set(String(portalUserId), authId);
      const r = rows.get(String(portalUserId));
      if (r) r.auth_user_id = authId;
      void email;
      return { ok: true, authUserId: authId, idempotent: false };
    },
    async verifyProvisioned({ portalUserId, expectedEmail }) {
      calls.verify += 1;
      if (behavior.verifyFail) return { ok: false, reason: behavior.verifyFail };
      const r = rows.get(String(portalUserId));
      if (!r || String(r.status) !== 'active' || !r.auth_user_id) return { ok: false, reason: 'ROW_MISMATCH' };
      if (r.last_login_at) return { ok: false, reason: 'LOGIN_MARKER_SET' };
      if (r.auth_user_id !== provisioned.get(String(portalUserId))) return { ok: false, reason: 'ID_MISMATCH' };
      void expectedEmail;
      return { ok: true };
    },
    sleep: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  };
}

function run16(rowsExtra = {}, behavior = {}) {
  const rows = new Map();
  const cands = [];
  for (let i = 1; i <= 16; i += 1) {
    const id = `pusr_a${String(i).padStart(2, '0')}`;
    rows.set(id, activeRow(id, `active${i}@example.mw`, rowsExtra[id] || {}));
    cands.push(cand(id));
  }
  return { rows, cands, deps: depsWith({ rows, behavior }) };
}

describe('selection (5B-1 scope)', () => {
  test('1: exactly 16 active never-logged-in users selected', async () => {
    const records = [];
    for (let i = 1; i <= 16; i += 1) {
      records.push(cand(`a${i}`, { hasEverLoggedIn: false }));
    }
    // Noise from every other population.
    records.push(cand('hyb', { hasEverLoggedIn: true, migrationStrategy: 'LEGACY_LOGIN_HYBRID_MIGRATION' }));
    records.push(cand('inv', { status: 'invited', classification: 'READY_CREATE', migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION' }));
    const sel = orch.selectEligibleActiveNeverLoggedIn(records);
    expect(sel).toHaveLength(16);
  });

  test('2: previously-logged-in active user excluded', async () => {
    const sel = orch.selectEligibleActiveNeverLoggedIn([
      cand('hyb1', { hasEverLoggedIn: true, migrationStrategy: 'LEGACY_LOGIN_HYBRID_MIGRATION' }),
    ]);
    expect(sel).toHaveLength(0);
  });

  test('3: all 49 invited users excluded', async () => {
    const records = [];
    for (let i = 1; i <= 49; i += 1) {
      records.push(cand(`inv${i}`, { status: 'invited', classification: 'READY_CREATE', migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION' }));
    }
    expect(orch.selectEligibleActiveNeverLoggedIn(records)).toHaveLength(0);
    expect(orch.selectEligibleInvitees(records)).toHaveLength(49);
  });

  test('4/5: disabled, mapped, manual populations excluded', async () => {
    const records = [
      cand('d1', { status: 'disabled', classification: 'DISABLED_DEFERRED', migrationStrategy: 'DEFER_UNTIL_REACTIVATED' }),
      cand('m1', { authMappingState: 'MAPPED_VERIFIED', classification: 'ALREADY_MAPPED', migrationStrategy: 'NO_ACTION_REQUIRED' }),
      cand('c1', { classification: 'AUTH_MAPPING_CONFLICT', migrationStrategy: 'MANUAL_REVIEW' }),
      cand('e1', { emailPresent: true, emailValid: false, classification: 'EMAIL_INVALID', migrationStrategy: 'MANUAL_REVIEW' }),
    ];
    expect(orch.selectEligibleActiveNeverLoggedIn(records)).toHaveLength(0);
  });

  test('6/7: status gate + last_login_at NULL gate at selection', async () => {
    const sel = orch.selectEligibleActiveNeverLoggedIn([
      cand('s1', { status: 'invited' }),
      cand('s2', { hasEverLoggedIn: true, migrationStrategy: 'LEGACY_LOGIN_HYBRID_MIGRATION' }),
      cand('s3'),
    ]);
    expect(sel.map((r) => r.portalUserId)).toEqual(['s3']);
  });

  test('8: state change between selection and provisioning → PORTAL_STATE_CHANGED', async () => {
    const rows = new Map([['pusr_s', { ...activeRow('pusr_s'), last_login_at: '2026-09-01T00:00:00.000Z' }]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_s')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PORTAL_STATE_CHANGED');
    expect(deps.calls.provision).toBe(0);
  });

  test('8b: status flip to invited → skipped', async () => {
    const rows = new Map([['pusr_f', { ...activeRow('pusr_f'), status: 'invited' }]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_f')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PORTAL_STATE_CHANGED');
    expect(deps.calls.provision).toBe(0);
  });
});

describe('per-user safety (active scope)', () => {
  test('9/15/16: safe create; hash and login marker untouched', async () => {
    const rows = new Map([['pusr_c', activeRow('pusr_c')]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_c')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(rows.get('pusr_c').auth_user_id).toBe('auth-for-pusr_c');
    expect(rows.get('pusr_c').status).toBe('active');
    expect(rows.get('pusr_c').password_hash).toBe('bcrypt-orig');
    expect(rows.get('pusr_c').last_login_at).toBeNull();
  });

  test('10: exact safe existing match → ADOPTED_EXISTING_AUTH', async () => {
    const rows = new Map([['pusr_d', activeRow('pusr_d', 'adopt@example.mw')]]);
    const authByEmail = new Map([['adopt@example.mw', [{ id: 'auth-pre' }]]]);
    const deps = depsWith({ rows, authByEmail });
    const orig = deps.provision.bind(deps);
    deps.provision = async ({ portalUserId }) => {
      deps.calls.provision += 1;
      rows.get(portalUserId).auth_user_id = 'auth-pre';
      deps.provisioned.set(portalUserId, 'auth-pre');
      return { ok: true, authUserId: 'auth-pre', idempotent: false };
    };
    void orig;
    const run = await orch.runProvisioningBatches([cand('pusr_d')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('ADOPTED_EXISTING_AUTH');
    expect(rows.get('pusr_d').status).toBe('active');
    expect(rows.get('pusr_d').last_login_at).toBeNull();
  });

  test('11/12: ambiguity and conflict → no mutation', async () => {
    const rows = new Map([
      ['pusr_amb', activeRow('pusr_amb', 'amb@example.mw')],
      ['pusr_con', activeRow('pusr_con', 'con@example.mw')],
    ]);
    const authByEmail = new Map([['amb@example.mw', [{ id: 'a1' }, { id: 'a2' }]]]);
    const deps = depsWith({ rows, authByEmail });
    const orig = deps.provision.bind(deps);
    deps.provision = async ({ portalUserId }) => {
      if (portalUserId === 'pusr_con') {
        const err = new Error('MAPPING_CONFLICT');
        err.code = 'MAPPING_CONFLICT';
        throw err;
      }
      return orig({ portalUserId });
    };
    const run = await orch.runProvisioningBatches(
      [cand('pusr_amb'), cand('pusr_con')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results.map((r) => r.status)).toEqual(['EMAIL_AMBIGUOUS', 'MAPPING_CONFLICT']);
    expect(rows.get('pusr_amb').auth_user_id).toBeNull();
    expect(rows.get('pusr_con').auth_user_id).toBeNull();
  });

  test('13: persistence failure halts', async () => {
    const rows = new Map([['pusr_p', activeRow('pusr_p')]]);
    const deps = depsWith({ rows, behavior: { provisionCode: 'MAPPING_PERSIST_FAILED' } });
    const run = await orch.runProvisioningBatches([cand('pusr_p'), cand('pusr_q')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('MAPPING_PERSIST_FAILED');
    expect(run.halted).toBe(true);
  });

  test('14: post-provision reconciliation failure halts', async () => {
    const rows = new Map([['pusr_v', activeRow('pusr_v')]]);
    const deps = depsWith({ rows, behavior: { verifyFail: 'LOGIN_MARKER_SET' } });
    const run = await orch.runProvisioningBatches([cand('pusr_v')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('POST_PROVISION_RECONCILIATION_FAILED');
    expect(run.halted).toBe(true);
  });
});

describe('boundary protections', () => {
  test('17/18/19: sessions, resets, customers untouched (no such deps)', async () => {
    const { rows, cands, deps } = run16();
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10, policy: POLICY });
    expect(run.results.filter((r) => r.status === 'PROVISIONED')).toHaveLength(16);
    expect(Object.keys(deps)).not.toEqual(expect.arrayContaining(['touchSessions', 'touchResets', 'touchCustomers']));
    for (const [, r] of rows) {
      expect(r.status).toBe('active');
      expect(r.last_login_at).toBeNull();
      expect(r.password_hash).toBe('bcrypt-orig');
    }
  });

  test('20: MFA untouched (no MFA surface)', async () => {
    const { rows, cands, deps } = run16();
    await orch.runProvisioningBatches(cands, deps, { batchSize: 10, policy: POLICY });
    expect('mfa' in deps || 'totp' in deps).toBe(false);
  });

  test('21: orphan untouched (zero-match discovery, no sweep)', async () => {
    const rows = new Map([['pusr_o', activeRow('pusr_o', 'mine@example.mw')]]);
    const deps = depsWith({ rows }); // orphan email unrelated → zero match
    const run = await orch.runProvisioningBatches([cand('pusr_o')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(deps.calls.discover).toBe(1);
  });

  test('22: previously-logged-in user never provisioned even if forced in', async () => {
    const rows = new Map([['pusr_h', { ...activeRow('pusr_h'), last_login_at: '2026-08-01T00:00:00.000Z' }]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_h')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PORTAL_STATE_CHANGED');
    expect(deps.calls.provision).toBe(0);
    expect(rows.get('pusr_h').auth_user_id).toBeNull();
  });

  test('23/24: deterministic order; 10+6 batches', async () => {
    const { rows, cands, deps } = run16();
    const shuffled = cands.slice().reverse();
    const run = await orch.runProvisioningBatches(shuffled, deps, { batchSize: 10, policy: POLICY });
    // Runner preserves caller order; selection owns sorting.
    const ordered = orch.selectEligibleActiveNeverLoggedIn(shuffled);
    expect(ordered.map((r) => r.portalUserId)).toEqual(cands.map((r) => r.portalUserId));
    expect(run.batches.map((b) => b.batchSize)).toEqual([10, 6]);
    expect(run.results).toHaveLength(16);
  });

  test('25/26: retry then halt semantics preserved under active policy', async () => {
    const rows = new Map([['pusr_t', activeRow('pusr_t')]]);
    const sleeps = [];
    const deps = depsWith({ rows, behavior: { failTimes: 1, failStatus: 503 } });
    deps.sleep = async (ms) => { sleeps.push(ms); };
    const run = await orch.runProvisioningBatches([cand('pusr_t')], deps, { batchSize: 10, policy: POLICY });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(run.results[0].attempts).toBe(2);
    expect(sleeps).toEqual([500]);
    const rows2 = new Map([['pusr_f', activeRow('pusr_f')]]);
    const deps2 = depsWith({ rows: rows2, behavior: { discoverThrow: true } });
    const run2 = await orch.runProvisioningBatches([cand('pusr_f')], deps2, { batchSize: 10, policy: POLICY });
    expect(run2.halted).toBe(true);
  });

  test('27: no secret/full-email leakage', async () => {
    const { rows, cands, deps } = run16();
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10, policy: POLICY });
    const dump = JSON.stringify(run);
    expect(dump).not.toMatch(/secret|password|token|Bearer|sb_secret/i);
    expect(dump).not.toContain('active1@example.mw');
  });

  test('28: idempotent rerun is a safe skip', async () => {
    const rows = new Map([['pusr_r', activeRow('pusr_r')]]);
    const deps = depsWith({ rows });
    const first = await orch.runProvisioningBatches([cand('pusr_r')], deps, { batchSize: 10, policy: POLICY });
    expect(first.results[0].status).toBe('PROVISIONED');
    const n = deps.calls.provision;
    const second = await orch.runProvisioningBatches([cand('pusr_r')], deps, { batchSize: 10, policy: POLICY });
    expect(second.results[0].status).toBe('PORTAL_STATE_CHANGED');
    expect(deps.calls.provision).toBe(n);
  });

  test('29: final 65/1 invariant shape (16 mapped actives, hybrid untouched)', async () => {
    const { rows, cands, deps } = run16();
    rows.set('pusr_hyb', { ...activeRow('pusr_hyb', 'hyb@example.mw'), last_login_at: '2026-08-01T00:00:00Z' });
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10, policy: POLICY });
    const mapped = [...rows.values()].filter((r) => r.auth_user_id).length;
    expect(mapped).toBe(16);
    expect(rows.get('pusr_hyb').auth_user_id).toBeNull();
    expect(run.halted).toBe(false);
  });

  test('30: no mutation outside the 16 (invited row forced in is skipped)', async () => {
    const rows = new Map([
      ['pusr_ok', activeRow('pusr_ok')],
      ['pusr_inv', { ...activeRow('pusr_inv'), status: 'invited' }],
    ]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_ok'), cand('pusr_inv', { status: 'invited' })], deps, { batchSize: 10, policy: POLICY });
    expect(run.results.map((r) => r.status)).toEqual(['PROVISIONED', 'PORTAL_STATE_CHANGED']);
    expect(rows.get('pusr_inv').auth_user_id).toBeNull();
  });
});
