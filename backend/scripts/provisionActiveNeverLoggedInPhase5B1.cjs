/**
 * Phase 5B-1 live batch runner — ACTIVE NEVER-LOGGED-IN users only (16 expected).
 *
 * READ-ONLY except for the explicitly scoped mutations:
 *   - POST /auth/v1/admin/users (passwordless create, active never-logged-in scope only)
 *   - PATCH portal_users.auth_user_id (via Phase 4 provisioner only)
 *
 * Aborts BEFORE any mutation unless pre-flight yields exactly the verified
 * 16-user set. Sequential, batches of 10+6, deterministic order, resumable
 * via auth_user_id cursor. The previously-logged-in active user, all invited
 * users, and the orphan Auth user are never touched.
 *
 * Usage: node scripts/provisionActiveNeverLoggedInPhase5B1.cjs
 * Exit 0: all 16 reconciled (or per-user partial, zero invariant violations).
 * Exit 1: halted, invariant violation, or pre-flight mismatch.
 */
require('dotenv').config();

const axios = require('axios');
const repo = require('../services/supabaseRepository.cjs');
const migration = require('../services/portalUserMigration.cjs');
const provisioner = require('../services/supabasePortalAuthAdmin.cjs');
const orch = require('../services/portalUserMigrationProvision.cjs');

const POLICY = { expectedStatus: 'active', requireNeverLoggedIn: true };
const PU = () => repo.portalEntities.portal_users;

// Bounded retry for transient read-only GETs (429/5xx/timeout/network).
// Mutations never flow through here — this hardens discovery/census only.
async function getWithRetry(url, config, attempts = 3) {
  let lastErr = null;
  for (let n = 1; n <= attempts; n += 1) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      lastErr = e;
      const status = e && e.response && e.response.status;
      const transient = status === 429 || (status >= 500 && status <= 504)
        || /timeout|timed\s?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|ECONNABORTED/i.test(String((e && e.code) || '') + ' ' + String(e && e.message || ''));
      if (!transient || n === attempts) throw e;
      await new Promise((r) => setTimeout(r, 500 * (2 ** (n - 1))));
    }
  }
  throw lastErr;
}

