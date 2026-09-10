/**
 * Responsive data-table UX system — contract tests.
 *
 * Pins the Rank → Stack → Slot → Label → Reveal → Breakpoint behaviour:
 *  1. Desktop renders a semantic table (scope, aria-sort, right-aligned money).
 *  2. Narrow layout renders compact records (title + amount slot + status).
 *  3. Detail-priority columns never render as table columns (reveal only).
 *  4. Expansion wiring exposes aria-expanded / aria-controls.
 *  5. Loading / empty / error states render without broken table structure.
 *  6. Money keeps the K convention with thousands separators, no decimals.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ResponsiveDataTable,
  StatusBadge,
  formatKwacha,
  formatKwachaCompact,
  type ResponsiveColumn,
} from '../../components/data-table';

interface Row {
  id: string;
  customer: string;
  invoice: string;
  date: string;
  amount: number;
  status: string;
  notes: string;
}

const COLUMNS: ResponsiveColumn<Row>[] = [
  { key: 'customer', label: 'Customer', priority: 'primary', kind: 'text', value: (r) => r.customer },
  { key: 'amount', label: 'Amount', priority: 'primary', kind: 'money', value: (r) => r.amount, render: (r) => formatKwacha(r.amount) },
  { key: 'status', label: 'Status', priority: 'secondary', kind: 'status', render: (r) => <StatusBadge status={r.status} /> },
  { key: 'date', label: 'Date', priority: 'secondary', kind: 'date', value: (r) => r.date },
  { key: 'reference', label: 'Reference', priority: 'detail', value: (r) => r.notes },
];

const ROWS: Row[] = [
  { id: 'a', customer: 'Kaphuka PVT School', invoice: 'INV-2041', date: '2026-09-04', amount: 125000, status: 'Unpaid', notes: 'Term 3 fees' },
  { id: 'b', customer: 'XYZ School', invoice: 'INV-2042', date: '2026-09-05', amount: 85000, status: 'Paid', notes: 'Stationery' },
];

const base = {
  columns: COLUMNS,
  keyOf: (r: Row) => r.id,
  caption: 'Invoices',
};

function renderTable(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ResponsiveDataTable<Row> {...base} data={extra.data !== undefined ? (extra.data as Row[]) : ROWS} {...(extra as object)} />,
  );
}

describe('formatKwacha — K convention', () => {
  it('renders whole Kwacha with thousands separators and no decimals by default', () => {
    expect(formatKwacha(125000)).toBe('K125,000');
    expect(formatKwacha(7500)).toBe('K7,500');
    expect(formatKwacha(1250000)).toBe('K1,250,000');
  });

  it('never throws and never recalculates the value', () => {
    expect(formatKwacha(null)).toBe('K0');
    expect(formatKwacha('85000')).toBe('K85,000');
    expect(formatKwachaCompact(1500000)).toBe('K1.5M');
  });
});

describe('StatusBadge — never colour alone', () => {
  it('renders readable text with a status role', () => {
    const html = renderToStaticMarkup(<StatusBadge status="Unpaid" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Unpaid');
    expect(html).toContain('Status: Unpaid');
  });

  it('maps common ERP statuses to labels', () => {
    expect(renderToStaticMarkup(<StatusBadge status="overdue" />)).toContain('Overdue');
    expect(renderToStaticMarkup(<StatusBadge status="Paid" />)).toContain('Paid');
    expect(renderToStaticMarkup(<StatusBadge status="draft" />)).toContain('Draft');
  });
});

describe('ResponsiveDataTable — desktop semantics', () => {
  it('renders a semantic table with sortable headers and aria-sort', () => {
    const cols: ResponsiveColumn<Row>[] = COLUMNS.map((c) =>
      c.key === 'date' ? { ...c, sortable: true } : c,
    );
    const html = renderToStaticMarkup(
      <ResponsiveDataTable<Row>
        {...base}
        columns={cols}
        data={ROWS}
        sort={{ key: 'date', direction: 'asc' }}
        onSort={() => {}}
      />,
    );
    expect(html).toContain('<table');
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('Sort by Date');
  });

  it('right-aligns money columns and keeps detail columns out of the table', () => {
    const html = renderTable();
    expect(html).toContain('rpt-align-right');
    expect(html).toContain('K125,000');
    // Detail-priority "Reference" must not become a table column…
    expect(html).not.toContain('<th scope="col" aria-sort');
    expect(html).toContain('Details');
  });

  it('exposes expand/collapse controls with aria-expanded + aria-controls', () => {
    const html = renderTable();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain('Expand row 1');
  });
});

describe('ResponsiveDataTable — narrow records (stack/slot/label)', () => {
  it('renders compact records with title, amount slot and status', () => {
    const html = renderTable();
    expect(html).toContain('rpt-card-title');
    expect(html).toContain('Kaphuka PVT School');
    expect(html).toContain('rpt-card-amount');
    expect(html).toContain('rpt-card-status');
  });
});

describe('ResponsiveDataTable — states', () => {
  it('renders loading skeletons without a broken table', () => {
    const html = renderTable({ loading: true, data: [] });
    expect(html).toContain('Loading records');
    expect(html).not.toContain('<td colSpan="0"');
  });

  it('renders the empty state with guidance copy', () => {
    const html = renderTable({
      data: [],
      emptyTitle: 'No invoices found',
      emptyDescription: 'There are no invoices matching your current filters.',
    });
    expect(html).toContain('No invoices found');
    expect(html).toContain('no invoices matching your current filters');
  });

  it('renders the error state with retry', () => {
    const onRetry = vi.fn();
    const html = renderTable({ data: [], error: 'Network failed', onRetry });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
  });
});

describe('ResponsiveDataTable — pagination footer', () => {
  it('announces the visible range and page', () => {
    const html = renderTable({
      pagination: { page: 1, pageSize: 25, total: 2, onPageChange: () => {} },
    });
    expect(html).toContain('aria-label="Pagination"');
    expect(html).toContain('of <strong>2</strong>');
  });
});
