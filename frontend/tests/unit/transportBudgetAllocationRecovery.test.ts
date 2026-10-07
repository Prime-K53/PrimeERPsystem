import { describe, expect, it } from 'vitest';
import { findInvoicesMissingAllocation } from '../../services/transportBudgetKpis';

const inv = (id: string, date: string) => ({ id, date });

describe('findInvoicesMissingAllocation', () => {
  it('returns invoices with no allocation event yet', () => {
    const out = findInvoicesMissingAllocation(
      [inv('INV-1', '2026-10-02'), inv('INV-2', '2026-10-03')],
      new Set(['INV-1']),
    );
    expect(out.map((i: any) => i.id)).toEqual(['INV-2']);
  });

  it('respects the business-date window', () => {
    const invoices = [inv('SEP', '2026-09-28'), inv('OCT', '2026-10-05')];
    const out = findInvoicesMissingAllocation(invoices, new Set(), '2026-10-01', '2026-10-07');
    expect(out.map((i: any) => i.id)).toEqual(['OCT']);
  });

  it('ignores blank ids and empty inputs', () => {
    expect(findInvoicesMissingAllocation([{ id: '', date: '2026-10-02' }], new Set())).toEqual([]);
    expect(findInvoicesMissingAllocation([], new Set(['INV-1']))).toEqual([]);
    expect(findInvoicesMissingAllocation(null as any, new Set())).toEqual([]);
  });

  it('accepts allocated keys as an array too', () => {
    const out = findInvoicesMissingAllocation([inv('INV-1', '2026-10-02')], ['INV-1']);
    expect(out).toEqual([]);
  });
});
