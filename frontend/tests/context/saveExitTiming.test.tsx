import React, { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * Save-path exit timing: persisting a transaction must never wait for the
 * customer-notification pipeline (template + LLM + webhooks, unbounded
 * latency). The notification is still sent — just in the background.
 *
 * The notification mock below NEVER resolves. Under the old code
 * (`await triggerCustomerActivityNotification(...)`) this test times out;
 * with the fix the save resolves immediately while the send is in flight.
 */
const mockNotify = vi.fn();
const mockAddAuditLog = vi.fn();
const mockAddAlert = vi.fn(async () => undefined);
const mockFetchSalesData = vi.fn(async () => undefined);
const mockFetchFinanceData = vi.fn(async () => undefined);
const mockTxnAddPayment = vi.fn(async () => undefined);
const mockTriggerNotification = vi.fn(() => new Promise<never>(() => {}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    notify: mockNotify,
    addAuditLog: mockAddAuditLog,
    addAlert: mockAddAlert,
    companyConfig: { currencySymbol: 'K' },
    user: { name: 'Tester' },
    isInitialized: false,
    checkPermission: () => true,
  }),
}));

vi.mock('../../stores/salesStore', () => ({
  useSalesStore: () => ({
    customerPayments: [],
    customers: [{ id: 'C-1', name: 'Acme', phone: '0999000000' }],
    fetchSalesData: mockFetchSalesData,
  }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({ fetchFinanceData: mockFetchFinanceData }),
}));

vi.mock('../../stores/productionStore', () => ({
  useProductionStore: () => ({}),
}));

vi.mock('../../stores/inventoryStore', () => ({
  useInventoryStore: () => ({}),
}));

vi.mock('../../services/transactionService', () => ({
  transactionService: { addCustomerPayment: (...args: any[]) => mockTxnAddPayment(...args) },
}));

vi.mock('../../services/customerNotificationService', () => ({
  customerNotificationService: {
    triggerNotification: (...args: any[]) => mockTriggerNotification(...args),
  },
}));

import { SalesProvider, useSales } from '../../context/SalesContext';

const payment: any = {
  id: 'PAY-TIMING-1',
  customerId: 'C-1',
  customerName: 'Acme',
  amount: 100,
  allocations: [{ invoiceId: 'INV-1', amount: 100 }],
  paymentMethod: 'Cash',
};

function Harness({ onDone }: { onDone: (p: Promise<void>) => void }) {
  const { addCustomerPayment } = useSales();
  useEffect(() => {
    onDone(addCustomerPayment(payment));
  }, []);
  return null;
}

describe('save-path exit timing', () => {
  it('addCustomerPayment resolves without waiting for notifications', async () => {
    let saved: Promise<void> | null = null;
    render(
      <SalesProvider>
        <Harness onDone={(p) => { saved = p; }} />
      </SalesProvider>
    );

    expect(saved).not.toBeNull();
    // Core write + refreshes complete even though the notification hangs.
    await saved!;
    expect(mockTxnAddPayment).toHaveBeenCalledTimes(1);
    expect(mockFetchSalesData).toHaveBeenCalled();
    expect(mockFetchFinanceData).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('PAY-TIMING-1'),
      'success'
    );
    // …and the notification was still dispatched in the background.
    await waitFor(() => {
      expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
    });
    expect(mockTriggerNotification).toHaveBeenCalledWith(
      'RECEIPT',
      expect.objectContaining({ id: 'PAY-TIMING-1' })
    );
  }, 15000);
});
