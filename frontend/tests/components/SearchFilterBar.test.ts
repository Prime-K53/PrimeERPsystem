/**
 * SearchFilterBar.test.ts — customer filter dropdowns must label options
 * with the Business Name, never the contact name.
 */
import { describe, expect, it } from 'vitest';
import {
  getInvoiceFilters,
  getQuotationFilters,
  getOrdersFilters,
  getPaymentFilters,
} from '../../components/SearchFilterBar';

const customers = [
  { id: 'C1', name: 'Ada Banda', businessName: 'Acme Printers Ltd', companyName: 'Acme' },
  { id: 'C2', name: 'John Phiri', companyName: 'Zed Milling' },
  { id: 'C3', name: 'Legacy Shop' },
];

function customerLabels(configs: Array<{ key: string; options?: Array<{ value: string; label: string }> }>) {
  const entry = configs.find((c) => c.key === 'customer');
  return (entry?.options || []).map((o) => o.label);
}

describe('customer filter builders', () => {
  it('invoice filters use business names', () => {
    expect(customerLabels(getInvoiceFilters(customers))).toEqual([
      'Acme Printers Ltd',
      'Zed Milling',
      'Legacy Shop',
    ]);
  });

  it('quotation filters use business names', () => {
    expect(customerLabels(getQuotationFilters(customers))).toEqual([
      'Acme Printers Ltd',
      'Zed Milling',
      'Legacy Shop',
    ]);
  });

  it('orders filters use business names', () => {
    expect(customerLabels(getOrdersFilters(customers))).toEqual([
      'Acme Printers Ltd',
      'Zed Milling',
      'Legacy Shop',
    ]);
  });

  it('payment filters use business names', () => {
    expect(customerLabels(getPaymentFilters(customers))).toEqual([
      'Acme Printers Ltd',
      'Zed Milling',
      'Legacy Shop',
    ]);
  });
});
