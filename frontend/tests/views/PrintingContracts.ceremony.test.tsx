import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Signing ceremony through the real view: sequential order enforcement,
 * capture validation, and dual-signature persistence.
 * (Canvas draw pixels are not testable in jsdom — the upload path covers
 * the confirm flow; draw stroke-tracking is unit-guarded by design.)
 */
const mockNotify = vi.fn();
const mockFetchFinanceData = vi.fn(async () => undefined);
const mockFetchSalesData = vi.fn(async () => undefined);
const mockUser: Record<string, any> = { id: 'u-1', username: 'tester', role: 'Admin' };

const contractRow: Record<string, any> = {
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

const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function openDetails() {
  render(<PrintingContractsView />);
  await waitFor(() => {
    expect(screen.getByText('PC-0001')).toBeTruthy();
  });
  fireEvent.click(screen.getByText('PC-0001'));
  await waitFor(() => {
    expect(screen.getByText('Signatures')).toBeTruthy();
  });
}

async function uploadSignature(fileName = 'sig.png') {
  // Switch the capture component to its Upload tab first (Draw is default).
  fireEvent.click(screen.getByText('Upload'));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  const file = new File([Buffer.from(PNG_BYTES, 'base64')], fileName, { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => {
    expect(screen.getByAltText('Uploaded signature preview')).toBeTruthy();
  });
}

describe('signing ceremony', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.assessmentContracts = [{ ...contractRow, data: {} }];
  });

  it('disables customer signing until the company has signed', async () => {
    const { container } = render(<PrintingContractsView />);
    await waitFor(() => {
      expect(screen.getByText('PC-0001')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('PC-0001'));
    await waitFor(() => {
      expect(screen.getByText('Signatures')).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent || '').trim() === 'Sign'
    );
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[1].getAttribute('title')).toMatch(/company must sign first/i);
    expect(screen.getByText('Unsigned')).toBeTruthy();
  });

  it('records the company signature with name, role and image', async () => {
    await openDetails();
    const signButtons = screen.getAllByText('Sign');
    fireEvent.click(signButtons[0]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign as Company' })).toBeTruthy();
    });

    // Capture validation: role is required even with prefilled name.
    fireEvent.click(screen.getByRole('button', { name: 'Sign as Company' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Role is required/);

    fireEvent.change(screen.getByPlaceholderText('e.g. Sales Manager'), {
      target: { value: 'Sales Manager' },
    });
    await uploadSignature();
    fireEvent.click(screen.getByRole('button', { name: 'Sign as Company' }));

    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.data.signatures.company).toMatchObject({
      name: 'tester',
      role: 'Sales Manager',
      mode: 'Upload',
    });
    expect(saved.data.signatures.company.signatureDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(saved.data.signatures.customer).toBeNull();
    expect(saved.data.signatures.history).toHaveLength(1);
    expect(saved.data.signatures.history[0].type).toBe('signed');
  });

  it('completes the ceremony once the company has signed', async () => {    financeState.assessmentContracts = [{
      ...contractRow,
      data: {
        signatures: {
          company: {
            name: 'Jane Banda', role: 'Sales Manager',
            signatureDataUrl: `data:image/png;base64,${PNG_BYTES}`,
            mode: 'Upload', signedAt: new Date().toISOString(), signedBy: 'u-1',
          },
          customer: null,
          history: [{ type: 'signed', party: 'company', at: new Date().toISOString(), by: 'u-1' }],
        },
      },
    }];
    await openDetails();
    expect(screen.getByText('Partially signed')).toBeTruthy();

    // Company block now offers Re-sign; the customer block offers Sign.
    expect(screen.getByText('Re-sign')).toBeTruthy();
    const customerSign = screen.getByText('Sign') as HTMLButtonElement;
    expect(customerSign.disabled).toBe(false);
    fireEvent.click(customerSign);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign as Customer' })).toBeTruthy();
    });
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Peter Phiri' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Sales Manager'), { target: { value: 'Head Teacher' } });
    await uploadSignature();
    fireEvent.click(screen.getByRole('button', { name: 'Sign as Customer' }));

    await waitFor(() => {
      expect(financeState.updateAssessmentContract).toHaveBeenCalledTimes(1);
    });
    const saved = financeState.updateAssessmentContract.mock.calls[0][0];
    expect(saved.data.signatures.company?.name).toBe('Jane Banda');
    expect(saved.data.signatures.customer).toMatchObject({ name: 'Peter Phiri', role: 'Head Teacher' });
    expect(saved.data.signatures.history.map((h: any) => h.type)).toEqual(['signed', 'signed']);
  });
});

describe('contract document generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financeState.assessmentContracts = [{ ...contractRow, data: {} }];
  });

  it('opens the document preview for the selected contract', async () => {
    await openDetails();
    fireEvent.click(screen.getByText('Generate document'));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
    expect(screen.getByText(/Printing Contract PC-0001/)).toBeTruthy();
  });
});
