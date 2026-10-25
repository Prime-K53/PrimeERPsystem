import { describe, it, expect } from 'vitest';
import {
  customerNameOf,
  getCustomerDisplayName,
  getCustomerContactName,
  getCustomerOptionLabel,
  isPlaceholderCustomerName,
  resolveCustomerDisplay,
  resolveCustomerNameById,
} from '../../utils/customerDisplay';

describe('getCustomerDisplayName', () => {
  describe('CASE 1: businessName and contactName both exist', () => {
    it('should return businessName as customer display name', () => {
      const result = getCustomerDisplayName({
        businessName: 'ABC Secondary School',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Name'
      });
      expect(result).toBe('ABC Secondary School');
    });

    it('should NOT return contactName as customer display name', () => {
      const result = getCustomerDisplayName({
        businessName: 'ABC Secondary School',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Name'
      });
      expect(result).not.toBe('John Banda');
    });
  });

  describe('CASE 2: businessName is null, contactName exists', () => {
    it('should return legacyCustomerName if businessName is missing', () => {
      const result = getCustomerDisplayName({
        businessName: null,
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Customer'
      });
      expect(result).toBe('Legacy Customer');
    });

    it('should NOT return contactName as customer display name fallback', () => {
      const result = getCustomerDisplayName({
        businessName: null,
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Customer'
      });
      expect(result).not.toBe('John Banda');
    });
  });

  describe('CASE 3: businessName is empty string, contactName exists', () => {
    it('should return legacyCustomerName if businessName is empty', () => {
      const result = getCustomerDisplayName({
        businessName: '',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Customer'
      });
      expect(result).toBe('Legacy Customer');
    });

    it('should NOT return contactName even when businessName is empty', () => {
      const result = getCustomerDisplayName({
        businessName: '',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy Customer'
      });
      expect(result).not.toBe('John Banda');
    });
  });

  describe('CASE 4: all fields null/empty', () => {
    it('should return empty string when all fields are null', () => {
      const result = getCustomerDisplayName({
        businessName: null,
        contactName: null,
        legacyCustomerName: null
      });
      expect(result).toBe('');
    });

    it('should return empty string when all fields are empty strings', () => {
      const result = getCustomerDisplayName({
        businessName: '',
        contactName: '',
        legacyCustomerName: ''
      });
      expect(result).toBe('');
    });
  });

  describe('CASE 5: companyName fallback', () => {
    it('should use companyName when businessName is missing', () => {
      const result = getCustomerDisplayName({
        businessName: null,
        companyName: 'Prime Company Ltd',
        contactName: 'Mary Phiri',
        legacyCustomerName: 'Legacy Name'
      });
      expect(result).toBe('Prime Company Ltd');
    });

    it('should prefer businessName over companyName', () => {
      const result = getCustomerDisplayName({
        businessName: 'ABC School',
        companyName: 'Prime Company Ltd',
        contactName: 'Mary Phiri',
        legacyCustomerName: 'Legacy Name'
      });
      expect(result).toBe('ABC School');
    });
  });

  describe('CASE 6: whitespace handling', () => {
    it('should trim whitespace from businessName', () => {
      const result = getCustomerDisplayName({
        businessName: '  ABC School  ',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy'
      });
      expect(result).toBe('ABC School');
    });

    it('should return empty string for whitespace-only businessName', () => {
      const result = getCustomerDisplayName({
        businessName: '   ',
        contactName: 'John Banda',
        legacyCustomerName: 'Legacy'
      });
      expect(result).toBe('Legacy');
    });
  });
});

describe('getCustomerContactName', () => {
  it('should return contactName when provided', () => {
    const result = getCustomerContactName({ contactName: 'John Banda' });
    expect(result).toBe('John Banda');
  });

  it('should return empty string when contactName is null', () => {
    const result = getCustomerContactName({ contactName: null });
    expect(result).toBe('');
  });

  it('should return empty string when contactName is empty', () => {
    const result = getCustomerContactName({ contactName: '' });
    expect(result).toBe('');
  });

  it('should NOT be affected by businessName', () => {
    const result = getCustomerContactName({ 
      contactName: 'John Banda',
      businessName: 'ABC School'
    });
    expect(result).toBe('John Banda');
  });

  it('should trim whitespace from contactName', () => {
    const result = getCustomerContactName({ contactName: '  John Banda  ' });
    expect(result).toBe('John Banda');
  });
});

