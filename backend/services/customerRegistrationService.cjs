/**
 * Customer Registration Request Service
 *
 * Approval-gated public intake for portal customer registration:
 *
 *   Portal registration → Customer Registration Request (PENDING)
 *   → ERP admin review → APPROVE (next phase) → official CUST-XXXX
 *   customer + portal credentials.
 *
 * A public registration MUST NEVER directly create:
 *   - a `customers` row
 *   - a `portal_users` row
 *   - a password hash / JWT / refresh token / session
 *   - ledger / inventory / sales / AR writes
 *
 * Pending requests live EXCLUSIVELY in the `customer_registration_requests`
 * envelope table so they can never appear in the Customer List, AR/debtors,
 * customer selectors, statements, sales, payments, reports, or accounting
 * (all of which read `customers` only).
 *
 * Architecture mirrors paymentRequestService.cjs (workflow data only, no
 * accounting writes) and portalLifecycleService.cjs (state machine +
 * atomic WHERE-status transitions), with numbering from
 * workflowEngine.nextYearScopedNumber (CREG-YYYY-######).
 *
 * Single-company ERP: no tenant_id / organization_id / company_id fields.
 */

const crypto = require('crypto');
const repo = require('./supabaseRepository.cjs');
const workflowEngine = require('./workflowEngine.cjs');

let _referralService = null;
function getReferralService() {
  if (!_referralService) {
    try {
      const ReferralService = require('./referralService.cjs');
      _referralService = new ReferralService();
    } catch {
      _referralService = null;
    }
  }
  return _referralService;
}

let _repoCanonical = null;
function getRepoCanonical() {
  if (!_repoCanonical) {
    try {
      _repoCanonical = require('./supabaseCanonicalRepository.cjs');
    } catch {
      _repoCanonical = null;
    }
  }
  return _repoCanonical;
}

let _portalAuthService = null;
function getPortalAuthService() {
  if (!_portalAuthService) {
    try {
      _portalAuthService = require('./portalAuthService.cjs');
    } catch {
      _portalAuthService = null;
    }
  }
  return _portalAuthService;
}

let _auditService = null;
function getAuditService() {
  if (!_auditService) {
    try {
      _auditService = require('../auditService.cjs').auditService || null;
    } catch {
      _auditService = null;
    }
  }
  return _auditService;
}

let _portalLifecycleService = null;
function getPortalLifecycleService() {
  if (!_portalLifecycleService) {
    try {
      _portalLifecycleService = require('./portalLifecycleService.cjs');
    } catch {
      _portalLifecycleService = null;
    }
  }
  return _portalLifecycleService;
}

// ─── Controlled lifecycle ──────────────────────────────────────────────────
const REGISTRATION_REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

// Statuses that block a duplicate active request for the same applicant.
const ACTIVE_STATUSES = Object.freeze([REGISTRATION_REQUEST_STATUS.PENDING]);

// Allowed transitions: pending → approved | rejected | cancelled. Terminal
// states are immutable. There is deliberately NO `duplicate` state: a
// duplicate is recorded as `rejected` + admin_notes identifying the
// original. There is deliberately NO `expired` state (no TTL requirement).
const ALLOWED_TRANSITIONS = Object.freeze({
  [REGISTRATION_REQUEST_STATUS.PENDING]: [
    REGISTRATION_REQUEST_STATUS.APPROVED,
    REGISTRATION_REQUEST_STATUS.REJECTED,
    REGISTRATION_REQUEST_STATUS.CANCELLED,
  ],
  [REGISTRATION_REQUEST_STATUS.APPROVED]: [],
  [REGISTRATION_REQUEST_STATUS.REJECTED]: [],
  [REGISTRATION_REQUEST_STATUS.CANCELLED]: [],
});

const REQUEST_NUMBER_PREFIX = 'CREG';
const PORTAL_EMAIL_DOMAIN = 'prime.mw';
const PORTAL_EMAIL_TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam', 'mx',
  'rev', 'hon', 'capt', 'col', 'gen', 'lord', 'lady', 'chief',
]);

// Keys that MUST never be persisted on a registration request. The legacy
// portal form collects a password; the request is an application, not an
// account, so credential material is stripped at the boundary and never
// stored, logged, or emitted.
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  'password',
  'password_hash',
  'passwordHash',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'portal_user',
  'portalUser',
  'customer_id',
  'customerId',
]);

