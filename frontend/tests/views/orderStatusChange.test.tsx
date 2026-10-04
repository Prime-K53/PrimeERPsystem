import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  canTransitionOrderStatus,
  getOrderCanonicalStatus,
  getOrderStatusActions,
} from '../../views/sales/components/orderStatusUtils';
import OrderStatusModal from '../../views/sales/components/OrderStatusModal';
import { OrdersList } from '../../views/sales/components/SalesLists';
import { toLegacyOrder } from '../../context/OrdersContext';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ companyConfig: { currencySymbol: 'K' } }),
}));

vi.mock('../../hooks/useDocumentPreview', () => ({
  useDocumentPreview: () => ({ handlePreview: vi.fn() }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useLocation: () => ({ pathname: '/sales-flow/orders' }),
    useNavigate: () => vi.fn(),
  };
});

const order = (status: string, extra: Record<string, any> = {}) => ({
  id: `ORD-1-${status}`,
  orderNumber: 'ORD-2026/0007',
  customerName: 'Luweya Primary School',
  orderDate: '2026-09-17',
  status,
  canonicalStatus: status,
  totalAmount: 45500,
  paidAmount: 0,
  items: [],
  ...extra,
});

describe('order status transitions', () => {
  it('reads the canonical status, not the lossy legacy projection', () => {
    // canonical Processing projects to legacy 'Partially Paid' once payment folds in.
    expect(getOrderCanonicalStatus(order('Processing', { status: 'Partially Paid', canonicalStatus: 'Processing' }))).toBe('Processing');
    expect(getOrderCanonicalStatus(order('Confirmed', { status: 'Paid', canonicalStatus: 'Confirmed' }))).toBe('Confirmed');
  });

  it('offers the next workflow step and nothing else', () => {
    expect(getOrderStatusActions(order('Draft')).map((a) => a.status)).toEqual(['Confirmed']);
    expect(getOrderStatusActions(order('Confirmed')).map((a) => a.status)).toEqual(['Processing', 'Fulfilled']);
    expect(getOrderStatusActions(order('Processing')).map((a) => a.status)).toEqual(['Fulfilled']);
  });

  it('treats terminal statuses as final', () => {
    for (const status of ['Fulfilled', 'Cancelled', 'Converted']) {
      expect(getOrderStatusActions(order(status))).toEqual([]);
    }
  });

  it('never offers Cancelled, which must go through cancelOrder to release stock', () => {
    const offered = ['Draft', 'Confirmed', 'Processing']
      .flatMap((status) => getOrderStatusActions(order(status)).map((a) => a.status));
    expect(offered).not.toContain('Cancelled');
  });

  it('never offers Converted, which would fabricate an invoiced state with no invoice', () => {
    const offered = ['Draft', 'Confirmed', 'Processing']
      .flatMap((status) => getOrderStatusActions(order(status)).map((a) => a.status));
    expect(offered).not.toContain('Converted');
  });

  it('only offers statuses the store can actually persist', () => {
    // updateOrderStatus runs canonicalizeStatus over the input; anything that does
    // not round-trip would be silently rewritten to a different status.
    const offered = ['Draft', 'Confirmed', 'Processing']
      .flatMap((status) => getOrderStatusActions(order(status)).map((a) => a.status));
    for (const status of offered) {
      expect(canTransitionOrderStatus('Confirmed', status) || status === 'Confirmed').toBe(true);
    }
    expect(offered).not.toContain('Shipped');
    expect(offered).not.toContain('Delivered');
    expect(offered).not.toContain('Pending');
  });

  it('demands an explicit confirmation for Fulfilled, which moves stock and the ledger', () => {
    const fulfilled = getOrderStatusActions(order('Confirmed')).find((a) => a.status === 'Fulfilled');
    expect(fulfilled?.requiresConfirmation).toBe(true);
    expect(fulfilled?.warning).toMatch(/stock/i);

    const processing = getOrderStatusActions(order('Confirmed')).find((a) => a.status === 'Processing');
    expect(processing?.requiresConfirmation).toBe(false);
  });

  it('rejects transitions the workflow does not allow', () => {
    expect(canTransitionOrderStatus('Draft', 'Confirmed')).toBe(true);
    expect(canTransitionOrderStatus('Draft', 'Fulfilled')).toBe(false);
    expect(canTransitionOrderStatus('Confirmed', 'Draft')).toBe(false);
    expect(canTransitionOrderStatus('Processing', 'Cancelled')).toBe(false);
    expect(canTransitionOrderStatus('Fulfilled', 'Processing')).toBe(false);
    expect(canTransitionOrderStatus('Confirmed', 'Confirmed')).toBe(false);
  });
});

describe('OrderStatusModal', () => {
  it('dispatches the chosen status and closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderStatusModal order={order('Draft') as any} onConfirm={onConfirm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^confirmed/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply change/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Confirmed'));
  });

  it('will not submit Fulfilled until the irreversible step is acknowledged', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderStatusModal order={order('Confirmed') as any} onConfirm={onConfirm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^fulfilled/i }));
    expect(screen.getByRole('button', { name: /apply change/i })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /apply change/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Fulfilled'));
  });

  it('explains why a final status cannot be changed instead of offering a dead action', () => {
    render(<OrderStatusModal order={order('Fulfilled') as any} onConfirm={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText(/final status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply change/i })).toBeDisabled();
  });

  it('surfaces a persistence failure and stays open', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('GL account 51200 is not posting-enabled'));
    const onClose = vi.fn();
    render(<OrderStatusModal order={order('Draft') as any} onConfirm={onConfirm} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /^confirmed/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply change/i }));

    await screen.findByRole('alert');
    expect(screen.getByText(/not posting-enabled/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not leak a previous selection into another order', () => {
    const { rerender } = render(
      <OrderStatusModal order={order('Confirmed') as any} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^processing/i }));

    rerender(<OrderStatusModal order={order('Draft', { id: 'ORD-2' }) as any} onConfirm={vi.fn()} onClose={vi.fn()} />);

    // Draft only offers Confirmed, so no Processing selection can survive.
    expect(screen.queryByRole('button', { name: /^processing/i })).toBeNull();
    expect(screen.getByRole('button', { name: /apply change/i })).toBeDisabled();
  });
});

