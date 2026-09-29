/**
 * supabasePortalIdentity.cjs — PHASE 1 + PHASE 2 (SHADOW-ONLY, staging-safe).
 *
 * Isolated Supabase Auth identity helpers for the Portal → Supabase Auth
 * migration. This module is deliberately disconnected from:
 *   - ERP staff JWT verification (backend/middleware/auth.cjs)
 *   - legacy Portal JWT verification (backend/middleware/portalAuth.cjs)
 *
 * Identity direction (NEVER reversed):
 *   Supabase sub (auth.users.id, UUID)
 *     → portal_users.auth_user_id (UUID, nullable, unique)
 *     → portal_users.id (TEXT Portal-user/application identity)
 *     → portal_users.customer_id (TEXT ERP customer/business identity)
 *     → customers.id (TEXT business primary key, e.g. CUST-XXXX)
 *
 * The Supabase `sub` is an authentication identity. It is NEVER a customer
 * ID and MUST NEVER be used, joined, or substituted as one.
 *
 * Single-company ERP: no tenant_id / organization_id / company_id /
 * tenant claims anywhere in this module.
 *
 * SHADOW-ONLY: nothing here grants or denies business authorization. The
 * Express middleware below only observes and logs safe diagnostics, and it
 * is mounted ONLY when PORTAL_SUPABASE_SHADOW === 'true' (default OFF).
 * Legacy authentication remains authoritative in all cases.
 *
 * NEVER logged by this module: passwords, password hashes, refresh tokens,
 * access tokens, Supabase JWTs, TOTP secrets, reset/invite codes, full
 * Authorization headers.
 */

const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// ─── Shadow flag (default OFF) ─────────────────────────────────────────────

const SHADOW_FLAG_NAME = 'PORTAL_SUPABASE_SHADOW';

function isShadowEnabled() {
  return String(process.env[SHADOW_FLAG_NAME] || '').trim().toLowerCase() === 'true';
}

// ─── UUID shape ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

// ─── Supabase JWT configuration (isolated from JWT_SECRET) ─────────────────
//
// The legacy portal/ERP verifiers use `JWT_SECRET` with no issuer/audience.
// The Supabase verifier MUST NOT reuse that model: Supabase Auth signs with
// asymmetric keys published at the project's JWKS endpoint, so signature
// trust comes from JWKS public keys (selected by `kid`) AND pinned expected
// issuer + audience. There is deliberately NO symmetric-secret option —
// HS256 must never verify a Supabase token, and `JWT_SECRET` must never be
// used for Supabase verification.

function getSupabaseJwtConfig() {
  const baseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  // Explicit JWKS URL wins; otherwise derive the standard GoTrue path.
  const jwksUrl = String(process.env.SUPABASE_JWKS_URL || '').trim()
    || (baseUrl ? `${baseUrl}/auth/v1/.well-known/jwks.json` : '');
  // GoTrue issues JWTs with iss = <project-url>/auth/v1 and aud =
  // "authenticated" unless overridden. Both are explicit env overrides.
  const issuer = process.env.SUPABASE_JWT_ISSUER || (baseUrl ? `${baseUrl}/auth/v1` : '');
  const audience = process.env.SUPABASE_JWT_AUDIENCE || 'authenticated';
  const configured = Boolean(baseUrl && jwksUrl && issuer && audience && !baseUrl.includes('placeholder'));
  return { baseUrl, jwksUrl, issuer, audience, configured };
}

// ─── JWKS key provider (small, contained, rotation-aware) ──────────────────
//
// Fetch via axios, cache within a TTL, select by `kid`. Only asymmetric
// signing material (RSA/EC, `sig` use) is imported — symmetric (`oct`) and
// non-signing keys are refused at import so an HMAC algorithm can never be
// verified against JWKS material. Private keys are never handled, logged,
// or stored: only public KeyObjects live in the cache.

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 8000;

// kid -> { key: KeyObject, kty }
let jwksKeyCache = new Map();
let jwksCacheFetchedAt = 0;
let jwksCacheUrl = '';

