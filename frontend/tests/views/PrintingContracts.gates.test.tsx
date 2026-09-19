import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Phase 1 behavioral gates: role enforcement, activation evidence routing,
 * and explicit override — exercised through the real view.
 */
const mockNotify = vi.fn();
const mockFetchFinanceData = vi.fn(async () => undefined);
const mockFetchSalesData = vi.fn(async () => undefined);
const mockUser: Record<string, any> = { id: 'u-1', username: 'tester' };

const contractRow: Record<string, any> = {
  id: 'c-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  school_id: 'sch-1',
  contract_number: 'PC-0001',
  title: 'Term 2 exam printing',
  status: 'pending_payment',
  prepaid_amount: 5000,
  consumed_amount: 0,
  reserved_amount: 0,
  assessment_count: 4,
  max_assessments: 4,
  assessment_price: 1250,
  assessment_type: 'examination',
  payment_status: 'pending',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  version: 1,
  data: {},
};

const financeState: Record<string, any> = {
  assessmentContracts: [],
  contractAssessments: [],
  contractAmendments: [],
  walletTransactions: [],
  invoices: [],
  recurringInvoices: [],
  fetchFinanceData: mockFetchFinanceData,
  addAssessmentContract: vi.fn(async () => undefined),
  updateAssessmentContract: vi.fn(async () => undefined),
  deleteAssessmentContract: vi.fn(async () => undefined),
  addContractAssessment: vi.fn(async () => undefined),
  updateContractAssessment: vi.fn(async () => undefined),
  deleteContractAssessment: vi.fn(async () => undefined),
  addContractAmendment: vi.fn(async () => undefined),
  updateContractAmendment: vi.fn(async () => undefined),
  addWalletTransaction: vi.fn(async () => undefined),
};

const salesState: Record<string, any> = {
  customers: [{ id: 'cust-1', name: 'Acme School Client' }],
  jobOrders: [],
  addJobOrder: vi.fn(async () => undefined),
  updateJobOrder: vi.fn(async () => undefined),
  fetchSalesData: mockFetchSalesData,
};

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: { companyName: 'Prime ERP', currencySymbol: 'K' },
    notify: mockNotify,
    user: mockUser,
  }),
}));

vi.mock('../../stores/financeStore', () => ({
  useFinanceStore: (sel: (s: Record<string, any>) => unknown) => sel(financeState),
}));

vi.mock('../../stores/salesStore', () => ({
  useSalesStore: (sel: (s: Record<string, any>) => unknown) => sel(salesState),
}));

vi.mock('../../services/db', () => ({
  dbService: { getAll: vi.fn(async () => []) },
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({ addInvoice: vi.fn(async () => 'INV-0001') }),
}));

import PrintingContractsView from '../../components/printing-contracts/PrintingContractsView';

async function openDetails() {
  render(<PrintingContractsView />);
  await waitFor(() => {
    expect(screen.getByText('PC-0001')).toBeTruthy();
  });
  fireEvent.click(screen.getByText('PC-0001'));
  await waitFor(() => {
    expect(screen.getByText('Printing Jobs')).toBeTruthy();
  });
}

describe('role gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.assessmentContracts = [{ ...contractRow }];
    financeState.invoices = [];
    Object.keys(mockUser).forEach((k) => delete mockUser[k]);
    Object.assign(mockUser, { id: 'u-1', username: 'tester' });
  });

  it('hides management actions from a known non-privileged role', async () => {
    Object.assign(mockUser, { role: 'Viewer' });
    const { container } = render(<PrintingContractsView />);
    await waitFor(() => {
      expect(screen.getByText('Printing Contracts')).toBeTruthy();
    });
    expect(screen.queryByText('New Contract')).toBeNull();
    expect(container.querySelector('[title="Delete"]')).toBeNull();
  });

  it('keeps management actions for an admin role', async () => {
    Object.assign(mockUser, { role: 'Admin' });
    render(<PrintingContractsView />);
    await waitFor(() => {
      expect(screen.getByText('New Contract')).toBeTruthy();
    });
  });
});

describe('activation evidence routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.invoices = [];
    Object.keys(mockUser).forEach((k) => delete mockUser[k]);
    Object.assign(mockUser, { id: 'u-1', username: 'tester', role: 'Admin' });
  });

  it('routes activation without evidence to the explicit override modal', async () => {
    financeState.assessmentContracts = [{ ...contractRow, data: {} }];
    await openDetails();
    fireEvent.click(screen.getByText('Verify & activate'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Activate without payment evidence' })).toBeTruthy();
    });
    // Submitting without a reason is refused.
    fireEvent.click(screen.getByText('Activate anyway'));
    expect(mockNotify).toHaveBeenCalledWith(
      'A reason is required to activate without payment evidence.',
      'error'
    );
    // A recorded reason activates WITHOUT a verified stamp or wallet move.
    fireEvent.change(screen.getByPlaceholderText(/Government LPO/), {
      target: { value: 'LPO received, cash follows' },
    });
    fireEvent.click(screen.getByText('Activate anyway'));
    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.status).toBe('active');
    expect(saved.payment_status).not.toBe('verified');
    expect(saved.data.activationOverride.reason).toBe('LPO received, cash follows');
    expect(financeState.addWalletTransaction).not.toHaveBeenCalled();
  });

  it('activates with verified stamp and wallet deposit on paid-invoice evidence', async () => {
    financeState.assessmentContracts = [{ ...contractRow, data: { issued_invoice_id: 'INV-1' } }];
    financeState.invoices = [{ id: 'INV-1', status: 'Paid', totalAmount: 5000, paidAmount: 5000 }];
    await openDetails();
    fireEvent.click(screen.getByText('Verify & activate'));
    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.status).toBe('active');
    expect(saved.payment_status).toBe('verified');
    expect(financeState.addWalletTransaction).toHaveBeenCalledTimes(1);
    expect(financeState.addWalletTransaction.mock.calls[0][0].data.type).toBe('CONTRACT_DEPOSIT');
    // No override modal on the evidence path.
    expect(screen.queryByRole('heading', { name: 'Activate without payment evidence' })).toBeNull();
  });
});
