/**
 * portalUserMigration.cjs — PHASE 5 read-only migration classifier / dry-run.
 *
 * Classifies every `portal_users` row into a deterministic migration decision
 * WITHOUT mutating anything:
 *
 *   portal_users → read-only classifier → status/email/Auth-collision
 *   classification → migration strategy → dry-run report.
 *
 * NON-MUTATION CONTRACT (enforced by construction, verified by tests):
 *  - No Supabase Auth create/update/delete/invite/recovery calls exist in
 *    this module. Auth discovery flows ONLY through an injected read-only
 *    adapter shaped { getUserById, findUsersByEmail }.
 *  - `asReadOnlyDiscovery()` strips any mutation-capable surface off an
 *    injected object (mutation methods are never forwarded) and throws when
 *    no read surface is present (fail closed).
 *  - No `portal_users` writes, no status/password/session/MFA/invite changes,
 *    no schema changes. The default logger is a silent no-op so report data
 *    can never leak into logs.
 *
 * Identity rules:
 *  - Migration identity is ALWAYS `portal_users.id`, never `customer_id`.
 *    Each row is classified independently (N:1 safe).
 *  - Email is a discovery heuristic only (original vs normalized preserved
 *    internally); never an identity key. Report DTOs carry a redacted email
 *    only — never the full address, never hashes, secrets, or tokens.
 *  - MFA truth is not inferable from the live schema: every record reports
 *    mfaState "UNKNOWN_LIVE_SCHEMA" without querying TOTP material.
 *
 * Single-company ERP: no tenant_id / organization_id / company_id fields,
 * claims, or dimensions anywhere in this module.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Classification vocabulary ──────────────────────────────────────────────

const CLASSIFICATION = Object.freeze({
  READY_CREATE: 'READY_CREATE',
  READY_ADOPT: 'READY_ADOPT',
  ALREADY_MAPPED: 'ALREADY_MAPPED',
  AUTH_MAPPING_CONFLICT: 'AUTH_MAPPING_CONFLICT',
  EMAIL_AMBIGUOUS: 'EMAIL_AMBIGUOUS',
  EMAIL_INVALID: 'EMAIL_INVALID',
  EMAIL_MISSING: 'EMAIL_MISSING',
  DUPLICATE_PORTAL_EMAIL: 'DUPLICATE_PORTAL_EMAIL',
  AUTH_NOT_FOUND_FOR_MAPPING: 'AUTH_NOT_FOUND_FOR_MAPPING',
  DISABLED_DEFERRED: 'DISABLED_DEFERRED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NO_ACTION_REQUIRED: 'NO_ACTION_REQUIRED',
});

const MIGRATION_STRATEGY = Object.freeze({
  PASSWORDLESS_AUTH_PROVISION: 'PASSWORDLESS_AUTH_PROVISION',
  PASSWORDLESS_AUTH_PROVISION_REVIEW: 'PASSWORDLESS_AUTH_PROVISION_REVIEW',
  LEGACY_LOGIN_HYBRID_MIGRATION: 'LEGACY_LOGIN_HYBRID_MIGRATION',
  DEFER_UNTIL_REACTIVATED: 'DEFER_UNTIL_REACTIVATED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NO_ACTION_REQUIRED: 'NO_ACTION_REQUIRED',
});

const MANUAL_REVIEW_CLASSIFICATIONS = new Set([
  CLASSIFICATION.AUTH_MAPPING_CONFLICT,
  CLASSIFICATION.EMAIL_AMBIGUOUS,
  CLASSIFICATION.EMAIL_INVALID,
  CLASSIFICATION.EMAIL_MISSING,
  CLASSIFICATION.DUPLICATE_PORTAL_EMAIL,
  CLASSIFICATION.AUTH_NOT_FOUND_FOR_MAPPING,
  CLASSIFICATION.MANUAL_REVIEW,
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

// ─── Email normalization (single deterministic helper) ──────────────────────

function normalizeEmail(email) {
  if (email === null || email === undefined) return null;
  const out = String(email).toLowerCase().trim().replace(/\s+/g, '');
  return out || null;
}

function isEmailPresent(email) {
  if (email === null || email === undefined) return false;
  return String(email).trim() !== '';
}

function isEmailValid(normalized) {
  return typeof normalized === 'string' && EMAIL_RE.test(normalized);
}

// Redact for reports: keep first local char + domain shape, never the address.
function redactEmail(original) {
  if (!isEmailPresent(original)) return null;
  const trimmed = String(original).trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '*** (invalid)';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const localHint = local.length > 0 ? `${local[0]}***` : '***';
  return `${localHint}@${domain}`;
}

// ─── Read-only Auth discovery seam ──────────────────────────────────────────
//
// Accepted injected shapes (read surface only):
//   { getUserById(id), findUsersByEmail(email) }          ← preferred
//   { getUser(id), listUsersByEmail(email) }              ← Phase 4 transport
// Anything else (including mutation methods) is never forwarded. Presence of
// mutation methods does NOT error — they are simply unreachable through the
// returned adapter (proven by test 21). Absence of a read surface throws.

const MUTATION_METHOD_NAMES = Object.freeze([
  'createUser', 'updateUser', 'deleteUser', 'inviteUser', 'generateLink',
  'create', 'update', 'remove', 'insert', 'upsert', 'sendInvite', 'recover',
]);

function asReadOnlyDiscovery(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    const err = new Error('Auth discovery is not configured');
    err.code = 'AUTH_DISCOVERY_UNAVAILABLE';
    throw err;
  }
  if (typeof candidate.getUserById === 'function' && typeof candidate.findUsersByEmail === 'function') {
    return {
      getUserById: (id) => candidate.getUserById(id),
      findUsersByEmail: (email) => candidate.findUsersByEmail(email),
    };
  }
  if (typeof candidate.getUser === 'function' && typeof candidate.listUsersByEmail === 'function') {
    return {
      getUserById: (id) => candidate.getUser(id),
      findUsersByEmail: (email) => candidate.listUsersByEmail(email),
    };
  }
  const err = new Error('Auth discovery exposes no read-only surface');
  err.code = 'AUTH_DISCOVERY_UNAVAILABLE';
  throw err;
}

// Read-only adapter over the Phase 4 Admin transport's GET helpers. Only the
// two read functions are closed over — the mutation path
// (provisionPortalUser/createUser) is never referenced here.
function fromAdminApiReadOnly(adminApi) {
  return asReadOnlyDiscovery(adminApi);
}

// ─── Repository seam (lazy default; tests inject fakes) ─────────────────────

function getPortalUsersRepo(override) {
  if (override) return override;
  const repo = require('./supabaseRepository.cjs');
  if (!repo || !repo.portalEntities || !repo.portalEntities.portal_users
    || typeof repo.portalEntities.portal_users.getAll !== 'function') {
    const err = new Error('Portal user store is not available');
    err.code = 'PORTAL_STORE_UNAVAILABLE';
    throw err;
  }
  return repo.portalEntities.portal_users;
}

// ─── Strategy selection (future path only — never executed here) ────────────

function strategyForEligible(status, hasEverLoggedIn) {
  if (status === 'invited') return MIGRATION_STRATEGY.PASSWORDLESS_AUTH_PROVISION;
  if (status === 'active') {
    return hasEverLoggedIn
      ? MIGRATION_STRATEGY.LEGACY_LOGIN_HYBRID_MIGRATION
      : MIGRATION_STRATEGY.PASSWORDLESS_AUTH_PROVISION_REVIEW;
  }
  return MIGRATION_STRATEGY.MANUAL_REVIEW;
}

// ─── Single-row classifier ──────────────────────────────────────────────────
//
// classifyPortalUser(row, ctx) → safe report DTO (no hashes/secrets/tokens).
// ctx: { duplicateEmails: Set<string>, authIdToPortalUserId: Map<string,string>,
//        authDiscovery: { getUserById, findUsersByEmail } | null }

async function classifyPortalUser(row, ctx = {}) {
  const portalUserId = row && row.id !== undefined && row.id !== null ? String(row.id) : '';
  const status = row ? String(row.status || '') : '';
  const originalEmail = row ? row.email ?? null : null;
  const normalized = normalizeEmail(originalEmail);
  const emailPresent = isEmailPresent(originalEmail);
  const emailValid = isEmailValid(normalized);
  const hasLegacyPasswordHash = !!(row && row.password_hash);
  const hasEverLoggedIn = !!(row && row.last_login_at !== null && row.last_login_at !== undefined && String(row.last_login_at).trim() !== '');
  const rawMapping = row && row.auth_user_id !== null && row.auth_user_id !== undefined
    ? String(row.auth_user_id).trim()
    : '';

  const base = {
    portalUserId,
    customerId: row && row.customer_id !== undefined && row.customer_id !== null ? String(row.customer_id) : null,
    status,
    emailPresent,
    emailValid,
    redactedEmail: redactEmail(originalEmail),
    hasLegacyPasswordHash,
    hasEverLoggedIn,
    authMappingState: 'UNMAPPED',
    authCollisionState: 'NOT_CHECKED',
    mfaState: 'UNKNOWN_LIVE_SCHEMA',
    classification: CLASSIFICATION.MANUAL_REVIEW,
    migrationStrategy: MIGRATION_STRATEGY.MANUAL_REVIEW,
    reason: 'UNCLASSIFIED',
  };

  const decide = (classification, migrationStrategy, reason, extra = {}) =>
    ({ ...base, classification, migrationStrategy, reason, ...extra });

  // Status gate first: disabled users need no Auth calls at all.
  if (status === 'disabled') {
    return decide(
      CLASSIFICATION.DISABLED_DEFERRED,
      MIGRATION_STRATEGY.DEFER_UNTIL_REACTIVATED,
      'STATUS_DISABLED',
      { authCollisionState: 'NOT_CHECKED' }
    );
  }

  if (!emailPresent) {
    return decide(CLASSIFICATION.EMAIL_MISSING, MIGRATION_STRATEGY.MANUAL_REVIEW, 'EMAIL_MISSING');
  }
  if (!emailValid) {
    return decide(CLASSIFICATION.EMAIL_INVALID, MIGRATION_STRATEGY.MANUAL_REVIEW, 'EMAIL_INVALID');
  }

  if (ctx.duplicateEmails && normalized && ctx.duplicateEmails.has(normalized)) {
    return decide(
      CLASSIFICATION.DUPLICATE_PORTAL_EMAIL,
      MIGRATION_STRATEGY.MANUAL_REVIEW,
      'DUPLICATE_PORTAL_EMAIL'
    );
  }

  // Existing mapping → read-only verification only. Never overwrite, never
  // self-heal here (Phase 4 behavior is out of scope for the dry-run).
  if (rawMapping !== '') {
    if (!isUuidShape(rawMapping)) {
      return decide(CLASSIFICATION.MANUAL_REVIEW, MIGRATION_STRATEGY.MANUAL_REVIEW, 'MALFORMED_MAPPING', {
        authMappingState: 'MAPPED_MALFORMED',
      });
    }
    if (!ctx.authDiscovery) {
      const err = new Error('Auth discovery is not configured');
      err.code = 'AUTH_DISCOVERY_UNAVAILABLE';
      throw err;
    }
    const authUser = await ctx.authDiscovery.getUserById(rawMapping);
    if (authUser) {
      return decide(CLASSIFICATION.ALREADY_MAPPED, MIGRATION_STRATEGY.NO_ACTION_REQUIRED, 'MAPPING_VERIFIED', {
        authMappingState: 'MAPPED_VERIFIED',
      });
    }
    return decide(
      CLASSIFICATION.AUTH_NOT_FOUND_FOR_MAPPING,
      MIGRATION_STRATEGY.MANUAL_REVIEW,
      'MAPPED_AUTH_USER_MISSING',
      { authMappingState: 'MAPPED_MISSING_AUTH_USER' }
    );
  }

  // Unmapped + unknown status → manual territory (no Auth calls wasted).
  if (status !== 'active' && status !== 'invited') {
    return decide(CLASSIFICATION.MANUAL_REVIEW, MIGRATION_STRATEGY.MANUAL_REVIEW, 'UNKNOWN_STATUS');
  }

  // Unmapped eligible user → read-only email collision discovery.
  if (!ctx.authDiscovery) {
    const err = new Error('Auth discovery is not configured');
    err.code = 'AUTH_DISCOVERY_UNAVAILABLE';
    throw err;
  }
  const matches = await ctx.authDiscovery.findUsersByEmail(normalized);
  const list = Array.isArray(matches) ? matches : [];
  if (list.length === 0) {
    return decide(CLASSIFICATION.READY_CREATE, strategyForEligible(status, hasEverLoggedIn), 'NO_AUTH_MATCH', {
      authCollisionState: 'NO_AUTH_MATCH',
    });
  }
  if (list.length > 1) {
    return decide(CLASSIFICATION.EMAIL_AMBIGUOUS, MIGRATION_STRATEGY.MANUAL_REVIEW, 'MULTIPLE_AUTH_MATCHES', {
      authCollisionState: 'MULTIPLE_MATCHES',
    });
  }
  const matchId = list[0] && list[0].id !== undefined && list[0].id !== null ? String(list[0].id) : '';
  if (!isUuidShape(matchId)) {
    return decide(CLASSIFICATION.EMAIL_AMBIGUOUS, MIGRATION_STRATEGY.MANUAL_REVIEW, 'UNUSABLE_AUTH_MATCH', {
      authCollisionState: 'MULTIPLE_MATCHES',
    });
  }
  const holder = ctx.authIdToPortalUserId ? ctx.authIdToPortalUserId.get(matchId) : undefined;
  if (holder !== undefined && holder !== portalUserId) {
    return decide(
      CLASSIFICATION.AUTH_MAPPING_CONFLICT,
      MIGRATION_STRATEGY.MANUAL_REVIEW,
      'AUTH_ID_MAPPED_ELSEWHERE',
      { authCollisionState: 'MATCH_MAPPED_ELSEWHERE' }
    );
  }
  if (holder !== undefined && holder === portalUserId) {
    // Defensive: row claims unmapped but the index says otherwise.
    return decide(CLASSIFICATION.ALREADY_MAPPED, MIGRATION_STRATEGY.NO_ACTION_REQUIRED, 'MAPPING_VERIFIED', {
      authMappingState: 'MAPPED_VERIFIED',
    });
  }
  return decide(CLASSIFICATION.READY_ADOPT, strategyForEligible(status, hasEverLoggedIn), 'SINGLE_UNMAPPED_AUTH_MATCH', {
    authCollisionState: 'SINGLE_MATCH_UNMAPPED',
  });
}

// ─── Dry-run API ────────────────────────────────────────────────────────────
//
// dryRunPortalUserMigration({ repo?, authDiscovery?, logger? }) → aggregate
// report. Reads every Portal user, classifies deterministically
// (sorted by portalUserId), performs only read-only Auth lookups, writes
// nothing. logger defaults to a silent no-op so classifications can never
// leak into logs.

const noopLogger = { log() {}, warn() {}, error() {} };

async function dryRunPortalUserMigration({ repo = null, authDiscovery = null, logger = null } = {}) {
  const log = logger || noopLogger;
  const usersRepo = getPortalUsersRepo(repo);
  const discovery = authDiscovery ? asReadOnlyDiscovery(authDiscovery) : null;

  let rows = [];
  try {
    rows = (await usersRepo.getAll({})) || [];
  } catch (err) {
    const wrapped = new Error('Portal user census read failed');
    wrapped.code = 'PORTAL_STORE_UNAVAILABLE';
    throw wrapped;
  }
  const list = Array.isArray(rows) ? rows.slice() : [];

  // Duplicate detection over normalized valid emails (missing/invalid rows
  // already have their own states and never join the duplicate set).
  const emailCounts = new Map();
  for (const row of list) {
    const normalized = normalizeEmail(row ? row.email ?? null : null);
    if (isEmailValid(normalized)) {
      emailCounts.set(normalized, (emailCounts.get(normalized) || 0) + 1);
    }
  }
  const duplicateEmails = new Set(
    [...emailCounts.entries()].filter(([, n]) => n > 1).map(([email]) => email)
  );

  // In-memory UUID → portalUserId index for conflict detection (no queries).
  const authIdToPortalUserId = new Map();
  for (const row of list) {
    const raw = row && row.auth_user_id !== null && row.auth_user_id !== undefined
      ? String(row.auth_user_id).trim()
      : '';
    if (raw !== '' && isUuidShape(raw) && row && row.id !== undefined && row.id !== null) {
      if (!authIdToPortalUserId.has(raw)) authIdToPortalUserId.set(raw, String(row.id));
    }
  }

  const ctx = { duplicateEmails, authIdToPortalUserId, authDiscovery: discovery };

  const records = [];
  for (const row of list) {
    records.push(await classifyPortalUser(row, ctx));
  }
  // Deterministic ordering independent of store/request order.
  records.sort((a, b) => String(a.portalUserId).localeCompare(String(b.portalUserId)));

  const byStatus = {};
  const byClassification = {};
  const byMigrationStrategy = {};
  const manualReview = [];
  for (const record of records) {
    byStatus[record.status || ''] = (byStatus[record.status || ''] || 0) + 1;
    byClassification[record.classification] = (byClassification[record.classification] || 0) + 1;
    byMigrationStrategy[record.migrationStrategy] = (byMigrationStrategy[record.migrationStrategy] || 0) + 1;
    if (MANUAL_REVIEW_CLASSIFICATIONS.has(record.classification)) manualReview.push(record.portalUserId);
  }
  manualReview.sort((a, b) => String(a).localeCompare(String(b)));

  if (log && typeof log.log === 'function') {
    log.log(`[PortalMigrationDryRun] classified ${records.length} portal users (${manualReview.length} manual review)`);
  }

  return {
    total: records.length,
    byStatus,
    byClassification,
    byMigrationStrategy,
    manualReviewCount: manualReview.length,
    manualReview,
    records,
  };
}

module.exports = {
  CLASSIFICATION,
  MIGRATION_STRATEGY,
  normalizeEmail,
  redactEmail,
  asReadOnlyDiscovery,
  fromAdminApiReadOnly,
  classifyPortalUser,
  dryRunPortalUserMigration,
};
