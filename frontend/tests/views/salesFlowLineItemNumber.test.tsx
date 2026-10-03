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
    notify: vi.fn(),
  }),
}));

vi.mock('../../stores/inventoryStore', () => ({
  useInventoryStore: () => ({
    inventory: [{ id: 'ITEM-1', name: 'A5 Flyer', sku: 'FG-FL-A5-4C' }],
  }),
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => ({ handlePreview: vi.fn() }),
}));

vi.mock('../../hooks/useDocumentVerificationLink', () => ({
  useDocumentVerificationLink: () => ({
    copyVerificationLink: vi.fn(),
    openVerificationLink: vi.fn(),
  }),
}));

vi.mock('../../views/sales/components/TransactionPricingInsights', () => ({
  default: () => null,
}));

vi.mock('../../views/shared/components/AuditTimeline', () => ({
  AuditTimeline: () => null,
}));

const currencyServiceMock = vi.hoisted(() => ({ symbol: 'K' }));
vi.mock('../../services/currencyService', () => ({
  currencyService: {
    getCurrency: () => currencyServiceMock,
    getBaseCurrency: () => 'USD',
  },
}));

const salesOrder: any = {
  id: 'SO-1',
  orderNumber: 'SO-1',
  customerId: 'CUST-1',
  customerName: 'Acme Ltd',
  orderDate: '2026-09-10T10:00:00.000Z',
  createdBy: 'admin',
  status: 'Processing',
  items: [
    {
      id: 'line-1',
      productId: 'ITEM-1',
      productName: 'A5 Full Colour Flyer',
      quantity: 2,
      unitPrice: 1000,
      subtotal: 2000,
    },
    {
      id: 'line-unknown',
      productId: 'NOPE-999',
      productName: 'Custom service',
      quantity: 1,
      unitPrice: 500,
      subtotal: 500,
    },
  ],
  payments: [],
};

const quotation: any = {
  id: 'QT-1',
  customerId: 'CUST-1',
  customerName: 'Acme Ltd',
  date: '2026-09-10T10:00:00.000Z',
  status: 'Draft',
  total: 2500,
  items: [
    {
      id: 'qline-1',
      productId: 'ITEM-1',
      name: 'A5 Full Colour Flyer',
      quantity: 2,
      price: 1000,
    },
    {
      id: 'qline-unknown',
      productId: 'NOPE-999',
      name: 'Custom service',
      quantity: 1,
      price: 500,
    },
  ],
};

vi.mock('../../context/OrdersContext', () => ({
  useOrders: () => ({ orders: [salesOrder] }),
}));

vi.mock('../../context/SalesContext', () => ({
  useSales: () => ({ quotations: [quotation] }),
}));

import { OrderDetails } from '../../views/sales/components/OrderDetails';
import { QuotationDetails } from '../../views/sales/components/QuotationDetails';

describe('Sales flow detail modals — line items show name + clickable SKU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Order details', () => {
    const renderDetails = () =>
      render(
        <OrderDetails
          order={salesOrder}
          onClose={mockOnClose}
          onEdit={vi.fn()}
          onAction={vi.fn()}
        />,
      );

    it('shows the item name and its SKU number', () => {
      renderDetails();
      expect(screen.getByText('A5 Full Colour Flyer')).toBeInTheDocument();
      expect(screen.getByText('#FG-FL-A5-4C')).toBeInTheDocument();
    });

    it('opens the item detail page when the SKU is clicked', () => {
      renderDetails();
      fireEvent.click(screen.getByTitle('Open item FG-FL-A5-4C details'));
      expect(mockOnClose).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/supply-chain/inventory/ITEM-1');
    });

    it('does not link a line that is not in inventory', () => {
      renderDetails();
      const fallback = screen.getByText('#NOPE-999');
      expect(fallback.tagName).toBe('P');
      expect(fallback.closest('button')).toBeNull();
    });
  });

  describe('Quotation details', () => {
    const renderDetails = () =>
      render(
        <QuotationDetails
          quotation={quotation}
          onClose={mockOnClose}
          onEdit={vi.fn()}
          onAction={vi.fn()}
        />,
      );

    it('shows the item name and its SKU number', () => {
      renderDetails();
      expect(screen.getByText('A5 Full Colour Flyer')).toBeInTheDocument();
      expect(screen.getByText('#FG-FL-A5-4C')).toBeInTheDocument();
    });

    it('opens the item detail page when the SKU is clicked', () => {
      renderDetails();
      fireEvent.click(screen.getByTitle('Open item FG-FL-A5-4C details'));
      expect(mockOnClose).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/supply-chain/inventory/ITEM-1');
    });

    it('does not link a line that is not in inventory', () => {
      renderDetails();
      const fallback = screen.getByText('#NOPE-999');
      expect(fallback.tagName).toBe('P');
      expect(fallback.closest('button')).toBeNull();
    });
  });
});
