import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { usePagination } from '../../hooks/usePagination';
import { useSearchSort } from '../../hooks/useSearchSort';
import { toLegacyOrder } from '../../context/OrdersContext';
import { salesOrderService } from '../../services/salesOrderService';
import { getOrderDisplayStatus } from '../../views/sales/components/orderStatusUtils';
import { OrdersList } from '../../views/sales/components/SalesLists';

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

// The global test setup replaces localStorage with no-op mocks. Make it a
// real in-memory store here so search persistence behaves like production.
const memStore = new Map<string, string>();
const installStatefulStorage = () => {
  memStore.clear();
  vi.mocked(window.localStorage.getItem).mockImplementation(
    (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  );
  vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => {
    memStore.set(k, String(v));
  });
  vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => {
    memStore.delete(k);
  });
  vi.mocked(window.localStorage.clear).mockImplementation(() => {
    memStore.clear();
  });
};

/**
 * Seeded realistic stored rows (IDs stand in for database rows):
 * - SO-2026-0007 legacy 'Pending'      -> Confirmed
 * - SO-2026-0003 legacy 'Completed'    -> Completed
 * - SO-2026-0011 legacy 'Paid'         -> Paid (via paymentStatus)
 * - SO-2026-0005 missing customerName  -> must still list
 * - SO-2026-0009 midnight UTC orderDate -> must still list/sort
 * - SO-2026-0002 legacy 'Cancelled'    -> stays listed (list shows all)
 */
const seedOrders = () => [
  { id: 'SO-2026-0001', orderNumber: 'SO-2026-0001', customerName: 'Acme Ltd', orderDate: '2026-09-10T10:00:00.000Z', status: 'Confirmed', totalAmount: 1000, paidAmount: 0, items: [{ id: 'i1', productId: 'p1', quantity: 1, unitPrice: 1000 }] },
  { id: 'SO-2026-0007', orderNumber: 'SO-2026-0007', customerName: 'Acme Ltd', orderDate: '2026-09-11T10:00:00.000Z', status: 'Pending', totalAmount: 2000, paidAmount: 0, items: [{ id: 'i1', productId: 'p1', quantity: 2, unitPrice: 1000 }] },
  { id: 'SO-2026-0003', orderNumber: 'SO-2026-0003', customerName: 'Beta Stores', orderDate: '2026-09-09T10:00:00.000Z', status: 'Completed', totalAmount: 3000, paidAmount: 3000, items: [{ id: 'i1', productId: 'p2', quantity: 3, unitPrice: 1000 }] },
  { id: 'SO-2026-0011', orderNumber: 'SO-2026-0011', customerName: 'Gamma Co', orderDate: '2026-09-12T10:00:00.000Z', status: 'Paid', totalAmount: 1500, paidAmount: 1500, items: [{ id: 'i1', productId: 'p3', quantity: 1, unitPrice: 1500 }] },
  { id: 'SO-2026-0005', orderNumber: 'SO-2026-0005', customerName: null, orderDate: '2026-09-08T10:00:00.000Z', status: 'Confirmed', totalAmount: 500, paidAmount: 0, items: [{ id: 'i1', productId: 'p4', quantity: 1, unitPrice: 500 }] },
  { id: 'SO-2026-0009', orderNumber: 'SO-2026-0009', customerName: 'Delta Shop', orderDate: '2026-09-17T00:00:00.000Z', status: 'Processing', totalAmount: 750, paidAmount: 0, items: [{ id: 'i1', productId: 'p5', quantity: 1, unitPrice: 750 }] },
  { id: 'SO-2026-0002', orderNumber: 'SO-2026-0002', customerName: 'Acme Ltd', orderDate: '2026-09-01T10:00:00.000Z', status: 'Cancelled', totalAmount: 900, paidAmount: 0, items: [{ id: 'i1', productId: 'p6', quantity: 1, unitPrice: 900 }] },
];

// Production pipeline: rows are canonicalized on write, projected on read.
const projectAll = (rows: any[]) =>
  rows.map((o: any) => toLegacyOrder(salesOrderService.canonicalizeOrder(o) as any));

const ORDER_SEARCH_KEY = 'orders_order_sort';
const SEARCH_FIELDS = ['customerName', 'id', 'orderNumber', 'status', 'notes'];