function clearJwksCache() {
  jwksKeyCache = new Map();
  jwksCacheFetchedAt = 0;
  jwksCacheUrl = '';
}

function importJwksKey(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (!jwk.kid || typeof jwk.kid !== 'string') return null;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return { key, kty: jwk.kty };
  } catch {
    return null;
  }
}

async function defaultFetchJwks(url) {
  const res = await axios.get(url, { timeout: JWKS_FETCH_TIMEOUT_MS });
  return res && res.data;
}

async function loadJwksKeys(jwksUrl, fetchJwks) {
  const doc = await (typeof fetchJwks === 'function' ? fetchJwks(jwksUrl) : defaultFetchJwks(jwksUrl));
  const arr = doc && Array.isArray(doc.keys) ? doc.keys : null;
  if (!arr) {
    const err = new Error('JWKS document has no keys array');
    err.code = 'JWKS_UNAVAILABLE';
    throw err;
  }
  const map = new Map();
  for (const jwk of arr) {
    const imported = importJwksKey(jwk);
    if (imported) map.set(String(jwk.kid), imported);
  }
  return map;
}

async function getJwksKey(kid, options = {}) {
  const cfg = getSupabaseJwtConfig();
  if (!cfg.configured) return { key: null, reason: 'NOT_CONFIGURED' };
  const now = Date.now();
  const fresh = jwksCacheUrl === cfg.jwksUrl && jwksCacheFetchedAt > 0 && (now - jwksCacheFetchedAt) < JWKS_CACHE_TTL_MS;
  if (!fresh) {
    try {
      jwksKeyCache = await loadJwksKeys(cfg.jwksUrl, options.fetchJwks);
      jwksCacheFetchedAt = now;
      jwksCacheUrl = cfg.jwksUrl;
    } catch (err) {
      return { key: null, reason: 'JWKS_UNAVAILABLE' };
    }
  }
  let entry = (kid && typeof kid === 'string') ? jwksKeyCache.get(kid) : null;
  if (!entry) {
    // Bounded rotation handling: exactly ONE refresh, then fail closed.
    // A second consecutive fetch is never issued for the same request, so
    // an unknown `kid` can neither spin a fetch loop nor be talked into
    // existence.
    try {
      jwksKeyCache = await loadJwksKeys(cfg.jwksUrl, options.fetchJwks);
      jwksCacheFetchedAt = Date.now();
      jwksCacheUrl = cfg.jwksUrl;
    } catch (err) {
      return { key: null, reason: 'JWKS_UNAVAILABLE' };
    }
    entry = (kid && typeof kid === 'string') ? jwksKeyCache.get(kid) : null;
    if (!entry) return { key: null, reason: 'UNKNOWN_KID' };
  }
  return { key: entry, reason: null };
}

// Asymmetric algorithms the verifier will ever accept. This is the full
// GoTrue signing surface (RS256/ES256); everything else — all HMAC
// variants, `none`, and exotic asymmetric suites — is rejected outright.
const ASYMMETRIC_ALLOWLIST = new Set(['RS256', 'ES256']);

// ─── verifySupabasePortalToken (fail-closed, never throws on bad input) ────

