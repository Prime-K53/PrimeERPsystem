import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { mapErpDataToDocument } from '../../utils/documentMapper';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import { buildPosReceiptDoc } from '../../services/receiptCalculationService';
import { getQuickPhotocopyLineDisplay } from '../../services/quickPhotocopyService';
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

describe('Quick Photocopy custom display name across surfaces', () => {
  const makeQPCustom = () => {
    const base: any = makeQP13();
    return {
      ...base,
      serviceDetails: { ...base.serviceDetails, customName: 'SIG Budget' },
    };
  };

  it('invoice preview shows SIG Budget with unchanged qty/rate/amount', () => {
    const { content } = mapErpDataToDocument('Invoice', {
      id: 'INV-QP-CUSTOM',
      date: '2026-09-17',
      customerName: 'Test Customer',
      currencySymbol: 'K',
      items: [{ ...makeQPCustom(), total: 1050, unitPrice: 150 }],
      subtotal: 1050,
      total: 1050,
    });

    const { container } = render(<div>{content}</div>);

    expect(screen.getByText('SIG Budget')).toBeInTheDocument();
    expect(screen.queryByText('Quick Photocopy')).not.toBeInTheDocument();
    expect(screen.getByText('13 pgs')).toBeInTheDocument();
    expect(screen.getByText('K 150.00/sht')).toBeInTheDocument();
    expect(screen.getAllByText('K1,050.00').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent?.match(/\/sht/g)?.length ?? 0).toBe(1);
  });

  it('quotation preview shows SIG Budget with unchanged amount', () => {
    const { content } = mapErpDataToDocument('Quotation', {
      id: 'QUO-QP-CUSTOM',
      date: '2026-09-17',
      customerName: 'Test Customer',
      currencySymbol: 'K',
      items: [{ ...makeQPCustom(), total: 1050, unitPrice: 150 }],
      subtotal: 1050,
      total: 1050,
    });

    render(<div>{content}</div>);

    expect(screen.getByText('SIG Budget')).toBeInTheDocument();
    expect(screen.getByText('13 pgs')).toBeInTheDocument();
    expect(screen.getByText('K 150.00/sht')).toBeInTheDocument();
  });

  it('POS cart row shows SIG Budget + 13 pgs @ K 150.00/sht with unchanged amount', () => {
    const { container } = render(
      <CartItemRow
        item={makeQPCustom() as any}
        updateQuantity={() => undefined}
        updatePrice={() => undefined}
        removeFromCart={() => undefined}
      />
    );

    expect(screen.getByText('SIG Budget')).toBeInTheDocument();
    expect(screen.getByText('13 pgs @ K 150.00/sht')).toBeInTheDocument();
    const row = container.firstChild as HTMLElement;
    expect(row.textContent).toContain('1,050');
    expect(row.textContent).not.toContain('Quick Photocopy');
  });

  it('POS receipt carries SIG Budget as desc with unchanged total', () => {
    const sale: any = {
      id: 'SALE-QP-CUSTOM',
      date: new Date().toISOString(),
      customerName: 'Walk-in Customer',
      items: [makeQPCustom()],
      subtotal: 1050,
      discount: 0,
      totalAmount: 1050,
      paymentMethod: 'Cash',
      payments: [{ method: 'Cash', amount: 1050 }],
    };
    const receipt: any = buildPosReceiptDoc({
      sale,
      cashierName: 'Cashier',
      itemDescriptionFormatter: (lineItem: any) =>
        getQuickPhotocopyLineDisplay(lineItem, 'K').name,
    });
    expect(receipt.items[0].desc).toBe('SIG Budget');
    expect(receipt.items[0].qty).toBe(7);
    expect(receipt.items[0].total).toBe(1050);
    expect(receipt.totalAmount).toBe(1050);
  });

  it('delivery note shows SIG Budget with pages qty', () => {
    const { content } = mapErpDataToDocument('Delivery Note', {
      id: 'DN-QP-CUSTOM',
      date: '2026-09-17',
      customerName: 'Test Customer',
      currencySymbol: 'K',
      items: [{ ...makeQPCustom(), total: 1050, unitPrice: 150 }],
    });

    const { container } = render(<div>{content}</div>);

    expect(screen.getByText('SIG Budget')).toBeInTheDocument();
    expect(screen.getByText('13 pgs')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Quick Photocopy');
  });

  it('generated document mapping preserves customName and QP totals', () => {
    for (const docType of ['INVOICE', 'QUOTATION', 'SALES_ORDER'] as const) {
      const mapped: any = mapToInvoiceData(
        {
          id: 'DOC-QP-CUSTOM',
          customerName: 'Test Customer',
          totalAmount: 1050,
          items: [makeQPCustom()],
        },
        { currencySymbol: 'K' } as any,
        docType
      );
      expect(mapped.items[0].serviceDetails.customName).toBe('SIG Budget');
      expect(mapped.items[0].total).toBe(1050);
      expect(mapped.items[0].price).toBe(150);
    }
  });
});
