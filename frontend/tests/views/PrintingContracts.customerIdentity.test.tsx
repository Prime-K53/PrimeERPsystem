import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * PC-P726/024 regression: the contract table, the edit prefill and the save
 * path must all use the STABLE customer identity.
 *
 * Defect history: a broken 1-arg `customerNameOf` made the view display the
 * raw id / `'—'`, prefill the id into the edit field and persist a placeholder
 * as the denormalised `customerName` — while the customer was properly linked
 * by `customer_id` the whole time.
 *
 * What must hold after the fix:
 *   - the table and the edit form show the RESOLVED business name;
 *   - re-saving keeps `customer_id` and writes the resolved name back;
 *   - a valid stored legacy name is never erased just because the customer is
 *     not (yet) in the loaded list;
 *   - an unresolvable reference surfaces an actionable error and blocks the
 *     write instead of silently persisting a placeholder.
 */
const mockNotify = vi.fn();
const mockUser: Record<string, any> = { id: 'u-1', username: 'tester', role: 'Admin' };

const baseContract = (overrides: Record<string, any> = {}) => ({
  id: 'c-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  school_id: '',
  contract_number: 'PC-0001',
  title: 'Term 2 exam printing',
  status: 'pending_payment',
  // The exact corruption the defect produced: a placeholder stored as the
  // denormalised party name while the stable link stayed valid.
  customerName: '_',
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
  ...overrides,
});

const financeState: Record<string, any> = {
  assessmentContracts: [],
  contractAssessments: [],
  contractAmendments: [],
  walletTransactions: [],
  invoices: [],
  recurringInvoices: [],
  fetchFinanceData: vi.fn(async () => undefined),
  addAssessmentContract: vi.fn(async () => undefined),
  updateAssessmentContract: vi.fn(async () => undefined),
  deleteAssessmentContract: vi.fn(async () => undefined),
  addContractAssessment: vi.fn(async () => undefined),
  updateContractAssessment: vi.fn(async () => undefined),
  deleteContractAssessment: vi.fn(async () => undefined),
  addContractAmendment: vi.fn(async () => undefined),
  updateContractAmendment: vi.fn(async () => undefined),
  addWalletTransaction: vi.fn(async () => undefined),
  consumeContractAssessment: vi.fn(async () => ({ success: true })),
  cancelPrintingContract: vi.fn(async () => ({ success: true, already: false, releasedValue: 0 })),
  voidPrintingContract: vi.fn(async () => ({
    success: true, already: false, reversedValue: 0, releasedValue: 0, newBalance: 5000,
  })),
};

const salesState: Record<string, any> = {
  customers: [{ id: 'cust-1', name: 'Acme School Client', walletBalance: 5000 }],
  jobOrders: [],
  addJobOrder: vi.fn(async () => undefined),
  updateJobOrder: vi.fn(async () => undefined),
  fetchSalesData: vi.fn(async () => undefined),
};

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: { companyName: 'Prime ERP', currencySymbol: 'K' },
    notify: mockNotify,
    user: mockUser,
  }),
}));

vi.mock('../../stores/financeStore', () => ({
  useFinanceStore: Object.assign(
    (sel: (s: Record<string, any>) => unknown) => sel(financeState),
    { getState: () => financeState }
  ),
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

async function openDetails(contractNumber = 'PC-0001') {
  render(<PrintingContractsView />);
  await waitFor(() => {
    expect(screen.getByText(contractNumber)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(contractNumber));
  await waitFor(() => {
    expect(screen.getByText('Printing Jobs')).toBeTruthy();
  });
}

async function openEdit() {
  fireEvent.click(screen.getByText('Edit Contract'));
  await waitFor(() => {
    expect(screen.getByPlaceholderText('Enter customer name')).toBeTruthy();
  });
  return screen.getByPlaceholderText('Enter customer name') as HTMLInputElement;
}

describe('printing contract customer identity (PC-P726/024 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.assessmentContracts = [baseContract()];
    salesState.customers = [{ id: 'cust-1', name: 'Acme School Client', walletBalance: 5000 }];
    Object.keys(mockUser).forEach((k) => delete mockUser[k]);
    Object.assign(mockUser, { id: 'u-1', username: 'tester', role: 'Admin' });
  });

  it('shows the resolved business name in the contracts table, never the placeholder', async () => {
    render(<PrintingContractsView />);
    await waitFor(() => {
      expect(screen.getByText('PC-0001')).toBeTruthy();
    });
    expect(screen.getAllByText('Acme School Client').length).toBeGreaterThan(0);
    // The corrupted stored value and the raw id must not be rendered.
    expect(screen.queryByText('_')).toBeNull();
    expect(screen.queryByText('cust-1')).toBeNull();
  });

  it('prefills the edit form with the resolved name, not the stored placeholder', async () => {
    await openDetails();
    const input = await openEdit();
    expect(input.value).toBe('Acme School Client');
  });

  it('re-saves the resolved name and keeps the stable customer id', async () => {
    await openDetails();
    await openEdit();
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.customer_id).toBe('cust-1');
    expect(saved.customerName).toBe('Acme School Client');
    expect(saved.customerName).not.toBe('_');
    expect(saved.data.school_name).toBeUndefined();
  });

  it('keeps a valid stored legacy name when the customer is not in the loaded list', async () => {
    financeState.assessmentContracts = [
      baseContract({ customerName: 'Legacy Stored School' }),
    ];
    salesState.customers = [];
    await openDetails();
    const input = await openEdit();
    expect(input.value).toBe('Legacy Stored School');
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.customer_id).toBe('cust-1');
    expect(saved.customerName).toBe('Legacy Stored School');
  });

  it('blocks the save with an actionable error when nothing usable can be resolved', async () => {
    financeState.assessmentContracts = [
      baseContract({ customerName: '_', school_id: '', data: {} }),
    ];
    salesState.customers = [];
    await openDetails();
    await openEdit();
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => {
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/refresh the list and select the customer again/i),
        'error',
      );
    });
    // No placeholder may be written when the reference cannot be resolved.
    expect(financeState.updateAssessmentContract).not.toHaveBeenCalled();
  });
});