function genId(prefix = 'creg') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  if (email === null || email === undefined) return null;
  const normalized = String(email).toLowerCase().trim().replace(/\s+/g, '');
  return normalized || null;
}

function normalizePhone(phone) {
  if (phone === null || phone === undefined || phone === '') return null;
  try {
    const svc = getReferralService();
    if (svc && typeof svc.normalizePhone === 'function') return svc.normalizePhone(phone);
  } catch { /* fall through to local normalization */ }
  return String(phone).replace(/\s+/g, '').replace(/^(\+?265|265|0)/, '').replace(/[^0-9]/g, '') || null;
}

function normalizeOrg(org) {
  if (org === null || org === undefined || org === '') return null;
  try {
    const svc = getReferralService();
    if (svc && typeof svc.normalizeOrg === 'function') return svc.normalizeOrg(org);
  } catch { /* fall through to local normalization */ }
  return String(org).toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '') || null;
}

function stripForbiddenKeys(input) {
  if (!input || typeof input !== 'object') return { clean: input, stripped: [] };
  const clean = { ...input };
  const stripped = [];
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (clean[key] !== undefined) {
      delete clean[key];
      stripped.push(key);
    }
  }
  // Never persist nested credential objects either.
  if (clean.data && typeof clean.data === 'object') {
    const nested = { ...clean.data };
    for (const key of FORBIDDEN_INPUT_KEYS) {
      if (nested[key] !== undefined) {
        delete nested[key];
        stripped.push(`data.${key}`);
      }
    }
    clean.data = nested;
  }
  return { clean, stripped };
}

function assertTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_TRANSITIONS[String(fromStatus || '')] || [];
  if (!allowed.includes(String(toStatus))) {
    throw new Error(`Invalid registration request transition: ${fromStatus} → ${toStatus}`);
  }
}

/**
 * Best-effort audit + ERP event emission. The core request write must NEVER
 * depend on audit/notification success. Safe metadata only — NEVER password,
 * hash, JWT, refresh token, or secret material.
 */
async function safeAudit(action, requestRow, actor = {}, context = {}) {
  const safeMetadata = {
    requestNumber: requestRow.request_number || requestRow.requestNumber || null,
    status: requestRow.status || null,
    companyName: requestRow.company_name || requestRow.companyName || null,
    referredByCode: requestRow.referred_by_code || requestRow.referredByCode || null,
    linkedCustomerId: requestRow.linked_customer_id || requestRow.linkedCustomerId || null,
  };
  try {
    const audit = getAuditService();
    if (audit && typeof audit.logEvent === 'function') {
      await audit.logEvent({
        userId: actor.id || 'anonymous',
        userRole: actor.role || 'anonymous',
        action,
        entityType: 'customer_registration_request',
        entityId: String(requestRow.id),
        details: `${action}: ${safeMetadata.requestNumber || requestRow.id}`,
        newValue: safeMetadata,
        ip: context.ip || null,
        userAgent: context.userAgent || null,
        httpMethod: context.method || null,
        httpPath: context.path || null,
        correlationId: context.correlationId || null,
      });
    }
  } catch (err) {
    console.warn('[CustomerRegistration] Audit skipped (best-effort):', err.message);
  }
  try {
    const lifecycle = getPortalLifecycleService();
    if (lifecycle && typeof lifecycle.publishErpEvent === 'function') {
      await lifecycle.publishErpEvent({
        customerId: null,
        docType: 'customer_registration_request',
        docId: String(requestRow.id),
        docNumber: safeMetadata.requestNumber,
        eventType: action.toLowerCase(),
        status: String(requestRow.status || ''),
        title: 'Customer registration request',
        body: `${safeMetadata.companyName || 'A new applicant'} submitted registration request ${safeMetadata.requestNumber || ''}.`.trim(),
        link: '#/registration-requests',
        notificationType: 'registration',
        actor: { type: actor.type || 'anonymous', id: actor.id || null, name: actor.name || 'Portal applicant' },
        metadata: safeMetadata,
      });
    }
  } catch (err) {
    console.warn('[CustomerRegistration] Event publish skipped (best-effort):', err.message);
  }
}

/**
 * Resolve a referral code server-side. Returns { code, referrerId,
 * referrerName } or null when no code was supplied. Throws 400-style Error
 * when a supplied code is invalid. NEVER finalizes referral attribution —
 * that happens at approval with the official CUST-XXXX id (next phase).
 */
