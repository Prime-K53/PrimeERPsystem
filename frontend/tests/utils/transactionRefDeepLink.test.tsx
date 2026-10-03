import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import {
  openTransactionRef,
  transactionRefKey,
  transactionRefUnavailableMessage,
  useTransactionRefTarget,
} from '../../hooks/useTransactionRefDeepLink';
import { resolveTransactionDestination } from '../../utils/transactionRef';

const invoices = [
  { id: 'i-1', invoiceNumber: 'INV-P726/021' },
  { id: 'i-2', invoiceNumber: 'INV-P726/022' },
];

describe('useTransactionRefTarget', () => {
  function Probe() {
    const ref = useTransactionRefTarget();
    const navigate = useNavigate();
    return (
      <div>
        <span data-testid="ref">{ref ? `${ref.type}:${ref.id}:${ref.number}` : 'none'}</span>
        <button
          onClick={() =>
            navigate(
              resolveTransactionDestination({ type: 'payment', id: 'p-1', number: 'RCP-1' })!.to,
            )
          }
        >
          go
        </button>
      </div>
    );
  }

  it('reads the reference from the query string', () => {
    render(
      <MemoryRouter initialEntries={['/sales-flow/invoices?txRef=invoice&txId=i-1&txNo=INV-P726%2F021']}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ref').textContent).toBe('invoice:i-1:INV-P726/021');
  });

  it('re-reads the reference on navigation (back / forward)', () => {
    render(
      <MemoryRouter initialEntries={['/reports']}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ref').textContent).toBe('none');
    act(() => {
      screen.getByText('go').click();
    });
    expect(screen.getByTestId('ref').textContent).toBe('payment:p-1:RCP-1');
  });

  it('ignores query strings that do not carry a supported reference', () => {
    render(
      <MemoryRouter initialEntries={['/fiscal-reports/ledgers?query=INV-1&accountId=1000']}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ref').textContent).toBe('none');
  });
});

describe('transactionRefKey', () => {
  it('is stable for the same reference and empty for none', () => {
    const a = { type: 'invoice' as const, id: 'i-1', number: 'INV-1' };
    expect(transactionRefKey(a)).toBe(transactionRefKey({ ...a }));
    expect(transactionRefKey({ ...a, id: 'i-2' })).not.toBe(transactionRefKey(a));
    expect(transactionRefKey(null)).toBe('');
  });
});

describe('openTransactionRef', () => {
  const ref = { type: 'invoice' as const, id: '', number: 'INV-P726/021' };

  it('returns "none" when there is no reference to open', () => {
    expect(openTransactionRef(invoices, null).status).toBe('none');
  });

  it('returns "none" when the reference targets a different type', () => {
    expect(openTransactionRef(invoices, ref, { expectType: 'payment' }).status).toBe('none');
  });

  it('opens the exact record', () => {
    const outcome = openTransactionRef(invoices, ref);
    expect(outcome.status).toBe('ok');
    expect(outcome.record).toBe(invoices[0]);
  });

  it('fails safely when the record is gone', () => {
    const outcome = openTransactionRef(invoices, { type: 'invoice', id: 'gone' });
    expect(outcome.status).toBe('missing');
    expect(outcome.record).toBeUndefined();
    expect(transactionRefUnavailableMessage(outcome)).toContain('no longer available');
  });

  it('refuses to open an ambiguous number', () => {
    const duplicated = [
      { id: 'a', invoiceNumber: 'INV-DUP/1' },
      { id: 'b', invoiceNumber: 'INV-DUP/1' },
    ];
    const outcome = openTransactionRef(duplicated, { type: 'invoice', number: 'INV-DUP/1' });
    expect(outcome.status).toBe('ambiguous');
    expect(outcome.record).toBeUndefined();
    expect(transactionRefUnavailableMessage(outcome)).toContain('More than one record matches');
  });
});