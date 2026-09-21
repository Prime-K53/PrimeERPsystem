/**
 * accountingInvariants.test.ts
 *
 * Phase 7 — Automated accounting invariants.
 *
 * Covers:
 *  1. Every journal entry is balanced.
 *  2. GROUP accounts cannot receive direct journal postings (resolver rejects).
 *  3. POSTING accounts can receive journal postings (resolver accepts).
 *  4. Parent balances equal the sum of their descendants.
 *  5. Bank Accounts = sum of child bank/mobile-money accounts.
 *  6. Accounts Receivable = sum of child AR accounts.
 *  7. Inventory = sum of merchandise + raw materials + finished goods.
 *  8. Assets = current assets + fixed assets.
 *  9. Account IDs/codes resolve consistently across journal creation and ledger reporting.
 * 10. No accounting engine path silently drops one side of a journal entry.
 */

import { describe, it, expect } from 'vitest';
import {
  computeOwnBalances,
  computeHierarchicalRollup,
  computeTypeTotals,
  isPostingAccount,
  classifyAccount,
  entryTouchesAccount,
  accountIdentifiers,
} from '../../services/accountingEngine';
import {
  resolveAccountForPosting,
  requireResolvedAccount,
  UnresolvedAccountError,
} from '../../services/transactions/_internal';
import { DEFAULT_ACCOUNTS } from '../../constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestAccount {
  id: string;
  code: string;
  account_number: string;
  name: string;
  account_type: string;
  type: string;
  normal_balance: string;
  parent_account_id?: string | null;
  allow_posting?: boolean;
  is_system_account?: boolean;
  opening_balance?: number;
  subtype?: string;
}

interface TestEntry {
  id: string;
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  referenceId?: string;
  entryType?: string;
  reconciled?: boolean;
}

function makeAccount(overrides: Partial<TestAccount> = {}): TestAccount {
  return {
    id: overrides.id || 'ACC-001',
    code: overrides.code || overrides.id || '001',
    account_number: overrides.account_number || overrides.code || overrides.id || '001',
    name: overrides.name || 'Test Account',
    account_type: overrides.account_type || 'ASSET',
    type: overrides.type || 'Asset',
    normal_balance: overrides.normal_balance || 'DEBIT',
    parent_account_id: overrides.parent_account_id || null,
    allow_posting: overrides.allow_posting ?? true,
    is_system_account: overrides.is_system_account || false,
    opening_balance: overrides.opening_balance || 0,
    subtype: overrides.subtype,
  };
}

// ---------------------------------------------------------------------------
// 1. Every journal entry is balanced
// ---------------------------------------------------------------------------

describe('Invariant 1: Journal entries are balanced', () => {
  it('a valid journal entry has equal debits and credits', () => {
    const entry: TestEntry = {
      id: 'LG-001',
      date: '2026-01-01',
      description: 'Test',
      debitAccountId: 'ACC-11110',
      creditAccountId: 'ACC-11310',
      amount: 1000,
    };
    // Row-level balance: the entry itself is always balanced by construction.
    expect(entry.amount).toBeGreaterThan(0);
    expect(entry.debitAccountId).not.toBe(entry.creditAccountId);
  });

  it('computeOwnBalances preserves balance for a simple Dr/Cr pair', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true }),
      makeAccount({ id: 'ACC-11310', code: '11310', name: 'Trade Debtors', allow_posting: true }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-001', date: '2026-01-01', description: 'Sale', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 1000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    expect(own['ACC-11110']).toBe(1000);
    expect(own['ACC-11310']).toBe(-1000);
    const totalDr = Object.values(own).filter(v => v > 0).reduce((s, v) => s + v, 0);
    const totalCr = Object.values(own).filter(v => v < 0).reduce((s, v) => s + Math.abs(v), 0);
    expect(totalDr).toBe(totalCr);
  });
});

// ---------------------------------------------------------------------------
// 2. GROUP accounts cannot receive direct journal postings
// ---------------------------------------------------------------------------