async function snapshotTable(table, select) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || '';
  const { data } = await getWithRetry(`${base}/rest/v1/${table}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    params: { select },
    timeout: 15000,
  });
  return data || [];
}

async function main() {
  const log = (msg) => console.log(`[Phase5B1] ${msg}`);
  const fail = (msg) => { console.error(`[Phase5B1][FATAL] ${msg}`); process.exitCode = 1; };

  // ── Pre-flight: fresh live census ──────────────────────────────────────────
  const all = await PU().getAll({});
  const count = (fn) => all.filter(fn).length;
  const activeRows = all.filter((u) => u.status === 'active');
  const census = {
    total: all.length,
    invited: count((u) => u.status === 'invited'),
    active: activeRows.length,
    disabled: count((u) => u.status === 'disabled'),
    mapped: count((u) => u.auth_user_id),
    activeNeverLoggedIn: activeRows.filter((u) => !u.auth_user_id && !u.last_login_at).length,
    activeLoggedIn: activeRows.filter((u) => !u.auth_user_id && u.last_login_at).length,
  };
  log(`census total=${census.total} invited=${census.invited} active=${census.active} disabled=${census.disabled} mapped=${census.mapped} activeNeverLoggedIn=${census.activeNeverLoggedIn} activeLoggedIn=${census.activeLoggedIn}`);
  if (!(census.total === 66 && census.invited === 49 && census.active === 17 && census.disabled === 0
    && census.mapped === 49 && census.activeNeverLoggedIn === 16 && census.activeLoggedIn === 1)) {
    fail(`pre-flight census mismatch: ${JSON.stringify(census)} — STOP, no mutations performed`);
    return;
  }

  // ── Baselines (hashes compared locally, never printed) ─────────────────────
  const hashBefore = new Map(all.map((u) => [String(u.id), u.password_hash ? String(u.password_hash).slice(0, 12) : null]));
  const loginBefore = new Map(all.map((u) => [String(u.id), u.last_login_at || null]));
  const statusBefore = new Map(all.map((u) => [String(u.id), u.status]));
  const resetsBefore = await snapshotTable('portal_password_resets', 'id,portal_user_id,code,expires_at,used_at');
  const sessionsBefore = await snapshotTable('portal_sessions', 'id,portal_user_id,refresh_token_hash,expires_at,revoked_at');
  const customersBefore = await snapshotTable('customers', 'id');
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || '';
  const authHeaders = { apikey: key, Authorization: `Bearer ${key}` };
  const listAuth = async () => {
    const out = [];
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await getWithRetry(`${base}/auth/v1/admin/users`,
        { headers: authHeaders, params: { page, per_page: 100 }, timeout: 10000 });
      const batch = (data && data.users) || [];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  };
  const authBefore = await listAuth();
  const portalEmails = new Set(all.map((u) => String(u.email || '').toLowerCase()));
  const orphansBefore = authBefore.filter((u) => !portalEmails.has(String(u.email || '').toLowerCase()));
  log(`auth before=${authBefore.length} orphans=${orphansBefore.length} resets=${resetsBefore.length} sessions=${sessionsBefore.length} customers=${customersBefore.length}`);
  if (authBefore.length !== 50 || orphansBefore.length !== 1) {
    fail('pre-flight Auth population mismatch — STOP, no mutations performed');
    return;
  }
  const orphanIdBefore = String(orphansBefore[0].id);
  const orphanConfirmedBefore = !!orphansBefore[0].email_confirmed_at;

  // ── Classifier recheck (read-only discovery) ───────────────────────────────
  const discovery = {
    getUserById: async (id) => {
      try {
        const { data } = await getWithRetry(
          `${base}/auth/v1/admin/users/${encodeURIComponent(id)}`,
          { headers: authHeaders, timeout: 8000 });
        return data || null;
      } catch (e) {
        if (e.response && e.response.status === 404) return null;
        throw e;
      }
    },
    findUsersByEmail: async (email) => {
      const users = await listAuth();
      return users
        .filter((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase())
        .map((u) => ({ id: u.id }));
    },
  };
  const report = await migration.dryRunPortalUserMigration({
    repo: { getAll: () => PU().getAll({}) },
    authDiscovery: discovery,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const eligible = orch.selectEligibleActiveNeverLoggedIn(report.records);
  const hybrid = report.records.filter((r) => r.migrationStrategy === 'LEGACY_LOGIN_HYBRID_MIGRATION');
  log(`eligible=${eligible.length} hybridReserved=${hybrid.length} manualReview=${report.manualReviewCount}`);
  if (eligible.length !== 16 || hybrid.length !== 1) {
    fail(`pre-flight selection mismatch (eligible=${eligible.length}, hybrid=${hybrid.length}) — STOP`);
    return;
  }

  // ── Live deps (active policy) ──────────────────────────────────────────────
  const deps = {
    readPortalRow: (id) => PU().getById(id),
    discoverAuthByEmail: async (email) => discovery.findUsersByEmail(email),
    provision: ({ portalUserId, email }) => provisioner.provisionPortalUser({ portalUserId, email }),
    verifyProvisioned: async ({ portalUserId, expectedEmail }) => {
      const fresh = await PU().getById(portalUserId);
      if (!fresh || String(fresh.status || '') !== 'active') return { ok: false, reason: 'STATUS_CHANGED' };
      if (fresh.last_login_at) return { ok: false, reason: 'LOGIN_MARKER_SET' };
      const authId = fresh.auth_user_id ? String(fresh.auth_user_id).trim() : '';
      if (!authId) return { ok: false, reason: 'MAPPING_ABSENT' };
      let authUser = null;
      try {
        const { data } = await getWithRetry(
          `${base}/auth/v1/admin/users/${encodeURIComponent(authId)}`,
          { headers: authHeaders, timeout: 8000 });
        authUser = data;
      } catch (e) {
        if (e.response && e.response.status === 404) return { ok: false, reason: 'AUTH_USER_MISSING' };
        return { ok: false, reason: 'AUTH_LOOKUP_FAILED' };
      }
      if (!authUser || String(authUser.id) !== authId) return { ok: false, reason: 'ID_MISMATCH' };
      if (String(authUser.email || '').toLowerCase() !== String(expectedEmail).toLowerCase()) {
        return { ok: false, reason: 'EMAIL_MISMATCH' };
      }
      if (authUser.email_confirmed_at) return { ok: false, reason: 'EMAIL_UNEXPECTEDLY_CONFIRMED' };
      return { ok: true };
    },
    logger: { log, warn: (m) => console.warn(`[Phase5B1] ${m}`), error: (m) => console.error(`[Phase5B1] ${m}`) },
  };

  // ── Batches 10 + 6 with invariant checkpoints ──────────────────────────────
  const run = await orch.runProvisioningBatches(eligible, deps, { batchSize: 10, policy: POLICY });
  for (const b of run.batches) {
    const now = await PU().getAll({});
    const activeMapped = now.filter((u) => u.status === 'active' && u.auth_user_id).length;
    const hybridMapped = now.filter((u) => u.status === 'active' && u.auth_user_id && u.last_login_at).length;
    const statusesChanged = now.filter((u) => statusBefore.get(String(u.id)) !== u.status).length;
    const loginsChanged = now.filter((u) => (loginBefore.get(String(u.id)) || null) !== (u.last_login_at || null)).length;
    log(`checkpoint batch ${b.batchNumber}: counts=${JSON.stringify(b.counts)} cumulative=${b.cumulativeMapped} remaining=${b.remaining} activeMapped=${activeMapped} hybridMapped=${hybridMapped} statusesChanged=${statusesChanged} loginsChanged=${loginsChanged}`);
    if (hybridMapped !== 0 || statusesChanged !== 0 || loginsChanged !== 0) {
      fail(`invariant violation after batch ${b.batchNumber} — HALTING`);
      return;
    }
    if (run.halted) break;
  }
  if (run.halted) {
    fail(`run halted: ${run.haltReason}`);
  }

  // ── Final reconciliation ───────────────────────────────────────────────────
  const after = await PU().getAll({});
  const final = {
    total: after.length,
    active: after.filter((u) => u.status === 'active').length,
    invited: after.filter((u) => u.status === 'invited').length,
    disabled: after.filter((u) => u.status === 'disabled').length,
    mapped: after.filter((u) => u.auth_user_id).length,
    activeMapped: after.filter((u) => u.status === 'active' && u.auth_user_id).length,
    activeUnmapped: after.filter((u) => u.status === 'active' && !u.auth_user_id).length,
    activeLoggedIn: after.filter((u) => u.status === 'active' && u.last_login_at).length,
    activeNeverLoggedIn: after.filter((u) => u.status === 'active' && !u.last_login_at).length,
  };
  const results = {};
  for (const r of run.results) results[r.status] = (results[r.status] || 0) + 1;
  log(`results=${JSON.stringify(results)} halted=${run.halted}`);
  log(`final total=${final.total} active=${final.active} invited=${final.invited} mapped=${final.mapped} activeMapped=${final.activeMapped} activeUnmapped=${final.activeUnmapped}`);

  const authAfter = await listAuth();
  const portalEmailSet = new Set(after.map((x) => String(x.email || '').toLowerCase()));
  const orphansAfter = authAfter.filter((u) => !portalEmailSet.has(String(u.email || '').toLowerCase()));
  log(`auth after=${authAfter.length} orphans=${orphansAfter.length}`);

  const resetsAfter = await snapshotTable('portal_password_resets', 'id,portal_user_id,code,expires_at,used_at');
  const sessionsAfter = await snapshotTable('portal_sessions', 'id,portal_user_id,refresh_token_hash,expires_at,revoked_at');
  const customersAfter = await snapshotTable('customers', 'id');
  let hashesChanged = 0;
  let loginsChanged = 0;
  for (const u of after) {
    const h = u.password_hash ? String(u.password_hash).slice(0, 12) : null;
    if (hashBefore.get(String(u.id)) !== h) hashesChanged += 1;
    if ((loginBefore.get(String(u.id)) || null) !== (u.last_login_at || null)) loginsChanged += 1;
  }
  const orphanIntact = orphansAfter.length === 1 && String(orphansAfter[0].id) === orphanIdBefore
    && !!orphansAfter[0].email_confirmed_at === orphanConfirmedBefore;
  const hybridRow = after.find((u) => u.status === 'active' && u.last_login_at);
  const hybridUntouched = !!hybridRow && !hybridRow.auth_user_id;
  log(`hashesChanged=${hashesChanged} loginsChanged=${loginsChanged} resetsSame=${JSON.stringify(resetsAfter) === JSON.stringify(resetsBefore)} sessionsSame=${JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore)} customersSame=${customersAfter.length === customersBefore.length} orphanIntact=${orphanIntact} hybridUntouched=${hybridUntouched}`);

  const ok = !run.halted
    && final.total === 66 && final.active === 17 && final.invited === 49 && final.disabled === 0
    && final.mapped === 65 && final.activeMapped === 16 && final.activeUnmapped === 1
    && final.activeLoggedIn === 1 && final.activeNeverLoggedIn === 16
    && authAfter.length === 66 && orphansAfter.length === 1
    && hashesChanged === 0 && loginsChanged === 0 && orphanIntact === true && hybridUntouched === true
    && JSON.stringify(resetsAfter) === JSON.stringify(resetsBefore)
    && JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore);
  log(ok ? 'PHASE5B1-RUN-OK' : 'PHASE5B1-RUN-NEEDS-REVIEW');
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[Phase5B1][FATAL] ${(e && e.code) || ''} ${e && e.message ? String(e.message).slice(0, 200) : e}`);
  process.exitCode = 1;
});
