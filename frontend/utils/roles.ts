/**
 * Canonical role model for Prime ERP (frontend mirror of backend/middleware/roles.cjs).
 *
 * Prime ERP is an Admin-only application. The only valid authenticated
 * identities are:
 *   - Admin           — full ERP access
 *   - portal_customer — customer portal access only
 *   - anonymous       — no protected API access
 *
 * Every other role string is legacy/unused and is rejected by the backend.
 * Comparison is case-insensitive and always lower-cased before storage so
 * the rest of the codebase only needs to compare against the constants below.
 *
 * No other module should define role constants. Import from here.
 */

export const ROLE_ADMIN = 'admin';
export const ROLE_PORTAL_CUSTOMER = 'portal_customer';
export const ROLE_ANONYMOUS = 'anonymous';

export const VALID_ROLES: ReadonlySet<string> = new Set([ROLE_ADMIN, ROLE_PORTAL_CUSTOMER]);

export const normalizeRole = (raw: unknown): string => {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return value === '' ? '' : value;
};

export const isAdminRole = (raw: unknown): boolean => normalizeRole(raw) === ROLE_ADMIN;

export const isPortalCustomerRole = (raw: unknown): boolean => normalizeRole(raw) === ROLE_PORTAL_CUSTOMER;

export const isKnownRole = (raw: unknown): boolean => VALID_ROLES.has(normalizeRole(raw));

/**
 * Resolve the canonical role from a user object. Returns one of the
 * ROLE_* constants. Falls back to ROLE_ANONYMOUS.
 *
 * Crucially, this treats Supabase-authenticated users with NO `role`
 * metadata AND no portal flag as Admin — because Prime ERP is an
 * Admin-only application: if a Supabase session exists and isn't a
 * portal customer, the only legitimate ERP identity is Admin.
 * Frontend-only fallback; the backend enforces the same rule from the
 * verified JWT in backend/middleware/auth.cjs.
 */
export const resolveCanonicalRole = (userLike: unknown): string => {
  if (!userLike || typeof userLike !== 'object') return ROLE_ANONYMOUS;
  const u = userLike as { role?: unknown; authMode?: unknown; isSuperAdmin?: unknown };
  const role = normalizeRole(u.role);
  if (role) return role;
  // No role metadata — infer Admin if the user is Supabase-authenticated
  // and not flagged as a portal customer. This matches the backend rule
  // and prevents the previous "Staf" / "User" fallback that caused 403s
  // on legitimate Admin sessions whose user_metadata.role was missing.
  if (u.authMode === 'supabase' || u.authMode === 'api') return ROLE_ADMIN;
  return ROLE_ANONYMOUS;
};