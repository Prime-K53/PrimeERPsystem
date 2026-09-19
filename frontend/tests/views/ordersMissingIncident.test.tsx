import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSearchSort } from '../../hooks/useSearchSort';
import { usePagination } from '../../hooks/usePagination';
import { toLegacyOrder } from '../../context/OrdersContext';
import { salesOrderService } from '../../services/salesOrderService';
import { fieldLevelMerge } from '../../services/syncConflictResolver';
import {
  getQuickPhotocopyLineDisplay,
  isQuickPhotocopyItem,
  resolveQuickPhotocopyDisplayName,
} from '../../services/quickPhotocopyService';
import { getOrderDisplayStatus } from '../../views/sales/components/orderStatusUtils';
import { OrdersList } from '../../views/sales/components/SalesLists';
import { renderHook } from '@testing-library/react';

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

/**
 * Incident 18/09/2026 — exact rows from the report (stored shapes mirrored
 * on the cloud payloads where known). The three middle orders must surface
 * identically to their surviving siblings.
 */
const incidentRows = () => [
  { id: 'ORDER-P726/021', orderNumber: 'ORDER-P726/021', customerName: 'Luweya Primary School', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 45500, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 7, unitPrice: 6500 }] },
  { id: 'ORDER-P726/022', orderNumber: 'ORDER-P726/022', customerName: 'Lengwe Primary School', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 58500, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 9, unitPrice: 6500 }] },
  { id: 'ORDER-P726/023', orderNumber: 'ORDER-P726/023', customerName: 'Kanyenda Primary School', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 175000, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 25, unitPrice: 7000 }] },
  { id: 'ORDER-P726/024', orderNumber: 'ORDER-P726/024', customerName: 'Liphuphwe Primary School', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 130000, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 20, unitPrice: 6500 }] },
  { id: 'ORDER-P726/025', orderNumber: 'ORDER-P726/025', customerName: 'Mua RC School', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 140000, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 20, unitPrice: 7000 }] },
  { id: 'ORDER-P726/026', orderNumber: 'ORDER-P726/026', customerName: 'Bondo RC Primary', orderDate: '2026-09-17', status: 'Confirmed', totalAmount: 78200, paidAmount: 0, items: [{ id: 'i1', productId: 'INV-PRD-036', quantity: 8, unitPrice: 6500 }] },
  { id: 'SO-P726/021', orderNumber: 'SO-P726/021', customerName: 'Chipse Primary School', orderDate: '2026-01-17', status: 'Confirmed', invoiceId: 'INV-P726/028', totalAmount: 236000, paidAmount: 236000, items: [{ id: 'i1', productId: 'INV-PRD-0107', quantity: 14, unitPrice: 7000 }] },
];

const SEARCH_FIELDS = ['customerName', 'id', 'orderNumber', 'status', 'notes'];

// Full production-shaped read path: canonicalize (write) -> project (read)
// -> search/sort -> Processing-first partition -> paginate-all-pages.
const runListPipeline = (rows: any[], itemsPerPage = 10) => {
  const projected = rows.map((o: any) => toLegacyOrder(salesOrderService.canonicalizeOrder(o) as any));
  const { result: search } = renderHook(() =>
    useSearchSort({
      data: projected,
      searchFields: SEARCH_FIELDS,
      defaultSortField: 'orderDate',
      defaultSortDirection: 'desc',
      storageKey: 'orders_order_sort',
    }),
  );
  const processed = [...search.current.processedData];
  const processing = processed.filter((o: any) => getOrderDisplayStatus(o) === 'Processing');
  const others = processed.filter((o: any) => getOrderDisplayStatus(o) !== 'Processing');
  const ordered = [...processing, ...others];
  const seen: string[] = [];
  const pages = Math.max(1, Math.ceil(ordered.length / itemsPerPage));
  for (let p = 0; p < pages; p++) {
    ordered.slice(p * itemsPerPage, (p + 1) * itemsPerPage).forEach((o: any) => seen.push(o.id));
  }
  return { projected, ordered, seen };
};