async function verifySupabasePortalToken(token, options = {}) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'MISSING_TOKEN' };
  }
  const cfg = getSupabaseJwtConfig();
  if (!cfg.configured) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }
  let header;
  try {
    const decoded = jwt.decode(token, { complete: true });
    header = decoded && decoded.header;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!header || typeof header !== 'object') {
    return { ok: false, reason: 'MALFORMED' };
  }
  const alg = header.alg;
  // Explicit HMAC/`none` rejection BEFORE key selection: a symmetric or
  // unsigned token must never reach verification against JWKS public
  // material, regardless of what `kid` it carries.
  if (typeof alg !== 'string' || alg.toLowerCase() === 'none' || /^hs(256|384|512)$/i.test(alg)) {
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
  }
  if (!ASYMMETRIC_ALLOWLIST.has(alg)) {
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
  }
  const resolved = await getJwksKey(header.kid, options);
  if (!resolved.key) {
    return { ok: false, reason: resolved.reason };
  }
  // Key-type must match the token algorithm family (RSA<->RS*, EC<->ES*),
  // so a key can never be cross-purposed across cryptosystems.
  const ktyOk = (resolved.key.kty === 'RSA' && alg.startsWith('RS'))
    || (resolved.key.kty === 'EC' && alg.startsWith('ES'));
  if (!ktyOk) {
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
  }
  let decoded;
  try {
    decoded = jwt.verify(token, resolved.key.key, {
      algorithms: [alg],
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
  } catch (err) {
    const name = err && err.name;
    const message = String((err && err.message) || '');
    if (name === 'TokenExpiredError') return { ok: false, reason: 'EXPIRED' };
    if (/issuer/i.test(message)) return { ok: false, reason: 'WRONG_ISSUER' };
    if (/audience/i.test(message)) return { ok: false, reason: 'WRONG_AUDIENCE' };
    if (/invalid signature/i.test(message)) return { ok: false, reason: 'INVALID_SIGNATURE' };
    if (/malformed/i.test(message)) return { ok: false, reason: 'MALFORMED' };
    return { ok: false, reason: 'INVALID' };
  }
  const sub = decoded && decoded.sub;
  if (!sub || typeof sub !== 'string' || sub.trim() === '') {
    return { ok: false, reason: 'MISSING_SUB' };
  }
  if (!isUuidShape(sub)) {
    return { ok: false, reason: 'MALFORMED_SUB' };
  }
  return { ok: true, sub: sub.trim(), iss: decoded.iss, aud: decoded.aud, exp: decoded.exp };
}

// ─── resolvePortalIdentity(sub) ────────────────────────────────────────────
//
// Server-side resolver implementing exactly:
//   Supabase sub → portal_users.auth_user_id → ACTIVE row → customer_id.
//
// Returns { user, reason }. `user` is the existing Portal-user identity plus
// the existing customer_id — never secrets, never the auth mapping itself.
// No active mapped row ⇒ no Portal authorization (user === null).

function getRepo(override) {
  if (override) return override;
  return require('./supabaseRepository.cjs');
}

async function resolvePortalIdentity(sub, options = {}) {
  if (!sub || typeof sub !== 'string' || sub.trim() === '') {
    return { user: null, reason: 'MISSING_SUB' };
  }
  const normalized = sub.trim();
  if (!isUuidShape(normalized)) {
    return { user: null, reason: 'MALFORMED_SUB' };
  }
  let row = null;
  try {
    const repo = getRepo(options.repo);
    if (!repo || !repo.portalEntities || !repo.portalEntities.portal_users
      || typeof repo.portalEntities.portal_users.getByAuthUserId !== 'function') {
      return { user: null, reason: 'NOT_CONFIGURED' };
    }
    row = await repo.portalEntities.portal_users.getByAuthUserId(normalized);
  } catch (err) {
    return { user: null, reason: 'LOOKUP_FAILED' };
  }
  if (!row) {
    return { user: null, reason: 'UNMAPPED' };
  }
  if (row.status !== 'active') {
    return { user: null, reason: 'NOT_ACTIVE', status: row.status || null };
  }
  // customer_id comes ONLY from the mapped portal_users row. The `sub`
  // above is never assigned to, compared with, or substituted for it.
  return {
    user: {
      id: row.id,
      customer_id: row.customer_id,
      email: row.email,
      full_name: row.full_name ?? null,
      phone: row.phone ?? null,
      status: row.status,
    },
    reason: null,
  };
}

// ─── GET /me contract (allow-list; secrets never leave the server) ─────────
//
// Approved public shape: identity + profile + business scope + derived
// flags. During this shadow-only phase Supabase cannot yet source
// email_confirmed / mfa_enrolled, so they are derived conservatively from
// the existing state machine and documented as such:
//   email_confirmed — legacy-derived: status 'active' means the invitation/
//     activation completed. WILL become Supabase email_confirmed_at-derived.
//   mfa_enrolled — legacy-derived: two_factor_enabled && two_factor_confirmed.
//     WILL become Supabase AAL-derived. Raw two_factor_* flags are NEVER
//     exposed (neither is password_hash, auth_user_id, data, version, or
//     any reset/session material).

function toPortalMeContract(user) {
  if (!user) return null;
  return {
    id: user.id,
    customer_id: user.customer_id,
    email: user.email,
    full_name: user.full_name ?? null,
    phone: user.phone ?? null,
    status: user.status,
    email_confirmed: user.status === 'active',
    mfa_enrolled: user.two_factor_enabled === true && user.two_factor_confirmed === true,
    last_login_at: user.last_login_at ?? null,
  };
}

// ─── Read-only mapping / coverage report ───────────────────────────────────
//
// Inspects the portal_users population WITHOUT modifying data. Reports
// status × mapping counts plus every anomaly class relevant to the N:1
// model. Only portal-user ids / customer ids / emails needed for
// operational triage are included — never hashes, secrets, or tokens.

async function getPortalAuthMappingReport(options = {}) {
  const repo = getRepo(options.repo);
  const rows = await repo.portalEntities.portal_users.getAll({});
  const list = Array.isArray(rows) ? rows : [];

  const counts = {
    total: list.length,
    activeMapped: 0,
    activeUnmapped: 0,
    invitedMapped: 0,
    invitedUnmapped: 0,
    disabledMapped: 0,
    disabledUnmapped: 0,
    otherStatus: 0,
  };

  const emailGroups = new Map();
  const customerGroups = new Map();
  const authUserGroups = new Map();
  const malformedAuthUserIds = [];
  const legacyActiveUnmappedIds = [];

  for (const row of list) {
    const status = String(row.status || '');
    const mapped = row.auth_user_id !== null && row.auth_user_id !== undefined && String(row.auth_user_id).trim() !== '';
    if (status === 'active') {
      if (mapped) counts.activeMapped += 1;
      else { counts.activeUnmapped += 1; legacyActiveUnmappedIds.push(row.id); }
    } else if (status === 'invited') {
      if (mapped) counts.invitedMapped += 1;
      else counts.invitedUnmapped += 1;
    } else if (status === 'disabled') {
      if (mapped) counts.disabledMapped += 1;
      else counts.disabledUnmapped += 1;
    } else {
      counts.otherStatus += 1;
    }

    const emailKey = String(row.email || '').toLowerCase().trim();
    if (emailKey) {
      if (!emailGroups.has(emailKey)) emailGroups.set(emailKey, []);
      emailGroups.get(emailKey).push(row.id);
    }
    const customerKey = row.customer_id === null || row.customer_id === undefined ? '' : String(row.customer_id);
    if (!customerGroups.has(customerKey)) customerGroups.set(customerKey, []);
    customerGroups.get(customerKey).push(row.id);

    if (mapped) {
      const raw = String(row.auth_user_id).trim();
      if (!isUuidShape(raw)) {
        malformedAuthUserIds.push({ id: row.id, value: raw });
      } else {
        const key = raw.toLowerCase();
        if (!authUserGroups.has(key)) authUserGroups.set(key, []);
        authUserGroups.get(key).push(row.id);
      }
    }
  }

  const duplicateEmails = [...emailGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([email, ids]) => ({ email, portal_user_ids: ids }));
  const multiUserCustomers = [...customerGroups.entries()]
    .filter(([customerId, ids]) => customerId !== '' && ids.length > 1)
    .map(([customerId, ids]) => ({ customer_id: customerId, portal_user_ids: ids }));
  const missingCustomerId = (customerGroups.get('') || []).slice();
  const duplicateAuthUserIds = [...authUserGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([authUserId, ids]) => ({ auth_user_id: authUserId, portal_user_ids: ids }));

  return {
    generated_at: new Date().toISOString(),
    counts,
    duplicateEmails,
    multiUserCustomers,
    missingCustomerId,
    duplicateAuthUserIds,
    malformedAuthUserIds,
    legacyActiveUnmappedIds,
  };
}

// ─── Shadow evaluation (observe + log only; never authorizes) ──────────────

function extractBearerToken(req) {
  try {
    const header = req && req.headers && req.headers.authorization;
    if (!header || typeof header !== 'string') return null;
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return null;
    return parts[1];
  } catch {
    return null;
  }
}

function compareShadowIdentity(legacyPortalUser, shadowResult) {
  if (!legacyPortalUser && !shadowResult.user) return { agreement: 'BOTH_ABSENT', mismatchCategory: null };
  if (!legacyPortalUser && shadowResult.user) return { agreement: 'SHADOW_ONLY', mismatchCategory: 'no-legacy-identity' };
  if (legacyPortalUser && !shadowResult.user) {
    return { agreement: 'LEGACY_ONLY', mismatchCategory: `shadow-${String(shadowResult.reason || 'unknown').toLowerCase()}` };
  }
  if (String(legacyPortalUser.id) !== String(shadowResult.user.id)) {
    return { agreement: 'MISMATCH', mismatchCategory: 'portal-user-id' };
  }
  if (String(legacyPortalUser.customer_id) !== String(shadowResult.user.customer_id)) {
    return { agreement: 'MISMATCH', mismatchCategory: 'customer-id' };
  }
  return { agreement: 'AGREE', mismatchCategory: null };
}

function shadowMappingState(shadowResult) {
  if (shadowResult.user) return 'mapped-active';
  if (shadowResult.reason === 'UNMAPPED') return 'unmapped';
  if (shadowResult.reason === 'NOT_ACTIVE') return `inactive:${String(shadowResult.status || 'unknown')}`;
  return `unresolved:${String(shadowResult.reason || 'unknown').toLowerCase()}`;
}

async function supabaseShadowMiddleware(req, res, next) {
  try {
    if (!isShadowEnabled()) return next();
    const token = extractBearerToken(req);
    if (!token) return next();
    const verified = await verifySupabasePortalToken(token);
    if (!verified.ok) {
      // Pre-migration traffic is ~100% legacy-family tokens, which fail
      // here by design (unsupported algorithm). Stay quiet for those;
      // surface only verifier states that indicate a real Supabase
      // configuration problem.
      if (verified.reason === 'NOT_CONFIGURED' || verified.reason === 'JWKS_UNAVAILABLE' || verified.reason === 'MALFORMED_SUB' || verified.reason === 'MISSING_SUB') {
        console.warn('[PortalSupabaseShadow] verifier not usable:', {
          reason: verified.reason,
          method: req.method,
          path: req.originalUrl || req.url,
        });
      }
      return next();
    }
    const shadow = await resolvePortalIdentity(verified.sub);
    const legacy = (req && req.portalUser) || null;
    const { agreement, mismatchCategory } = compareShadowIdentity(legacy, shadow);
    // Safe fields only: route + identities + mapping state + agreement.
    // NEVER tokens, headers, hashes, or secrets (see module header).
    console.log('[PortalSupabaseShadow] ' + JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.url,
      correlationId: req.correlationId || null,
      legacyPortalUserId: legacy ? legacy.id : null,
      legacyCustomerId: legacy ? legacy.customer_id : null,
      shadowSub: verified.sub,
      mappingState: shadowMappingState(shadow),
      shadowPortalUserId: shadow.user ? shadow.user.id : null,
      shadowCustomerId: shadow.user ? shadow.user.customer_id : null,
      agreement,
      mismatchCategory,
    }));
  } catch {
    // The shadow path must never break a request — fail silent, legacy
    // authentication (which already ran) remains authoritative.
  }
  return next();
}

module.exports = {
  SHADOW_FLAG_NAME,
  isShadowEnabled,
  isUuidShape,
  getSupabaseJwtConfig,
  clearJwksCache,
  verifySupabasePortalToken,
  resolvePortalIdentity,
  toPortalMeContract,
  getPortalAuthMappingReport,
  compareShadowIdentity,
  supabaseShadowMiddleware,
};
