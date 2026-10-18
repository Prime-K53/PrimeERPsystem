/**
 * customerAccountScope.test.ts — customer/branch financial identity.
 *
 * Proves the account-identity rules that the ledger, payment allocation and
 * statements all depend on:
 *   1. a branch is identified by its STABLE embedded id, never by its name;
 *   2. two branches that share a display name are TWO accounts and can never
 *      collide — a name-only (legacy) row fails safe and is FLAGGED;
 *   3. a missing scope never means "all accounts";
 *   4. Main and branch scopes are mutually exclusive;
 *   5. the authoritative allocation ownership rule refuses cross-customer,
 *      cross-branch, sibling-branch and ambiguous legacy allocations.
 *
 * Every assertion here fails if the corresponding safeguard is removed.
 *
 * Run: cd frontend && npx vitest run tests/customerAccountScope.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAccountScope,
  resolveRecordScope,
  mainAccountScope,
  validateAccountScope,
  recordBranchKeys,
  recordMatchesScope,
  recordScopeDisposition,
  filterRecordsByScope,
  collectAmbiguousScopeRecords,
  scopeIdentity,
  isSameAccountScope,
  assertSameAccountOwnership,
} from '../services/customerAccountScope';

/** A customer whose two branches deliberately share the display name. */
const CUSTOMER_SHARED = {
  id: 'CUST-1',
  name: 'Alpha Schools',
  subAccounts: [
    { id: 'SUB-A', name: 'Exam Centre' },
    { id: 'SUB-B', name: 'Exam Centre' }, // same name, DIFFERENT branch
    { id: 'SUB-C', name: 'Fees' },
  ],
};

/** A customer with unique branch names. */
const CUSTOMER_UNIQUE = {
  id: 'CUST-2',
  name: 'Beta Academy',
  subAccounts: [
    { id: 'SUB-X', name: 'Fees' },
    { id: 'SUB-Y', name: 'Boarding' },
  ],
};

describe('A. branch identity is the stable id, never the name', () => {
  it('two branches with the SAME name resolve to distinct stable scopes', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const b = resolveAccountScope('CUST-1', 'SUB-B', CUSTOMER_SHARED);
    expect(a.branchKey).toBe('id:SUB-A');
    expect(b.branchKey).toBe('id:SUB-B');
    expect(a.branchId).toBe('SUB-A');
    expect(b.branchId).toBe('SUB-B');
    expect(a.branchKey).not.toBe(b.branchKey);
    expect(isSameAccountScope(a, b)).toBe(false);
  });

  it('a display name shared by two branches is reported AMBIGUOUS (no stable id)', () => {
    const byName = resolveAccountScope('CUST-1', 'Exam Centre', CUSTOMER_SHARED);
    expect(byName.branchId).toBeNull();
    expect(byName.ambiguous).toBe(true);
    expect(byName.branchKey).toBe('name:exam-centre');
  });

  it('a unique display name is promoted to its stable id', () => {
    const scope = resolveAccountScope('CUST-2', 'Boarding', CUSTOMER_UNIQUE);
    expect(scope.branchKey).toBe('id:SUB-Y');
    expect(scope.branchId).toBe('SUB-Y');
    expect(scope.ambiguous).toBe(false);
    expect(scope.branchLabel).toBe('Boarding');
  });

  it('an explicit id that belongs to the customer resolves to that branch', () => {
    const scope = resolveAccountScope('CUST-2', 'SUB-X', CUSTOMER_UNIQUE);
    expect(scope.branchKey).toBe('id:SUB-X');
    expect(scope.branchLabel).toBe('Fees');
  });

  it('Main is the default only when no branch was selected', () => {
    for (const branch of [undefined, null, '', 'Main', 'main account']) {
      const s = resolveAccountScope('CUST-1', branch as any, CUSTOMER_SHARED);
      expect(s.isMain).toBe(true);
      expect(s.branchKey).toBe('main');
      expect(s.branchId).toBeNull();
    }
  });

  it('branch keys match case-insensitively so a legacy capitalisation still maps', () => {
    const lower = resolveAccountScope('CUST-2', 'boarding', CUSTOMER_UNIQUE);
    const upper = resolveAccountScope('CUST-2', 'BOARDING', CUSTOMER_UNIQUE);
    expect(lower.branchKey).toBe('id:SUB-Y');
    expect(upper.branchKey).toBe('id:SUB-Y');
  });
});

