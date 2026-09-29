/**
 * portalUserMigrationProvision.cjs — PHASE 5A batched provisioning orchestration.
 *
 * Pure orchestration over injected dependencies (no live imports, no env
 * reads). The live script wires the real Phase 4 provisioner, classifier,
 * and read-only verification; unit tests inject fakes.
 *
 * Safety model:
 *  - Candidates are pre-selected by selectEligibleInvitees() (invited +
 *    unmapped + valid email + READY_CREATE + PASSWORDLESS_AUTH_PROVISION),
 *    sorted deterministically by portalUserId. Anything else is never
 *    provisioned — re-checked per user at Step A (stale selection → skip).
 *  - Sequential processing only. No parallel workers, no in-memory locks;
 *    correctness rests on Auth email uniqueness + the DB unique index.
 *  - Per-user failures (ambiguous/conflict/state-changed/non-transient)
 *    record a safe status and continue. Infrastructure/security invariant
 *    failures HALT the entire run (no blind continuation).
 *  - Transient Auth failures (429/5xx/timeout/network) get bounded retries
 *    (3 attempts, exponential backoff, injected sleep); then reconcile: if
 *    the mapping is now present+verified the user counts as provisioned,
 *    otherwise AUTH_CREATE_FAILED.
 *  - Post-provision verification failure halts the run — a mismatch must
 *    never be papered over.
 *
 * Result statuses are safe: { portalUserId, redactedEmail, status, reason?,
 * attempts }. No emails, hashes, tokens, keys, or secrets ever appear.
 */

const RESULT_STATUS = Object.freeze({
  PROVISIONED: 'PROVISIONED',
  ALREADY_PROVISIONED: 'ALREADY_PROVISIONED',
  ADOPTED_EXISTING_AUTH: 'ADOPTED_EXISTING_AUTH',
  EMAIL_AMBIGUOUS: 'EMAIL_AMBIGUOUS',
  MAPPING_CONFLICT: 'MAPPING_CONFLICT',
  AUTH_CREATE_FAILED: 'AUTH_CREATE_FAILED',
  MAPPING_PERSIST_FAILED: 'MAPPING_PERSIST_FAILED',
  POST_PROVISION_RECONCILIATION_FAILED: 'POST_PROVISION_RECONCILIATION_FAILED',
  AUTH_DISCOVERY_FAILED: 'AUTH_DISCOVERY_FAILED',
  PORTAL_STATE_CHANGED: 'PORTAL_STATE_CHANGED',
  SKIPPED_OUT_OF_SCOPE: 'SKIPPED_OUT_OF_SCOPE',
  PROVISION_HALTED: 'PROVISION_HALTED',
});

// Provisioner codes that halt the whole run (infrastructure/security).
const HALT_CODES = new Set([
  'AUTH_ADMIN_UNAVAILABLE', // credential/config failure — would hit everyone
  'MAPPING_PERSIST_FAILED', // store/schema failure — would hit everyone
]);

const CONTINUE_CODES = new Map([
  ['EMAIL_AMBIGUOUS', RESULT_STATUS.EMAIL_AMBIGUOUS],
  ['MAPPING_CONFLICT', RESULT_STATUS.MAPPING_CONFLICT],
  ['NOT_FOUND', RESULT_STATUS.PORTAL_STATE_CHANGED],
  ['INVALID_INPUT', RESULT_STATUS.PORTAL_STATE_CHANGED],
]);

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

