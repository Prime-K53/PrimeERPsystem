import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockNotify = vi.fn();
const mockFetchFinanceData = vi.fn(async () => undefined);
const mockFetchSalesData = vi.fn(async () => undefined);

const contractRow = {
  id: 'c-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  school_id: 'sch-1',
  contract_number: 'PC-0001',
  title: 'Term 2 exam printing',
  status: 'draft',
  prepaid_amount: 5000,
  consumed_amount: 0,
  reserved_amount: 0,
  assessment_count: 0,
  max_assessments: 4,
  assessment_price: 1000,
  assessment_type: 'examination',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  version: 1,
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
    user: { id: 'u-1', username: 'tester' },
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

describe('PrintingContracts modal chrome (Add Customer look, no sidebars)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.assessmentContracts = [];
  });

  it('renders the hub with a New Contract action', () => {
    render(<PrintingContractsView />);
    expect(screen.getByText('Printing Contracts')).toBeTruthy();
    expect(screen.getByText('New Contract')).toBeTruthy();
  });

  it('renders the dashboard in the shared UI language (money bar + filters)', () => {
    render(<PrintingContractsView />);
    for (const label of ['Active Contracts', 'Draft / Pending Payment', 'Available Funds', 'Assessments Reserved / Consumed']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('Search contracts, schools, clients...')).toBeTruthy();
    expect(screen.getByText('Legacy recurring billing (archived — 0 records)')).toBeTruthy();
  });

  it('opens the contract form in Add-Customer chrome without a sidebar', async () => {
    const { container } = render(<PrintingContractsView />);
    fireEvent.click(screen.getByText('New Contract'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'New Printing Contract' })).toBeTruthy();
    });
    // Add-Customer chrome markers: section labels, serif title, gradient footer actions
    expect(screen.getByText('Parties & Type')).toBeTruthy();
    expect(screen.getByText('Commercials & Period')).toBeTruthy();
    expect(screen.getByText('Create Draft Contract')).toBeTruthy();
    // Invoice-style billing: billable lines with totals + issue action
    expect(screen.getByText('Assessment item')).toBeTruthy();
    expect(screen.getByText('Contract total')).toBeTruthy();
    expect(screen.getByText('Save & issue invoice')).toBeTruthy();
    // No sidebar nav (customer modal's "Customer Setup" rail must not exist here)
    expect(screen.queryByText('Customer Setup')).toBeNull();
    expect(container.querySelector('.max-w-2xl')).toBeNull();
  });

  it('opens contract details as a centered modal with horizontal tabs (no side drawer)', async () => {
    financeState.assessmentContracts = [contractRow];
    const { container } = render(<PrintingContractsView />);

    await waitFor(() => {
      expect(screen.getByText('PC-0001')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('PC-0001'));

    await waitFor(() => {
      expect(screen.getByText('Printing Jobs')).toBeTruthy();
    });
    for (const tab of ['Overview', 'Assessments', 'Printing Jobs', 'Wallet', 'Amendments']) {
      expect(screen.getByText(tab)).toBeTruthy();
    }
    // Footer actions from the customer-modal chrome
    expect(screen.getByText('Edit Contract')).toBeTruthy();
    // Old side-drawer markup is gone
    expect(container.querySelector('.max-w-3xl')).toBeNull();
    expect(screen.queryByText('Customer Setup')).toBeNull();
  });
});