describe('resolveCustomerDisplay', () => {
  it('should return both displayName and contactName separately', () => {
    const customer = {
      businessName: 'ABC School',
      contactName: 'John Banda',
      name: 'Legacy Name'
    };
    const result = resolveCustomerDisplay(customer);
    expect(result.displayName).toBe('ABC School');
    expect(result.contactName).toBe('John Banda');
  });

  it('should return empty strings when customer is null', () => {
    const result = resolveCustomerDisplay(null);
    expect(result.displayName).toBe('');
    expect(result.contactName).toBe('');
  });

  it('should not mix up displayName and contactName', () => {
    const customer = {
      businessName: 'ABC School',
      contactName: 'John Banda',
      name: 'Legacy Name'
    };
    const result = resolveCustomerDisplay(customer);
    expect(result.displayName).not.toBe('John Banda');
    expect(result.contactName).not.toBe('ABC School');
  });

  it('should use legacy name when businessName is missing', () => {
    const customer = {
      businessName: null,
      contactName: 'John Banda',
      name: 'Legacy Name'
    };
    const result = resolveCustomerDisplay(customer);
    expect(result.displayName).toBe('Legacy Name');
    expect(result.contactName).toBe('John Banda');
  });
});

describe('Business Name vs Contact Name Separation', () => {
  const testCases = [
    { 
      businessName: 'ABC Secondary School',
      contactName: 'John Banda',
      expectedDisplayName: 'ABC Secondary School',
      expectedContactName: 'John Banda'
    },
    { 
      businessName: 'Prime Printing',
      contactName: 'Mary Phiri',
      expectedDisplayName: 'Prime Printing',
      expectedContactName: 'Mary Phiri'
    },
    { 
      businessName: 'XYZ Hospital',
      contactName: 'Dr. Smith',
      expectedDisplayName: 'XYZ Hospital',
      expectedContactName: 'Dr. Smith'
    }
  ];

  testCases.forEach(({ businessName, contactName, expectedDisplayName, expectedContactName }) => {
    it(`should correctly separate business and contact for ${businessName}`, () => {
      const displayName = getCustomerDisplayName({ businessName, contactName });
      const contact = getCustomerContactName({ contactName });
      
      expect(displayName).toBe(expectedDisplayName);
      expect(contact).toBe(expectedContactName);
    });
  });
});

describe('getCustomerOptionLabel (dropdown labels: Business Name, never contact)', () => {
  it('uses businessName when present, ignoring contact-style legacy name', () => {
    expect(
      getCustomerOptionLabel({ id: 'C1', name: 'Ada Banda', businessName: 'Acme Printers Ltd', companyName: 'Acme' })
    ).toBe('Acme Printers Ltd');
  });

  it('falls back to companyName, then legacy name, then id — never blank', () => {
    expect(getCustomerOptionLabel({ id: 'C2', name: 'Ada Banda', companyName: 'Zed Milling' })).toBe('Zed Milling');
    expect(getCustomerOptionLabel({ id: 'C3', name: 'Legacy Shop' })).toBe('Legacy Shop');
    expect(getCustomerOptionLabel({ id: 'C4' })).toBe('C4');
    expect(getCustomerOptionLabel(null)).toBe('Unknown customer');
  });

  it('never surfaces a contact-only record as a blank or contact label', () => {
    // A record carrying only a person name still renders (legacy fallback),
    // and a record with no identity at all falls back to its id.
    expect(getCustomerOptionLabel({ id: 'C5', name: 'Ada Banda' })).toBe('Ada Banda');
    expect(getCustomerOptionLabel({ id: 'C6', name: '  ' })).toBe('C6');
  });
});

