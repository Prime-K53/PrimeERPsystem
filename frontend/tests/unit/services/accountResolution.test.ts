import { describe, expect, it, beforeEach, vi } from 'vitest';

const MOCK_ACCOUNTS = [
  { id: 'acc-uuid-1000', code: '1000', account_number: '1111', name: 'Main Cash', account_type: 'ASSET', is_active: true, allow_posting: true, is_system_account: true },
  { id: 'acc-uuid-1050', code: '1050', account_number: '1121', name: 'FDH Bank', account_type: 'ASSET', is_active: true, allow_posting: true },
  { id: 'acc-uuid-1100', code: '1100', account_number: '1211', name: 'Accounts Receivable', account_type: 'ASSET', is_active: true, allow_posting: true },
  { id: 'acc-uuid-1200', code: '1200', account_number: '1300', name: 'Inventory', account_type: 'ASSET', is_active: true, allow_posting: true },
  { id: 'acc-uuid-2000', code: '2000', account_number: '2110', name: 'Accounts Payable', account_type: 'LIABILITY', is_active: true, allow_posting: true },
  { id: 'acc-uuid-3000', code: '3000', account_number: '3000', name: 'Capital', account_type: 'EQUITY', is_active: true, allow_posting: true },
  { id: 'acc-uuid-4000', code: '4000', account_number: '4110', name: 'Sales', account_type: 'INCOME', is_active: true, allow_posting: true },
  { id: 'acc-uuid-5000', code: '5000', account_number: '5000', name: 'COGS', account_type: 'EXPENSE', is_active: true, allow_posting: true },
  { id: 'acc-uuid-6100', code: '6100', account_number: '6100', name: 'Operating Expenses', account_type: 'EXPENSE', is_active: false, allow_posting: true },
  { id: 'acc-uuid-parent', code: '6000', account_number: '6000', name: 'Expenses Group', account_type: 'EXPENSE', is_active: true, allow_posting: false },
  { id: 'acc-uuid-other-company', code: '9999', account_number: '9999', name: 'Other Company Account', account_type: 'ASSET', is_active: true, allow_posting: true, company_id: 'other-company-id' },
];