async function resolveReferral(referredByCode) {
  if (!referredByCode || String(referredByCode).trim() === '') return null;
  const code = String(referredByCode).trim().toUpperCase();
  let rows = [];
  try {
    rows = await repo.getAll('customer_referrals');
  } catch {
    rows = [];
  }
  const match = (rows || []).find(
    (r) => String(r.referral_code ?? r.referralCode ?? '').trim().toUpperCase() === code
  );
  if (!match) {
    const err = new Error('Invalid referral code');
    err.code = 'INVALID_REFERRAL_CODE';
    throw err;
  }
  const referrerId = match.referred_by_id ?? match.referredById ?? null;
  let referrerName = match.referred_by_name ?? match.referredByName ?? null;
  if (referrerId) {
    try {
      const customer = await repo.getById('customers', String(referrerId));
      if (customer) referrerName = customer.name || referrerName || 'Referrer';
    } catch { /* best-effort */ }
  }
  return { code, referrerId: referrerId ? String(referrerId) : null, referrerName: referrerName || 'Referrer' };
}

async function findPendingByEmail(normalizedEmail) {
  if (!normalizedEmail) return null;
  let rows = [];
  try {
    rows = await repo.getAll('customer_registration_requests');
  } catch {
    return null;
  }
  return (rows || []).find(
    (r) =>
      String(r.status || '') === REGISTRATION_REQUEST_STATUS.PENDING &&
      normalizeEmail(r.email) === normalizedEmail
  ) || null;
}

async function findPendingByPhone(normalizedPhone) {
  if (!normalizedPhone) return null;
  let rows = [];
  try {
    rows = await repo.getAll('customer_registration_requests');
  } catch {
    return null;
  }
  return (rows || []).find(
    (r) =>
      String(r.status || '') === REGISTRATION_REQUEST_STATUS.PENDING &&
      r.phone !== null &&
      r.phone !== undefined &&
      r.phone !== '' &&
      normalizePhone(r.phone) === normalizedPhone
  ) || null;
}

async function findOfficialCustomer({ normalizedEmail, normalizedPhone, normalizedCompany }) {
  let customers = [];
  try {
    customers = await repo.getAll('customers');
  } catch {
    return null;
  }
  for (const c of customers || []) {
    if (normalizedEmail && normalizeEmail(c.email) === normalizedEmail) return c;
    if (normalizedPhone && c.phone && normalizePhone(c.phone) === normalizedPhone) return c;
  }
  if (normalizedCompany && normalizedCompany.length >= 3) {
    for (const c of customers || []) {
      const candidate = normalizeOrg(c.name || c.company_name || c.companyName || '');
      if (candidate && (candidate.includes(normalizedCompany) || normalizedCompany.includes(candidate))) {
        return c;
      }
    }
  }
  return null;
}

/**
 * Create a registration request (application, NOT an account).
 *
 * MUST ONLY write a single `customer_registration_requests` row. MUST NOT
 * create/update customers, portal_users, password hashes, JWTs, sessions,
 * ledger/inventory/sales/AR records.
 */