describe('isPlaceholderCustomerName (placeholders are missing references, not names)', () => {
  it('rejects typographic placeholders and empty values', () => {
    for (const value of ['', '   ', '_', '__', '-', '--', '—', '–', '.', '..', 'n/a', 'N/A', 'none', 'null', 'nil', 'undefined', 'tbd', 'unknown', 'unknown customer', 'Customer']) {
      expect(isPlaceholderCustomerName(value), `"${value}" must not be a name`).toBe(true);
    }
    expect(isPlaceholderCustomerName(null)).toBe(true);
    expect(isPlaceholderCustomerName(undefined)).toBe(true);
  });

  it('rejects the internal customer key in every spelling', () => {
    expect(isPlaceholderCustomerName('CUST-0035')).toBe(true);
    expect(isPlaceholderCustomerName('cust-0035')).toBe(true);
    expect(isPlaceholderCustomerName('CUST 0035')).toBe(true);
    expect(isPlaceholderCustomerName('CUST-0035 School')).toBe(false);
  });

  it('accepts real business names, including non-Latin and qualified names', () => {
    for (const value of ['Mphandula CDSS', "St Mary's (Blantyre)", 'ABC Secondary School', 'Zomba CCAP', 'МБОУ Школа №5', '学校']) {
      expect(isPlaceholderCustomerName(value), `"${value}" must be a name`).toBe(false);
    }
  });
});

describe('getCustomerDisplayName skips placeholder candidates', () => {
  it('falls through a placeholder businessName to companyName then legacy name', () => {
    expect(getCustomerDisplayName({ businessName: '_', companyName: 'Prime Company Ltd' })).toBe('Prime Company Ltd');
    expect(getCustomerDisplayName({ businessName: '—', legacyCustomerName: 'Legacy School' })).toBe('Legacy School');
    expect(getCustomerDisplayName({ businessName: 'CUST-0035', companyName: '', legacyCustomerName: 'Real Junior School' })).toBe('Real Junior School');
  });

  it('returns the empty string when every candidate is a placeholder', () => {
    expect(getCustomerDisplayName({ businessName: '_', companyName: '-', legacyCustomerName: 'n/a' })).toBe('');
    expect(getCustomerDisplayName({})).toBe('');
  });
});

describe('resolveCustomerNameById (identity by stable id, never by display string)', () => {
  const customers = [
    { id: 'CUST-0035', name: '_', businessName: 'Mphandula CDSS' },
    { id: 'CUST-0036', name: 'Legacy Only School' },
    { id: 'CUST-0037', businessName: '_', companyName: 'Acme Printers' },
    { id: 'CUST-0038', name: '_' },
  ];

  it('resolves the business name for a known id', () => {
    expect(resolveCustomerNameById('CUST-0035', customers)).toBe('Mphandula CDSS');
  });

  it('falls back to the legacy name when businessName is a placeholder', () => {
    expect(resolveCustomerNameById('CUST-0037', customers)).toBe('Acme Printers');
  });

  it('returns empty for an unknown id — never a name guessed from input', () => {
    expect(resolveCustomerNameById('CUST-9999', customers)).toBe('');
    expect(resolveCustomerNameById('Mphandula CDSS', customers)).toBe('');
  });

  it('returns empty when the customer carries no usable name', () => {
    expect(resolveCustomerNameById('CUST-0038', customers)).toBe('');
  });
});

describe('customerNameOf (internal screens only: id is the last resort, never a placeholder)', () => {
  const customers = [{ id: 'CUST-0035', businessName: 'Mphandula CDSS' }];

  it('returns the resolved name when the id is known', () => {
    expect(customerNameOf('CUST-0035', customers)).toBe('Mphandula CDSS');
  });

  it('returns the raw id for an unresolved reference (actionable, not blank)', () => {
    expect(customerNameOf('CUST-0040', customers)).toBe('CUST-0040');
  });

  it('returns an em dash only when no reference exists at all', () => {
    expect(customerNameOf('', customers)).toBe('—');
    expect(customerNameOf(undefined, customers)).toBe('—');
  });
});