describe('B. recordBranchKeys recognizes subAccountId / sub_account_id / branch_id', () => {
  it('reads the camelCase stable id', () => {
    expect(recordBranchKeys({ subAccountId: 'SUB-A' })).toEqual(['id:SUB-A']);
  });

  it('reads the snake_case stable id (backend projection parity)', () => {
    expect(recordBranchKeys({ sub_account_id: 'SUB-A' })).toEqual(['id:SUB-A']);
  });

  it('reads branch_id / branchId', () => {
    expect(recordBranchKeys({ branchId: 'SUB-A' })).toContain('id:SUB-A');
    expect(recordBranchKeys({ branch_id: 'SUB-A' })).toContain('id:SUB-A');
  });

  it('exposes BOTH the id key and the name key when both are present', () => {
    const keys = recordBranchKeys({ subAccountId: 'SUB-A', subAccountName: 'Exam Centre' });
    expect(keys).toContain('id:SUB-A');
    expect(keys).toContain('name:exam-centre');
  });

  it('an id-tagged row with a BLANK name is a branch row, not Main', () => {
    const keys = recordBranchKeys({ subAccountId: 'SUB-A', subAccountName: '' });
    expect(keys).toEqual(['id:SUB-A']);
    expect(keys).not.toContain('main');
  });

  it('an untagged legacy row is Main', () => {
    expect(recordBranchKeys({})).toEqual(['main']);
    expect(recordBranchKeys({ subAccountName: 'Main' })).toEqual(['main']);
  });
});

describe('C. scope matching never bleeds between accounts', () => {
  const recA = { id: 'INV-A', customerId: 'CUST-1', subAccountId: 'SUB-A', subAccountName: 'Exam Centre' };
  const recB = { id: 'INV-B', customerId: 'CUST-1', subAccountId: 'SUB-B', subAccountName: 'Exam Centre' };
  const recLegacy = { id: 'INV-L', customerId: 'CUST-1', subAccountName: 'Exam Centre' };
  const recMain = { id: 'INV-M', customerId: 'CUST-1' };

  it('an id-tagged row matches ONLY its own branch', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const b = resolveAccountScope('CUST-1', 'SUB-B', CUSTOMER_SHARED);
    expect(recordMatchesScope(recA, a, CUSTOMER_SHARED)).toBe(true);
    expect(recordMatchesScope(recA, b, CUSTOMER_SHARED)).toBe(false);
    expect(recordMatchesScope(recB, b, CUSTOMER_SHARED)).toBe(true);
    expect(recordMatchesScope(recB, a, CUSTOMER_SHARED)).toBe(false);
  });

  it('a legacy NAME-only row does NOT match either same-named branch (fail safe)', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const b = resolveAccountScope('CUST-1', 'SUB-B', CUSTOMER_SHARED);
    expect(recordMatchesScope(recLegacy, a, CUSTOMER_SHARED)).toBe(false);
    expect(recordMatchesScope(recLegacy, b, CUSTOMER_SHARED)).toBe(false);
    const disposition = recordScopeDisposition(recLegacy, a, CUSTOMER_SHARED);
    expect(disposition.matches).toBe(false);
    expect(disposition.ambiguous).toBe(true);
    expect(disposition.reason).toMatch(/ambiguous/);
  });

  it('a legacy name-only row DOES match when the name is unique for the customer', () => {
    const legacyUnique = { id: 'INV-U', customerId: 'CUST-2', subAccountName: 'Boarding' };
    const y = resolveAccountScope('CUST-2', 'SUB-Y', CUSTOMER_UNIQUE);
    expect(recordMatchesScope(legacyUnique, y, CUSTOMER_UNIQUE)).toBe(true);
  });

  it('untagged rows belong to Main and branch scopes exclude them', () => {
    const main = mainAccountScope('CUST-1');
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    expect(recordMatchesScope(recMain, main)).toBe(true);
    expect(recordMatchesScope(recMain, a, CUSTOMER_SHARED)).toBe(false);
    expect(recordMatchesScope(recA, main)).toBe(false);
    expect(recordMatchesScope(recLegacy, main, CUSTOMER_SHARED)).toBe(false);
  });

  it('Main excludes every branch row (Main must be explicit, never a catch-all)', () => {
    const main = mainAccountScope('CUST-1');
    const scoped = filterRecordsByScope([recA, recB, recLegacy, recMain], main, CUSTOMER_SHARED);
    expect(scoped.map((r) => r.id)).toEqual(['INV-M']);
  });

  it('a different customer id never matches, even with an identical branch name', () => {
    const foreign = { id: 'INV-F', customerId: 'CUST-OTHER', subAccountName: 'Exam Centre' };
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    expect(recordMatchesScope(foreign, a, CUSTOMER_SHARED)).toBe(false);
  });

  it('an empty-customer scope matches NOTHING (fails closed)', () => {
    const empty = mainAccountScope('');
    expect(filterRecordsByScope([recA, recMain], empty, CUSTOMER_SHARED)).toEqual([]);
  });
});

