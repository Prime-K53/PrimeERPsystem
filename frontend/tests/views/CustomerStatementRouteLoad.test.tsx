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
});
