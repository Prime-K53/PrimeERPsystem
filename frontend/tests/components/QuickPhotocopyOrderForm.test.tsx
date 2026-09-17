import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrderForm } from '../../views/sales/components/OrderForm';

// Stable identities across renders: OrderForm effects depend on these, so
// fresh object literals per hook call would loop the renderer out of memory.
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

// Keep the render graph light: modal/panel children are irrelevant to the
// line-item display under test.
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

/**
 * Production-shaped Quick Photocopy line:
 * 13 entered pages, 1 copy, K150/sheet → 7 billable sheets → K1,050.
 */
const makeQP13 = () => ({
  id: 'QUICK-PHOTO-TEST-13x1',
  itemId: 'SVC-PHOTOCOPY',
  sku: 'QUICK-PHOTO',
  name: 'Quick Photocopy',
  desc: 'Quick Photocopy',
  price: 150,
  quantity: 7,
  unit: 'sheet',
  category: 'Service',
  type: 'Service',
  billableSheets: 7,
  qpPages: 13,
  qpCopies: 1,
  serviceDetails: {
    pages: 13,
    copies: 1,
    totalPages: 13,
    billableSheets: 7,
    pricePerSheet: 150,
  },
});

describe('Order Form Quick Photocopy line display', () => {
  it('shows Quick Photocopy | 13 pgs | K 150.00/sht with unchanged amount', () => {
    const { container } = render(
      <OrderForm
        type="Invoice"
        initialData={{
          customerName: 'Test Customer',
          customerId: 'C-1',
          items: [makeQP13()],
        }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('Quick Photocopy')).toBeInTheDocument();
    expect(screen.getByText('13 pgs')).toBeInTheDocument();
    expect(screen.getByText('K 150.00/sht')).toBeInTheDocument();
    // Amount still sheets × price (7 × 150 = K1,050.00), display only.
    // (JSX splits currency/number into adjacent text nodes, so match HTML.)
    expect(container.textContent).toContain('K1,050.00');
    // Rate exactly once; no legacy long forms in the form.
    expect(container.textContent?.match(/\/sht/g)?.length ?? 0).toBe(1);
    expect(container.textContent).not.toContain('/sheet');
    expect(container.textContent).not.toContain('pages');
  });
});
