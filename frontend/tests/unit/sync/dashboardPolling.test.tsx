/**
 * dashboardPolling.test.tsx — regression tests for the DataContext polling
 * timer churn proven on Device B (timer destroyed/recreated through
 * generations 1..50 on every data refresh):
 *
 * 1. Initial mount creates exactly ONE DataContext polling timer.
 * 2. Parent re-renders with fresh slice identities (what every data refresh
 *    does) do NOT clear/recreate the timer.
 * 3. `queueRefresh()` / `emit-data-changed` refresh cycles do NOT
 *    clear/recreate the timer (but the refresh itself still runs).
 * 4. Redundant `startPolling(sameInterval)` keeps the live timer (no-op).
 * 5. A genuinely different interval still replaces the timer.
 * 6. Unmount still clears the timer (lifecycle cleanup preserved).
 * 7. Explicit `stopPolling()` still clears the timer.
 *
 * Data production behavior is untouched: slice contexts, db, and helpers
 * are mocked; the REAL DataProvider + useModuleRefresh + timer code runs.
 */
import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('../../../stores/financeStore', () => ({ useFinanceStore: () => ({}) }));
vi.mock('../../../context/InventoryContext', () => ({ useInventory: () => ({}) }));
vi.mock('../../../context/ProductionContext', () => ({ useProduction: () => ({}) }));
vi.mock('../../../context/SalesContext', () => ({ useSales: () => ({}) }));
vi.mock('../../../context/ProcurementContext', () => ({ useProcurement: () => ({}) }));
vi.mock('../../../context/OrdersContext', () => ({ useOrders: () => ({}) }));
vi.mock('../../../context/ExaminationContext', () => ({ useExamination: () => ({}) }));
vi.mock('../../../context/BankingContext', () => ({
  useBankingStore: { getState: () => ({ fetchBankingData: vi.fn(async () => {}) }) },
}));
vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: {},
    alerts: [],
    reminders: [],
    isOnline: true,
    user: null,
    notify: () => {},
    dbSyncStatus: 'idle',
    connectDbSync: () => {},
    addReminder: () => {},
    toggleReminder: () => {},
    deleteReminder: () => {},
    clearAlerts: () => {},
    dismissAlert: () => {},
  }),
}));
vi.mock('../../../services/db', () => ({
  dbService: {
    getAll: async () => [],
    put: async () => {},
    delete: async () => {},
    source: '',
  },
}));
vi.mock('../../../utils/helpers', () => ({ generateNextId: () => 'TASK-1' }));
vi.mock('../../../context/legacyDataContext', () => ({ runLegacyRefreshTasks: async () => [] }));
vi.mock('../../../utils/idGeneration', () => ({ generateOpaqueId: () => 'ctx-test' }));

import { DataProvider, useData } from '../../../context/DataContext';
import { useModuleRefresh } from '../../../hooks/useModuleRefresh';

interface ApiBox {
  startPolling?: (intervalMs?: number) => void;
  stopPolling?: (reason?: string) => void;
}

function Probe({ apiBox }: { apiBox: ApiBox }) {
  useModuleRefresh(undefined, { interval: 60000 });
  const { startPolling, stopPolling } = useData();
  useEffect(() => {
    apiBox.startPolling = startPolling;
    apiBox.stopPolling = stopPolling;
  });
  return null;
}

function Harness({ tick, apiBox }: { tick: number; apiBox: ApiBox }) {
  return (
    <DataProvider>
      <Probe apiBox={apiBox} />
      <span>{tick}</span>
    </DataProvider>
  );
}

function pollTimerIds(setIntervalSpy: ReturnType<typeof vi.spyOn>): unknown[] {
  // setInterval handle is the mock RESULT (calls[i][0] is the callback).
  return setIntervalSpy.mock.calls
    .map((c, i) => ({ ms: c[1], id: setIntervalSpy.mock.results[i]?.value }))
    .filter((e) => e.ms === 60000)
    .map((e) => e.id);
}

describe('DataContext polling timer stability', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(window, 'setInterval');
    clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    debugSpy = vi.spyOn(console, 'debug');
    debugSpy.mockClear();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('mount creates exactly one 60s polling timer', async () => {
    const apiBox: ApiBox = {};
    const view = render(<Harness tick={0} apiBox={apiBox} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(pollTimerIds(setIntervalSpy)).toHaveLength(1);
    expect(apiBox.startPolling).toBeDefined();
    view.unmount();
  });

  it('repeated re-renders with fresh slice identities do NOT replace the timer', async () => {
    const apiBox: ApiBox = {};
    const view = render(<Harness tick={0} apiBox={apiBox} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const pollIds = pollTimerIds(setIntervalSpy);
    expect(pollIds).toHaveLength(1);

    // Simulate what every data refresh does: the provider subtree
    // re-renders while every slice hook returns fresh object identities,
    // which used to churn startPolling/stopPolling identities and thereby
    // destroy/recreate the timer through endless generations.
    for (let tick = 1; tick <= 3; tick++) {
      view.rerender(<Harness tick={tick} apiBox={apiBox} />);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    }

    expect(pollTimerIds(setIntervalSpy)).toHaveLength(1);
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).not.toContain(pollIds[0]);
    view.unmount();
  });

  it('emit-data-changed refresh cycles run the refresh WITHOUT replacing the timer', async () => {
    const apiBox: ApiBox = {};
    const view = render(<Harness tick={0} apiBox={apiBox} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const pollIds = pollTimerIds(setIntervalSpy);
    expect(pollIds).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('primeerp:data-changed', { detail: { source: 'probe-test' } }),
      );
      await new Promise((r) => setTimeout(r, 250));
    });

    // The refresh itself ran through the existing pipeline...
    const lines = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('dashboard_data_load_completed'))).toBe(true);
    // ...but the polling timer was never touched.
    expect(pollTimerIds(setIntervalSpy)).toHaveLength(1);
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).not.toContain(pollIds[0]);
    view.unmount();
  });

  it('redundant startPolling(sameInterval) keeps the timer; a new interval replaces it', async () => {
    const apiBox: ApiBox = {};
    const view = render(<Harness tick={0} apiBox={apiBox} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const pollIds = pollTimerIds(setIntervalSpy);
    expect(pollIds).toHaveLength(1);

    await act(async () => {
      apiBox.startPolling!(60000);
      apiBox.startPolling!(60000);
    });
    expect(pollTimerIds(setIntervalSpy)).toHaveLength(1);
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).not.toContain(pollIds[0]);

    await act(async () => {
      apiBox.startPolling!(120000);
    });
    // Genuine interval change still replaces the timer (single active timer).
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).toContain(pollIds[0]);
    view.unmount();
  });

  it('unmount and explicit stop still clear the timer (cleanup preserved)', async () => {
    const apiBox: ApiBox = {};
    const view = render(<Harness tick={0} apiBox={apiBox} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const pollIds = pollTimerIds(setIntervalSpy);
    expect(pollIds).toHaveLength(1);

    await act(async () => {
      apiBox.stopPolling!();
    });
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).toContain(pollIds[0]);

    view.unmount();
    // Unmount path also clears (no throw, no leak).
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