describe('Orders List missing-orders diagnostic', () => {
  beforeEach(() => {
    installStatefulStorage();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('projection preserves every stored row (no loss by status/customer/date)', () => {
    const projected = projectAll(seedOrders());
    expect(projected.map((o: any) => o.id).sort()).toEqual(
      ['SO-2026-0001', 'SO-2026-0002', 'SO-2026-0003', 'SO-2026-0005', 'SO-2026-0007', 'SO-2026-0009', 'SO-2026-0011'].sort(),
    );
    // Legacy vocab translated, rows intact.
    expect(projected.find((o: any) => o.id === 'SO-2026-0007')?.status).toBe('Confirmed');
    expect(projected.find((o: any) => o.id === 'SO-2026-0003')?.status).toBe('Completed');
    expect(projected.find((o: any) => o.id === 'SO-2026-0011')?.status).toBe('Paid');
    // Display status never drops rows either.
    for (const o of projected) {
      expect(['Processing', 'Done', 'Cancelled']).toContain(getOrderDisplayStatus(o));
    }
  });

  it('does not modify stored order data (statuses/dates/customers/totals intact)', () => {
    const seeds = seedOrders();
    const snapshot = JSON.parse(JSON.stringify(seeds));
    projectAll(seeds);
    expect(seeds).toEqual(snapshot);
  });

  it('a stale persisted search re-applies on load and hides non-matching orders', () => {
    // Simulate: user searched "acme" in a previous session (persisted), reloaded.
    memStore.set(`${ORDER_SEARCH_KEY}_search`, JSON.stringify('acme'));
    const { result } = renderHook(() =>
      useSearchSort({
        data: projectAll(seedOrders()),
        searchFields: SEARCH_FIELDS,
        defaultSortField: 'orderDate',
        defaultSortDirection: 'desc',
        storageKey: ORDER_SEARCH_KEY,
      }),
    );
    const ids = result.current.processedData.map((o: any) => o.id);
    // SO-2026-0005 (null customer), SO-2026-0003/0009/0011 vanish at this layer.
    expect(ids).not.toContain('SO-2026-0005');
    expect(ids).not.toContain('SO-2026-0003');
    expect(ids).not.toContain('SO-2026-0009');
    expect(ids).not.toContain('SO-2026-0011');
    expect(ids).toContain('SO-2026-0001');
    expect(result.current.hasActiveSearch).toBe(true);
  });

  it('explicit search still filters, and clearing restores every order', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useSearchSort({
        data: projectAll(seedOrders()),
        searchFields: SEARCH_FIELDS,
        defaultSortField: 'orderDate',
        defaultSortDirection: 'desc',
        storageKey: ORDER_SEARCH_KEY,
      }),
    );
    expect(result.current.processedData).toHaveLength(7);
    act(() => {
      result.current.setSearchTerm('gamma');
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.processedData.map((o: any) => o.id)).toEqual(['SO-2026-0011']);
    act(() => {
      result.current.clearSearch();
    });
    expect(result.current.processedData).toHaveLength(7);
  });

  it('sorting stays date-desc without losing rows', () => {
    const seeds = projectAll(seedOrders());
    delete (seeds[0] as any).orderDate;
    const { result } = renderHook(() =>
      useSearchSort({
        data: seeds,
        searchFields: SEARCH_FIELDS,
        defaultSortField: 'orderDate',
        defaultSortDirection: 'desc',
        storageKey: ORDER_SEARCH_KEY,
      }),
    );
    const ids = result.current.processedData.map((o: any) => o.id);
    expect(ids).toHaveLength(7);
    // Dated rows stay newest-first; the dateless row pins to a stable end.
    const dated = ids.filter((id: string) => id !== 'SO-2026-0001');
    expect(dated).toEqual(['SO-2026-0009', 'SO-2026-0011', 'SO-2026-0007', 'SO-2026-0003', 'SO-2026-0005', 'SO-2026-0002']);
  });

  it('Card view exposes the same search control as List view', () => {
    const onSearchChange = vi.fn();
    const onSearchClear = vi.fn();
    render(
      <OrdersList
        data={projectAll(seedOrders()) as any}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        viewMode="Card"
        searchTerm=""
        onSearchChange={onSearchChange}
        onSearchClear={onSearchClear}
      />,
    );
    const input = screen.getByPlaceholderText('Search orders...');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'acme' } });
    expect(onSearchChange).toHaveBeenCalledWith('acme');
  });

  it('pagination never loses rows: overflow heals and page union is complete', () => {
    const data = Array.from({ length: 25 }, (_, i) => ({ id: `SO-PG-${i + 1}` }));
    const { result, rerender } = renderHook(
      ({ rows }: { rows: Array<{ id: string }> }) => usePagination(rows, 10),
      { initialProps: { rows: data } },
    );
    act(() => {
      result.current.last();
    });
    expect(result.current.currentPage).toBe(3);
    // Data shrinks below the current page (filter applied, rows deleted, etc.)
    rerender({ rows: data.slice(0, 5) });
    expect(result.current.currentPage).toBe(1);
    expect(result.current.currentItems.map((o: any) => o.id)).toEqual(
      data.slice(0, 5).map((o) => o.id),
    );
    // Union across all pages contains every row exactly once.
    const seen = new Set<string>();
    const full = renderHook(({ rows }: { rows: Array<{ id: string }> }) => usePagination(rows, 10), {
      initialProps: { rows: data },
    });
    for (let p = 1; p <= full.result.current.maxPage; p++) {
      act(() => {
        full.result.current.jump(p);
      });
      full.result.current.currentItems.forEach((o: any) => seen.add(o.id));
    }
    expect(seen.size).toBe(25);
  });
});