function isTransientProvisionError(err) {
  const msg = String((err && err.message) || '');
  return /status\s(429|500|502|503|504)\b|timeout|timed\s?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket\shang\s?up|network/i.test(msg);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noopLogger = { log() {}, warn() {}, error() {} };

function redactEmail(email) {
  if (email === null || email === undefined || String(email).trim() === '') return null;
  const trimmed = String(email).trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '*** (invalid)';
  return `${trimmed[0]}***@${trimmed.slice(at + 1)}`;
}

// Strict scope gate (§1): invited + unmapped + valid email + READY_CREATE +
// PASSWORDLESS_AUTH_PROVISION, sorted by portalUserId ascending.
function selectEligibleInvitees(records) {
  return selectEligibleByPolicy(records, {
    expectedStatus: 'invited',
    migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION',
  });
}

// Phase 5B-1 scope gate: active + never-logged-in + unmapped + valid email +
// READY_CREATE + PASSWORDLESS_AUTH_PROVISION_REVIEW, sorted by portalUserId.
// The single previously-logged-in active user (and every other population)
// is excluded by construction.
function selectEligibleActiveNeverLoggedIn(records) {
  return selectEligibleByPolicy(records, {
    expectedStatus: 'active',
    migrationStrategy: 'PASSWORDLESS_AUTH_PROVISION_REVIEW',
    requireNeverLoggedIn: true,
  });
}

function selectEligibleByPolicy(records, policy) {
  const expectedStatus = (policy && policy.expectedStatus) || 'invited';
  const strategy = (policy && policy.migrationStrategy) || 'PASSWORDLESS_AUTH_PROVISION';
  const requireNeverLoggedIn = !!(policy && policy.requireNeverLoggedIn);
  const list = (Array.isArray(records) ? records : []).filter((r) => {
    if (!r) return false;
    if (r.status !== expectedStatus) return false;
    if (r.authMappingState !== 'UNMAPPED') return false;
    if (r.emailPresent !== true || r.emailValid !== true) return false;
    if (r.classification !== 'READY_CREATE') return false;
    if (r.migrationStrategy !== strategy) return false;
    if (r.portalUserId === undefined || r.portalUserId === null || String(r.portalUserId) === '') return false;
    if (requireNeverLoggedIn && r.hasEverLoggedIn === true) return false;
    return true;
  });
  list.sort((a, b) => String(a.portalUserId).localeCompare(String(b.portalUserId)));
  return list;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Provision one candidate through Steps A–F.
// deps: { readPortalRow, discoverAuthByEmail, provision, verifyProvisioned,
//         sleep?, logger? }
// policy: { expectedStatus?, requireNeverLoggedIn? } — defaults preserve the
// Phase 5A invited behavior; Phase 5B-1 passes { expectedStatus: 'active',
// requireNeverLoggedIn: true } so a user who logged in (or changed status)
// between selection and provisioning fails safe with PORTAL_STATE_CHANGED.
async function provisionOne(candidate, deps, policy = null) {
  const logger = (deps && deps.logger) || noopLogger;
  const sleep = (deps && deps.sleep) || defaultSleep;
  const expectedStatus = (policy && policy.expectedStatus) || 'invited';
  const requireNeverLoggedIn = !!(policy && policy.requireNeverLoggedIn);
  const portalUserId = String(candidate.portalUserId);
  const redactedEmail = redactEmail(candidate.redactedEmail && candidate.redactedEmail.includes('@')
    ? candidate.redactedEmail
    : null) || candidate.redactedEmail || null;

  const finish = (status, reason = null, attempts = 1) => ({ portalUserId, redactedEmail, status, reason, attempts });

  // Step A — reread + eligibility (stale selection fails safe). Under a
  // never-logged-in policy, a newly appeared last_login_at immediately
  // removes the user from this phase (hybrid population).
  let row = null;
  try {
    row = await deps.readPortalRow(portalUserId);
  } catch (err) {
    return finish(RESULT_STATUS.PORTAL_STATE_CHANGED, 'PORTAL_READ_FAILED');
  }
  const email = row && row.email !== undefined && row.email !== null ? String(row.email).trim() : '';
  const lastLogin = row ? row.last_login_at : null;
  const lastLoginPresent = lastLogin !== null && lastLogin !== undefined && String(lastLogin).trim() !== '';
  const eligible = row
    && String(row.status || '') === expectedStatus
    && (row.auth_user_id === null || row.auth_user_id === undefined || String(row.auth_user_id).trim() === '')
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && (!requireNeverLoggedIn || !lastLoginPresent);
  if (!eligible) {
    return finish(RESULT_STATUS.PORTAL_STATE_CHANGED, 'PORTAL_STATE_CHANGED');
  }

  // Step B — read-only Auth discovery. A transport failure here halts the
  // run (§11 fail-closed): discovery health is systemic, not per-user.
  let matches = null;
  try {
    matches = await deps.discoverAuthByEmail(email);
  } catch (err) {
    return { ...finish(RESULT_STATUS.AUTH_DISCOVERY_FAILED, 'AUTH_DISCOVERY_FAILED'), halt: true };
  }
  const list = Array.isArray(matches) ? matches : [];
  if (list.length > 1) {
    return finish(RESULT_STATUS.EMAIL_AMBIGUOUS, 'MULTIPLE_AUTH_MATCHES');
  }
  const preexisting = list.length === 1 ? list[0] : null;

  // Step C — provision with bounded transient retries + reconcile.
  let attempts = 0;
  let lastError = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const res = await deps.provision({ portalUserId, email });
      if (res && res.idempotent === true) {
        return finish(RESULT_STATUS.ALREADY_PROVISIONED, null, attempts);
      }
      const adopted = preexisting !== null;
      // Steps D–F — verify before declaring success.
      let verification = null;
      try {
        verification = await deps.verifyProvisioned({ portalUserId, expectedEmail: email });
      } catch (err) {
        return { ...finish(RESULT_STATUS.POST_PROVISION_RECONCILIATION_FAILED, 'VERIFY_TRANSPORT_FAILED', attempts), halt: true };
      }
      if (!verification || verification.ok !== true) {
        return { ...finish(RESULT_STATUS.POST_PROVISION_RECONCILIATION_FAILED, (verification && verification.reason) || 'VERIFY_MISMATCH', attempts), halt: true };
      }
      return finish(adopted ? RESULT_STATUS.ADOPTED_EXISTING_AUTH : RESULT_STATUS.PROVISIONED, null, attempts);
    } catch (err) {
      const code = err && err.code;
      if (code && HALT_CODES.has(code)) {
        return { ...finish(code === 'MAPPING_PERSIST_FAILED' ? RESULT_STATUS.MAPPING_PERSIST_FAILED : RESULT_STATUS.AUTH_CREATE_FAILED, code, attempts), halt: true };
      }
      if (code && CONTINUE_CODES.has(code)) {
        return finish(CONTINUE_CODES.get(code), code, attempts);
      }
      if (code === 'AUTH_ADMIN_FAILED' && isTransientProvisionError(err) && attempts < MAX_ATTEMPTS) {
        logger.warn(`[MigrationProvision] transient failure for ${portalUserId} (attempt ${attempts}), backing off`);
        await sleep(BACKOFF_BASE_MS * (2 ** (attempts - 1)));
        lastError = err;
        continue;
      }
      if (code === 'AUTH_ADMIN_FAILED') {
        // Reconcile: the create may have succeeded despite the error.
        try {
          const check = await deps.verifyProvisioned({ portalUserId, expectedEmail: email });
          if (check && check.ok === true) {
            return finish(preexisting ? RESULT_STATUS.ADOPTED_EXISTING_AUTH : RESULT_STATUS.PROVISIONED, 'RECONCILED_AFTER_ERROR', attempts);
          }
        } catch (_) { /* fall through to failure record */ }
        return finish(RESULT_STATUS.AUTH_CREATE_FAILED, 'AUTH_ADMIN_FAILED', attempts);
      }
      // Unknown error shape — fail closed for the whole run.
      return { ...finish(RESULT_STATUS.AUTH_CREATE_FAILED, (code || 'UNEXPECTED_ERROR'), attempts), halt: true };
    }
  }
  void lastError;
  return finish(RESULT_STATUS.AUTH_CREATE_FAILED, 'RETRIES_EXHAUSTED');
}

