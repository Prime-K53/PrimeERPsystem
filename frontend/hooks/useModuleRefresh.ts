import { useEffect, useRef, useCallback } from 'react';
import { useData } from '../context/DataContext';
import { diagCaller, diagDashboardRefreshTriggered, diagLog, diagPollingLifecycleCall, diagPollingScheduled } from '../services/syncDiag';

interface UseModuleRefreshOptions {
  interval?: number | null;
  focusRefresh?: boolean;
}

const MIN_FOCUS_REFRESH_INTERVAL = 60_000;

/**
 * Hook to manage data polling and window-focus refresh for specific modules.
 * 
 * @param refreshFn Optional custom refresh function. Defaults to refreshAllData from DataContext.
 * @param options Configuration for interval and focus refresh.
 */
export const useModuleRefresh = (
  refreshFn?: () => Promise<void>,
  options: UseModuleRefreshOptions = {}
) => {
  const { startPolling, stopPolling, refreshAllData } = useData();
  const { interval = 300_000, focusRefresh = true } = options;
  
  const targetRefreshFn = refreshFn || refreshAllData;
  const lastRefreshRef = useRef<number>(0);
  const mountedRef = useRef(true);

  const handleFocus = useCallback(() => {
    if (!focusRefresh || !mountedRef.current) return;

    const now = Date.now();
    if (now - lastRefreshRef.current > MIN_FOCUS_REFRESH_INTERVAL) {
      lastRefreshRef.current = now;
      // [ERP-SYNC-DIAG] existing focus-refresh path only — reports focus triggers.
      diagDashboardRefreshTriggered('useModuleRefresh:focus', `throttleMs=${MIN_FOCUS_REFRESH_INTERVAL}`);
      targetRefreshFn().catch(() => undefined);
    } else {
      // [ERP-SYNC-DIAG] existing throttle only — reports focus refreshes suppressed by throttle.
      diagLog('focus_refresh_throttled', { throttleMs: MIN_FOCUS_REFRESH_INTERVAL });
    }
  }, [focusRefresh, targetRefreshFn]);

  useEffect(() => {
    mountedRef.current = true;
    // [ERP-SYNC-DIAG] effect-run intent only — proves remounts/re-runs that
    // re-request polling. This hook owns NO timer itself; the REAL timer
    // lives in DataContext.startPolling (see dashboard_poll_timer_* events).
    diagPollingLifecycleCall('useModuleRefresh', 'start', diagCaller());
    // Start polling if interval is provided
    if (interval !== null && interval > 0) {
      // [ERP-SYNC-DIAG] existing polling only — reports the requested interval.
      diagPollingScheduled('useModuleRefresh', interval, Math.max(interval, 60000));
      startPolling(interval);
    }

    // Register focus listener
    if (focusRefresh) {
      window.addEventListener('focus', handleFocus);
    }

    return () => {
      mountedRef.current = false;
      // [ERP-SYNC-DIAG] cleanup intent only — behavior unchanged.
      diagPollingLifecycleCall('useModuleRefresh', 'stop', diagCaller());
      stopPolling();
      window.removeEventListener('focus', handleFocus);
    };
  }, [interval, focusRefresh, startPolling, stopPolling, handleFocus]);

  return {
    refresh: targetRefreshFn
  };
};