describe('D. ambiguity is flagged, never silently attributed', () => {
  it('collects the legacy rows that a shared branch name makes unattributable', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const rows = [
      { id: 'INV-A', customerId: 'CUST-1', subAccountId: 'SUB-A' },
      { id: 'INV-L1', customerId: 'CUST-1', subAccountName: 'Exam Centre' },
      { id: 'INV-L2', customerId: 'CUST-1', subAccountName: 'exam centre' },
      { id: 'INV-M', customerId: 'CUST-1' },
      { id: 'INV-OTHER', customerId: 'CUST-OTHER', subAccountName: 'Exam Centre' },
    ];
    const flagged = collectAmbiguousScopeRecords(rows, a, CUSTOMER_SHARED);
    expect(flagged.map((f) => f.id).sort()).toEqual(['INV-L1', 'INV-L2']);
    expect(flagged.every((f) => f.reason.includes('ambiguous'))).toBe(true);
  });

  it('reports nothing ambiguous for a uniquely named branch', () => {
    const x = resolveAccountScope('CUST-2', 'SUB-X', CUSTOMER_UNIQUE);
    const flagged = collectAmbiguousScopeRecords(
      [{ id: 'I1', customerId: 'CUST-2', subAccountName: 'Fees' }],
      x,
      CUSTOMER_UNIQUE,
    );
    expect(flagged).toEqual([]);
  });
});

describe('E. validateAccountScope enforces parent-child ownership', () => {
  it('accepts Main', () => {
    expect(validateAccountScope(mainAccountScope('CUST-1'), CUSTOMER_SHARED).ok).toBe(true);
  });

  it('accepts a branch id that belongs to the customer (even if its NAME is shared)', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const result = validateAccountScope(a, CUSTOMER_SHARED);
    expect(result.ok).toBe(true);
    expect(result.ambiguous).toBe(true); // warns about the shared name
  });

  it('rejects a branch that does NOT belong to the customer', () => {
    const foreign = resolveAccountScope('CUST-1', 'EXAM-CENTRE-BRANCH', CUSTOMER_SHARED);
    const result = validateAccountScope(foreign, CUSTOMER_SHARED);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not-owned|not_owned|branch/);
  });

  it('rejects an unresolvable name-only branch scope', () => {
    const nameOnly = resolveAccountScope('CUST-1', 'Exam Centre', CUSTOMER_SHARED);
    const result = validateAccountScope(nameOnly, CUSTOMER_SHARED);
    expect(result.ok).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it('rejects a branch scope when the parent customer is missing (fails closed)', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const result = validateAccountScope(a, null);
    expect(result.ok).toBe(false);
  });

  it('rejects a scope with no customer id', () => {
    expect(validateAccountScope(mainAccountScope(''), CUSTOMER_SHARED).ok).toBe(false);
    expect(validateAccountScope(null, CUSTOMER_SHARED).ok).toBe(false);
  });
});

