import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OrderForm } from '../../views/sales/components/OrderForm';

/**
 * Billing-account selection on the Sales Flow > Order Form.
 *
 * A customer that owns sub accounts must be able to say WHICH account the
 * document is billed to, and that choice (name + stable branch id) must reach
 * the saved document so the ledger / payment allocation scope by account
 * instead of collapsing everything into Main.
 */
const mocks = vi.hoisted(() => ({
  mockCompanyConfig: { currencySymbol: 'K' },
  mockUser: { name: 'Tester', username: 'tester' },
  mockNotify: vi.fn(),
  mockFinance: { invoices: [], recurringInvoices: [], accounts: [], ledger: [] },
  mockSales: {
    quotations: [],
    customerPayments: [],
    customers: [] as any[],
    addCustomer: vi.fn(),
  },
  mockInventoryCtx: { inventory: [], marketAdjustments: [], updateReservedStock: vi.fn(), addItem: vi.fn() },
  mockProcurement: { suppliers: [], addSupplier: vi.fn() },
  mockOrders: { createOrder: vi.fn(), orders: [] },
  mockPreview: { handlePreview: vi.fn() },
  mockAI: {
    loading: {},
    errors: {},
    suggestItems: vi.fn(),
    optimisePrice: vi.fn(),
    detectAnomalies: vi.fn(),
    generateDescription: vi.fn(),
    optimiseDiscount: vi.fn(),
  },
  mockNavigate: vi.fn(),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: mocks.mockCompanyConfig,
    notify: mocks.mockNotify,
    user: mocks.mockUser,
  }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => mocks.mockFinance,
}));

vi.mock('../../context/SalesContext', () => ({
  useSales: () => mocks.mockSales,
}));

vi.mock('../../context/InventoryContext', () => ({
  useInventory: () => mocks.mockInventoryCtx,
}));

vi.mock('../../context/ProcurementContext', () => ({
  useProcurement: () => mocks.mockProcurement,
}));

vi.mock('../../context/OrdersContext', () => ({
  useOrders: () => mocks.mockOrders,
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => mocks.mockPreview,
}));

vi.mock('../../hooks/useOrderFormAI', () => ({
  useOrderFormAI: () => mocks.mockAI,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, useNavigate: () => mocks.mockNavigate };
});

vi.mock('../../views/pos/components/PosModals', () => ({
  VariantSelectorModal: () => null,
  ServiceCalculatorModal: () => null,
}));

vi.mock('../../components/QuickPrintModal', () => ({ default: () => null }));
vi.mock('../../components/items/ItemModal', () => ({ ItemModal: () => null }));
vi.mock('../../components/AIGeneratorCard', () => ({ AIGeneratorCard: () => null }));
vi.mock('../../views/inventory/components/InventoryTransactionHistory', () => ({ default: () => null }));

const BRANCHED_CUSTOMER = {
  id: 'C-1',
  name: 'Branchy Ltd',
  email: 'branchy@example.com',
  phone: '0700000000',
  balance: 0,
  walletBalance: 0,
  creditLimit: 0,
  status: 'Active',
  segment: 'Corporate',
  subAccounts: [
    { id: 'SUB-FEES', name: 'Fees Office', accountNumber: 'ACC-001' },
    { id: 'SUB-BOARD', name: 'Boarding' },
  ],
};

const SIMPLE_CUSTOMER = {
  id: 'C-2',
  name: 'Simple Ltd',
  email: 'simple@example.com',
  phone: '',
  balance: 0,
  walletBalance: 0,
  creditLimit: 0,
  status: 'Active',
  segment: 'Individual',
  subAccounts: [],
};

const makeInitialData = (customer: typeof BRANCHED_CUSTOMER) => ({
  customerName: customer.name,
  customerId: customer.id,
  items: [
    { id: 'PROD-PEN', name: 'Pen', price: 500, quantity: 2, type: 'Product', category: 'Stationery', stock: 100 },
  ],
});

const selectBillingAccount = (value: string) => {
  const select = screen.getByDisplayValue(/Main Account|Fees Office|Boarding/) as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockSales.customers = [BRANCHED_CUSTOMER, SIMPLE_CUSTOMER];
});

describe('OrderForm billing account', () => {
  it('offers the billing account only when the customer has sub accounts', () => {
    const { unmount } = render(
      <OrderForm type="Invoice" initialData={makeInitialData(BRANCHED_CUSTOMER)} onSave={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByText('Billing Account')).toBeInTheDocument();
    const select = screen.getByDisplayValue('Main Account') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Main Account',
      'Boarding',
      'Fees Office · ACC-001',
    ]);
    unmount();

    render(
      <OrderForm type="Invoice" initialData={makeInitialData(SIMPLE_CUSTOMER)} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.queryByText('Billing Account')).not.toBeInTheDocument();
  });

  it('persists the chosen branch (name + stable id) on the order', async () => {
    render(
      <OrderForm type="Order" initialData={makeInitialData(BRANCHED_CUSTOMER)} onSave={vi.fn()} onCancel={vi.fn()} />
    );

    selectBillingAccount('SUB-FEES');
    fireEvent.click(screen.getByText('Save & Finalise'));

    await waitFor(() => expect(mocks.mockOrders.createOrder).toHaveBeenCalledTimes(1));
    const payload = mocks.mockOrders.createOrder.mock.calls[0][0];
    expect(payload.subAccountId).toBe('SUB-FEES');
    expect(payload.subAccountName).toBe('Fees Office');
  });

  it('defaults to Main and clears the branch id when Main is picked', async () => {
    const onSave = vi.fn();
    render(
      <OrderForm
        type="Order"
        initialData={{ ...makeInitialData(BRANCHED_CUSTOMER), subAccountId: 'SUB-BOARD', subAccountName: 'Boarding' }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue('Boarding')).toBeInTheDocument();
    selectBillingAccount('main');
    fireEvent.click(screen.getByText('Save & Finalise'));

    await waitFor(() => expect(mocks.mockOrders.createOrder).toHaveBeenCalledTimes(1));
    const payload = mocks.mockOrders.createOrder.mock.calls[0][0];
    expect(payload.subAccountName).toBe('Main');
    expect(payload.subAccountId).toBeUndefined();
  });

  it('carries the billing account onto an invoice and applies branch payment terms', async () => {
    const onSave = vi.fn();
    render(<OrderForm type="Invoice" initialData={makeInitialData(BRANCHED_CUSTOMER)} onSave={onSave} onCancel={vi.fn()} />);

    selectBillingAccount('SUB-BOARD');
    fireEvent.click(screen.getByText('Save & Finalise'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.subAccountId).toBe('SUB-BOARD');
    expect(saved.subAccountName).toBe('Boarding');
    // Sub-account documents run on the branch payment policy.
    expect(saved.paymentTerms).toBe('Net 30');
  });
});