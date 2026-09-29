/**
 * supabasePortalAuthAdmin.cjs — PHASE 4 registration provisioning boundary.
 *
 * Dedicated server-side boundary for provisioning Portal users into Supabase
 * Auth (GoTrue Admin API) during registration-request approval, and for
 * persisting the authentication mapping:
 *
 *   auth.users.id (UUID)
 *     → portal_users.auth_user_id
 *     → portal_users.id (pusr_…)
 *     → portal_users.customer_id
 *     → customers.id (CUST-XXXX)
 *
 * Single-company ERP: no tenant_id / organization_id / company_id fields,
 * claims, or dimensions anywhere in this module.
 *
 * Hard rules enforced here:
 *  - Service-role key is read server-side ONLY (env), sent ONLY as an
 *    Authorization/apikey header to the Admin API. It is NEVER returned,
 *    logged, embedded in JWTs, or exposed through any API response.
 *  - NO password is ever generated, copied, imported, returned, or logged.
 *    The legacy bcrypt hash is never read. Auth users are created
 *    passwordless (no password field); Portal invite-code activation
 *    remains the setup UX. Invite/recovery link issuance is a later phase
 *    and no reset URLs are produced here.
 *  - NO Auth tokens (access/refresh) are ever returned or logged.
 *  - NO Auth metadata is populated (unnecessary → omitted). The backend
 *    database remains authoritative for Portal authorization and ownership.
 *  - Email is a provisioning/discovery attribute ONLY — never the
 *    authoritative identity. Post-mapping auth resolves sub → auth_user_id.
 *  - Idempotent + retry-safe: existing mappings are verified and reused
 *    (never duplicated); email-taken races resolve to the single exact
 *    match or fail closed on ambiguity; failures never invent UUIDs and
 *    never mark the mapping complete.
 *  - Concurrency correctness rests on Supabase Auth email uniqueness plus
 *    the database UNIQUE constraint on portal_users.auth_user_id — never
 *    on an in-memory lock.
 *
 * All thrown errors carry a safe machine-readable `.code` and a message
 * free of secrets, tokens, links, and response bodies.
 */

const axios = require('axios');

// ─── Feature flag (default OFF) ─────────────────────────────────────────────

const PROVISIONING_FLAG_NAME = 'PORTAL_SUPABASE_REGISTRATION_PROVISIONING';

function isProvisioningEnabled() {
  return String(process.env[PROVISIONING_FLAG_NAME] || '').trim().toLowerCase() === 'true';
}

// ─── UUID shape (local copy keeps this boundary isolated) ───────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function normalizeEmail(email) {
  if (email === null || email === undefined) return null;
  const out = String(email).toLowerCase().trim().replace(/\s+/g, '');
  return out || null;
}

// ─── Admin API configuration (server-side only) ─────────────────────────────

const ADMIN_TIMEOUT_MS = 8000;
const ADMIN_LIST_PAGE_SIZE = 100;
const ADMIN_LIST_MAX_PAGES = 10;

function getAuthAdminConfig() {
  const baseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  // Existing backend convention: service-role key lives in
  // SUPABASE_SECRET_KEY (SUPABASE_SERVICE_ROLE_KEY accepted as an alias).
  const serviceKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const configured = Boolean(baseUrl && serviceKey && !baseUrl.includes('placeholder') && !serviceKey.includes('placeholder'));
  return { baseUrl, configured, hasServiceKey: Boolean(serviceKey) };
}

function adminHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── Default Admin API transport (axios; hermetic tests inject a mock) ──────

function serviceKeyOrThrow(cfg) {
  // The key itself is never attached to errors, logs, or return values.
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!cfg.configured || !key) {
    throw codedError('AUTH_ADMIN_UNAVAILABLE', 'Supabase Auth Admin API is not configured');
  }
  return key;
}

