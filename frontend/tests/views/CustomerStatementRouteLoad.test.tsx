import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CustomerStatement from '../../views/reports/CustomerStatement';

const mocks = vi.hoisted(() => ({
  mockCompanyConfig: { currencySymbol: 'K' },
  mockFinance: { invoices: [] },
  mockSales: {
    customers: [
      { id: 'C-1', name: 'Acme School', phone: '0991234567', email: 'acme@example.com' },
      { id: 'C-2', name: 'Beta College', phone: '', email: '' },
    ],
    customerPayments: [],
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ companyConfig: mocks.mockCompanyConfig }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => mocks.mockFinance,
}));

vi.mock('../../context/SalesContext', () => ({
  useSales: () => mocks.mockSales,
}));

vi.mock('../../stores/documentStore', () => ({
  useDocumentStore: () => ({ safeOpenPreview: vi.fn() }),
}));

const renderAt = (state: Record<string, string>) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/revenue/contacts', state }]}>
      <Routes>
        <Route path="/revenue/contacts" element={<CustomerStatement />} />
      </Routes>
    </MemoryRouter>
  );

describe('CustomerStatement auto-loads customer from route state', () => {
  // The selected customer renders in the Customer filter field (and the
  // statement header once rows exist) — assert via the filter field span.
  const expectCustomerLoaded = (name: string) => {
    const field = document.querySelector('span.text-xs.font-medium.truncate');
    expect(field).not.toBeNull();
    expect(field!.textContent).toBe(name);
  };

  it('shows the customer name passed from the customer card', () => {
    renderAt({ customerId: 'C-1', customerName: 'Acme School' });
    expectCustomerLoaded('Acme School');
  });

  it('resolves the customer by name when only customerName is passed', () => {
    renderAt({ customerName: 'Beta College' });
    expectCustomerLoaded('Beta College');
  });

  it('supports the ?customerId= query param', () => {
    render(
      <MemoryRouter initialEntries={['/revenue/contacts?customerId=C-2']}>
        <Routes>
          <Route path="/revenue/contacts" element={<CustomerStatement />} />
        </Routes>
      </MemoryRouter>
    );
    expectCustomerLoaded('Beta College');
  });

  it('does not auto-load for an unknown customer id', () => {
    renderAt({ customerId: 'NOPE', customerName: 'Ghost' });
    expect(screen.queryByText('Ghost')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search by name, phone, email…')).toBeInTheDocument();
  });

  it('a manual Change clears the selection without the route state overriding it', () => {
    const { unmount } = renderAt({ customerId: 'C-1', customerName: 'Acme School' });
    expectCustomerLoaded('Acme School');
    fireEvent.click(screen.getByText('Change'));
    expect(screen.queryByText('Acme School')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search by name, phone, email…')).toBeInTheDocument();
    unmount();
  });

  it('bill details render CartItem-shaped lines with computed totals', () => {
    mocks.mockFinance.invoices = [
      {
        id: 'INV-1',
        customerId: 'C-1',
        date: '2026-09-05',
        invoiceNumber: 'INV-1',
        items: [{ id: 'PROD-PEN', name: 'Pen', quantity: 18, price: 6000 }],
        totalAmount: 108000,
        paidAmount: 0,
        status: 'Unpaid',
      },
    ];
    try {
      renderAt({ customerId: 'C-1', customerName: 'Acme School' });
      expectCustomerLoaded('Acme School');
      // Bill Details off by default: no item rows.
      expect(screen.queryByText('Pen')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Display Settings'));
      fireEvent.click(screen.getByText('Bill Details'));
      // name -> Description, quantity -> Qty, price -> Price, qty*price -> Total.
      expect(screen.getByText('Pen')).toBeInTheDocument();
      expect(screen.getByText('18')).toBeInTheDocument();
      expect(screen.getByText('K6,000.00')).toBeInTheDocument();
      // Item Total also matches the statement outstanding summary.
      expect(screen.getAllByText('K108,000.00').length).toBeGreaterThanOrEqual(1);
    } finally {
      mocks.mockFinance.invoices = [];
    }
  });

  it('customer dropdown shows all 65 customers instead of silently cutting at 30', () => {
    mocks.mockSales.customers = Array.from({ length: 65 }, (_, i) => ({
      id: `C-${i + 1}`,
      name: `Customer ${i + 1}`,
      phone: '',
      email: '',
    }));
    try {
      renderAt({});
      fireEvent.focus(screen.getByPlaceholderText('Search by name, phone, email…'));
      // Previously sliced at 30 — the last customer was unreachable.
      expect(screen.getByText('Customer 65')).toBeInTheDocument();
      expect(screen.queryByText(/Showing \d+ of \d+ customers/)).not.toBeInTheDocument();
    } finally {
      mocks.mockSales.customers = [
        { id: 'C-1', name: 'Acme School', phone: '0991234567', email: 'acme@example.com' },
        { id: 'C-2', name: 'Beta College', phone: '', email: '' },
      ];
    }
  });

  it('customer dropdown warns when the 100-row cap hides matches', () => {
    mocks.mockSales.customers = Array.from({ length: 120 }, (_, i) => ({
      id: `C-${i + 1}`,
      name: `Customer ${i + 1}`,
      phone: '',
      email: '',
    }));
    try {
      renderAt({});
      fireEvent.focus(screen.getByPlaceholderText('Search by name, phone, email…'));
      expect(screen.getByText('Showing 100 of 120 customers — type to narrow the search…')).toBeInTheDocument();
    } finally {
      mocks.mockSales.customers = [
        { id: 'C-1', name: 'Acme School', phone: '0991234567', email: 'acme@example.com' },
        { id: 'C-2', name: 'Beta College', phone: '', email: '' },
      ];
    }
  });
});
