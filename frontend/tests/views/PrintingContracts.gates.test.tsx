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

async function openDetails() {
  const rendered = render(<PrintingContractsView />);
  await waitFor(() => {
    expect(screen.getByText('PC-0001')).toBeTruthy();
  });
  fireEvent.click(screen.getByText('PC-0001'));
  await waitFor(() => {
    expect(screen.getByText('Printing Jobs')).toBeTruthy();
  });
  return rendered;
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

  it('activates with verified stamp on paid-invoice evidence when wallet is funded', async () => {
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
    // No history-only wallet deposit at activation — prepaid funding is credited
    // when the invoice payment is confirmed (processInvoice/updateInvoice), not here.
    expect(financeState.addWalletTransaction).not.toHaveBeenCalled();
    // No override modal on the evidence path.
    expect(screen.queryByRole('heading', { name: 'Activate without payment evidence' })).toBeNull();
  });

  it('rejects activation when invoice is paid but wallet is unfunded', async () => {
    salesState.customers = [{ id: 'cust-1', name: 'Acme School Client', walletBalance: 0 }];
    financeState.assessmentContracts = [{ ...contractRow, data: { issued_invoice_id: 'INV-1' } }];
    financeState.invoices = [{ id: 'INV-1', status: 'Paid', totalAmount: 5000, paidAmount: 5000 }];
    await openDetails();
    fireEvent.click(screen.getByText('Verify & activate'));
    await waitFor(() => {
      expect(mockNotify).toHaveBeenCalledWith(
        'Contract cannot be activated: customer wallet is not funded. Confirm the invoice payment first.',
        'error'
      );
    });
    expect(financeState.updateAssessmentContract).not.toHaveBeenCalled();
  });
});

describe('cancel and void gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockUser).forEach((k) => delete mockUser[k]);
    Object.assign(mockUser, { id: 'u-1', username: 'tester', role: 'Admin' });
    salesState.customers = [{ id: 'cust-1', name: 'Acme School Client', walletBalance: 5000 }];
    financeState.invoices = [];
    financeState.contractAssessments = [
      { id: 'a-1', contract_id: 'c-1', assessment_name: 'Maths', status: 'consumed', item_price: 1000, version: 1 },
      { id: 'a-2', contract_id: 'c-1', assessment_name: 'English', status: 'reserved', item_price: 4000, version: 1 },
    ];
    financeState.cancelPrintingContract = vi.fn(async () => ({ success: true, already: false, releasedValue: 4000 }));
    financeState.voidPrintingContract = vi.fn(async () => ({
      success: true, already: false, reversedValue: 1000, releasedValue: 4000, newBalance: 5000,
    }));
  });

  it('cancel requires confirmation and states that consumed money is not returned', async () => {
    financeState.assessmentContracts = [{
      ...contractRow,
      status: 'active',
      prepaid_amount: 5000,
      consumed_amount: 1000,
      reserved_amount: 4000,
    }];
    await openDetails();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel printing contract' });
    expect(dialog.textContent).toMatch(/Consumed assessments \(K1,000\) and the money already charged are NOT returned/);
    expect(dialog.textContent).toMatch(/use Void instead/i);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel contract' }));
    await waitFor(() => {
      expect(financeState.cancelPrintingContract).toHaveBeenCalledWith({
        contractId: 'c-1',
        performedBy: 'u-1',
        reason: 'Cancelled from Printing Contracts',
      });
    });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringMatching(/Consumed assessments were NOT reversed/),
      'success',
    );
    expect(financeState.voidPrintingContract).not.toHaveBeenCalled();
  });

  it('void requires a reason and then reverses consumed money', async () => {
    financeState.assessmentContracts = [{
      ...contractRow,
      status: 'active',
      prepaid_amount: 5000,
      consumed_amount: 1000,
      reserved_amount: 4000,
    }];
    await openDetails();

    fireEvent.click(screen.getByRole('button', { name: /Void contract/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Void printing contract' })).toBeTruthy();
    });

    // Empty reason is refused; no service call is made.
    fireEvent.click(screen.getByRole('button', { name: 'Void contract — reverse consumed money' }));
    expect(mockNotify).toHaveBeenCalledWith('A reason is required to void a printing contract.', 'error');
    expect(financeState.voidPrintingContract).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Contract signed in error/), {
      target: { value: 'Contract signed in error' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Void contract — reverse consumed money' }));
    await waitFor(() => {
      expect(financeState.voidPrintingContract).toHaveBeenCalledWith({
        contractId: 'c-1',
        reason: 'Contract signed in error',
        performedBy: 'u-1',
      });
    });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringMatching(/returned to the customer wallet/),
      'success',
    );
  });

  it('hides every mutation action and shows the audit banner for a voided contract', async () => {
    financeState.assessmentContracts = [{
      ...contractRow,
      status: 'voided',
      prepaid_amount: 0,
      consumed_amount: 0,
      reserved_amount: 0,
      data: {
        void: {
          reason: 'Contract signed in error',
          reversedAmount: 1000,
          releasedAmount: 4000,
          at: '2026-10-01T10:00:00.000Z',
          by: 'u-1',
        },
      },
    }];
    const { container } = await openDetails();

    expect(screen.getByText('Contract voided — terminal')).toBeTruthy();
    expect(screen.getByText(/Reason: Contract signed in error/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Void contract' })).toBeNull();
    expect(screen.queryByText('Verify & activate')).toBeNull();
    expect(screen.queryByText('Edit Contract')).toBeNull();
    expect(screen.queryByText('Schedule Assessment')).toBeNull();
    expect(screen.queryByText('Request Amendment')).toBeNull();
    // List-row Edit/Delete icons are hidden too.
    expect(container.querySelector('[title="Delete"]')).toBeNull();
    expect(container.querySelector('[title="Edit"]')).toBeNull();
  });
});
