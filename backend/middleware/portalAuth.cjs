const jwt = require('jsonwebtoken');
const portalAuthService = require('../services/portalAuthService.cjs');

// ─── Phase 3 dual-auth feature flag (default OFF) ────────────────────────────
// PORTAL_SUPABASE_DUAL_AUTH === 'true' enables authoritative dual-family
// Portal authentication: valid legacy Portal JWTs keep working exactly as
// before, and valid Supabase Auth JWTs (JWKS-verified + mapped active
// portal_users row) are additionally accepted on Portal routes.
// When OFF/absent (safe default, rollback state) the Portal boundary is
// legacy-only and behaves byte-identically to the pre-Phase-3 verifier.
const DUAL_AUTH_FLAG_NAME = 'PORTAL_SUPABASE_DUAL_AUTH';

function isDualAuthEnabled() {
  return String(process.env[DUAL_AUTH_FLAG_NAME] || '').trim().toLowerCase() === 'true';
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

function generatePortalToken(user) {
  const payload = {
    id: user.id,
    customer_id: user.customer_id,
    email: user.email,
    full_name: user.full_name || null,
    referred_by_code: user.referred_by_code || null,
    role: 'portal_customer'
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: portalAuthService.ACCESS_TOKEN_EXPIRY });
}

function generatePortalTokenWithUser(user) {
  return generatePortalToken(user);
}

const verifyPortalToken = async (req, res, next) => {
  const publicEndpoints = ['/auth/login', '/auth/forgot-password', '/auth/reset-password', '/auth/refresh'];
  if (publicEndpoints.includes(req.path)) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = req.path === '/events'
    ? (authHeader && authHeader.split(' ')[1]) || req.query.token
    : (authHeader && authHeader.split(' ')[1]);

  if (!token) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'No authentication token provided'
    });
  }

  // ── Step A — legacy verifier (existing trusted mechanism, unchanged) ──────
  // A cryptographically valid legacy Portal identity is accepted immediately
  // and Supabase verification is NOT attempted afterwards.
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.role || decoded.role !== 'portal_customer') {
      return res.status(403).json({
        error: 'Invalid token role',
        message: 'This token is not valid for portal access'
      });
    }
    req.portalUser = {
      customer_id: decoded.customer_id,
      email: decoded.email,
      full_name: decoded.full_name || null,
      role: decoded.role,
      id: decoded.id,
    };
    req.portalAuthFamily = 'legacy';
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        message: 'Your session has expired. Please login again.'
      });
    }
    // Legacy-only mode (safe default): identical response to before Phase 3.
    if (!isDualAuthEnabled()) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'The provided authentication token is invalid'
      });
    }
    // Dual mode: any other legacy failure falls through to Step B. (A
    // Supabase RS/ES JWT always fails here with an invalid-signature error,
    // never with TokenExpiredError, so expired legacy tokens keep the exact
    // legacy response above.)
  }

  // ── Step B — Supabase verifier (dual mode only) ────────────────────────────
  // Every check below must pass; no identity is derived from unverified
  // claims. Failures return the SAME generic unauthorized response as the
  // legacy path — never the family, mapping state, or cryptographic reason.
  try {
    const { verifySupabasePortalToken, resolvePortalIdentity } = require('../services/supabasePortalIdentity.cjs');
    const verified = await verifySupabasePortalToken(token);
    if (!verified.ok) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'The provided authentication token is invalid'
      });
    }
    const shadow = await resolvePortalIdentity(verified.sub);
    if (!shadow.user) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'The provided authentication token is invalid'
      });
    }
    // Portal identity comes ONLY from the mapped database row, using the
    // exact req.portalUser contract Portal handlers already consume.
    req.portalUser = {
      customer_id: shadow.user.customer_id,
      email: shadow.user.email,
      full_name: shadow.user.full_name || null,
      role: 'portal_customer',
      id: shadow.user.id,
    };
    req.portalAuthFamily = 'supabase';
    return next();
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token',
      message: 'The provided authentication token is invalid'
    });
  }
};

module.exports = {
  generatePortalToken,
  generatePortalTokenWithUser,
  verifyPortalToken,
  isDualAuthEnabled,
  DUAL_AUTH_FLAG_NAME,
  JWT_SECRET
};