describe('OrdersList ORDER ACTIONS menu', () => {
  const renderList = (props: Record<string, any> = {}) =>
    render(
      <OrdersList
        data={[order('Confirmed') as any]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAction={vi.fn()}
        viewMode="List"
        {...props}
      />,
    );

  it('opens the status modal from the context menu and reports the choice as a status_ action', async () => {
    const onAction = vi.fn();
    renderList({ onAction });

    fireEvent.contextMenu(screen.getByText('Luweya Primary School'));
    fireEvent.click(await screen.findByText('Change Status'));

    expect(screen.getByText('Change order status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^processing/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply change/i }));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), 'status_Processing'));
  });

  it('shows the real lifecycle status next to the action, not the folded display label', async () => {
    renderList({ data: [order('Processing', { status: 'Partially Paid', canonicalStatus: 'Processing' })] });

    fireEvent.contextMenu(screen.getByText('Luweya Primary School'));
    expect(await screen.findByText('Change Status')).toBeInTheDocument();
    expect(screen.getByTitle('Currently Processing')).toBeInTheDocument();
  });

  it('marks a fulfilled order as Done in both list and card views', () => {
    // The production shape after toLegacyOrder: legacy 'Completed', canonical 'Fulfilled'.
    const fulfilled = toLegacyOrder({ id: 'ORD-DONE-1', orderNumber: 'ORD-2026/0009', customerName: 'Bondo RC Primary', orderDate: '2026-09-17', status: 'Fulfilled', items: [], subtotal: 0, total: 78200, totalAmount: 78200, paidAmount: 0 } as any) as any;

    for (const viewMode of ['List', 'Card'] as const) {
      const { unmount } = renderList({ data: [fulfilled], viewMode });
      const pills = screen.getAllByText('Done');
      expect(pills.length).toBeGreaterThan(0);
      expect(screen.queryByText('Processing')).toBeNull();
      unmount();
    }
  });

  it('does not report a paid but unfulfilled order as Done', () => {
    const paidNotFulfilled = toLegacyOrder({ id: 'ORD-P-1', orderNumber: 'ORD-2026/0010', customerName: 'Mua RC School', orderDate: '2026-09-17', status: 'Processing', paymentStatus: 'Paid', paidAmount: 140000, items: [], subtotal: 0, total: 140000, totalAmount: 140000 } as any) as any;

    renderList({ data: [paidNotFulfilled] });

    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.queryByText('Done')).toBeNull();
  });
});
