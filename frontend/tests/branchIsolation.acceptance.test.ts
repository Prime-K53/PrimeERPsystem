/**
 * branchIsolation.acceptance.test.ts
 *
 * ACCEPTANCE evidence for Customer Branch Financial Isolation.
 *
 * Every case here is behavioural: it drives the real helpers/services with real
 * data shapes and fails if the isolation safeguard is removed. There are no
 * source-string assertions.
 *
 * Fixture customer (one customer, two branches with an IDENTICAL display name):
 *   CUST-ACME "Acme Schools"
 *     ├─ Main            (untagged)
 *     ├─ SUB-A "Campus"  ─┐ same display name, different ids
 *     └─ SUB-B "Campus"  ─┘
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAccountScope,
  recordMatchesScope,
  collectAmbiguousScopeRecords,
  assertSameAccountOwnership,
  scopeIdentity,
} from '../services/customerAccountScope';
import { buildLedgerFromRecords } from '../services/customerLedger';
import {
  resolveRecurringSubscriptionScope,
  hasRecurringRunForPeriod,
} from '../services/recurringBillingScope';

type AnyRec = Record<string, any>;

const ACME = {
  id: 'CUST-ACME',
  name: 'Acme Schools',
  subAccounts: [
    { id: 'SUB-A', name: 'Campus', walletBalance: 0 },
    { id: 'SUB-B', name: 'Campus', walletBalance: 0 },
  ],
};
const CUSTOMERS = [ACME];

const MAIN = resolveAccountScope(ACME.id, null, ACME as any);
const A = resolveAccountScope(ACME.id, 'SUB-A', ACME as any);
const B = resolveAccountScope(ACME.id, 'SUB-B', ACME as any);

// A single month of movement: Main and each branch carry their own amounts, and
// a legacy name-only invoice carries an amount that belongs to NO branch.
const INVOICES: AnyRec[] = [
  { id: 'INV-MAIN', customerId: ACME.id, totalAmount: 1000, paidAmount: 400, status: 'Partially Paid' },
  { id: 'INV-A', customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus', totalAmount: 500, paidAmount: 100, status: 'Partially Paid' },
  { id: 'INV-B', customerId: ACME.id, subAccountId: 'SUB-B', subAccountName: 'Campus', totalAmount: 700, paidAmount: 700, status: 'Paid' },
  { id: 'INV-LEGACY', customerId: ACME.id, subAccountName: 'Campus', totalAmount: 333, paidAmount: 0, status: 'Unpaid' },
];
const PAYMENTS: AnyRec[] = [
  { id: 'PAY-MAIN', customerId: ACME.id, amount: 400, amountApplied: 400, status: 'Cleared' },
  { id: 'PAY-A', customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus', amount: 100, amountApplied: 100, status: 'Cleared' },
  { id: 'PAY-B', customerId: ACME.id, subAccountId: 'SUB-B', subAccountName: 'Campus', amount: 700, amountApplied: 700, status: 'Cleared' },
];

const ledgerFor = (scope: any) => buildLedgerFromRecords({
  customerId: ACME.id, invoices: INVOICES, payments: PAYMENTS, scope, customer: ACME as any,
});
const refs = (ledger: any) => ledger.transactions.map((t: any) => String(t.reference)).sort();

describe('ACCEPTANCE 1 — a parent and its branches never share balances, transactions or outstanding', () => {
  it('each account sees only its own transactions', () => {
    expect(refs(ledgerFor(MAIN))).toEqual(['INV-MAIN', 'PAY-MAIN']);
    expect(refs(ledgerFor(A))).toEqual(['INV-A', 'PAY-A']);
    expect(refs(ledgerFor(B))).toEqual(['INV-B', 'PAY-B']);
  });

  it('outstanding is computed per account and never summed across accounts', () => {
    expect(ledgerFor(MAIN).outstandingBalance).toBe(600);   // 1000 - 400
    expect(ledgerFor(A).outstandingBalance).toBe(400);     // 500 - 100
    expect(ledgerFor(B).outstandingBalance).toBe(0);       // 700 - 700
  });

  it('the ledger reports the account it was built for, so a statement can identify itself', () => {
    expect((ledgerFor(MAIN).scope as any).branchKey).toBe('main');
    expect((ledgerFor(A).scope as any).branchKey).toBe('id:SUB-A');
    expect((ledgerFor(B).scope as any).branchKey).toBe('id:SUB-B');
  });

  it('a legacy name-only record is never silently attributed to Main or to a branch', () => {
    // Main: the legacy row carries a branch NAME, so it is not a Main row and
    // Main reports nothing ambiguous (nothing to disambiguate for Main).
    expect(recordMatchesScope(INVOICES[3], MAIN as any, ACME as any)).toBe(false);
    expect(collectAmbiguousScopeRecords(INVOICES, MAIN as any, ACME as any)).toEqual([]);

    // Each branch: the record is excluded AND reported, never absorbed.
    for (const scope of [A, B]) {
      expect(recordMatchesScope(INVOICES[3], scope as any, ACME as any)).toBe(false);
      const flagged = collectAmbiguousScopeRecords(INVOICES, scope as any, ACME as any);
      expect(flagged.map((r: any) => r.id)).toEqual(['INV-LEGACY']);
      expect(flagged[0].reason).toMatch(/ambiguous/i);
    }

    // And its money is never silently added to any account's ledger.
    const totals = [ledgerFor(MAIN).outstandingBalance, ledgerFor(A).outstandingBalance, ledgerFor(B).outstandingBalance];
    expect(totals.reduce((a, b) => a + b, 0)).toBe(1000); // 600 + 400 + 0 (333 excluded)
  });
});

describe('ACCEPTANCE 2 — two branches with identical display names stay isolated', () => {
  it('the branches have distinct canonical scope keys', () => {
    expect(scopeIdentity(A)).toBe(`${ACME.id}::id:SUB-A`);
    expect(scopeIdentity(B)).toBe(`${ACME.id}::id:SUB-B`);
    expect(scopeIdentity(A)).not.toBe(scopeIdentity(B));
    expect(scopeIdentity(MAIN)).toBe(`${ACME.id}::main`);
  });

  it('neither branch matches the other branch\'s rows', () => {
    expect(recordMatchesScope(INVOICES[1], B as any, ACME as any)).toBe(false);
    expect(recordMatchesScope(INVOICES[2], A as any, ACME as any)).toBe(false);
    expect(ledgerFor(A).outstandingBalance + ledgerFor(B).outstandingBalance).toBe(400);
  });

  it('the shared display name resolves to NEITHER branch on its own', () => {
    const byName = resolveAccountScope(ACME.id, 'Campus', ACME as any);
    expect(byName.branchId).toBeNull();
    expect(byName.ambiguous).toBe(true);
    expect(recordMatchesScope(INVOICES[1], byName as any, ACME as any)).toBe(false);
    expect(recordMatchesScope(INVOICES[2], byName as any, ACME as any)).toBe(false);
  });
});

describe('ACCEPTANCE 3 — cross-branch allocation and reversal are refused before any mutation', () => {
  const invoice = INVOICES[1];

  it('a Main payment cannot settle a branch invoice', () => {
    expect(() => assertSameAccountOwnership(PAYMENTS[0], invoice, ACME as any)).toThrowError();
    try {
      assertSameAccountOwnership(PAYMENTS[0], invoice, ACME as any);
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('a sibling branch payment cannot settle the other branch invoice', () => {
    try {
      assertSameAccountOwnership(PAYMENTS[2], invoice, ACME as any);
      throw new Error('allocation should have been refused');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('a branch payment cannot settle a Main invoice', () => {
    try {
      assertSameAccountOwnership(PAYMENTS[1], INVOICES[0], ACME as any);
      throw new Error('allocation should have been refused');
    } catch (err: any) {
      expect(err.code).toBe('ECROSS_ACCOUNT');
    }
  });

  it('the same branch still allocates (the gate is not simply closed)', () => {
    expect(() => assertSameAccountOwnership(PAYMENTS[1], invoice, ACME as any)).not.toThrow();
  });
});

describe('ACCEPTANCE 6 — recurring subscriptions retain the branch they were created for', () => {
  const base = { customerId: ACME.id, customerName: ACME.name, total: 250, status: 'Active' };

  it('a branch subscription keeps its stable id and label', () => {
    const res = resolveRecurringSubscriptionScope({ ...base, subAccountId: 'SUB-A', subAccountName: 'Campus' }, CUSTOMERS);
    expect(res.ok).toBe(true);
    expect(res.subAccountId).toBe('SUB-A');
    expect(res.subAccountName).toBe('Campus');
    expect(res.scopeKey).toBe(`${ACME.id}::id:SUB-A`);
  });

  it('a legacy name-only subscription resolves when the name is unambiguous', () => {
    const unique = { id: 'CUST-B', name: 'Beta', subAccounts: [{ id: 'SUB-X', name: 'Fees' }] };
    const res = resolveRecurringSubscriptionScope(
      { customerId: 'CUST-B', customerName: 'Beta', subAccountName: 'Fees' }, [unique],
    );
    expect(res.ok).toBe(true);
    expect(res.subAccountId).toBe('SUB-X');
  });

  it('a subscription whose branch name is shared by two branches is REFUSED', () => {
    const res = resolveRecurringSubscriptionScope({ ...base, subAccountName: 'Campus' }, CUSTOMERS);
    expect(res.ok).toBe(false);
    expect(res.subAccountId).toBe('');
    expect(res.message).toMatch(/cannot be identified/i);
  });

  it('a subscription naming a branch the customer does not own is REFUSED', () => {
    const res = resolveRecurringSubscriptionScope({ ...base, subAccountId: 'SUB-NOPE' }, CUSTOMERS);
    expect(res.ok).toBe(false);
  });

  it('a subscription for an unidentifiable customer is REFUSED (never falls back to another customer by name)', () => {
    const res = resolveRecurringSubscriptionScope(
      { customerId: 'CUST-GONE', customerName: ACME.name, subAccountId: 'SUB-A' }, CUSTOMERS,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('customer-not-identified');
  });

  it('a parent run and each branch run invoice independently on the same day', () => {
    const invoices: AnyRec[] = [
      { id: 'INV-REC-1', customerName: ACME.name, customerId: ACME.id, date: '2026-05-04T00:00:00.000Z', totalAmount: 250 },
    ];
    const opts = (sub: AnyRec) => ({
      subscription: sub, customer: ACME as any, customerName: ACME.name, dateKey: '2026-05-04',
      matchesRunId: (inv: AnyRec) => String(inv.id).includes('REC'),
    });

    // The existing invoice is a MAIN run.
    expect(hasRecurringRunForPeriod(invoices, opts({ ...base, subAccountId: 'SUB-A' }))).toBe(false);
    expect(hasRecurringRunForPeriod(invoices, opts({ ...base, subAccountId: 'SUB-B' }))).toBe(false);
    expect(hasRecurringRunForPeriod(invoices, opts(base))).toBe(true);

    // Once a branch-A run exists, only branch A is considered done.
    invoices.push({
      id: 'INV-REC-2', customerName: ACME.name, customerId: ACME.id,
      date: '2026-05-04T00:00:00.000Z', totalAmount: 250, subAccountId: 'SUB-A', subAccountName: 'Campus',
    });
    expect(hasRecurringRunForPeriod(invoices, opts({ ...base, subAccountId: 'SUB-A' }))).toBe(true);
    expect(hasRecurringRunForPeriod(invoices, opts({ ...base, subAccountId: 'SUB-B' }))).toBe(false);
    expect(hasRecurringRunForPeriod(invoices, opts(base))).toBe(true);
  });
});