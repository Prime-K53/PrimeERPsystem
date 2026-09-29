/**
 * Phase 5A batch-runner unit tests — hermetic.
 *
 * Exercises portalUserMigrationProvision.cjs orchestration with injected
 * fakes only. No network, no database, no live Auth. Covers the §22 matrix:
 * batching, scope exclusion, adoption, conflicts, persistence/verification
 * failures, idempotency, invitation/hash protection, orphan protection,
 * ordering, retries, halt behavior, leakage, checkpoints, final invariants.
 */
const orch = require('../services/portalUserMigrationProvision.cjs');

function cand(id, extra = {}) {
  return {
    portalUserId: id, customerId: 'CUST-1', status: 'invited',
    emailPresent: true, emailValid: true, redactedEmail: 'u***@example.mw',
    authMappingState: 'UNMAPPED', classification: 'READY_CREATE',
    migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION', reason: 'NO_AUTH_MATCH',
    ...extra,
  };
}

function row(id, email = 'User@Example.Mw') {
  return { id, status: 'invited', auth_user_id: null, email };
}

// Deps builder: rows Map, authByEmail Map, behavior switches.
function depsWith({ rows = new Map(), authByEmail = new Map(), behavior = {} } = {}) {
  const calls = { provision: 0, discover: 0, verify: 0, reads: 0 };
  const provisioned = new Map(); // portalUserId -> authId
  return {
    calls, provisioned,
    async readPortalRow(id) {
      calls.reads += 1;
      if (behavior.readThrow) throw new Error('store down');
      const r = rows.get(String(id));
      return r ? { ...r } : null;
    },
    async discoverAuthByEmail(email) {
      calls.discover += 1;
      if (behavior.discoverThrow) throw new Error('network down');
      const key = String(email).toLowerCase();
      return (authByEmail.get(key) || []).slice();
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
      if (behavior.alreadyMapped) {
        return { ok: true, authUserId: behavior.alreadyMapped, idempotent: true };
      }
      const authId = `auth-for-${portalUserId}`;
      provisioned.set(String(portalUserId), authId);
      const r = rows.get(String(portalUserId));
      if (r) r.auth_user_id = authId;
      return { ok: true, authUserId: authId, idempotent: false };
    },
    async verifyProvisioned({ portalUserId, expectedEmail }) {
      calls.verify += 1;
      if (behavior.verifyFail) return { ok: false, reason: behavior.verifyFail };
      if (behavior.verifyThrow) throw new Error('verify transport down');
      const r = rows.get(String(portalUserId));
      const authId = provisioned.get(String(portalUserId)) || (behavior.alreadyMapped && String(portalUserId) === behavior.alreadyMappedFor ? behavior.alreadyMapped : null);
      if (!r || String(r.status) !== 'invited' || !r.auth_user_id) return { ok: false, reason: 'ROW_MISMATCH' };
      if (behavior.alreadyMapped && String(portalUserId) === behavior.alreadyMappedFor) {
        return { ok: true };
      }
      if (r.auth_user_id !== authId) return { ok: false, reason: 'ID_MISMATCH' };
      void expectedEmail;
      return { ok: true };
    },
    sleep: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  };
}

function tenInvited(prefix = 'pusr_t') {
  const rows = new Map();
  const cands = [];
  for (let i = 1; i <= 10; i += 1) {
    const id = `${prefix}${i}`;
    rows.set(id, row(id, `user${i}@example.mw`));
    cands.push(cand(id));
  }
  return { rows, cands };
}

describe('batching', () => {
  test('1: exactly 10 users processed in a batch', async () => {
    const { rows, cands } = tenInvited();
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10 });
    expect(run.results).toHaveLength(10);
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].batchSize).toBe(10);
    expect(run.halted).toBe(false);
  });

  test('2: 49 users produce 10/10/10/10/9 batches', async () => {
    const rows = new Map();
    const cands = [];
    for (let i = 1; i <= 49; i += 1) {
      const id = `pusr_${String(i).padStart(3, '0')}`;
      rows.set(id, row(id, `u${i}@example.mw`));
      cands.push(cand(id));
    }
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10 });
    expect(run.batches.map((b) => b.batchSize)).toEqual([10, 10, 10, 10, 9]);
    expect(run.results).toHaveLength(49);
  });
});

