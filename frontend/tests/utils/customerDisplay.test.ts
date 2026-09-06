import { describe, it, expect } from 'vitest';
import { getCustomerDisplayName, getCustomerContactName, resolveCustomerDisplay } from '../../utils/customerDisplay';

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