describe('F. authoritative allocation ownership rule', () => {
  const mainInvoice = { id: 'INV-M', customerId: 'CUST-1', totalAmount: 100 };
  const invoiceA = { id: 'INV-A', customerId: 'CUST-1', subAccountId: 'SUB-A', subAccountName: 'Exam Centre' };
  const invoiceB = { id: 'INV-B', customerId: 'CUST-1', subAccountId: 'SUB-B', subAccountName: 'Exam Centre' };
  const legacyInvoice = { id: 'INV-L', customerId: 'CUST-1', subAccountName: 'Exam Centre' };

  it('allows a Main payment to settle a Main invoice', () => {
    const pay = { id: 'P1', customerId: 'CUST-1', amount: 50 };
    expect(() => assertSameAccountOwnership(pay, mainInvoice, CUSTOMER_SHARED)).not.toThrow();
  });

  it('allows a branch payment to settle its OWN branch, resolved from the name', () => {
    // Payment carries the display name only; it must resolve to SUB-A via the
    // customer and then match the id-tagged invoice.
    const pay = { id: 'P2', customerId: 'CUST-1', subAccountName: 'Fees' };
    const invoice = { id: 'INV-C', customerId: 'CUST-1', subAccountId: 'SUB-C', subAccountName: 'Fees' };
    expect(() => assertSameAccountOwnership(pay, invoice, CUSTOMER_SHARED)).not.toThrow();
  });

  it('refuses a Main payment against a BRANCH invoice', () => {
    const pay = { id: 'P3', customerId: 'CUST-1', amount: 50 };
    try {
      assertSameAccountOwnership(pay, invoiceA, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('refuses a BRANCH payment against a Main invoice', () => {
    const pay = { id: 'P4', customerId: 'CUST-1', subAccountId: 'SUB-A' };
    try {
      assertSameAccountOwnership(pay, mainInvoice, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('refuses SIBLING-branch allocation (A -> B)', () => {
    const pay = { id: 'P5', customerId: 'CUST-1', subAccountId: 'SUB-A' };
    try {
      assertSameAccountOwnership(pay, invoiceB, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
      expect(err.invoiceId).toBe('INV-B');
    }
  });

  it('refuses a CROSS-CUSTOMER allocation even when the branch names match', () => {
    const pay = { id: 'P6', customerId: 'CUST-1', subAccountId: 'SUB-A' };
    const otherCustomerInvoice = { id: 'INV-Z', customerId: 'CUST-OTHER', subAccountId: 'SUB-A', subAccountName: 'Exam Centre' };
    try {
      assertSameAccountOwnership(pay, otherCustomerInvoice, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('refuses a legacy name-only allocation when the name is shared (ambiguous)', () => {
    const pay = { id: 'P7', customerId: 'CUST-1', subAccountName: 'Exam Centre' };
    try {
      assertSameAccountOwnership(pay, legacyInvoice, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('EAMBIGUOUS_SCOPE');
    }
  });

  it('refuses a branch id that is not owned by the parent customer', () => {
    const pay = { id: 'P8', customerId: 'CUST-1', subAccountId: 'SUB-X' };
    const invoice = { id: 'INV-X', customerId: 'CUST-1', subAccountId: 'SUB-X' };
    try {
      assertSameAccountOwnership(pay, invoice, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('EINVALID_SCOPE');
    }
  });

  it('refuses when the payment has no resolvable customer scope', () => {
    const pay = { id: 'P9', amount: 10 };
    try {
      assertSameAccountOwnership(pay, mainInvoice, CUSTOMER_SHARED);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('EAMBIGUOUS_SCOPE');
    }
  });
});

describe('G. identity helpers', () => {
  it('scopeIdentity is stable and distinct per account', () => {
    const a = resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER_SHARED);
    const b = resolveAccountScope('CUST-1', 'SUB-B', CUSTOMER_SHARED);
    const m = mainAccountScope('CUST-1');
    expect(scopeIdentity(a)).toBe('CUST-1::id:SUB-A');
    expect(new Set([scopeIdentity(a), scopeIdentity(b), scopeIdentity(m)]).size).toBe(3);
  });

  it('resolveRecordScope prefers the stable id over a (possibly wrong) name', () => {
    const record = { customerId: 'CUST-1', subAccountId: 'SUB-B', subAccountName: 'Fees' };
    const scope = resolveRecordScope(record, CUSTOMER_SHARED);
    expect(scope.branchKey).toBe('id:SUB-B');
  });
});
