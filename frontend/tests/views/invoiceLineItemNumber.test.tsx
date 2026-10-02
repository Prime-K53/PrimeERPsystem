import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOnClose = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: { currencySymbol: 'K' },
    auditLogs: [],
    notify: vi.fn(),
    user: { role: 'Admin' },
  }),
}));

const financeInvoice: any = {
  id: 'INV-ITEM-1',
  invoiceNumber: 'INV-ITEM-1',
  customerId: 'CUST-1',
  customerName: 'Acme Ltd',
  date: '2026-09-10T10:00:00.000Z',
  dueDate: '2026-09-17T10:00:00.000Z',
  status: 'Unpaid',
  totalAmount: 2000,
  paidAmount: 0,
  items: [
    {
      id: 'line-1',
      productId: 'ITEM-1',
      name: 'A5 Full Colour Flyer',
      description: '150gsm gloss, single sided',
      quantity: 2,
      price: 1000,
    },
    {
      id: 'line-unknown',
      productId: 'NOPE-999',
      name: 'Custom service',
      quantity: 1,
      price: 500,
    },
  ],
};

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({
    customerPayments: [],
    invoices: [financeInvoice],
    deliveryNotes: [],
    ledger: [],
    accounts: [],
    updateCustomerPayment: vi.fn(),
    updateInvoice: vi.fn(),
    addCustomerPayment: vi.fn(),
    editInvoiceWithAdjustment: vi.fn(),
    postInvoiceCorrection: vi.fn(),
    getInvoiceVerificationToken: vi.fn(async () => null),
    getDocumentVerificationToken: vi.fn(async () => null),
    cancelInvoice: vi.fn(),
  }),
}));

vi.mock('../../context/SalesContext', () => ({
  useSales: () => ({ customers: [] }),
}));

vi.mock('../../context/ExaminationContext', () => ({
  useExamination: () => ({ batches: [] }),
}));

vi.mock('../../stores/inventoryStore', () => ({
  useInventoryStore: () => ({
    inventory: [{ id: 'ITEM-1', name: 'A5 Full Colour Flyer', sku: 'FG-FL-A5-4C', stock: 100 }],
  }),
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => ({ handlePreview: vi.fn() }),
}));

vi.mock('../../components/ai/AIDocumentSummarizer', () => ({
  default: () => null,
}));

vi.mock('../../views/sales/components/TransactionPricingInsights', () => ({
  default: () => null,
}));

import { InvoiceDetails } from '../../views/sales/components/InvoiceDetails';

describe('Invoice full detail — Overview line items show name + clickable item number', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderDetails = () =>
    render(
      <InvoiceDetails
        invoice={financeInvoice as any}
        onClose={mockOnClose}
        onEdit={vi.fn()}
        onAction={vi.fn()}
      />,
    );

  it('always shows the item name and the item number', () => {
    renderDetails();
    expect(screen.getByText('A5 Full Colour Flyer')).toBeInTheDocument();
    expect(screen.getByText('#FG-FL-A5-4C')).toBeInTheDocument();
    // Unmatched line still shows its reference number.
    expect(screen.getByText('Custom service')).toBeInTheDocument();
    expect(screen.getByText('#NOPE-999')).toBeInTheDocument();
  });

  it('opens the item detail page when the item number is clicked', () => {
    renderDetails();
    fireEvent.click(screen.getByTitle('Open item FG-FL-A5-4C details'));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/supply-chain/inventory/ITEM-1');
  });

  it('does not link the number when the item is not in inventory', () => {
    renderDetails();
    const fallback = screen.getByText('#NOPE-999');
    expect(fallback.tagName).toBe('P');
    expect(fallback.closest('button')).toBeNull();
  });
});
