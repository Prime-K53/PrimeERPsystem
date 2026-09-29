import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OrderForm } from '../../views/sales/components/OrderForm';

// Same light render graph as QuickPhotocopyOrderForm.test.tsx: OrderForm
// effects depend on stable identities, modal/panel children are stubbed.
const mocks = vi.hoisted(() => ({
  mockCompanyConfig: {
    currencySymbol: 'K',
    transactionSettings: { pos: { photocopyPrice: 150 } },
  },
  mockUser: { name: 'Tester', username: 'tester' },
  mockNotify: vi.fn(),
  mockFinance: { invoices: [], recurringInvoices: [], accounts: [], ledger: [] },
  mockSales: { quotations: [], customerPayments: [], customers: [], addCustomer: vi.fn() },
  mockInventoryCtx: {
    inventory: [],
    marketAdjustments: [],
    updateReservedStock: vi.fn(),
    addItem: vi.fn(),
  },
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

vi.mock('../../components/QuickPrintModal', () => ({
  default: () => null,
}));

vi.mock('../../components/items/ItemModal', () => ({
  ItemModal: () => null,
}));

vi.mock('../../components/AIGeneratorCard', () => ({
  AIGeneratorCard: () => null,
}));

vi.mock('../../views/inventory/components/InventoryTransactionHistory', () => ({
  default: () => null,
}));

const makeItems = () => ([
  { id: 'PROD-PEN', name: 'Pen', price: 500, quantity: 2, type: 'Product', category: 'Stationery', stock: 100 },
  { id: 'PROD-PENCIL', name: 'Pencil', price: 200, quantity: 3, type: 'Product', category: 'Stationery', stock: 100 },
]);

const makeInitialData = (id: string) => ({
  id,
  customerName: 'Test Customer',
  customerId: 'C-1',
  status: 'Unpaid',
  items: makeItems(),
});

const removeFirstGridRow = (container: HTMLElement) => {
  const table = container.querySelector('table');
  expect(table).not.toBeNull();
  const buttons = within(table as HTMLElement).getAllByRole('button');
  expect(buttons.length).toBeGreaterThan(0);
  fireEvent.click(buttons[0]);
};

describe('OrderForm edit mode survives background refreshes', () => {
  it('a removed item stays removed when the parent re-provides the same document', () => {
    const { container, rerender } = render(
      <OrderForm
        type="Invoice"
        initialData={makeInitialData('INV-EDIT-1')}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('Pen')).toBeInTheDocument();
    expect(screen.getByText('Pencil')).toBeInTheDocument();

    removeFirstGridRow(container);
    expect(screen.queryByText('Pen')).not.toBeInTheDocument();
    expect(screen.getByText('Pencil')).toBeInTheDocument();

    // Simulate a background sync/poll refresh: same document id, fresh
    // object identity, original (unsaved) items — as produced when
    // `invoices` is re-read from IndexedDB after refreshAllData.
    rerender(
      <OrderForm
        type="Invoice"
        initialData={makeInitialData('INV-EDIT-1')}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Regression: without the edit-init guard the removed item reappears.
    expect(screen.queryByText('Pen')).not.toBeInTheDocument();
    expect(screen.getByText('Pencil')).toBeInTheDocument();
  });

  it('switching to a different document re-initializes the form', () => {
    const { container, rerender } = render(
      <OrderForm
        type="Invoice"
        initialData={makeInitialData('INV-EDIT-1')}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    removeFirstGridRow(container);
    expect(screen.queryByText('Pen')).not.toBeInTheDocument();

    rerender(
      <OrderForm
        type="Invoice"
        initialData={makeInitialData('INV-EDIT-2')}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('Pen')).toBeInTheDocument();
    expect(screen.getByText('Pencil')).toBeInTheDocument();
  });
});