describe('incident 18/09/2026: ORDER-P726/022, /023, /024 must list', () => {
  it('all seven IDs are returned to the Orders List data source', () => {
    const { seen } = runListPipeline(incidentRows());
    expect(seen.sort()).toEqual(
      ['ORDER-P726/021', 'ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024', 'ORDER-P726/025', 'ORDER-P726/026', 'SO-P726/021'].sort(),
    );
  });

  it('previously-missing and surviving rows render identically in the list', () => {
    const { ordered } = runListPipeline(incidentRows());
    render(
      <OrdersList
        data={ordered as any}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        viewMode="List"
        searchTerm=""
        onSearchChange={vi.fn()}
        onSearchClear={vi.fn()}
      />,
    );
    for (const num of ['ORDER-P726/021', 'ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024', 'ORDER-P726/025', 'ORDER-P726/026', 'SO-P726/021']) {
      expect(screen.getByText(num)).toBeInTheDocument();
    }
  });

  it('Processing orders are not excluded (all six ORDER rows)', () => {
    const { ordered } = runListPipeline(incidentRows());
    const processing = ordered.filter((o: any) => getOrderDisplayStatus(o) === 'Processing');
    expect(processing.map((o: any) => o.id).sort()).toEqual(
      ['ORDER-P726/021', 'ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024', 'ORDER-P726/025', 'ORDER-P726/026'].sort(),
    );
  });

  it('order totals are preserved exactly (K45,500 … K175,000 … K78,200)', () => {
    const { projected } = runListPipeline(incidentRows());
    const byId = new Map(projected.map((o: any) => [o.id, o]));
    expect(byId.get('ORDER-P726/021')?.totalAmount).toBe(45500);
    expect(byId.get('ORDER-P726/022')?.totalAmount).toBe(58500);
    expect(byId.get('ORDER-P726/023')?.totalAmount).toBe(175000);
    expect(byId.get('ORDER-P726/024')?.totalAmount).toBe(130000);
    expect(byId.get('ORDER-P726/025')?.totalAmount).toBe(140000);
    expect(byId.get('ORDER-P726/026')?.totalAmount).toBe(78200);
    expect(byId.get('SO-P726/021')?.totalAmount).toBe(236000);
  });

  it('Quick Photocopy display stays compact and never affects order inclusion', () => {
    const qp = {
      id: 'QUICK-PHOTO-13x1',
      itemId: 'SVC-PHOTOCOPY',
      sku: 'QUICK-PHOTO',
      name: 'Quick Photocopy',
      desc: 'Quick Photocopy',
      price: 150,
      quantity: 7,
      serviceDetails: { pages: 13, copies: 1, totalPages: 13, billableSheets: 7, pricePerSheet: 150 },
    };
    expect(isQuickPhotocopyItem(qp)).toBe(true);
    const display = getQuickPhotocopyLineDisplay(qp, 'K');
    expect(display).toMatchObject({ name: 'Quick Photocopy', qty: '13 pgs', rate: 'K 150.00/sht', amount: 1050 });
    expect(resolveQuickPhotocopyDisplayName(qp)).toBe('Quick Photocopy');
    // Normal order lines are untouched by QP scoping.
    const normal = { id: 'i1', productId: 'INV-PRD-036', quantity: 7, unitPrice: 6500 };
    expect(isQuickPhotocopyItem(normal)).toBe(false);
    // An order carrying service lines still projects and lists.
    const withService = incidentRows().map((o: any) =>
      o.id === 'ORDER-P726/022' ? { ...o, items: [...o.items, { ...qp }] } : o,
    );
    const { seen } = runListPipeline(withService);
    expect(seen).toContain('ORDER-P726/022');
  });

  it('pagination across small pages returns every row exactly once', () => {
    const { seen } = runListPipeline(incidentRows(), 3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('17/09/2026 rows and the 17/01/2026 row all survive date handling', () => {
    const { ordered } = runListPipeline(incidentRows());
    expect(ordered).toHaveLength(7);
    const dates = ordered.map((o: any) => o.orderDate);
    expect(dates).toContain('2026-09-17');
    expect(dates).toContain('2026-01-17');
    // Newest first; the January row pins last without disappearing.
    expect(ordered[ordered.length - 1].id).toBe('SO-P726/021');
  });

  it('sync merge never discards valid order rows', () => {
    const local022: any = {
      id: 'ORDER-P726/022', orderNumber: 'ORDER-P726/022', customerName: 'Lengwe Primary School',
      status: 'Confirmed', totalAmount: 58500, updated_at: '2026-09-17T13:15:00.000Z',
      _updatedAt: '2026-09-17T13:15:00.000Z', items: [],
    };
    // Same-row live/live merge keeps identity and every field.
    const mergedLive = fieldLevelMerge(local022, { ...local022, totalAmount: 58500, updated_at: '2026-09-17T13:16:00.000Z' }) as any;
    expect(mergedLive.id).toBe('ORDER-P726/022');
    expect(mergedLive.orderNumber).toBe('ORDER-P726/022');
    expect(mergedLive.customerName).toBe('Lengwe Primary School');
    expect(mergedLive.totalAmount).toBe(58500);
    // Newer cloud totals merge in without dropping identity.
    const mergedNewer = fieldLevelMerge(local022, { ...local022, totalAmount: 59000, updated_at: '2026-09-18T08:00:00.000Z' }) as any;
    expect(mergedNewer.id).toBe('ORDER-P726/022');
  });

  it('soft-deleted rows stay hidden by design (documents tombstone behavior)', () => {
    const tombstoned = incidentRows().map((o: any) =>
      o.id === 'ORDER-P726/022' ? { ...o, deletedAt: '2026-09-18T08:00:00.000Z' } : o,
    );
    // Repository layer contract: tombstones never reach the list input.
    const visible = tombstoned.filter((o: any) => !o?.deletedAt);
    expect(visible.map((o: any) => o.id)).not.toContain('ORDER-P726/022');
    expect(visible).toHaveLength(6);
  });

  it('pipeline introduces no duplicates and modifies no stored data', () => {
    const seeds = incidentRows();
    const snapshot = JSON.parse(JSON.stringify(seeds));
    const { seen, projected } = runListPipeline(seeds);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seeds).toEqual(snapshot);
    // Stored statuses/dates/customers/totals untouched by read path.
    for (const original of snapshot) {
      const stored = seeds.find((s: any) => s.id === original.id);
      expect(stored).toEqual(original);
    }
    expect(projected).toHaveLength(7);
  });
});
