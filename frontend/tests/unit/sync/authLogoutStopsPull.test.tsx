/**
 * Logout teardown test: AuthContext logout() must stop the sync engine so no
 * future PULL reconciliation can fire afterwards.
 *
 * Flow: mount AuthProvider with a restorable Admin Supabase session →
 * cold boot starts the engine (initial full pull) → logout() → advance 10
 * fake-minutes → zero additional PULL requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, act } from '@testing-library/react';

const { mockFetchPullPage, mockGetSyncAccessToken } = vi.hoisted(() => ({
  mockFetchPullPage: vi.fn(),
  mockGetSyncAccessToken: vi.fn(),
}));

vi.mock('../../../services/syncApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/syncApiClient')>();
  return {
    ...actual,
    fetchPullPage: mockFetchPullPage,
    getSyncAccessToken: mockGetSyncAccessToken,
  };
});

const adminSessionUser = {
  id: 'u1',
  email: 'admin@test.com',
  app_metadata: {},
  user_metadata: { role: 'Admin', username: 'admin', full_name: 'Admin User' },
};

vi.mock('../../../services/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: 'tok-123',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: adminSessionUser,
          },
        },
      })),
      refreshSession: vi.fn(async () => ({ data: { session: null } })),
      signOut: vi.fn(async () => ({})),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../../services/db', () => ({
  dbService: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => 'mock-id'),
    bulkPut: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    getAll: vi.fn(async () => []),
    getSetting: vi.fn(async () => undefined),
    saveSetting: vi.fn(async () => undefined),
    setSyncListener: vi.fn(),
    checkIntegrity: vi.fn(async () => ({ healthy: true, issues: [] })),
    performAutoBackup: vi.fn(),
  },
  getStoreForCloudTable: (table: string) => table,
}));

vi.mock('../../../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setNotifyCallback: vi.fn(),
    getLogs: vi.fn(() => []),
    clearLogs: vi.fn(() => []),
  },
}));

import { AuthProvider, useAuth } from '../../../context/AuthContext';
import { isPullInFlight } from '../../../services/syncService';

const emptyPage = (table: string, offset = 0) => ({
  table,
  rows: [],
  page: { offset, limit: 2000, count: 0, hasMore: false },
});

describe('AuthContext logout stops PULL reconciliation', () => {
  beforeEach(() => {
    mockFetchPullPage.mockReset().mockImplementation(async (table: string, opts: any = {}) => emptyPage(table, opts.offset ?? 0));
    mockGetSyncAccessToken.mockReset().mockResolvedValue('tok-123');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logout prevents future reconciliation (no pulls after logout)', async () => {
    let ctx: ReturnType<typeof useAuth> | null = null;
    const Probe = () => {
      ctx = useAuth();
      return null;
    };
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    try {
      // Cold boot restores the Admin session and starts the engine.
      await waitFor(() => expect(ctx?.user).not.toBeNull(), { timeout: 15000 });
      // Let the initial full pull settle.
      await waitFor(() => expect(mockFetchPullPage.mock.calls.length).toBe(144), { timeout: 15000 });
      await waitFor(() => expect(isPullInFlight()).toBe(false), { timeout: 15000 });
      const callsAtLogout = mockFetchPullPage.mock.calls.length;

      await act(async () => {
        await ctx!.logout();
      });
      await waitFor(() => expect(ctx?.user).toBeNull(), { timeout: 10000 });

      // 10 fake-minutes (two reconciliation intervals): nothing may fire.
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockFetchPullPage.mock.calls.length).toBe(callsAtLogout);
    } finally {
      unmount();
    }
  });
});
