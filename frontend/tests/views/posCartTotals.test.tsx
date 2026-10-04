import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CartSidebar } from '../../views/pos/components/CartSidebar';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ companyConfig: { currencySymbol: 'K' } }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({ invoices: [] }),
}));

const line = (over: Record<string, unknown> = {}) => ({
  id: 'PROD-RECEIPT-M',
  name: 'Receipt Book - M',
  sku: 'RB-M',
  price: 6000,
  cost: 3163.5,
  quantity: 1,
  type: 'Product',
  ...over,
}) as any;

const renderSidebar = (props: Partial<React.ComponentProps<typeof CartSidebar>> = {}) =>
  render(
    <CartSidebar
      cart={[line()]}
      sales={[]}
      selectedCustomerName={null}
      selectedSubAccount=""
      setSelectedSubAccount={() => undefined}
      onSelectCustomer={() => undefined}
      updateQuantity={() => undefined}
      updatePrice={() => undefined}
      resetPriceOverride={() => undefined}
      removeFromCart={() => undefined}
      clearCart={() => undefined}
      onPark={() => undefined}
      onReturn={() => undefined}
      onPay={() => undefined}
      totals={{ subtotal: 6000, total: 6000 }}
      {...props}
    />
  );

describe('POS order totals block', () => {
  it('reports Subtotal as the line amount, never the cost', () => {
    const { container } = renderSidebar();

    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getAllByText('K6,000.00').length).toBeGreaterThanOrEqual(1);
    // Cost is 3,163.50 — printing it under the word "Subtotal" was the defect.
    expect(container.textContent).not.toMatch(/3,163\.50/);
  });

  it('keeps Subtotal − Discount = Total', () => {
    renderSidebar({ manualDiscountPercent: 10 });

    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('Discount 10%')).toBeInTheDocument();
    expect(screen.getByText('−K600.00')).toBeInTheDocument();
    // 6000 − 600
    expect(screen.getByText('K5,400.00')).toBeInTheDocument();
  });

  it('shows adjustments as a memo of the line prices, never as an addend', () => {
    renderSidebar({
      adjustmentSummary: [{ adjustmentId: 'ADJ-1', adjustmentName: 'Market', totalAmount: 2836.5, itemCount: 1 }],
    });

    expect(screen.getByText('Includes adjustments K2,836.50')).toBeInTheDocument();
    // The old block carried a bare "Adjustments" row that read as a charge on
    // top of a subtotal which already contained it.
    expect(screen.queryByText('Adjustments')).not.toBeInTheDocument();
  });

  it('makes the amount due the single largest number on the column', () => {
    renderSidebar();

    const total = screen.getByText('K6,000.00', { selector: 'span[style*="28px"]' });
    expect(total).toBeInTheDocument();
    expect(Number.parseFloat(total.style.fontSize)).toBeGreaterThanOrEqual(24);
  });
});