describe('resolveAccountForPosting', () => {
  let resolveAccountForPosting: any;

  beforeEach(async () => {
    const module = await import('../../../services/transactions/_internal');
    resolveAccountForPosting = module.resolveAccountForPosting;
  });

  describe('UUID identifiers', () => {
    it('returns UUID when account exists', () => {
      const result = resolveAccountForPosting('acc-uuid-1000', MOCK_ACCOUNTS, {});
      expect(result).toBe('acc-uuid-1000');
    });

    it('returns null when UUID does not exist', () => {
      const result = resolveAccountForPosting('non-existent-uuid', MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });
  });

  describe('Legacy code identifiers', () => {
    it('resolves legacy code "1000" to account.id', () => {
      const result = resolveAccountForPosting('1000', MOCK_ACCOUNTS, {});
      expect(result).toBe('acc-uuid-1000');
    });

    it('resolves legacy code "1050" to account.id', () => {
      const result = resolveAccountForPosting('1050', MOCK_ACCOUNTS, {});
      expect(result).toBe('acc-uuid-1050');
    });

    it('resolves account_number "1111" to account.id', () => {
      const result = resolveAccountForPosting('1111', MOCK_ACCOUNTS, {});
      expect(result).toBe('acc-uuid-1000');
    });

    it('returns null for non-existent code', () => {
      const result = resolveAccountForPosting('8888', MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });
  });

  describe('Inactive account validation', () => {
    it('rejects inactive account by default', () => {
      const result = resolveAccountForPosting('6100', MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });

    it('accepts inactive account when allowInactive=true', () => {
      const result = resolveAccountForPosting('6100', MOCK_ACCOUNTS, { allowInactive: true });
      expect(result).toBe('acc-uuid-6100');
    });
  });

  describe('Non-posting account validation', () => {
    it('rejects non-posting account by default', () => {
      const result = resolveAccountForPosting('6000', MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });

    it('accepts non-posting account when allowNonPosting=true', () => {
      const result = resolveAccountForPosting('6000', MOCK_ACCOUNTS, { allowNonPosting: true });
      expect(result).toBe('acc-uuid-parent');
    });
  });

  describe('Company/tenant validation', () => {
    it('rejects cross-company account by default', () => {
      const result = resolveAccountForPosting('9999', MOCK_ACCOUNTS, { companyId: 'my-company' });
      expect(result).toBeNull();
    });

    it('accepts account when company matches', () => {
      const result = resolveAccountForPosting('9999', MOCK_ACCOUNTS, { companyId: 'other-company-id' });
      expect(result).toBe('acc-uuid-other-company');
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty identifier', () => {
      const result = resolveAccountForPosting('', MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });

    it('returns null for null identifier', () => {
      const result = resolveAccountForPosting(null as any, MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });

    it('returns null for undefined identifier', () => {
      const result = resolveAccountForPosting(undefined as any, MOCK_ACCOUNTS, {});
      expect(result).toBeNull();
    });

    it('handles empty accounts array', () => {
      const result = resolveAccountForPosting('1000', [], {});
      expect(result).toBeNull();
    });
  });
});

describe('resolveToAccountId (backward compatibility)', () => {
  let resolveToAccountId: any;

  beforeEach(async () => {
    const module = await import('../../../services/transactions/_internal');
    resolveToAccountId = module.resolveToAccountId;
  });

  it('returns UUID as-is', () => {
    const result = resolveToAccountId('acc-uuid-1000', MOCK_ACCOUNTS);
    expect(result).toBe('acc-uuid-1000');
  });

  it('resolves legacy code to account.id when accounts provided', () => {
    const result = resolveToAccountId('1000', MOCK_ACCOUNTS);
    expect(result).toBe('acc-uuid-1000');
  });

  it('returns identifier as-is when account not found (backward compat)', () => {
    const result = resolveToAccountId('DOES-NOT-EXIST', MOCK_ACCOUNTS);
    expect(result).toBe('DOES-NOT-EXIST');
  });

  it('returns identifier as-is when accounts list not provided (backward compat)', () => {
    const result = resolveToAccountId('1000', undefined);
    expect(result).toBe('1000');
  });
});

describe('Normal balance verification (Phase 1 regression)', () => {
  it('Main Cash has DEBIT normal balance', () => {
    const cashAccount = MOCK_ACCOUNTS.find(a => a.code === '1000');
    expect(cashAccount).toBeDefined();
    expect(cashAccount!.account_type).toBe('ASSET');
  });

  it('Accounts Receivable has DEBIT normal balance', () => {
    const arAccount = MOCK_ACCOUNTS.find(a => a.code === '1100');
    expect(arAccount).toBeDefined();
    expect(arAccount!.account_type).toBe('ASSET');
  });

  it('Accounts Payable has CREDIT normal balance', () => {
    const apAccount = MOCK_ACCOUNTS.find(a => a.code === '2000');
    expect(apAccount).toBeDefined();
    expect(apAccount!.account_type).toBe('LIABILITY');
  });

  it('Sales has CREDIT normal balance', () => {
    const salesAccount = MOCK_ACCOUNTS.find(a => a.code === '4000');
    expect(salesAccount).toBeDefined();
    expect(salesAccount!.account_type).toBe('INCOME');
  });

  it('COGS has DEBIT normal balance', () => {
    const cogsAccount = MOCK_ACCOUNTS.find(a => a.code === '5000');
    expect(cogsAccount).toBeDefined();
    expect(cogsAccount!.account_type).toBe('EXPENSE');
  });
});

describe('requireResolvedAccount (strict mode)', () => {
  let requireResolvedAccount: any;
  let UnresolvedAccountError: any;

  beforeEach(async () => {
    const module = await import('../../../services/transactions/_internal');
    requireResolvedAccount = module.requireResolvedAccount;
    UnresolvedAccountError = module.UnresolvedAccountError;
  });

  it('returns canonical ID for valid legacy code', () => {
    const result = requireResolvedAccount('1000', MOCK_ACCOUNTS, {});
    expect(result).toBe('acc-uuid-1000');
  });

  it('returns canonical ID for valid UUID', () => {
    const result = requireResolvedAccount('acc-uuid-1000', MOCK_ACCOUNTS, {});
    expect(result).toBe('acc-uuid-1000');
  });

  it('returns canonical ID for valid account_number', () => {
    const result = requireResolvedAccount('1111', MOCK_ACCOUNTS, {});
    expect(result).toBe('acc-uuid-1000');
  });

  it('throws UnresolvedAccountError for nonexistent account', () => {
    expect(() => {
      requireResolvedAccount('DOES-NOT-EXIST', MOCK_ACCOUNTS, {});
    }).toThrow(UnresolvedAccountError);
  });

  it('throws UnresolvedAccountError for undefined', () => {
    expect(() => {
      requireResolvedAccount(undefined as any, MOCK_ACCOUNTS, {});
    }).toThrow(UnresolvedAccountError);
  });

  it('throws UnresolvedAccountError for inactive account by default', () => {
    expect(() => {
      requireResolvedAccount('6100', MOCK_ACCOUNTS, {});
    }).toThrow(UnresolvedAccountError);
  });

  it('allows inactive account when allowInactive=true', () => {
    const result = requireResolvedAccount('6100', MOCK_ACCOUNTS, { allowInactive: true });
    expect(result).toBe('acc-uuid-6100');
  });

  it('throws UnresolvedAccountError for non-posting account by default', () => {
    expect(() => {
      requireResolvedAccount('6000', MOCK_ACCOUNTS, {});
    }).toThrow(UnresolvedAccountError);
  });

  it('allows non-posting account when allowNonPosting=true', () => {
    const result = requireResolvedAccount('6000', MOCK_ACCOUNTS, { allowNonPosting: true });
    expect(result).toBe('acc-uuid-parent');
  });

  it('throws UnresolvedAccountError for cross-company account by default', () => {
    expect(() => {
      requireResolvedAccount('9999', MOCK_ACCOUNTS, { companyId: 'my-company' });
    }).toThrow(UnresolvedAccountError);
  });

  it('allows account when company matches', () => {
    const result = requireResolvedAccount('9999', MOCK_ACCOUNTS, { companyId: 'other-company-id' });
    expect(result).toBe('acc-uuid-other-company');
  });
});

describe('UnresolvedAccountError', () => {
  let UnresolvedAccountError: any;

  beforeEach(async () => {
    const module = await import('../../../services/transactions/_internal');
    UnresolvedAccountError = module.UnresolvedAccountError;
  });

  it('has correct name', () => {
    const error = new UnresolvedAccountError('1000');
    expect(error.name).toBe('UnresolvedAccountError');
  });

  it('contains the account reference', () => {
    const error = new UnresolvedAccountError('1000');
    expect(error.message).toBe('Unable to resolve posting account: 1000');
    expect(error.accountRef).toBe('1000');
  });
});
