import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { TransactionRefLink } from '../../components/TransactionRefLink';

function renderAt(path: string, ui: React.ReactElement, initialEntry = path) {
  const seen: { pathname: string; search: string }[] = [];
  function Probe() {
    const location = useLocation();
    seen.push({ pathname: location.pathname, search: location.search });
    return null;
  }
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="*" element={<>{ui}<Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return { seen };
}

describe('TransactionRefLink', () => {
  it('opens the exact invoice from its number', () => {
    const { seen } = renderAt(
      '/dashboard',
      <TransactionRefLink type="invoice" id="INV-1" number="INV-P726/021" />,
    );
    const link = screen.getByRole('link', { name: 'Open Invoice INV-P726/021' });
    expect(link.getAttribute('href')).toContain('txRef=invoice');
    expect(link.getAttribute('href')).toContain('txNo=INV-P726%2F021');
    fireEvent.click(link);
    const last = seen[seen.length - 1];
    expect(last.pathname).toBe('/sales-flow/invoices');
    expect(last.search).toContain('txId=INV-1');
    expect(last.search).toContain('txNo=INV-P726%2F021');
  });

  it.each([
    ['quotation', 'QT-1', 'Open Quotation QT-1'],
    ['order', 'ORD-1', 'Open Order ORD-1'],
    ['payment', 'PMT-1', 'Open Payment PMT-1'],
    ['receipt', 'RCP-1', 'Open Receipt RCP-1'],
    ['purchase', 'PO-1', 'Open Purchase bill PO-1'],
    ['purchase-order', 'PO-1', 'Open Purchase order PO-1'],
    ['delivery-note', 'DN-1', 'Open Delivery note DN-1'],
  ])('renders an accessible link for %s references', (type, number, name) => {
    renderAt('/dashboard', <TransactionRefLink type={type} id={number} number={number} />);
    expect(screen.getByRole('link', { name })).toBeInTheDocument();
  });

  it('sends examination batch references straight to the batch detail route', () => {
    renderAt('/dashboard', <TransactionRefLink type="examination-batch" id="batch-7" number="EXM-1" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/examination/batches/batch-7');
  });

  it('survives URL-encoded references containing slashes', () => {
    renderAt('/dashboard', <TransactionRefLink type="invoice" number="INV-P726/021" />);
    const href = screen.getByRole('link').getAttribute('href') || '';
    expect(href).toContain('INV-P726%2F021');
    expect(href).not.toContain('INV-P726/021&');
  });

  it('renders plain text when the reference cannot be resolved', () => {
    const { container } = render(
      <MemoryRouter>
        <TransactionRefLink type="invoice" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders plain text for an unknown transaction type', () => {
    renderAt('/dashboard', <TransactionRefLink type="mystery" number="X-1" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('X-1')).toBeInTheDocument();
  });

  it('renders plain text on its own destination page to avoid a duplicate control', () => {
    renderAt(
      '/sales-flow/invoices',
      <TransactionRefLink type="invoice" id="INV-1" number="INV-1" />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
  });

  it('stays a link on the destination page when alwaysLink is set', () => {
    renderAt(
      '/sales-flow/invoices',
      <TransactionRefLink type="invoice" id="INV-1" number="INV-1" alwaysLink />,
    );
    expect(screen.getByRole('link')).toBeInTheDocument();
  });

  it('does not trigger the enclosing clickable row', () => {
    const onRowClick = vi.fn();
    renderAt(
      '/dashboard',
      <div>
        <table>
          <tbody>
            <tr onClick={onRowClick}>
              <td>
                <TransactionRefLink type="invoice" id="INV-1" number="INV-1" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('opens the referenced invoice rather than the row action', () => {
    const onRowClick = vi.fn();
    const { seen } = renderAt(
      '/reports',
      <table>
        <tbody>
          <tr onClick={onRowClick}>
            <td>
              <TransactionRefLink type="invoice" id="INV-9" number="INV-P726/021" />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(onRowClick).not.toHaveBeenCalled();
    const last = seen[seen.length - 1];
    expect(last.pathname).toBe('/sales-flow/invoices');
    expect(last.search).toContain('txRef=invoice');
    expect(last.search).toContain('txId=INV-9');
  });

  it('is keyboard focusable and activates with Enter', () => {
    renderAt('/dashboard', <TransactionRefLink type="invoice" id="INV-1" number="INV-1" />);
    const link = screen.getByRole('link');
    link.focus();
    expect(document.activeElement).toBe(link);
    // Real anchors turn Enter into a click; assert the accessible contract that
    // makes that work rather than emulating a browser default we do not own.
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href');
  });

  it('leaves modified clicks (new tab) to the browser', () => {
    renderAt('/dashboard', <TransactionRefLink type="invoice" id="INV-1" number="INV-1" />);
    const link = screen.getByRole('link');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    const prevented = !link.dispatchEvent(evt);
    expect(prevented).toBe(false);
  });

  it('uses the supplied display label but the authoritative identity', () => {
    renderAt('/dashboard', <TransactionRefLink type="invoice" id="internal-42" number="INV-P726/021" label="INV-1" />);
    expect(screen.getByRole('link', { name: 'Open Invoice INV-1' })).toBeInTheDocument();
    expect(screen.getByRole('link').getAttribute('data-tx-ref-target')).toContain('txId=internal-42');
  });

  it('falls back to a plain hash href when rendered outside a Router', () => {
    // A few ERP views are unit-mounted standalone; the anchor must still be
    // valid markup rather than crashing on a missing Router context.
    const { onUnavailable } = { onUnavailable: undefined as undefined | (() => void) };
    render(
      <TransactionRefLink
        type="invoice"
        id="INV-1"
        number="INV-1"
        onUnavailable={onUnavailable ? () => onUnavailable() : undefined}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('#/sales-flow/invoices?txRef=invoice&txId=INV-1&txNo=INV-1');
  });
});