const defaultAdminApi = {
  // Create a passwordless Auth user. Resolves { id } or { taken: true }
  // when the email is already registered (caller resolves safely).
  async createUser(email) {
    const cfg = getAuthAdminConfig();
    const key = serviceKeyOrThrow(cfg);
    let res;
    try {
      res = await axios.post(
        `${cfg.baseUrl}/auth/v1/admin/users`,
        { email, email_confirm: false },
        { headers: adminHeaders(key), timeout: ADMIN_TIMEOUT_MS }
      );
    } catch (err) {
      const status = err && err.response && err.response.status;
      const msg = String((err && err.response && err.response.data && err.response.data.msg) || (err && err.message) || '');
      if ((status === 400 || status === 409 || status === 422) && /already|exist|taken|duplicate/i.test(msg)) {
        return { taken: true };
      }
      throw codedError('AUTH_ADMIN_FAILED', `Supabase Auth user creation failed (status ${status || 'unknown'})`);
    }
    const id = res && res.data && res.data.id;
    if (!isUuidShape(id)) {
      throw codedError('AUTH_ADMIN_FAILED', 'Supabase Auth user creation returned an unusable identity');
    }
    return { id: String(id).trim() };
  },

  // Fetch one Auth user by id. Resolves the user object or null on 404.
  async getUser(id) {
    const cfg = getAuthAdminConfig();
    const key = serviceKeyOrThrow(cfg);
    try {
      const res = await axios.get(`${cfg.baseUrl}/auth/v1/admin/users/${encodeURIComponent(String(id))}`, {
        headers: adminHeaders(key),
        timeout: ADMIN_TIMEOUT_MS,
      });
      return (res && res.data) || null;
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) return null;
      throw codedError('AUTH_ADMIN_FAILED', `Supabase Auth user lookup failed (status ${status || 'unknown'})`);
    }
  },

  // Exact-email match across paged Admin list. Returns ALL exact matches so
  // the caller can fail closed on ambiguity (never LIMIT 1 as a shortcut).
  async listUsersByEmail(email) {
    const cfg = getAuthAdminConfig();
    const key = serviceKeyOrThrow(cfg);
    const wanted = normalizeEmail(email);
    const matches = [];
    try {
      for (let page = 1; page <= ADMIN_LIST_MAX_PAGES; page += 1) {
        const res = await axios.get(`${cfg.baseUrl}/auth/v1/admin/users`, {
          headers: adminHeaders(key),
          params: { page, per_page: ADMIN_LIST_PAGE_SIZE },
          timeout: ADMIN_TIMEOUT_MS,
        });
        const users = (res && res.data && res.data.users) || [];
        for (const u of users) {
          if (u && normalizeEmail(u.email) === wanted) matches.push(u);
        }
        if (!Array.isArray(users) || users.length < ADMIN_LIST_PAGE_SIZE) break;
      }
    } catch (err) {
      const status = err && err.response && err.response.status;
      throw codedError('AUTH_ADMIN_FAILED', `Supabase Auth user search failed (status ${status || 'unknown'})`);
    }
    return matches;
  },
};

// ─── Auth password update (Phase 5B-2B hybrid migration only) ───────────────
//
// updateAuthUserPassword(authUserId, plaintextPassword) → { ok: true }.
// Sets the password on an EXISTING Auth identity via PUT
// /auth/v1/admin/users/{id} with exactly { password }. Email confirmation,
// metadata, phone, and MFA are never touched; the user is never recreated.
// The plaintext password is a transient argument only: never stored,
// cached, logged, returned, or embedded in errors. Failures throw coded
// errors free of credential material; the caller (login hook) treats them
// as best-effort and never breaks legacy authentication because of them.

// Classify a transport failure into a safe, coarse category without
// touching bodies, configs, headers, or request data.
function classifyTransportError(err) {
  const status = err && err.response && err.response.status;
  if (typeof status === 'number') {
    return { httpStatus: status, errorClass: 'HTTP' };
  }
  const code = String((err && err.code) || '');
  const message = String((err && err.message) || '');
  if (/ECONNABORTED|ETIMEDOUT/i.test(code) || /timeout|timed\s?out/i.test(message)) {
    return { httpStatus: null, errorClass: 'TIMEOUT' };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EPIPE|socket|network/i.test(code + ' ' + message)) {
    return { httpStatus: null, errorClass: 'NETWORK' };
  }
  return { httpStatus: null, errorClass: 'UNKNOWN' };
}

async function updateAuthUserPassword(authUserId, plaintextPassword) {
  if (!isUuidShape(authUserId)) {
    throw codedError('INVALID_INPUT', 'A valid Auth user id is required');
  }
  if (typeof plaintextPassword !== 'string' || plaintextPassword.length === 0) {
    throw codedError('INVALID_INPUT', 'A password value is required');
  }
  const cfg = getAuthAdminConfig();
  const key = serviceKeyOrThrow(cfg);
  try {
    await axios.put(
      `${cfg.baseUrl}/auth/v1/admin/users/${encodeURIComponent(String(authUserId).trim())}`,
      { password: plaintextPassword },
      { headers: adminHeaders(key), timeout: ADMIN_TIMEOUT_MS }
    );
  } catch (err) {
    const status = err && err.response && err.response.status;
    // Public contract preserved (coded error, no credential material).
    // Safe transport facts are attached for route-level diagnostics only:
    // httpStatus (number|null) + errorClass (HTTP|TIMEOUT|NETWORK|UNKNOWN).
    // Never the body, config, headers, or request data.
    const failure = codedError('AUTH_PASSWORD_UPDATE_FAILED', `Supabase Auth password update failed (status ${status || 'unknown'})`);
    const { httpStatus, errorClass } = classifyTransportError(err);
    failure.httpStatus = httpStatus;
    failure.errorClass = errorClass;
    throw failure;
  }
  return { ok: true };
}

// ─── Repository access (lazy; keeps this boundary decoupled) ────────────────

