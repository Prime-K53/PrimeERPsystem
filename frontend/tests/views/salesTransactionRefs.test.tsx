import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InvoiceList, QuotationList } from '../../views/sales/components/SalesLists';
import type { Invoice, Quotation } from '../../types';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    companyConfig: { currencySymbol: 'K' },
    notify: vi.fn(),
    user: { role: 'admin' },
  }),
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => ({ handlePreview: vi.fn(), handlePrint: vi.fn() }),
}));

vi.mock('../../services/invoiceRecoveryService', () => ({
  recoverInvoiceToCloud: vi.fn(async () => undefined),
}));

const invoices: Invoice[] = [
  {
    id: 'inv-1',
    invoiceNumber: 'INV-P726/021',
    customerId: 'c1',
    customerName: 'Acme Ltd',
    totalAmount: 1000,
    paidAmount: 0,
    date: '2026-09-10',
    dueDate: '2026-09-17',
    status: 'Unpaid',
  } as unknown as Invoice,
];

const quotations: Quotation[] = [
  {
    id: 'qt-1',
    quotationNumber: 'QT-P726/0007',
    customerId: 'c1',
    customerName: 'Acme Ltd',
    total: 500,
    date: '2026-09-09',
    status: 'Draft',
  } as unknown as Quotation,
];

function renderList(node: React.ReactElement, pathname: string) {
  return render(<MemoryRouter initialEntries={[pathname]}>{node}</MemoryRouter>);
}

describe('sales transaction references (representative module)', () => {
  it('renders invoice numbers as clickable references outside the invoices module', () => {
    const onView = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderList(
      <InvoiceList
        data={invoices}
        onView={onView}
        onEdit={onEdit}
        onDelete={onDelete}
        viewMode="List"
      />,
      '/revenue/contacts',
    );

    const link = screen.getByRole('link', { name: 'Open Invoice inv-1' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toContain('txRef=invoice');
    expect(link.getAttribute('href')).toContain('txId=inv-1');
    expect(link.getAttribute('href')).toContain('txNo=INV-P726%2F021');
  });

  it('renders quotation numbers as clickable references outside the quotations module', () => {
    renderList(
      <QuotationList
        data={quotations}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        viewMode="List"
      />,
      '/fiscal-reports/ledgers',
    );

    const link = screen.getByRole('link', { name: 'Open Quotation qt-1' });
    expect(link.getAttribute('href')).toContain('/sales-flow/quotations');
    expect(link.getAttribute('href')).toContain('txNo=QT-P726%2F0007');
  });

  it('keeps the reference plain on the owning page so the row action stays the only control', () => {
    const onView = vi.fn();
    renderList(
      <InvoiceList
        data={invoices}
        onView={onView}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        viewMode="List"
      />,
      '/sales-flow/invoices',
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('inv-1')).toBeInTheDocument();
  });

  it('leaves existing document actions working', () => {
    const onView = vi.fn();
    const onEdit = vi.fn();
    renderList(
      <InvoiceList
        data={invoices}
        onView={onView}
        onEdit={onEdit}
        onDelete={vi.fn()}
        viewMode="List"
      />,
      '/sales-flow/invoices',
    );

    // Preview + Edit buttons are unaffected by the reference change.
    fireEvent.click(screen.getByTitle('Preview PDF'));
    fireEvent.click(screen.getByTitle('Edit'));
    expect(onEdit).toHaveBeenCalledWith(invoices[0]);
  });
});