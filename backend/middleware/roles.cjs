/**
 * Canonical role model for Prime ERP.
 *
 * Prime ERP is an Admin-only application. The only valid authenticated
 * identities are:
 *   - Admin           — full ERP access
 *   - portal_customer — customer portal access only
 *   - anonymous       — no protected API access
 *
 * Every other role string is legacy/unused and is rejected. Comparison
 * is case-insensitive on input and always lower-cased before storage so
 * the rest of the codebase only needs to compare against the constants
 * below.
 *
 * No other module should define role constants. Import from here.
 */

const ROLE_ADMIN = 'admin';
const ROLE_PORTAL_CUSTOMER = 'portal_customer';
const ROLE_ANONYMOUS = 'anonymous';

const VALID_ROLES = new Set([ROLE_ADMIN, ROLE_PORTAL_CUSTOMER]);

const normalize = (raw) => {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (value === '') return '';
  return value;
};

/** True iff the role string is exactly the canonical Admin role. */
const isAdmin = (raw) => normalize(raw) === ROLE_ADMIN;

/** True iff the role string is exactly the canonical portal_customer role. */
const isPortalCustomer = (raw) => normalize(raw) === ROLE_PORTAL_CUSTOMER;

/** True iff the role string is a known ERP/portal role. */
const isKnownRole = (raw) => VALID_ROLES.has(normalize(raw));

/**
 * Resolve the role from an authenticated user object. We trust the
 * verified authentication context (req.user on the backend, the parsed
 * JWT/session on the frontend) — never trust a role supplied by an
 * unauthenticated header or request body.
 *
 * Returns ROLE_ADMIN, ROLE_PORTAL_CUSTOMER, or ROLE_ANONYMOUS.
 */
const resolveRole = (user) => {
  if (!user || typeof user !== 'object') return ROLE_ANONYMOUS;
  return normalize(user.role) || ROLE_ANONYMOUS;
};

module.exports = {
  ROLE_ADMIN,
  ROLE_PORTAL_CUSTOMER,
  ROLE_ANONYMOUS,
  VALID_ROLES,
  isAdmin,
  isPortalCustomer,
  isKnownRole,
  resolveRole,
  normalize,
};