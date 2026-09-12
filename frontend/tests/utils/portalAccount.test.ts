import { describe, it, expect } from 'vitest';
import { getPortalAccountState, portalStatusLabel } from '../../utils/portalAccount';

describe('getPortalAccountState', () => {
  it('returns none without a portal user id', () => {
    expect(getPortalAccountState(null)).toBe('none');
    expect(getPortalAccountState(undefined)).toBe('none');
    expect(getPortalAccountState({} as any)).toBe('none');
    expect(getPortalAccountState({ portalUserId: '', portalStatus: 'active' })).toBe('none');
  });

  it('returns active for active or legacy (status-less) accounts', () => {
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'active' })).toBe('active');
    expect(getPortalAccountState({ portalUserId: 'pusr_1' } as any)).toBe('active');
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'ACTIVE' })).toBe('active');
  });

  it('returns invited for pending activation (never treated as active)', () => {
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'invited' })).toBe('invited');
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'pending' })).toBe('invited');
    // Invited accounts cannot sign in — the UI must not offer Rotate password.
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'invited' })).not.toBe('active');
  });

  it('returns disabled for revoked states', () => {
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'disabled' })).toBe('disabled');
    expect(getPortalAccountState({ portalUserId: 'pusr_1', portalStatus: 'suspended' })).toBe('disabled');
  });

  it('labels every state', () => {
    expect(portalStatusLabel('active')).toBe('Active');
    expect(portalStatusLabel('invited')).toBe('Invite pending');
    expect(portalStatusLabel('disabled')).toBe('Disabled');
    expect(portalStatusLabel('none')).toBe('Inactive');
  });
});
