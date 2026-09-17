import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { mapErpDataToDocument } from '../../utils/documentMapper';
import { CartItemRow } from '../../views/pos/components/CartSidebar';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ companyConfig: { currencySymbol: 'K' } }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({ invoices: [] }),
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

describe('Quick Photocopy line display across surfaces', () => {
  it('generated document (invoice preview) shows Quick Photocopy | 13 pgs | K 150.00/sht | K1,050.00', () => {
    const { content } = mapErpDataToDocument('Invoice', {
      id: 'INV-QP-13',
      date: '2026-09-17',
      customerName: 'Test Customer',
      currencySymbol: 'K',
      items: [{ ...makeQP13(), total: 1050, unitPrice: 150 }],
      subtotal: 1050,
      total: 1050,
    });

    const { container } = render(<div>{content}</div>);

    expect(screen.getByText('Quick Photocopy')).toBeInTheDocument();
    expect(screen.getByText('13 pgs')).toBeInTheDocument();
    expect(screen.getByText('K 150.00/sht')).toBeInTheDocument();
    // Line amount (also reflected in the summary subtotal/total cells).
    expect(screen.getAllByText('K1,050.00').length).toBeGreaterThanOrEqual(1);
    // Rate exactly once; no legacy long forms anywhere in the table.
    expect(container.textContent?.match(/\/sht/g)?.length ?? 0).toBe(1);
    expect(container.textContent).not.toContain('/sheet');
    expect(container.textContent).not.toContain('pages');
    // Template columns unchanged.
    for (const header of ['Description', 'Qty', 'Price', 'Amount']) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
  });

  it('generated document leaves normal products untouched', () => {
    const { content } = mapErpDataToDocument('Invoice', {
      id: 'INV-MIX-1',
      date: '2026-09-17',
      customerName: 'Test Customer',
      currencySymbol: 'K',
      items: [
        { ...makeQP13(), total: 1050, unitPrice: 150 },
        { id: 'PROD-001', name: 'Pen', quantity: 3, unitPrice: 500, total: 1500 },
      ],
      subtotal: 2550,
      total: 2550,
    });

    const { container } = render(<div>{content}</div>);

    expect(screen.getByText('Pen')).toBeInTheDocument();
    expect(screen.getByText('K500.00')).toBeInTheDocument();
    // Still exactly one rate on the whole document (the QP line only).
    expect(container.textContent?.match(/\/sht/g)?.length ?? 0).toBe(1);
  });

  it('POS cart row shows Quick Photocopy + 13 pgs @ K 150.00/sht with unchanged amount', () => {
    const { container } = render(
      <CartItemRow
        item={makeQP13() as any}
        updateQuantity={() => undefined}
        updatePrice={() => undefined}
        removeFromCart={() => undefined}
      />
    );

    expect(screen.getByText('Quick Photocopy')).toBeInTheDocument();
    expect(screen.getByText('13 pgs @ K 150.00/sht')).toBeInTheDocument();
    // Amount still sheets × price (7 × 150), display only.
    const row = container.firstChild as HTMLElement;
    expect(row.textContent).toContain('1,050');
    // Rate exactly once; no legacy long forms in the row.
    expect(row.textContent?.match(/\/sht/g)?.length ?? 0).toBe(1);
    expect(row.textContent).not.toContain('/sheet');
    expect(row.textContent).not.toContain('pages');
    expect(within(row).getByText('Quick Photocopy').textContent).not.toContain('—');
  });
});