async function createRegistrationRequest(input = {}, options = {}) {
  const { clean: body, stripped } = stripForbiddenKeys(input);
  if (stripped.length > 0) {
    console.warn('[CustomerRegistration] Stripped forbidden credential keys from submission:', stripped.join(','));
  }

  const companyName = body.companyName ?? body.company_name ?? '';
  const contactName = body.contactName ?? body.contact_name ?? '';
  const email = body.email ?? '';
  const phone = body.phone ?? null;
  const tier = body.tier ?? null;
  const note = body.note ?? null;
  const referredByCodeInput = body.referredByCode ?? body.referred_by_code ?? null;

  if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
    throw new Error('Company name must be at least 2 characters');
  }
  if (!contactName || typeof contactName !== 'string' || contactName.trim().length < 2) {
    throw new Error('Contact name must be at least 2 characters');
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('A valid email is required');
  }
  const normalizedPhone = phone === null || phone === undefined || phone === '' ? null : normalizePhone(phone);
  const normalizedCompany = normalizeOrg(companyName);
  const idempotencyKey =
    options.idempotencyKey || body.idempotencyKey || body.idempotency_key || null;

  // Referral code: validate server-side, retain normalized form + resolved
  // identity. Attribution is NOT finalized here.
  const referral = await resolveReferral(referredByCodeInput);

  // Fraud signals via the existing referral mechanism (high-severity =
  // applicant already exists as an official customer).
  try {
    const svc = getReferralService();
    if (svc && typeof svc.checkFraudSignals === 'function') {
      const signals = await svc.checkFraudSignals({
        customerId: null,
        email: normalizedEmail,
        phone: phone || null,
        organisation: companyName.trim(),
        referredById: referral ? referral.referrerId : null,
      });
      const high = (signals || []).filter((s) => s.severity === 'high');
      if (high.length > 0) {
        const err = new Error('An account with these details already exists');
        err.code = 'DUPLICATE_CUSTOMER';
        err.signals = high;
        throw err;
      }
    }
  } catch (err) {
    if (err && (err.code === 'DUPLICATE_CUSTOMER')) throw err;
    console.warn('[CustomerRegistration] Fraud check skipped (best-effort):', err.message);
  }

  // Idempotency: same key → same request, never a second row.
  if (idempotencyKey) {
    let rows = [];
    try {
      rows = await repo.getAll('customer_registration_requests');
    } catch {
      rows = [];
    }
    const prior = (rows || []).find(
      (r) => String(r.idempotency_key ?? r.idempotencyKey ?? '') === String(idempotencyKey)
    );
    if (prior) return prior;
  }

  // Duplicate protection: one PENDING request per applicant (email primary,
  // phone secondary — mirrors payment ACTIVE_STATUSES per invoice).
  const dupEmail = await findPendingByEmail(normalizedEmail);
  if (dupEmail) {
    const err = new Error(
      `A pending registration request already exists for this email (${dupEmail.request_number || dupEmail.requestNumber || dupEmail.id})`
    );
    err.code = 'DUPLICATE_PENDING_REQUEST';
    err.existingRequest = dupEmail;
    throw err;
  }
  if (normalizedPhone) {
    const dupPhone = await findPendingByPhone(normalizedPhone);
    if (dupPhone) {
      const err = new Error(
        `A pending registration request already exists for this phone number (${dupPhone.request_number || dupPhone.requestNumber || dupPhone.id})`
      );
      err.code = 'DUPLICATE_PENDING_REQUEST';
      err.existingRequest = dupPhone;
      throw err;
    }
  }

  // An official customer with these details should be rejected, not queued.
  const official = await findOfficialCustomer({ normalizedEmail, normalizedPhone, normalizedCompany });
  if (official && (normalizeEmail(official.email) === normalizedEmail || (normalizedPhone && official.phone && normalizePhone(official.phone) === normalizedPhone))) {
    const err = new Error('An account with these details already exists');
    err.code = 'DUPLICATE_CUSTOMER';
    err.matchedCustomerId = official.id;
    throw err;
  }

  const id = genId('creg');
  const requestNumber = await workflowEngine.nextYearScopedNumber(
    'customer_registration_requests',
    'request_number',
    REQUEST_NUMBER_PREFIX
  );
  const record = {
    id,
    request_number: requestNumber,
    company_name: companyName.trim(),
    contact_name: contactName.trim(),
    email: normalizedEmail,
    phone: phone === null || phone === undefined || phone === '' ? null : String(phone).trim(),
    tier: tier || null,
    referred_by_code: referral ? referral.code : null,
    referred_by_id: referral ? referral.referrerId : null,
    referred_by_name: referral ? referral.referrerName : null,
    status: REGISTRATION_REQUEST_STATUS.PENDING,
    note: note || null,
    submitted_at: nowIso(),
    created_by: options.createdBy || null,
    assigned_to: null,
    assigned_at: null,
    reviewed_by: null,
    reviewed_at: null,
    admin_notes: null,
    linked_customer_id: null,
    idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
    deleted_at: null,
  };

  // EXACTLY ONE write, to the request table only. This call must never touch
  // `customers`, `portal_users`, sessions, or accounting tables.
  await repo.upsert('customer_registration_requests', record);

  await safeAudit('REGISTRATION_REQUEST_CREATED', record, options.actor || {}, options.context || {});

  return record;
}

/**
 * Fetch a request by envelope id. No ownership enforcement here — callers
 * (public status endpoint vs admin) apply their own scoping.
 */
async function getRequestById(id) {
  if (!id) return null;
  return repo.getById('customer_registration_requests', String(id));
}