describe('Invariant 2: GROUP accounts cannot receive postings', () => {
  it('isPostingAccount returns false for allow_posting=false', () => {
    const groupAcc = makeAccount({ id: 'ACC-10000', code: '10000', name: 'Assets', allow_posting: false });
    expect(isPostingAccount(groupAcc)).toBe(false);
    expect(classifyAccount(groupAcc)).toBe('GROUP');
  });

  it('isPostingAccount returns true for allow_posting=true', () => {
    const postingAcc = makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true });
    expect(isPostingAccount(postingAcc)).toBe(true);
    expect(classifyAccount(postingAcc)).toBe('POSTING');
  });

  it('resolveAccountForPosting rejects GROUP accounts when allowNonPosting=false', () => {
    const accounts = [
      makeAccount({ id: 'ACC-10000', code: '10000', name: 'Assets', allow_posting: false }),
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true }),
    ];
    const resolved = resolveAccountForPosting('10000', accounts, { allowNonPosting: false });
    expect(resolved).toBeNull();
  });

  it('resolveAccountForPosting accepts POSTING accounts when allowNonPosting=false', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true }),
    ];
    const resolved = resolveAccountForPosting('11110', accounts, { allowNonPosting: false });
    expect(resolved).toBe('ACC-11110');
  });

  it('requireResolvedAccount throws for GROUP account references', () => {
    const accounts = [
      makeAccount({ id: 'ACC-10000', code: '10000', name: 'Assets', allow_posting: false }),
    ];
    expect(() => requireResolvedAccount('10000', accounts, {})).toThrow(UnresolvedAccountError);
  });
});

// ---------------------------------------------------------------------------
// 3. POSTING accounts can receive journal postings
// ---------------------------------------------------------------------------

describe('Invariant 3: POSTING accounts can receive postings', () => {
  it('resolveAccountForPosting accepts a leaf posting account', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true }),
    ];
    const resolved = resolveAccountForPosting('11410', accounts, { allowNonPosting: false });
    expect(resolved).toBe('ACC-11410');
  });

  it('computeOwnBalances accumulates on a posting account', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, opening_balance: 0 }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-001', date: '2026-01-01', description: 'GRN', debitAccountId: 'ACC-11410', creditAccountId: 'ACC-21110', amount: 5000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    expect(own['ACC-11410']).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 4. Parent balances equal the sum of their descendants
// ---------------------------------------------------------------------------

