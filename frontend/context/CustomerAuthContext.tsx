import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { portalApi, getPortalSession, savePortalSession, clearPortalSession, refreshPortalSessionDetailed, computeRefreshDelayMs, getAccessTokenAgeMs } from '../services/portalApiClient';
import { loginWithApi } from '../services/authApiClient';

interface PortalUser {
  id: string;
  customer_id: string;
  email: string;
  full_name?: string;
  phone?: string;
}

interface CustomerAuthContextType {
  user: PortalUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  loginWithApi: (email: string, password: string, twoFactorCode?: string) => Promise<{ success: boolean; message?: string; requiresTwoFactor?: boolean; pendingToken?: string }>;
  activate: (customerId: string, code: string, password: string) => Promise<'SUCCESS' | 'INVALID' | 'ERROR'>;
  logout: () => void;
  refreshSession: () => Promise<boolean>;
}

const CustomerAuthContext = createContext<CustomerAuthContextType | null>(null);

export function useCustomerAuth(): CustomerAuthContextType {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error('useCustomerAuth must be used within CustomerAuthProvider');
  return ctx;
}

export function CustomerAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAuthenticated = user !== null;

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const logout = useCallback(() => {
    clearRefreshTimer();
    const session = getPortalSession();
    if (session?.refresh_token) {
      portalApi.post('/auth/logout', { refresh_token: session.refresh_token }).catch(() => {});
    }
    clearPortalSession();
    setUser(null);
  }, [clearRefreshTimer]);

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const session = getPortalSession();
      if (!session?.refresh_token) {
        logout();
        return false;
      }
      const result = await refreshPortalSessionDetailed();
      if (result.ok) {
        setUser(getPortalSession()?.user ?? null);
        scheduleTokenRefresh(computeRefreshDelayMs(getPortalSession()?.expires_in));
        return true;
      }
      if (result.reason === 'transient') {
        // Transient failure (timeout/network/5xx): the stored session may
        // still be valid — keep the user signed in and retry soon instead of
        // destroying the session and bouncing to login.
        scheduleTokenRefresh(60 * 1000);
        return false;
      }
      logout();
      return false;
    } catch {
      logout();
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout]);

  const scheduleTokenRefresh = useCallback((delayMs: number) => {
    clearRefreshTimer();
    if (delayMs > 0) {
      refreshTimer.current = setTimeout(() => {
        refreshSession();
      }, delayMs);
    }
  }, [clearRefreshTimer, refreshSession]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const session = getPortalSession();
      if (!session?.user || !session?.access_token) {
        if (!cancelled) setLoading(false);
        return;
      }

      // Trust a freshly-issued token without a server round-trip. Age comes
      // from the locally recorded issue timestamp — never from parsing the
      // opaque `expires_in` duration string.
      const ageMs = getAccessTokenAgeMs(session);
      if (ageMs !== null && ageMs < 5 * 60 * 1000) {
        if (!cancelled) {
          setUser(session.user);
          scheduleTokenRefresh(computeRefreshDelayMs(session.expires_in));
          setLoading(false);
        }
        return;
      }

      // Unknown age or older token: validate once against the server.
      const result = await refreshPortalSessionDetailed();
      if (cancelled) return;
      if (result.ok) {
        // Successful refresh MUST restore the user — a valid session must
        // never leave `user === null` behind.
        setUser(getPortalSession()?.user ?? session.user);
        scheduleTokenRefresh(computeRefreshDelayMs(getPortalSession()?.expires_in));
        setLoading(false);
        return;
      }
      if (result.reason === 'transient') {
        // The refresh endpoint could not be reached, but the stored session
        // may still be valid: keep the user signed in so the dashboard can
        // render (from cache if needed) instead of bouncing to login.
        setUser(session.user);
        scheduleTokenRefresh(60 * 1000);
        setLoading(false);
        return;
      }
      clearPortalSession();
      setUser(null);
      setLoading(false);
    };

    init();

    const onSessionExpired = () => {
      clearRefreshTimer();
      setUser(null);
    };
    window.addEventListener('portal-session-expired', onSessionExpired);

    return () => {
      cancelled = true;
      clearRefreshTimer();
      window.removeEventListener('portal-session-expired', onSessionExpired);
    };
  }, [clearRefreshTimer, scheduleTokenRefresh]);

  const loginWithApiCallback = useCallback(async (email: string, password: string, twoFactorCode?: string): Promise<{ success: boolean; message?: string; requiresTwoFactor?: boolean; pendingToken?: string }> => {
    try {
      const result = await loginWithApi({ email, password, portal: 'customer', two_factor_code: twoFactorCode });
      
      if (result.requires_two_factor) {
        return { success: false, requiresTwoFactor: true, pendingToken: result.pending_token };
      }
      
      savePortalSession({
        access_token: result.access_token || '',
        refresh_token: result.refresh_token || '',
        expires_in: result.expires_in || '30m',
        refreshed_at: Date.now(),
        user: result.user as PortalUser,
      });
      setUser(result.user as PortalUser);
      scheduleTokenRefresh(computeRefreshDelayMs(result.expires_in));
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err?.body?.message || err?.message || 'Login failed. Please try again.' };
    }
  }, [scheduleTokenRefresh]);

  const activate = useCallback(async (customerId: string, code: string, password: string): Promise<'SUCCESS' | 'INVALID' | 'ERROR'> => {
    try {
      const result = await portalApi.post<{
        message: string;
        user: PortalUser;
        access_token: string;
        refresh_token: string;
        expires_in: string;
      }>('/auth/activate', { customer_id: customerId, code, password });

      savePortalSession({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_in: result.expires_in,
        refreshed_at: Date.now(),
        user: result.user,
      });

      setUser(result.user);
      scheduleTokenRefresh(computeRefreshDelayMs(result.expires_in));
      return 'SUCCESS';
    } catch (err: any) {
      if (err?.status === 400 || err?.status === 401 || err?.status === 409) return 'INVALID';
      return 'ERROR';
    }
  }, [scheduleTokenRefresh]);

  return (
    <CustomerAuthContext.Provider value={{ user, isAuthenticated, loading, loginWithApi: loginWithApiCallback, activate, logout, refreshSession }}>
      {children}
    </CustomerAuthContext.Provider>
  );
}
