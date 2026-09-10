/**
 * Balance-consistency regression tests (accounting audit fix).
 *
 * Covers the exact post-sale defect class:
 *  - leaf balances derived from posted journal lines
 *  - recursive parent rollup at arbitrary depth
 *  - no parent/child double counting in type totals and summary cards
 *  - trial balance validates TOTAL debits vs TOTAL credits (never per-account
 *    debit/credit symmetry)
 *  - balanced ledgers are never reported as "N accounts out of balance"
 *  - equity presentation does not duplicate profit
 *  - reversals net to zero without double counting
 *  - balance math is idempotent
 *
 * Scenario values below (4,000 opening / 324,000 credit sale) are TEST
 * FIXTURE data only. Production code must never hard-code them.
 */
import { describe, it, expect } from 'vitest';
import {
  computeOwnBalances,
  computeHierarchicalRollup,
  computeTypeTotals,
  computeTrialBalance,
  checkBalanceSheetEquation,
  buildReconciliation,
  formatReconciliation,
  getCanonicalAccountType,
  isPostedLedgerEntry,
} from '../../services/accountingEngine';
import { computeHierarchicalBalances } from '../../services/transactions/_internal';
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
  referenceType?: string;
}

/** Deeply nested COA mirroring the live hierarchy (leaf→parent→…→root). */
function nestedCoa(): TestAccount[] {
  const acc = (
    code: string,
    name: string,
    account_type: string,
    normal_balance: string,
    parent: string | null = null,
    extra: Partial<TestAccount> = {}
  ): TestAccount => ({
    id: code,
    code,
    account_number: code,
    name,
    account_type,
    type:
      account_type === 'ASSET' ? 'Asset'
      : account_type === 'LIABILITY' ? 'Liability'
      : account_type === 'EQUITY' ? 'Equity'
      : account_type === 'INCOME' ? 'Revenue'
      : 'Expense',
    normal_balance,
    parent_account_id: parent,
    ...extra,
  });
  return [
    acc('10000', 'Assets', 'ASSET', 'DEBIT', null, { allow_posting: false, is_system_account: true }),
    acc('11000', 'Current Assets', 'ASSET', 'DEBIT', '10000', { allow_posting: false }),
    acc('11100', 'Cash in Hand', 'ASSET', 'DEBIT', '11000', { allow_posting: false }),
    acc('11110', 'Cash Drawer', 'ASSET', 'DEBIT', '11100', { allow_posting: true, is_system_account: true }),
    acc('11120', 'Petty Cash', 'ASSET', 'DEBIT', '11100', { allow_posting: true }),
    acc('11300', 'Accounts Receivable', 'ASSET', 'DEBIT', '11000', { allow_posting: false, is_system_account: true }),
    acc('11310', 'Trade Debtors', 'ASSET', 'DEBIT', '11300', { allow_posting: true, is_system_account: true }),
    acc('11400', 'Inventory', 'ASSET', 'DEBIT', '11000', { allow_posting: false, is_system_account: true }),
    acc('11410', 'Merchandise Inventory', 'ASSET', 'DEBIT', '11400', { allow_posting: true }),
    acc('20000', 'Liabilities', 'LIABILITY', 'CREDIT', null, { allow_posting: false, is_system_account: true }),
    acc('21000', 'Current Liabilities', 'LIABILITY', 'CREDIT', '20000', { allow_posting: false }),
    acc('21100', 'Accounts Payable', 'LIABILITY', 'CREDIT', '21000', { allow_posting: false, is_system_account: true }),
    acc('21110', 'Trade Creditors', 'LIABILITY', 'CREDIT', '21100', { allow_posting: true, is_system_account: true }),
    acc('30000', 'Equity', 'EQUITY', 'CREDIT', null, { allow_posting: false, is_system_account: true }),
    acc('31000', "Owner's Capital", 'EQUITY', 'CREDIT', '30000', { allow_posting: true }),
    acc('32000', 'Retained Earnings', 'EQUITY', 'CREDIT', '30000', { is_system_account: true }),
    acc('33000', 'Current Year Earnings', 'EQUITY', 'CREDIT', '30000', { is_system_account: true }),
    acc('34000', 'Drawings', 'EQUITY', 'CREDIT', '30000', { allow_posting: true }),
    acc('40000', 'Income', 'INCOME', 'CREDIT', null, { allow_posting: false, is_system_account: true }),
    acc('41000', 'Sales / Revenue', 'INCOME', 'CREDIT', '40000', { allow_posting: false }),
    acc('41100', 'Product Sales', 'INCOME', 'CREDIT', '41000', { allow_posting: true, is_system_account: true }),
    acc('50000', 'Expenses', 'EXPENSE', 'DEBIT', null, { allow_posting: false, is_system_account: true }),
    acc('51000', 'Cost of Sales', 'EXPENSE', 'DEBIT', '50000', { allow_posting: false }),
    acc('51200', 'Cost of Goods Sold', 'EXPENSE', 'DEBIT', '51000', { allow_posting: true, is_system_account: true }),
  ];
}