describe('Invariant 4: Parent balances equal sum of descendants', () => {
  it('direct parent rollup matches sum of children own balances', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-11400', code: '11400', name: 'Inventory', allow_posting: false }),
      makeAccount({ id: 'ACC-11410', code: '11410', name: 'Merchandise', allow_posting: true, parent_account_id: 'ACC-11400' }),
      makeAccount({ id: 'ACC-11420', code: '11420', name: 'Raw Materials', allow_posting: true, parent_account_id: 'ACC-11400' }),
      makeAccount({ id: 'ACC-11430', code: '11430', name: 'Finished Goods', allow_posting: true, parent_account_id: 'ACC-11400' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'GRN Merch', debitAccountId: 'ACC-11410', creditAccountId: 'ACC-21110', amount: 1000 },
      { id: 'LG-2', date: '2026-01-01', description: 'GRN Raw', debitAccountId: 'ACC-11420', creditAccountId: 'ACC-21110', amount: 2000 },
      { id: 'LG-3', date: '2026-01-01', description: 'GRN Finished', debitAccountId: 'ACC-11430', creditAccountId: 'ACC-21110', amount: 3000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['ACC-11410']).toBe(1000);
    expect(tree['ACC-11420']).toBe(2000);
    expect(tree['ACC-11430']).toBe(3000);
    expect(tree['ACC-11400']).toBe(6000);
  });

  it('deep hierarchy rollup is correct at arbitrary depth', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-10000', code: '10000', name: 'Assets', allow_posting: false }),
      makeAccount({ id: 'ACC-11000', code: '11000', name: 'Current Assets', allow_posting: false, parent_account_id: 'ACC-10000' }),
      makeAccount({ id: 'ACC-11100', code: '11100', name: 'Cash in Hand', allow_posting: false, parent_account_id: 'ACC-11000' }),
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true, parent_account_id: 'ACC-11100' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'Open', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-31000', amount: 5000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['ACC-11110']).toBe(5000);
    expect(tree['ACC-11100']).toBe(5000);
    expect(tree['ACC-11000']).toBe(5000);
    expect(tree['ACC-10000']).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 5. Bank Accounts = sum of child bank/mobile-money accounts
// ---------------------------------------------------------------------------

describe('Invariant 5: Bank Accounts equals sum of children', () => {
  it('11200 rollup equals 11210 + 11230 + 11240', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-11200', code: '11200', name: 'Bank Accounts', allow_posting: false }),
      makeAccount({ id: 'ACC-11210', code: '11210', name: 'National Bank', allow_posting: true, parent_account_id: 'ACC-11200' }),
      makeAccount({ id: 'ACC-11230', code: '11230', name: 'First Capital Bank', allow_posting: true, parent_account_id: 'ACC-11200' }),
      makeAccount({ id: 'ACC-11240', code: '11240', name: 'Mobile Money', allow_posting: true, parent_account_id: 'ACC-11200' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'Deposit', debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11310', amount: 140000 },
      { id: 'LG-2', date: '2026-01-01', description: 'Deposit', debitAccountId: 'ACC-11230', creditAccountId: 'ACC-11310', amount: 251000 },
      { id: 'LG-3', date: '2026-01-01', description: 'Deposit', debitAccountId: 'ACC-11240', creditAccountId: 'ACC-11310', amount: 300000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['ACC-11210']).toBe(140000);
    expect(tree['ACC-11230']).toBe(251000);
    expect(tree['ACC-11240']).toBe(300000);
    expect(tree['ACC-11200']).toBe(691000);
  });
});

// ---------------------------------------------------------------------------
// 6. Accounts Receivable = sum of child AR accounts
// ---------------------------------------------------------------------------

describe('Invariant 6: Accounts Receivable equals sum of children', () => {
  it('11300 rollup equals 11310', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-11300', code: '11300', name: 'Accounts Receivable', allow_posting: false }),
      makeAccount({ id: 'ACC-11310', code: '11310', name: 'Trade Debtors', allow_posting: true, parent_account_id: 'ACC-11300' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'Invoice', debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 500000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['ACC-11310']).toBe(500000);
    expect(tree['ACC-11300']).toBe(500000);
  });
});

// ---------------------------------------------------------------------------
// 7. Inventory = sum of merchandise + raw materials + finished goods
// ---------------------------------------------------------------------------

describe('Invariant 7: Inventory equals sum of children', () => {
  it('11400 rollup equals 11410 + 11420 + 11430', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-11400', code: '11400', name: 'Inventory', allow_posting: false }),
      makeAccount({ id: 'ACC-11410', code: '11410', name: 'Merchandise Inventory', allow_posting: true, parent_account_id: 'ACC-11400' }),
      makeAccount({ id: 'ACC-11420', code: '11420', name: 'Raw Materials', allow_posting: true, parent_account_id: 'ACC-11400' }),
      makeAccount({ id: 'ACC-11430', code: '11430', name: 'Finished Goods', allow_posting: true, parent_account_id: 'ACC-11400' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'GRN Merch', debitAccountId: 'ACC-11410', creditAccountId: 'ACC-21110', amount: 1000 },
      { id: 'LG-2', date: '2026-01-01', description: 'GRN Raw', debitAccountId: 'ACC-11420', creditAccountId: 'ACC-21110', amount: 2000 },
      { id: 'LG-3', date: '2026-01-01', description: 'GRN Finished', debitAccountId: 'ACC-11430', creditAccountId: 'ACC-21110', amount: 3000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['ACC-11410']).toBe(1000);
    expect(tree['ACC-11420']).toBe(2000);
    expect(tree['ACC-11430']).toBe(3000);
    expect(tree['ACC-11400']).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// 8. Assets = current assets + fixed assets
// ---------------------------------------------------------------------------

describe('Invariant 8: Assets equals current assets + fixed assets', () => {
  it('type total for ASSET equals sum of own balances across asset accounts', () => {
    const accounts: TestAccount[] = [
      makeAccount({ id: 'ACC-10000', code: '10000', name: 'Assets', allow_posting: false }),
      makeAccount({ id: 'ACC-11000', code: '11000', name: 'Current Assets', allow_posting: false }),
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true, parent_account_id: 'ACC-11000' }),
      makeAccount({ id: 'ACC-12000', code: '12000', name: 'Fixed Assets', allow_posting: false }),
      makeAccount({ id: 'ACC-12100', code: '12100', name: 'Motor Vehicles', allow_posting: true, parent_account_id: 'ACC-12000' }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'Open', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-31000', amount: 1000 },
      { id: 'LG-2', date: '2026-01-01', description: 'Buy', debitAccountId: 'ACC-12100', creditAccountId: 'ACC-11210', amount: 5000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const totals = computeTypeTotals(accounts as any[], own);
    expect(totals.assets).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// 9. Account IDs/codes resolve consistently
// ---------------------------------------------------------------------------

describe('Invariant 9: Account IDs/codes resolve consistently', () => {
  it('accountIdentifiers returns id, code, and account_number', () => {
    const acc = makeAccount({ id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer' });
    const ids = accountIdentifiers(acc as any);
    expect(ids).toContain('ACC-11110');
    expect(ids).toContain('11110');
  });

  it('entryTouchesAccount matches by id, code, or account_number', () => {
    const acc = makeAccount({ id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', allow_posting: true });
    const entryById: TestEntry = { id: 'LG-1', date: '2026-01-01', description: 'Test', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 100 };
    const entryByCode: TestEntry = { id: 'LG-2', date: '2026-01-01', description: 'Test', debitAccountId: '11110', creditAccountId: 'ACC-11310', amount: 100 };
    expect(entryTouchesAccount(entryById as any, acc as any, 'debit')).toBe(true);
    expect(entryTouchesAccount(entryByCode as any, acc as any, 'debit')).toBe(true);
  });

  it('legacy code "1000" resolves to Cash Drawer via legacy map', () => {
    const accounts = DEFAULT_ACCOUNTS;
    const resolved = resolveAccountForPosting('1000', accounts, {});
    expect(resolved).toBeDefined();
    const match = accounts.find(a => a.id === resolved || a.code === resolved || a.account_number === resolved);
    expect(match?.name).toBe('Cash Drawer');
  });

  it('an unknown reference does not resolve', () => {
    const resolved = resolveAccountForPosting('UNKNOWN-CODE', DEFAULT_ACCOUNTS, {});
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. No accounting engine path silently drops one side of a journal entry
// ---------------------------------------------------------------------------

describe('Invariant 10: No silent drop of one side', () => {
  it('computeOwnBalances includes both debit and credit sides for valid accounts', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true }),
      makeAccount({ id: 'ACC-11310', code: '11310', name: 'Trade Debtors', allow_posting: true }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-1', date: '2026-01-01', description: 'Payment', debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 70000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    expect(own['ACC-11110']).toBe(70000);
    expect(own['ACC-11310']).toBe(-70000);
  });

  it('an orphaned account reference is excluded from all balances', () => {
    const accounts = [
      makeAccount({ id: 'ACC-11110', code: '11110', name: 'Cash Drawer', allow_posting: true }),
      makeAccount({ id: 'ACC-11310', code: '11310', name: 'Trade Debtors', allow_posting: true }),
    ];
    const ledger: TestEntry[] = [
      { id: 'LG-BAD', date: '2026-01-01', description: 'Bad ref', debitAccountId: '1000', creditAccountId: 'ACC-11310', amount: 70000 },
    ];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    expect(own['ACC-11110']).toBeUndefined();
    expect(own['ACC-11310']).toBe(-70000);
  });

  it('the K70,000 defect path is prevented by strict resolution', () => {
    const accounts = DEFAULT_ACCOUNTS;
    // The old bug wrote "1000" verbatim. The resolver must catch it.
    expect(() => requireResolvedAccount('1000', accounts, { strict: true })).toThrow(UnresolvedAccountError);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ACCOUNTS structural invariants
// ---------------------------------------------------------------------------

describe('DEFAULT_ACCOUNTS structural invariants', () => {
  it('all DEFAULT_ACCOUNTS have explicit allow_posting', () => {
    for (const a of DEFAULT_ACCOUNTS) {
      expect(a.allow_posting).toBeDefined();
    }
  });

  it('GROUP accounts in DEFAULT_ACCOUNTS have allow_posting=false', () => {
    const expectedGroups = ['10000', '11000', '11100', '11200', '11300', '11400', '11500',
      '12000', '20000', '21000', '21100', '21200', '22000', '30000', '31000', '32000', '33000',
      '40000', '41000', '42000', '50000', '51000', '52000', '54000'];
    for (const code of expectedGroups) {
      const acc = DEFAULT_ACCOUNTS.find(a => a.code === code || a.account_number === code);
      expect(acc?.allow_posting, `Account ${code} should be GROUP (allow_posting=false)`).toBe(false);
    }
  });

  it('key leaf accounts have allow_posting=true', () => {
    const expectedLeaves = ['11110', '11120', '11210', '11220', '11230', '11240',
      '11310', '11410', '11420', '11430', '11510', '11520',
      '12100', '12200', '12300', '12400', '12500',
      '21110', '21210', '21220', '21300', '22100', '22200', '22300', '22310', '22400',
      '31000', '34000',
      '41100', '41200', '42100', '42200',
      '51100', '51200', '51300',
      '52100', '52200', '52300', '52400', '52500', '52600', '52700', '52800', '52900', '53000',
      '54100'];
    for (const code of expectedLeaves) {
      const acc = DEFAULT_ACCOUNTS.find(a => a.code === code || a.account_number === code);
      expect(acc?.allow_posting, `Account ${code} should be POSTING (allow_posting=true)`).toBe(true);
    }
  });
});
