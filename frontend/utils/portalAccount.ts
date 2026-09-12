/**
 * Portal account state helper (shared by ERP customer surfaces).
 *
 * Backend truth: only `status === 'active'` portal users can sign in
 * (`portalAuthService.authenticatePortalUser` and the Supabase fallback both
 * reject anything else). In particular an `invited` account can NEVER log in
 * with a password — not even a freshly rotated one — until it completes
 * activation with a valid invite code. Treating `invited` as active in the
 * UI is what produced "Email and password do not match our records" after
 * a rotate, and dead-end "Create account" calls on already-invited users.
 */
export type PortalAccountState = 'none' | 'invited' | 'active' | 'disabled';

export function getPortalAccountState(
  customer: { portalUserId?: unknown; portalStatus?: unknown } | null | undefined
): PortalAccountState {
  if (!customer || !customer.portalUserId) return 'none';
  const s = String(customer.portalStatus ?? 'active').toLowerCase().trim();
  if (s === 'disabled' || s === 'suspended' || s === 'revoked' || s === 'blocked') return 'disabled';
  if (s === 'invited' || s === 'pending' || s === 'invite_sent' || s === 'awaiting_activation') return 'invited';
  return 'active';
}

export function portalStatusLabel(state: PortalAccountState): string {
  if (state === 'active') return 'Active';
  if (state === 'invited') return 'Invite pending';
  if (state === 'disabled') return 'Disabled';
  return 'Inactive';
}
