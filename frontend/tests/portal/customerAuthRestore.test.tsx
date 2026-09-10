/**
 * Customer auth session-restoration tests (Tests 2, 3, 8 + transient init).
 *
 * A restored/refreshable session must ALWAYS end with `user` set (never
 * `user === null` with a valid session), and initialization must resolve
 * `loading` exactly once. Only invalid sessions redirect to login.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { CustomerAuthProvider, useCustomerAuth } from '../../context/CustomerAuthContext';

const mockSessionStore = vi.hoisted(() => ({ session: null as any }));
const mockRefresh = vi.hoisted(() => ({ fn: null as null | (() => Promise<any>) }));

vi.mock('../../services/portalApiClient', async () => {
  const actual = await vi.importActual<typeof import('../../services/portalApiClient')>(
    '../../services/portalApiClient'
  );
  return {
    ...actual,
    getPortalSession: vi.fn(() => mockSessionStore.session),
    savePortalSession: vi.fn((s: any) => {
      mockSessionStore.session = s;
    }),
    clearPortalSession: vi.fn(() => {
      mockSessionStore.session = null;
    }),
    refreshPortalSessionDetailed: vi.fn(() => mockRefresh.fn!()),
  };
});

vi.mock('../../services/authApiClient', () => ({
  loginWithApi: vi.fn(),
}));

function seedSession(session: any) {
  mockSessionStore.session = session;
}

function freshSession() {
  return {
    access_token: 'access-fresh',
    refresh_token: 'refresh-fresh',
    expires_in: '30m',
    refreshed_at: Date.now(),
    user: { id: 'u-1', customer_id: 'C-1', email: 'c@example.com', full_name: 'Customer One' },
  };
}

function renderAuth() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <CustomerAuthProvider>{children}</CustomerAuthProvider>
  );
  return renderHook(() => useCustomerAuth(), { wrapper });
}

describe('customer auth session restoration', () => {
  beforeEach(() => {
    mockSessionStore.session = null;
    mockRefresh.fn = null;
    vi.clearAllMocks();
  });

  it('Test 2/8: fresh stored session restores the user without a server round-trip', async () => {
    seedSession(freshSession());
    mockRefresh.fn = async () => {
      throw new Error('must not refresh a fresh session');
    };
    const { result, unmount } = renderAuth();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toMatchObject({ id: 'u-1', customer_id: 'C-1' });
    unmount();
  });

  it('Test 3: successful refresh on restore sets the user (never null)', async () => {
    seedSession({ ...freshSession(), refreshed_at: Date.now() - 60 * 60 * 1000 });
    const refreshed = {
      ...freshSession(),
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      user: { id: 'u-1', customer_id: 'C-1', email: 'c@example.com', full_name: 'Customer One' },
    };
    mockRefresh.fn = async () => {
      mockSessionStore.session = refreshed;
      return { ok: true };
    };
    const { result, unmount } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.customer_id).toBe('C-1');
    unmount();
  });

  it('transient refresh failure during init keeps the user signed in', async () => {
    const stored = { ...freshSession(), refreshed_at: Date.now() - 60 * 60 * 1000 };
    seedSession(stored);
    mockRefresh.fn = async () => ({ ok: false, reason: 'transient' });
    const { result, unmount } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Valid session preserved: dashboard may render instead of login.
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toMatchObject({ id: 'u-1' });
    unmount();
  });

  it('invalid session clears and redirects to login state', async () => {
    seedSession({ ...freshSession(), refreshed_at: Date.now() - 60 * 60 * 1000 });
    mockRefresh.fn = async () => ({ ok: false, reason: 'invalid' });
    const { result, unmount } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(mockSessionStore.session).toBeNull();
    unmount();
  });

  it('no stored session resolves logged-out without any refresh call', async () => {
    const { result, unmount } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    unmount();
  });
});
