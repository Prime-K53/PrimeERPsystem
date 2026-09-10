/**
 * Customer import name mapping — pins the two-name contract:
 * Business name (identity) + Contact person, with legacy single-name
 * CSVs treated as the business name.
 */
import { describe, it, expect } from 'vitest';
import { resolveImportCustomerNames, customerBusinessIdentity } from '../../utils/customerImportNames';

describe('resolveImportCustomerNames', () => {
  it('reads Business name + Contact person columns', () => {
    expect(
      resolveImportCustomerNames({ 'Business name': 'ABC School', 'Contact person': 'John Banda' }),
    ).toEqual({ business: 'ABC School', contact: 'John Banda' });
  });

  it('accepts Company/CompanyName variants', () => {
    expect(resolveImportCustomerNames({ Company: 'ABC', ContactName: 'Jane' })).toEqual({
      business: 'ABC',
      contact: 'Jane',
    });
    expect(
      resolveImportCustomerNames({ CompanyName: 'ABC', 'Contact Person': 'Jane' }),
    ).toEqual({ business: 'ABC', contact: 'Jane' });
  });

  it('treats legacy single-name columns as the business name', () => {
    expect(resolveImportCustomerNames({ 'Full name': 'ABC School' })).toEqual({
      business: 'ABC School',
      contact: '',
    });
    expect(resolveImportCustomerNames({ Name: 'ABC School' })).toEqual({
      business: 'ABC School',
      contact: '',
    });
    expect(resolveImportCustomerNames({ CustomerName: 'ABC School' })).toEqual({
      business: 'ABC School',
      contact: '',
    });
  });

  it('prefers the business column over legacy columns when both exist', () => {
    expect(
      resolveImportCustomerNames({
        'Business name': 'ABC School',
        Name: 'Someone Else',
        'Contact person': 'John Banda',
      }),
    ).toEqual({ business: 'ABC School', contact: 'John Banda' });
  });

  it('trims whitespace and returns empty strings when absent', () => {
    expect(resolveImportCustomerNames({ 'Business name': '  ABC  ', Foo: 'x' })).toEqual({
      business: 'ABC',
      contact: '',
    });
    expect(resolveImportCustomerNames({})).toEqual({ business: '', contact: '' });
  });
});

describe('customerBusinessIdentity', () => {
  it('prefers businessName, then companyName, then legacy name', () => {
    expect(
      customerBusinessIdentity({ businessName: 'A', companyName: 'B', name: 'C' }),
    ).toBe('a');
    expect(customerBusinessIdentity({ companyName: 'ABC School' })).toBe('abc school');
    expect(customerBusinessIdentity({ name: 'ABC School' })).toBe('abc school');
  });

  it('is null-safe', () => {
    expect(customerBusinessIdentity(null)).toBe('');
    expect(customerBusinessIdentity({})).toBe('');
  });
});