async function getRequestByNumber(requestNumber) {
  if (!requestNumber) return null;
  const target = String(requestNumber).trim().toUpperCase();
  let rows = [];
  try {
    rows = await repo.getAll('customer_registration_requests');
  } catch {
    return null;
  }
  return (rows || []).find(
    (r) => String(r.request_number ?? r.requestNumber ?? '').trim().toUpperCase() === target
  ) || null;
}

/**
 * Admin list — all requests with optional filters. Route layer enforces
 * admin authorization; this returns full rows for the future review inbox.
 */
async function listRequests({ status, search, referredByCode, dateFrom, dateTo } = {}) {
  let rows = [];
  try {
    rows = await repo.getAll('customer_registration_requests');
  } catch {
    return [];
  }
  let filtered = (rows || []).filter((r) => !r.deleted_at && !r.deletedAt);
  if (status) {
    filtered = filtered.filter((r) => String(r.status || '') === String(status));
  }
  if (referredByCode) {
    const code = String(referredByCode).trim().toUpperCase();
    filtered = filtered.filter(
      (r) => String(r.referred_by_code ?? r.referredByCode ?? '').trim().toUpperCase() === code
    );
  }
  if (dateFrom) {
    filtered = filtered.filter((r) => String(r.submitted_at || r.created_at || '') >= String(dateFrom));
  }
  if (dateTo) {
    filtered = filtered.filter((r) => String(r.submitted_at || r.created_at || '') <= String(dateTo));
  }
  if (search) {
    const q = String(search).toLowerCase();
    filtered = filtered.filter((r) =>
      String(r.company_name ?? r.companyName ?? '').toLowerCase().includes(q) ||
      String(r.contact_name ?? r.contactName ?? '').toLowerCase().includes(q) ||
      String(r.email ?? '').toLowerCase().includes(q) ||
      String(r.request_number ?? r.requestNumber ?? '').toLowerCase().includes(q)
    );
  }
  filtered.sort((a, b) =>
    String(b.submitted_at || b.created_at || '').localeCompare(String(a.submitted_at || a.created_at || ''))
  );
  return filtered;
}

/**
 * Atomic terminal transition helper. Re-reads the row, validates the
 * transition, and treats a missing/changed row as a race conflict — the
 * equivalent of UPDATE ... WHERE id=? AND status='pending' with zero
 * affected rows.
 */
async function transitionRequest(id, toStatus, { reviewedBy = null, adminNotes, actor = {}, context = {} } = {}) {
  if (!id) throw new Error('Registration request id is required');
  if (!toStatus) throw new Error('status is required');
  const request = await getRequestById(String(id));
  if (!request) throw new Error('Registration request not found');
  if (request.deleted_at || request.deletedAt) throw new Error('Registration request not found');
  assertTransition(request.status, toStatus);
  // Race guard: re-read inside the write path would be ideal; the envelope
  // store has no conditional-write primitive, so a second fetch immediately
  // before upsert narrows the window and any concurrent winner is detected
  // by the status no longer being pending.
  const fresh = await getRequestById(String(id));
  if (!fresh) throw new Error('Registration request not found');
  assertTransition(fresh.status, toStatus);

  const updates = {
    ...fresh,
    status: String(toStatus),
    reviewed_by: reviewedBy || null,
    reviewed_at: nowIso(),
  };
  if (adminNotes !== undefined) updates.admin_notes = adminNotes === null ? null : String(adminNotes);

  await repo.upsert('customer_registration_requests', updates);

  const action =
    toStatus === REGISTRATION_REQUEST_STATUS.APPROVED
      ? 'REGISTRATION_REQUEST_APPROVED'
      : toStatus === REGISTRATION_REQUEST_STATUS.REJECTED
        ? 'REGISTRATION_REQUEST_REJECTED'
        : toStatus === REGISTRATION_REQUEST_STATUS.CANCELLED
          ? 'REGISTRATION_REQUEST_CANCELLED'
          : 'REGISTRATION_REQUEST_STATUS_CHANGED';
  await safeAudit(action, updates, actor, context);

  return updates;
}

async function rejectRequest(id, opts = {}) {
  if (!opts || opts.adminNotes === undefined || String(opts.adminNotes || '').trim() === '') {
    throw new Error('admin_notes is required to reject a registration request');
  }
  return transitionRequest(id, REGISTRATION_REQUEST_STATUS.REJECTED, opts);
}