function getPortalUsersRepo(override) {
  if (override) return override;
  const repo = require('./supabaseRepository.cjs');
  if (!repo || !repo.portalEntities || !repo.portalEntities.portal_users) {
    throw codedError('AUTH_ADMIN_UNAVAILABLE', 'Portal user store is not available');
  }
  return repo.portalEntities.portal_users;
}

// ─── Provisioning ───────────────────────────────────────────────────────────
//
// provisionPortalUser({ portalUserId, email?, adminApi?, repo? })
//   → { ok: true, authUserId, idempotent: boolean }
//   throws coded errors; NEVER writes a fake UUID, NEVER completes the
//   mapping on failure, NEVER touches passwords/tokens/secrets.

async function provisionPortalUser({ portalUserId, email = null, adminApi = null, repo = null } = {}) {
  if (!portalUserId || typeof portalUserId !== 'string' || portalUserId.trim() === '') {
    throw codedError('INVALID_INPUT', 'portalUserId is required');
  }
  const api = adminApi || defaultAdminApi;
  const users = getPortalUsersRepo(repo);

  let row = null;
  try {
    row = await users.getById(portalUserId);
  } catch (err) {
    throw codedError('AUTH_ADMIN_FAILED', 'Portal user lookup failed');
  }
  if (!row) {
    throw codedError('NOT_FOUND', 'Portal user not found');
  }

  const rowEmail = normalizeEmail(row.email);
  const targetEmail = normalizeEmail(email) || rowEmail;
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    throw codedError('INVALID_INPUT', 'A valid email is required for Auth provisioning');
  }

  const existingMapping = row.auth_user_id !== null && row.auth_user_id !== undefined
    ? String(row.auth_user_id).trim()
    : '';

  // ── State B: mapping already present → verify usable, never duplicate ─────
  if (existingMapping !== '') {
    if (!isUuidShape(existingMapping)) {
      throw codedError('MAPPING_CONFLICT', 'Existing Auth mapping is malformed');
    }
    const authUser = await api.getUser(existingMapping);
    if (!authUser) {
      // Stale mapping (Auth user deleted): fall through to re-provision and
      // overwrite with the freshly resolved identity below.
    } else {
      if (normalizeEmail(authUser.email) !== rowEmail) {
        throw codedError('MAPPING_CONFLICT', 'Existing Auth mapping does not match the Portal user');
      }
      return { ok: true, authUserId: existingMapping, idempotent: true };
    }
  }

  // ── States A/C: resolve-or-create by exact email ──────────────────────────
  let authUserId = null;
  const created = await api.createUser(targetEmail);
  if (created && created.id) {
    if (!isUuidShape(created.id)) {
      throw codedError('AUTH_ADMIN_FAILED', 'Supabase Auth user creation returned an unusable identity');
    }
    authUserId = String(created.id).trim();
  } else {
    // Email taken (including create-races): adopt ONLY on unambiguous match.
    const matches = await api.listUsersByEmail(targetEmail);
    if (!Array.isArray(matches) || matches.length === 0) {
      throw codedError('AUTH_ADMIN_FAILED', 'Supabase Auth identity could not be resolved for retry');
    }
    if (matches.length !== 1 || !isUuidShape(matches[0] && matches[0].id)) {
      throw codedError('EMAIL_AMBIGUOUS', 'Supabase Auth identity is ambiguous for this email');
    }
    authUserId = String(matches[0].id).trim();
  }

  // Never steal an identity already mapped to a DIFFERENT portal user.
  try {
    const holder = await users.getByAuthUserId(authUserId);
    if (holder && String(holder.id) !== String(portalUserId)) {
      throw codedError('MAPPING_CONFLICT', 'Supabase Auth identity is already mapped to another Portal user');
    }
  } catch (err) {
    if (err && err.code === 'MAPPING_CONFLICT') throw err;
    throw codedError('AUTH_ADMIN_FAILED', 'Auth mapping ownership check failed');
  }

  // ── Persist + verify (no fake mapping, no silent completion) ─────────────
  try {
    await users.update(portalUserId, { auth_user_id: authUserId });
  } catch (err) {
    throw codedError('MAPPING_PERSIST_FAILED', 'Auth mapping could not be persisted for retry');
  }
  let fresh = null;
  try {
    fresh = await users.getById(portalUserId);
  } catch (err) {
    throw codedError('MAPPING_PERSIST_FAILED', 'Auth mapping could not be verified for retry');
  }
  if (!fresh || String(fresh.auth_user_id || '').trim() !== authUserId) {
    throw codedError('MAPPING_PERSIST_FAILED', 'Auth mapping could not be verified for retry');
  }

  return { ok: true, authUserId, idempotent: false };
}

module.exports = {
  PROVISIONING_FLAG_NAME,
  isProvisioningEnabled,
  getAuthAdminConfig,
  provisionPortalUser,
  updateAuthUserPassword,
  defaultAdminApi,
};