// Run candidates in sequential batches with per-batch checkpoints.
// deps: same as provisionOne. options: { batchSize?, policy? } — policy is
// forwarded to every provisionOne call.
async function runProvisioningBatches(candidates, deps, options = {}) {
  const logger = (deps && deps.logger) || noopLogger;
  const batchSize = options.batchSize || 10;
  const policy = options.policy || null;
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  const batches = chunk(list, batchSize);
  const results = [];
  const batchReports = [];
  let halted = false;
  let haltReason = null;
  let cumulativeMapped = 0;

  for (let i = 0; i < batches.length; i += 1) {
    if (halted) break;
    const batch = batches[i];
    const batchCounts = {};
    for (const candidate of batch) {
      const res = await provisionOne(candidate, deps, policy);
      results.push(res);
      batchCounts[res.status] = (batchCounts[res.status] || 0) + 1;
      if (res.status === RESULT_STATUS.PROVISIONED
        || res.status === RESULT_STATUS.ADOPTED_EXISTING_AUTH
        || res.status === RESULT_STATUS.ALREADY_PROVISIONED) {
        cumulativeMapped += 1;
      }
      if (res.halt === true) {
        halted = true;
        haltReason = res.reason;
        logger.error(`[MigrationProvision] HALTING run at batch ${i + 1}: ${res.reason}`);
        break;
      }
    }
    const report = {
      batchNumber: i + 1,
      batchSize: batch.length,
      counts: batchCounts,
      cumulativeMapped,
      remaining: list.length - results.length,
      halted,
    };
    batchReports.push(report);
    logger.log(`[MigrationProvision] batch ${report.batchNumber}: ${JSON.stringify(report.counts)} (cumulative ${cumulativeMapped}, remaining ${report.remaining})`);
  }

  return { results, batches: batchReports, halted, haltReason };
}

module.exports = {
  RESULT_STATUS,
  HALT_CODES,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  isTransientProvisionError,
  redactEmail,
  selectEligibleInvitees,
  selectEligibleActiveNeverLoggedIn,
  provisionOne,
  runProvisioningBatches,
};