const OPENING_JOURNAL: TestEntry[] = [
  {
    id: 'LG-OPEN-1',
    date: '2026-01-01T00:00:00.000Z',
    description: 'Opening balance',
    debitAccountId: '11110',
    creditAccountId: '31000',
    amount: 4000,
    referenceId: 'OPENING_BALANCE',
  },
];

const CREDIT_SALE_JOURNAL: TestEntry[] = [
  {
    id: 'LG-REV-AR-1',
    date: '2026-09-10T00:00:00.000Z',
    description: 'POS Sale Revenue (AR)',
    debitAccountId: '11310',
    creditAccountId: '41100',
    amount: 324000,
    referenceId: 'SALE-1',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('balance consistency (post-sale audit)', () => {
  it('Test 1 — opening balance DR 11110 / CR 31000 = 4,000 rolls up correctly', () => {
    const accounts = nestedCoa();
    const own = computeOwnBalances(accounts as any[], OPENING_JOURNAL as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    const trial = computeTrialBalance(accounts as any[], OPENING_JOURNAL as any[]);

    expect(own['11110']).toBe(4000);
    expect(own['31000']).toBe(4000);
    expect(tree['11110']).toBe(4000);
    expect(tree['11100']).toBe(4000);
    expect(tree['11000']).toBe(4000);
    expect(tree['10000']).toBe(4000);
    expect(tree['30000']).toBe(4000);
    expect(tree['31000']).toBe(4000);

    expect(trial.totalDebits).toBe(4000);
    expect(trial.totalCredits).toBe(4000);
    expect(trial.difference).toBe(0);
    expect(trial.isBalanced).toBe(true);
  });

  it('Test 2 — credit sale DR 11310 / CR 41100 = 324,000 balances the ledger', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    const totals = computeTypeTotals(accounts as any[], own);
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);

    expect(own['11310']).toBe(324000);
    expect(own['41100']).toBe(324000);
    expect(own['31000']).toBe(4000);
    expect(own['11110']).toBe(4000);

    expect(tree['11310']).toBe(324000);
    expect(tree['11300']).toBe(324000);
    expect(tree['11000']).toBe(328000);
    expect(tree['10000']).toBe(328000);

    expect(totals.assets).toBe(328000);
    expect(totals.liabilities).toBe(0);
    expect(totals.equity).toBe(4000);
    expect(totals.income).toBe(324000);
    expect(totals.expenses).toBe(0);

    expect(trial.totalDebits).toBe(328000);
    expect(trial.totalCredits).toBe(328000);
    expect(trial.difference).toBe(0);
    expect(trial.isBalanced).toBe(true);

    // Balance-sheet equation honours unclosed P&L: A = L + E + (I − X).
    const check = checkBalanceSheetEquation(totals);
    expect(check.balanced).toBe(true);
    expect(check.difference).toBe(0);
  });

  it('Test 3 — parent rollup is recursive and counts each leaf exactly once', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);

    // 11110 → 11100 → 11000 → 10000
    expect(tree['11110']).toBe(4000);
    expect(tree['11100']).toBe(4000);
    expect(tree['11000']).toBe(328000);
    expect(tree['10000']).toBe(328000);

    // Root display rollup equals the sum of posting-account own balances.
    const leafSum = ['11110', '11120', '11310', '11410'].reduce((s, id) => s + (own[id] || 0), 0);
    expect(tree['10000']).toBe(leafSum);
  });

  it('Test 4 — type totals never double-count ancestors', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const tree = computeHierarchicalRollup(accounts as any[], own);
    const totals = computeTypeTotals(accounts as any[], own);

    // Naïve (buggy) method: sum every account's ROLLED-UP balance.
    const naiveAssets = accounts
      .filter((a) => getCanonicalAccountType(a as any) === 'ASSET')
      .reduce((s, a) => s + (tree[a.id] || 0), 0);
    expect(naiveAssets).toBeGreaterThan(totals.assets); // proves the trap exists

    // Canonical method: exactly the leaf economics, once.
    expect(totals.assets).toBe(328000);
  });

  it('Test 5 — full canonical COA: a balanced ledger reports zero accounts out of balance', () => {
    const accounts = DEFAULT_ACCOUNTS as any[];
    expect(accounts.length).toBeGreaterThan(60);
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const trial = computeTrialBalance(accounts, ledger as any[]);
    const own = computeOwnBalances(accounts, ledger as any[]);
    const totals = computeTypeTotals(accounts, own);

    expect(trial.isBalanced).toBe(true);
    expect(trial.difference).toBe(0);

    // The old per-account "debit === credit" metric would flag every touched
    // account; the engine must never surface that as "out of balance".
    const asymmetric = trial.lines.filter((l) => l.totalDebit !== l.totalCredit).length;
    expect(asymmetric).toBeGreaterThan(0); // asymmetry is normal…
    expect(trial.isBalanced).toBe(true); // …and never means unbalanced.

    expect(totals.assets).toBe(328000);
    expect(totals.equity).toBe(4000);
    expect(totals.income).toBe(324000);
  });

  it('Test 5b — canonical COA hierarchy: every non-root has a parent; roots roll up the full scenario', () => {
    const accounts = DEFAULT_ACCOUNTS as any[];
    const roots = accounts.filter((a: any) => !a.parent_account_id);
    // Only the five type roots may lack a parent link.
    expect(roots.map((a: any) => a.code).sort()).toEqual(['10000', '20000', '30000', '40000', '50000']);

    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const own = computeOwnBalances(accounts, ledger as any[]);
    const tree = computeHierarchicalRollup(accounts, own);
    const totals = computeTypeTotals(accounts, own);

    // Full-depth rollup: leaf → … → root, counted exactly once.
    expect(tree['11110']).toBe(4000);
    expect(tree['11100']).toBe(4000);
    expect(tree['11000']).toBe(328000);
    expect(tree['10000']).toBe(328000);
    expect(tree['11310']).toBe(324000);
    expect(tree['11300']).toBe(324000);
    expect(tree['30000']).toBe(4000);
    expect(tree['31000']).toBe(4000);
    expect(tree['40000']).toBe(324000);
    expect(tree['41000']).toBe(324000);
    expect(tree['41100']).toBe(324000);
    // Root display rollups agree with own-balance type totals (no double count).
    expect(tree['10000']).toBe(totals.assets);
    expect(tree['20000']).toBe(totals.liabilities);
    expect(tree['30000']).toBe(totals.equity);
    expect(tree['40000']).toBe(totals.income);
    expect(tree['50000']).toBe(totals.expenses);
  });

  it('Test 6 — unbalanced/corrupt journal lines are detected, valid ones always balance', () => {
    const accounts = nestedCoa();

    // A well-formed journal (both sides resolve) always balances by construction.
    const good = computeTrialBalance(accounts as any[], CREDIT_SALE_JOURNAL as any[]);
    expect(good.totalDebits).toBe(324000);
    expect(good.totalCredits).toBe(324000);
    expect(good.isBalanced).toBe(true);

    // Corrupt line: credit side references a non-existent account, so the
    // debit is counted with no matching credit — the trial must flag it.
    const danglingCredit = computeTrialBalance(accounts as any[], [
      { id: 'D1', date: '2026-09-10', description: 'dangling credit', debitAccountId: '11310', creditAccountId: 'NO-SUCH-ACCOUNT', amount: 100 },
    ] as any[]);
    expect(danglingCredit.totalDebits).toBe(100);
    expect(danglingCredit.totalCredits).toBe(0);
    expect(danglingCredit.difference).toBe(100);
    expect(danglingCredit.isBalanced).toBe(false);

    // Corrupt line: missing debit side entirely.
    const missingDebit = computeTrialBalance(accounts as any[], [
      { id: 'D2', date: '2026-09-10', description: 'missing debit', debitAccountId: '', creditAccountId: '41100', amount: 90 },
    ] as any[]);
    expect(missingDebit.totalDebits).toBe(0);
    expect(missingDebit.totalCredits).toBe(90);
    expect(missingDebit.difference).toBe(-90);
    expect(missingDebit.isBalanced).toBe(false);
  });

  it('Test 7 — one-sided account activity (41100: D 0 / C 324,000) is not out of balance', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    const sales = trial.lines.find((l) => l.accountCode === '41100')!;
    expect(sales).toBeDefined();
    expect(sales.totalDebit).toBe(0);
    expect(sales.totalCredit).toBe(324000);
    expect(sales.balance).toBe(324000);
    expect(trial.isBalanced).toBe(true);
  });

  it('Test 8 — non-posting parents carry no independent ledger balance', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    // Parents have no direct postings: own balance is zero; their DISPLAY
    // value comes purely from descendants.
    for (const parent of ['10000', '11000', '11100', '11300', '30000', '40000', '41000']) {
      expect(own[parent] ?? 0).toBe(0);
    }
    const tree = computeHierarchicalRollup(accounts as any[], own);
    expect(tree['11100']).toBe(own['11110']);
    expect(tree['11300']).toBe(own['11310']);
  });

  it('Test 9 — offsetting reversal nets to zero and stays balanced', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const before = computeTrialBalance(accounts as any[], ledger as any[]);
    expect(before.isBalanced).toBe(true);

    // Reversal semantics used by void flows: one swapped-side entry.
    const reversed = [
      ...ledger,
      {
        id: 'LG-REV-1',
        date: '2026-09-11T00:00:00.000Z',
        description: 'REVERSAL: POS Sale Revenue (AR)',
        debitAccountId: '41100',
        creditAccountId: '11310',
        amount: 324000,
        referenceId: 'REV-SALE-1',
      },
    ];
    const own = computeOwnBalances(accounts as any[], reversed as any[]);
    const after = computeTrialBalance(accounts as any[], reversed as any[]);
    const totals = computeTypeTotals(accounts as any[], own);

    expect(own['11310']).toBe(0);
    expect(own['41100']).toBe(0);
    expect(totals.assets).toBe(4000);
    expect(after.isBalanced).toBe(true);
    // Each side grew by exactly one reversal amount — original counted once.
    expect(after.totalDebits).toBe(before.totalDebits + 324000);
    expect(after.totalCredits).toBe(before.totalCredits + 324000);
  });

  it('Test 10 — balance calculation is idempotent', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const first = {
      own: computeOwnBalances(accounts as any[], ledger as any[]),
      tree: computeHierarchicalRollup(accounts as any[], computeOwnBalances(accounts as any[], ledger as any[])),
      trial: computeTrialBalance(accounts as any[], ledger as any[]),
    };
    for (let i = 0; i < 3; i += 1) {
      expect(computeOwnBalances(accounts as any[], ledger as any[])).toEqual(first.own);
      expect(
        computeHierarchicalRollup(accounts as any[], computeOwnBalances(accounts as any[], ledger as any[]))
      ).toEqual(first.tree);
      expect(computeTrialBalance(accounts as any[], ledger as any[])).toEqual(first.trial);
    }
  });

  it('mixed id/code/number parent links roll up (UUID ids + code parents)', () => {
    const accounts: TestAccount[] = [
      { id: 'ACC-11100', code: '11100', account_number: '11100', name: 'Cash in Hand', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: '11000', allow_posting: false },
      { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: '11100', allow_posting: true },
      { id: 'ACC-11000', code: '11000', account_number: '11000', name: 'Current Assets', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: null, allow_posting: false },
    ];
    const own = computeOwnBalances(accounts as any[], OPENING_JOURNAL as any[]);
    // Ledger references the canonical code; matching must resolve the UUID row.
    expect(own['ACC-11110']).toBe(4000);
    const tree = computeHierarchicalBalances(accounts as any[], own);
    expect(tree['ACC-11110']).toBe(4000);
    expect(tree['ACC-11100']).toBe(4000);
    expect(tree['ACC-11000']).toBe(4000);
  });

  it('cyclic and self-parent references cannot hang or corrupt the rollup', () => {
    const accounts: TestAccount[] = [
      { id: 'A', code: 'A', account_number: 'A', name: 'A', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: 'B', allow_posting: false },
      { id: 'B', code: 'B', account_number: 'B', name: 'B', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: 'A', allow_posting: false },
      { id: 'SELF', code: 'SELF', account_number: 'SELF', name: 'Self', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: 'SELF', allow_posting: false },
      { id: 'LEAF', code: 'LEAF', account_number: 'LEAF', name: 'Leaf', account_type: 'ASSET', type: 'Asset', normal_balance: 'DEBIT', parent_account_id: 'A', allow_posting: true, opening_balance: 50 },
    ];
    const own = computeOwnBalances(accounts as any[], [] as any[]);
    const tree = computeHierarchicalBalances(accounts as any[], own);
    expect(own['LEAF']).toBe(50);
    expect(Number.isFinite(tree['A'])).toBe(true);
    expect(Number.isFinite(tree['B'])).toBe(true);
    expect(tree['SELF']).toBe(0);
    // Type total uses own balances only — immune to the cycle.
    expect(computeTypeTotals(accounts as any[], own).assets).toBe(50);
  });

  it('trial-balance lines carry the required reporting shape', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    for (const line of trial.lines) {
      expect(typeof line.accountCode).toBe('string');
      expect(typeof line.accountName).toBe('string');
      expect(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']).toContain(line.accountType);
      expect(typeof line.totalDebit).toBe('number');
      expect(typeof line.totalCredit).toBe('number');
      expect(typeof line.balance).toBe('number');
    }
    // Only accounts with activity are listed.
    expect(trial.lines.map((l) => l.accountCode).sort()).toEqual(['11110', '11310', '31000', '41100']);
  });

  it('reconciliation diagnostic reconciles every layer for the scenario', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];
    const report = buildReconciliation(accounts as any[], ledger as any[]);

    expect(report.totalDebits).toBe(328000);
    expect(report.totalCredits).toBe(328000);
    expect(report.difference).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.totals.assets).toBe(328000);
    expect(report.totals.liabilities).toBe(0);
    expect(report.totals.equity).toBe(4000);
    expect(report.totals.income).toBe(324000);
    expect(report.totals.expenses).toBe(0);
    for (const row of report.perType) {
      expect(row.difference).toBe(0);
    }
    expect(report.balanceSheet.balanced).toBe(true);

    const text = formatReconciliation(report);
    expect(text).toContain('Balanced:      YES');
    expect(text).toContain('--- ASSETS ---');
    expect(text).toContain('--- EQUITY ---');
  });

  it('draft/void-marked rows are excluded while offsetting entries are kept', () => {
    const accounts = nestedCoa();
    const ledger: TestEntry[] = [
      ...OPENING_JOURNAL,
      { id: 'DRAFT', date: '2026-09-10', description: 'draft', debitAccountId: '11310', creditAccountId: '41100', amount: 99999, referenceId: 'X' },
      { id: 'VOIDED', date: '2026-09-10', description: 'void', debitAccountId: '11310', creditAccountId: '41100', amount: 88888, referenceId: 'Y' },
    ];
    (ledger[1] as any).status = 'Draft';
    (ledger[2] as any).status = 'voided';
    expect(isPostedLedgerEntry(ledger[1] as any)).toBe(false);
    expect(isPostedLedgerEntry(ledger[2] as any)).toBe(false);
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);
    expect(trial.totalDebits).toBe(4000);
    expect(trial.totalCredits).toBe(4000);
    expect(trial.isBalanced).toBe(true);
  });

  it('trial balance honours asOfDate (point-in-time reporting)', () => {
    const accounts = nestedCoa();
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL];

    const beforeSale = computeTrialBalance(accounts as any[], ledger as any[], { asOfDate: '2026-06-30' });
    expect(beforeSale.totalDebits).toBe(4000);
    expect(beforeSale.totalCredits).toBe(4000);
    expect(beforeSale.isBalanced).toBe(true);
    expect(beforeSale.lines.map((l) => l.accountCode).sort()).toEqual(['11110', '31000']);

    const afterSale = computeTrialBalance(accounts as any[], ledger as any[], { asOfDate: '2026-12-31' });
    expect(afterSale.totalDebits).toBe(328000);
    expect(afterSale.totalCredits).toBe(328000);
    expect(afterSale.isBalanced).toBe(true);
  });

  it('year-end closing zeroes income into 33000 exactly once (no profit duplication)', () => {
    const accounts = nestedCoa();
    // Proper closing lines: debit EACH revenue account, credit 33000.
    const closing = [
      {
        id: 'LG-CLOSE-1',
        date: '2026-12-31T00:00:00.000Z',
        description: 'Close Product Sales for 2026',
        debitAccountId: '41100',
        creditAccountId: '33000',
        amount: 324000,
        referenceId: 'CLOSE-INCOME-2026',
      },
    ];
    const ledger = [...OPENING_JOURNAL, ...CREDIT_SALE_JOURNAL, ...closing];
    const own = computeOwnBalances(accounts as any[], ledger as any[]);
    const totals = computeTypeTotals(accounts as any[], own);
    const trial = computeTrialBalance(accounts as any[], ledger as any[]);

    expect(own['41100']).toBe(0);
    expect(own['33000']).toBe(324000);
    expect(totals.income).toBe(0);
    expect(totals.equity).toBe(328000);
    expect(totals.assets).toBe(328000);
    expect(trial.isBalanced).toBe(true);
    expect(checkBalanceSheetEquation(totals).balanced).toBe(true);
  });
});