async function cancelRequest(id, opts = {}) {
  return transitionRequest(id, REGISTRATION_REQUEST_STATUS.CANCELLED, opts);
}

/**
 * Public DTO — creation response and anonymous status lookup. Contains NO
 * PII beyond the request number, NO customer_id, NO tokens, NO password
 * material.
 */
function toPublicDto(row) {
  if (!row) return null;
  return {
    requestNumber: row.request_number || row.requestNumber || null,
    status: row.status || REGISTRATION_REQUEST_STATUS.PENDING,
    submittedAt: row.submitted_at || row.submittedAt || row.created_at || null,
  };
}

/**
 * Admin DTO — full row for the review inbox. Still NEVER includes password
 * or token material (none is ever stored).
 */
function toAdminDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestNumber: row.request_number ?? row.requestNumber ?? null,
    companyName: row.company_name ?? row.companyName ?? null,
    contactName: row.contact_name ?? row.contactName ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    tier: row.tier ?? null,
    referredByCode: row.referred_by_code ?? row.referredByCode ?? null,
    referredById: row.referred_by_id ?? row.referredById ?? null,
    referredByName: row.referred_by_name ?? row.referredByName ?? null,
    status: row.status ?? null,
    note: row.note ?? null,
    submittedAt: row.submitted_at ?? row.submittedAt ?? row.created_at ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
    assignedTo: row.assigned_to ?? row.assignedTo ?? null,
    reviewedBy: row.reviewed_by ?? row.reviewedBy ?? null,
    reviewedAt: row.reviewed_at ?? row.reviewedAt ?? null,
    adminNotes: row.admin_notes ?? row.adminNotes ?? null,
    linkedCustomerId: row.linked_customer_id ?? row.linkedCustomerId ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Derive a stable portal login email for a customer. Mirrors the
 * portalAdmin.derivePortalEmail algorithm: first non-title word of
 * the company name @ prime.mw, with digit-tail and incrementing
 * suffix disambiguation.
 */