describe('scope exclusion', () => {
  test('3/4: selector admits only invited+unmapped+READY_CREATE+PASSWORDLESS_AUTH_PROVISION', async () => {
    const records = [
      cand('ok1'),
      cand('active1', { status: 'active', classification: 'READY_CREATE', migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION_REVIEW' }),
      cand('disabled1', { status: 'disabled' }),
      cand('mapped1', { authMappingState: 'MAPPED_VERIFIED', classification: 'ALREADY_MAPPED', migrationStrategy: 'NO_ACTION_REQUIRED' }),
      cand('conflict1', { classification: 'AUTH_MAPPING_CONFLICT', migrationStrategy: 'MANUAL_REVIEW' }),
      cand('ambig1', { classification: 'EMAIL_AMBIGUOUS', migrationStrategy: 'MANUAL_REVIEW' }),
      cand('badmail1', { emailPresent: true, emailValid: false, classification: 'EMAIL_INVALID', migrationStrategy: 'MANUAL_REVIEW' }),
      cand('dup1', { classification: 'DUPLICATE_PORTAL_EMAIL', migrationStrategy: 'MANUAL_REVIEW' }),
      cand('adopt1', { classification: 'READY_ADOPT' }),
    ];
    const sel = orch.selectEligibleInvitees(records);
    expect(sel.map((r) => r.portalUserId)).toEqual(['ok1']);
  });
});

describe('provisioning paths', () => {
  test('5: already-mapped users are never recreated (idempotent)', async () => {
    const rows = new Map([['pusr_m', row('pusr_m')]]);
    const deps = depsWith({ rows, behavior: { alreadyMapped: 'auth-existing', alreadyMappedFor: 'pusr_m' } });
    const run = await orch.runProvisioningBatches([cand('pusr_m')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('ALREADY_PROVISIONED');
  });

  test('6: zero Auth match → create → PROVISIONED', async () => {
    const rows = new Map([['pusr_c', row('pusr_c')]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_c')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(rows.get('pusr_c').auth_user_id).toBe('auth-for-pusr_c');
  });

  test('7: exact safe existing match → ADOPTED_EXISTING_AUTH', async () => {
    const rows = new Map([['pusr_a', row('pusr_a', 'adopt@example.mw')]]);
    const authByEmail = new Map([['adopt@example.mw', [{ id: 'auth-pre' }]]]);
    const deps = depsWith({ rows, authByEmail });
    // Adoption writes the pre-existing id (simulating provisioner adopt path).
    const origProvision = deps.provision.bind(deps);
    deps.provision = async ({ portalUserId }) => {
      deps.calls.provision += 1;
      rows.get(portalUserId).auth_user_id = 'auth-pre';
      deps.provisioned.set(portalUserId, 'auth-pre');
      return { ok: true, authUserId: 'auth-pre', idempotent: false };
    };
    void origProvision;
    const run = await orch.runProvisioningBatches([cand('pusr_a')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('ADOPTED_EXISTING_AUTH');
  });

  test('8: multiple matches → EMAIL_AMBIGUOUS, no mutation', async () => {
    const rows = new Map([['pusr_x', row('pusr_x', 'dup@example.mw')]]);
    const authByEmail = new Map([['dup@example.mw', [{ id: 'a1' }, { id: 'a2' }]]]);
    const deps = depsWith({ rows, authByEmail });
    const run = await orch.runProvisioningBatches([cand('pusr_x')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('EMAIL_AMBIGUOUS');
    expect(deps.calls.provision).toBe(0);
    expect(rows.get('pusr_x').auth_user_id).toBeNull();
  });

  test('9: mapping conflict → MAPPING_CONFLICT, no mutation', async () => {
    const rows = new Map([['pusr_y', row('pusr_y')]]);
    const deps = depsWith({ rows, behavior: { provisionCode: 'MAPPING_CONFLICT' } });
    const run = await orch.runProvisioningBatches([cand('pusr_y')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('MAPPING_CONFLICT');
    expect(rows.get('pusr_y').auth_user_id).toBeNull();
  });

  test('10: persistence failure → halt with MAPPING_PERSIST_FAILED', async () => {
    const rows = new Map([['pusr_z', row('pusr_z')]]);
    const deps = depsWith({ rows, behavior: { provisionCode: 'MAPPING_PERSIST_FAILED' } });
    const run = await orch.runProvisioningBatches([cand('pusr_z'), cand('pusr_z2')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('MAPPING_PERSIST_FAILED');
    expect(run.halted).toBe(true);
    expect(run.results).toHaveLength(1);
  });

  test('11: post-provision mismatch → halt', async () => {
    const rows = new Map([['pusr_v', row('pusr_v')]]);
    const deps = depsWith({ rows, behavior: { verifyFail: 'ID_MISMATCH' } });
    const run = await orch.runProvisioningBatches([cand('pusr_v')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('POST_PROVISION_RECONCILIATION_FAILED');
    expect(run.halted).toBe(true);
  });

  test('12: rerun of mapped user is a safe skip (no recreation)', async () => {
    const rows = new Map([['pusr_r', row('pusr_r')]]);
    const deps = depsWith({ rows });
    const first = await orch.runProvisioningBatches([cand('pusr_r')], deps, { batchSize: 10 });
    expect(first.results[0].status).toBe('PROVISIONED');
    // A rerun re-selects from fresh classification: the mapped row is no
    // longer eligible, so the runner skips it without touching Auth.
    const createsBefore = deps.calls.provision;
    const second = await orch.runProvisioningBatches([cand('pusr_r')], deps, { batchSize: 10 });
    expect(second.results[0].status).toBe('PORTAL_STATE_CHANGED');
    expect(deps.calls.provision).toBe(createsBefore);
    expect(rows.get('pusr_r').auth_user_id).toBe('auth-for-pusr_r');
  });
});

describe('protection guards', () => {
  test('13/14: invitation status untouched; codes untouched', async () => {
    const rows = new Map([['pusr_i', { ...row('pusr_i'), status: 'invited' }]]);
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches([cand('pusr_i')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(rows.get('pusr_i').status).toBe('invited');
    // Orchestration never touches invite/session stores (no such deps exist).
    expect(Object.keys(deps)).not.toEqual(expect.arrayContaining(['consumeInvite', 'revokeSessions']));
  });

  test('15: legacy password hash untouched', async () => {
    const rows = new Map([['pusr_h', { ...row('pusr_h'), password_hash: 'bcrypt-orig' }]]);
    const deps = depsWith({ rows });
    await orch.runProvisioningBatches([cand('pusr_h')], deps, { batchSize: 10 });
    expect(rows.get('pusr_h').password_hash).toBe('bcrypt-orig');
  });

  test('16: active users never selected, touched count zero', async () => {
    const records = [cand('a1', { status: 'active' }), cand('i1')];
    expect(orch.selectEligibleInvitees(records).map((r) => r.portalUserId)).toEqual(['i1']);
  });

  test('17: orphan Auth user untouched (no adopt without exact email link)', async () => {
    const rows = new Map([['pusr_o', row('pusr_o', 'mine@example.mw')]]);
    const authByEmail = new Map(); // orphan has unrelated email → zero match
    const deps = depsWith({ rows, authByEmail });
    const run = await orch.runProvisioningBatches([cand('pusr_o')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(deps.calls.discover).toBe(1);
  });

  test('18: deterministic ordering by portalUserId', async () => {
    const rows = new Map([
      ['pusr_z', row('pusr_z')], ['pusr_a', row('pusr_a')], ['pusr_m', row('pusr_m')],
    ]);
    const deps = depsWith({ rows });
    // Ordering is owned by selectEligibleInvitees; the runner preserves it.
    const ordered = orch.selectEligibleInvitees([cand('pusr_z'), cand('pusr_a'), cand('pusr_m')]);
    expect(ordered.map((r) => r.portalUserId)).toEqual(['pusr_a', 'pusr_m', 'pusr_z']);
    const run = await orch.runProvisioningBatches(ordered, deps, { batchSize: 10 });
    expect(run.results.map((r) => r.portalUserId)).toEqual(['pusr_a', 'pusr_m', 'pusr_z']);
  });
});

describe('retry and halt', () => {
  test('19: transient 500s retried then succeed', async () => {
    const rows = new Map([['pusr_t', row('pusr_t')]]);
    const sleeps = [];
    const deps = depsWith({ rows, behavior: { failTimes: 2, failStatus: 503 } });
    deps.sleep = async (ms) => { sleeps.push(ms); };
    const run = await orch.runProvisioningBatches([cand('pusr_t')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('PROVISIONED');
    expect(run.results[0].attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  test('19b: non-transient 422 not retried', async () => {
    const rows = new Map([['pusr_n', row('pusr_n')]]);
    const deps = depsWith({ rows, behavior: { failTimes: 5, failStatus: 422 } });
    const run = await orch.runProvisioningBatches([cand('pusr_n')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('AUTH_CREATE_FAILED');
    expect(run.results[0].attempts).toBe(1);
  });

  test('20: fatal discovery failure halts; no further mutations', async () => {
    const rows = new Map([['pusr_f1', row('pusr_f1')], ['pusr_f2', row('pusr_f2')]]);
    const deps = depsWith({ rows, behavior: { discoverThrow: true } });
    const run = await orch.runProvisioningBatches([cand('pusr_f1'), cand('pusr_f2')], deps, { batchSize: 10 });
    expect(run.results[0].status).toBe('AUTH_DISCOVERY_FAILED');
    expect(run.halted).toBe(true);
    expect(deps.calls.provision).toBe(0);
    expect(run.results).toHaveLength(1);
  });
});

describe('leakage and checkpoints', () => {
  test('21/22: no secret or full-email leakage in results', async () => {
    const { rows, cands } = tenInvited();
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10 });
    const dump = JSON.stringify(run);
    expect(dump).not.toMatch(/secret|password|token|Bearer|sb_secret/i);
    // No full local parts leak; redacted form keeps only first char + domain.
    expect(dump).not.toContain('user1@example.mw');
    expect(dump).not.toContain('User@Example.Mw');
    expect(run.results[0].redactedEmail).toMatch(/^\S\*+@\S+$/);
  });

  test('23: batch checkpoint reconciliation', async () => {
    const rows = new Map();
    const cands = [];
    for (let i = 1; i <= 25; i += 1) {
      const id = `pusr_${String(i).padStart(3, '0')}`;
      rows.set(id, row(id, `u${i}@example.mw`));
      cands.push(cand(id));
    }
    // Force one per-user failure in batch 2.
    const deps = depsWith({ rows });
    const origProvision = deps.provision.bind(deps);
    deps.provision = async (args) => {
      if (args.portalUserId === 'pusr_011') {
        const err = new Error('MAPPING_CONFLICT');
        err.code = 'MAPPING_CONFLICT';
        throw err;
      }
      return origProvision(args);
    };
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10 });
    expect(run.batches).toHaveLength(3);
    expect(run.batches[0].cumulativeMapped).toBe(10);
    expect(run.batches[1].counts).toEqual({ PROVISIONED: 9, MAPPING_CONFLICT: 1 });
    expect(run.batches[1].cumulativeMapped).toBe(19);
    expect(run.batches[2].cumulativeMapped).toBe(24);
    expect(run.batches[2].remaining).toBe(0);
  });

  test('24: final 49/17 mapping invariant shape', async () => {
    const rows = new Map();
    const cands = [];
    for (let i = 1; i <= 49; i += 1) {
      const id = `pusr_${String(i).padStart(3, '0')}`;
      rows.set(id, row(id, `u${i}@example.mw`));
      cands.push(cand(id));
    }
    const deps = depsWith({ rows });
    const run = await orch.runProvisioningBatches(cands, deps, { batchSize: 10 });
    const ok = run.results.filter((r) => ['PROVISIONED', 'ADOPTED_EXISTING_AUTH', 'ALREADY_PROVISIONED'].includes(r.status)).length;
    expect(ok).toBe(49);
    expect(run.halted).toBe(false);
    const mapped = [...rows.values()].filter((r) => r.auth_user_id).length;
    expect(mapped).toBe(49);
  });
});