async function derivePortalEmail(name, customerId) {
  const portalAuth = getPortalAuthService();
  const safe = String(name || '').toLowerCase().trim();
  const words = safe.split(/[^a-z0-9]+/).filter((w) => w && !PORTAL_EMAIL_TITLE_WORDS.has(w));
  const digitTail = String(customerId || '').replace(/\D/g, '').slice(-3);
  let base;
  if (words.length === 0) {
    base = `customer-${String(customerId || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  } else {
    base = words[0];
  }
  let attempt = 0;
  for (;;) {
    let local;
    if (attempt === 0) {
      local = base;
    } else if (attempt === 1 && digitTail) {
      local = `${base}${digitTail}`;
    } else {
      const n = attempt + (digitTail ? 0 : 1);
      local = `${base}${digitTail}${n}`;
    }
    const candidate = `${local}@${PORTAL_EMAIL_DOMAIN}`;
    if (portalAuth && typeof portalAuth.getPortalUserByEmail === 'function') {
      const existing = await portalAuth.getPortalUserByEmail(candidate);
      if (!existing) return candidate;
    } else {
      return candidate;
    }
    attempt += 1;
  }
}

/**
 * Generate the next CUST-XXXX customer number by scanning existing
 * customers and finding max(N)+1.
 */
async function generateCustomerNumber() {
  const repoCanonical = getRepoCanonical();
  let customers = [];
  try {
    if (repoCanonical && typeof repoCanonical.getAll === 'function') {
      customers = await repoCanonical.getAll('customers');
    }
  } catch {
    customers = [];
  }
  let maxNum = 0;
  for (const c of customers || []) {
    const id = String(c.id || '');
    const match = id.match(/^CUST-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `CUST-${String(maxNum + 1).padStart(4, '0')}`;
}

/**
 * Approve a pending registration request. Transitions PENDING →
 * APPROVED, creates an official CUST-XXXX customer, creates a
 * portal user (status: invited), generates an invite code,
 * finalizes referral attribution, and records audit events.
 *
 * Compensation: if portal user creation fails after customer
 * creation, the customer is soft-deleted and the error is re-thrown.
 *
 * Returns { request, customerId, portalUserId, inviteCode } or
 * { request, alreadyApproved: true } on idempotent retry.
 */
async function approveRequest(id, { reviewedBy, adminNotes, idempotencyKey, context = {} } = {}) {
  if (!id) throw new Error('Registration request id is required');

  const request = await getRequestById(String(id));
  if (!request) throw new Error('Registration request not found');
  if (request.deleted_at || request.deletedAt) throw new Error('Registration request not found');

  // Idempotency: already approved → return existing result
  if (request.status === REGISTRATION_REQUEST_STATUS.APPROVED) {
    return {
      request: toAdminDto(request),
      alreadyApproved: true,
      linkedCustomerId: request.linked_customer_id || null,
    };
  }

  assertTransition(request.status, REGISTRATION_REQUEST_STATUS.APPROVED);

  // Transition status to APPROVED
  const approved = await transitionRequest(id, REGISTRATION_REQUEST_STATUS.APPROVED, {
    reviewedBy: reviewedBy || request.reviewedBy || null,
    adminNotes: adminNotes !== undefined ? adminNotes : request.admin_notes,
    actor: { type: 'admin', id: reviewedBy || 'system', name: 'ERP Admin', role: 'Admin' },
    context,
  });

  let customerId = null;
  let portalUserId = null;
  let inviteCode = null;

  try {
    // Generate CUST-XXXX customer number
    const customerNumber = await generateCustomerNumber();

    // Create official customer in canonical store
    const repoCanonical = getRepoCanonical();
    if (repoCanonical && typeof repoCanonical.upsert === 'function') {
      await repoCanonical.upsert('customers', {
        id: customerNumber,
        name: request.company_name,
        email: request.email,
        phone: request.phone || null,
        business_name: request.company_name,
        contact_name: request.contact_name,
        tier: request.tier || null,
        status: 'active',
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      customerId = customerNumber;
    }

    // Derive portal email and create portal user (invited status)
    const portalEmail = await derivePortalEmail(request.company_name, customerId);
    const portalAuth = getPortalAuthService();
    const password = crypto.randomBytes(9).toString('base64url');
    const portalUser = await portalAuth.registerPortalUser({
      customer_id: customerId,
      email: portalEmail,
      password: password,
      full_name: request.contact_name || request.company_name,
      phone: request.phone || null,
      status: 'invited',
    });
    portalUserId = portalUser.id;

    // Create invite code
    const invite = await portalAuth.createInviteCode(portalUserId);
    inviteCode = invite.code;

    // Finalize referral if applicable
    if (request.referred_by_id) {
      try {
        const svc = getReferralService();
        if (svc && typeof svc.getAll === 'function' && typeof svc.register === 'function') {
          const existingReferrals = await svc.getAll({ customer_id: customerId });
          const hasReferral = existingReferrals && existingReferrals.referrals && existingReferrals.referrals.length > 0;
          if (!hasReferral) {
            await svc.register({
              customer_id: customerId,
              referred_by_id: request.referred_by_id,
              referred_by_name: request.referred_by_name || null,
              notes: `Approved via registration request ${request.request_number || request.id}`,
            });
          }
        }
      } catch (err) {
        console.warn('[CustomerRegistration] Referral finalization skipped:', err.message);
      }
    }

    // Update request with linked customer id
    const updated = await repo.upsert('customer_registration_requests', {
      ...approved,
      linked_customer_id: customerId,
      updated_at: nowIso(),
    });

    await safeAudit('REGISTRATION_REQUEST_APPROVED', updated,
      { type: 'admin', id: reviewedBy || 'system', name: 'ERP Admin', role: 'Admin' },
      context);

    return {
      request: toAdminDto(updated),
      customerId,
      portalUserId,
      inviteCode,
    };

  } catch (err) {
    // Compensation: if customer was created but portal user failed, soft-delete customer
    if (customerId) {
      try {
        const repoCanonical = getRepoCanonical();
        if (repoCanonical && typeof repoCanonical.softDelete === 'function') {
          await repoCanonical.softDelete('customers', customerId);
        }
      } catch (compErr) {
        console.error('[CustomerRegistration] Compensation soft-delete failed:', compErr.message);
      }
    }
    throw err;
  }
}

module.exports = {
  REGISTRATION_REQUEST_STATUS,
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  REQUEST_NUMBER_PREFIX,
  PORTAL_EMAIL_DOMAIN,
  normalizeEmail,
  normalizePhone,
  normalizeOrg,
  createRegistrationRequest,
  getRequestById,
  getRequestByNumber,
  listRequests,
  transitionRequest,
  rejectRequest,
  cancelRequest,
  approveRequest,
  toPublicDto,
  toAdminDto,
};
