/**
 * customerLedgerScope.test.ts — the authoritative ledger must be per-account.
 *
 * Proves:
 *   1. the ledger result includes ONLY the requested account's rows; Main never
 *      absorbs branch movements and a branch never absorbs Main/sibling rows;
 *   2. the account scope defaults to MAIN — omitting it can never silently mean
 *      "all accounts";
 *   3. a BRANCH never inherits the parent (Main) opening balance — it is
 *      reported as unresolved until the business sets one;
 *   4. a legacy row whose branch name is shared by two branches is EXCLUDED and
 *      FLAGGED (`ambiguousScopeRecords`) — never silently attributed;
 *   5. intentional whole-customer reporting goes through the separately named
 *      consolidated operation.
 *
 * Run: cd frontend && npx vitest run tests/customerLedgerScope.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { get: vi.fn(), getAll: vi.fn() },
}));

vi.mock('../services/db', () => ({ dbService: mockDb }));

import {
  buildLedgerFromRecords,
  buildConsolidatedLedgerFromRecords,
  buildCustomerLedger,
  buildConsolidatedCustomerLedger,
  getCustomerOpeningBalance,
  getCustomerOpeningBalanceDetailed,
  getCustomerOutstanding,
} from '../services/customerLedger';
import { resolveAccountScope, mainAccountScope } from '../services/customerAccountScope';

const CUSTOMER = {
  id: 'CUST-1',
  name: 'Alpha Schools',
  balance: 1000,
  subAccounts: [
    { id: 'SUB-A', name: 'Fees' },
    { id: 'SUB-B', name: 'Boarding' },
  ],
};

const INVOICES = [
  { id: 'INV-MAIN', customerId: 'CUST-1', totalAmount: 100, status: 'Unpaid' },
  { id: 'INV-A', customerId: 'CUST-1', subAccountId: 'SUB-A', subAccountName: 'Fees', totalAmount: 200, status: 'Unpaid' },
  { id: 'INV-B', customerId: 'CUST-1', subAccountId: 'SUB-B', subAccountName: 'Boarding', totalAmount: 300, status: 'Unpaid' },
];

const PAYMENTS = [
  { id: 'PAY-MAIN', customerId: 'CUST-1', amount: 50, amountApplied: 50, status: 'Cleared' },
  { id: 'PAY-A', customerId: 'CUST-1', subAccountId: 'SUB-A', subAccountName: 'Fees', amount: 20, amountApplied: 20, status: 'Cleared' },
];

const branchA = () => resolveAccountScope('CUST-1', 'SUB-A', CUSTOMER);
const branchB = () => resolveAccountScope('CUST-1', 'SUB-B', CUSTOMER);

describe('ledger scoping — Main and branches never mix', () => {
  it('Main scope contains ONLY untagged (Main) rows', () => {
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-1',
      invoices: INVOICES,
      payments: PAYMENTS,
      scope: mainAccountScope('CUST-1'),
      customer: CUSTOMER,
    });
    expect(ledger.transactions.map((t) => t.reference).sort()).toEqual(['INV-MAIN', 'PAY-MAIN']);
    expect(ledger.outstandingBalance).toBe(50); // 100 - 50
  });

  it('branch A contains ONLY branch A rows', () => {
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-1',
      invoices: INVOICES,
      payments: PAYMENTS,
      scope: branchA(),
      customer: CUSTOMER,
    });
    expect(ledger.transactions.map((t) => t.reference).sort()).toEqual(['INV-A', 'PAY-A']);
    expect(ledger.outstandingBalance).toBe(180); // 200 - 20
  });

  it('branch B contains ONLY branch B rows and never Main or sibling A', () => {
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-1',
      invoices: INVOICES,
      payments: PAYMENTS,
      scope: branchB(),
      customer: CUSTOMER,
    });
    expect(ledger.transactions.map((t) => t.reference)).toEqual(['INV-B']);
    expect(ledger.outstandingBalance).toBe(300);
  });

  it('the scope is reported on the result (a branch statement can identify itself)', () => {
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-1', invoices: INVOICES, payments: PAYMENTS, scope: branchA(), customer: CUSTOMER,
    });
    expect(ledger.scope).toMatchObject({ branchKey: 'id:SUB-A', isMain: false, branchLabel: 'Fees', branchId: 'SUB-A' });
  });

  it('intentional consolidation is a SEPARATE, named operation', () => {
    const ledger = buildConsolidatedLedgerFromRecords({
      customerId: 'CUST-1', invoices: INVOICES, payments: PAYMENTS, openingBalance: 0,
    });
    // 100 + 200 + 300 - 50 - 20 = 530
    expect(ledger.outstandingBalance).toBe(530);
    expect(ledger.scope).toBeNull();
  });
});

describe('default scope is MAIN — omission never means "all accounts"', () => {
  beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.getAll.mockReset();
    mockDb.get.mockResolvedValue(CUSTOMER);
    mockDb.getAll.mockImplementation(async (store: string) =>
      store === 'invoices' ? INVOICES : store === 'customerPayments' ? PAYMENTS : []);
  });

  it('buildCustomerLedger(explicit Main) === buildCustomerLedger(default)', async () => {
    const withDefault = await buildCustomerLedger('CUST-1', { customer: CUSTOMER });
    const withMain = await buildCustomerLedger('CUST-1', { scope: mainAccountScope('CUST-1'), customer: CUSTOMER });
    expect(withDefault.scope?.branchKey).toBe('main');
    expect(withDefault.outstandingBalance).toBe(withMain.outstandingBalance);
    expect(withDefault.outstandingBalance).toBe(1050); // opening 1000 + 100 - 50
  });

  it('the default ledger does NOT include branch activity', async () => {
    const ledger = await buildCustomerLedger('CUST-1', { customer: CUSTOMER });
    expect(ledger.transactions.map((t) => t.reference)).not.toContain('INV-A');
    expect(ledger.transactions.map((t) => t.reference)).not.toContain('INV-B');
  });

  it('a branch ledger and the Main ledger are different numbers for the same customer', async () => {
    const main = await buildCustomerLedger('CUST-1', { customer: CUSTOMER });
    const a = await buildCustomerLedger('CUST-1', { scope: branchA(), customer: CUSTOMER });
    expect(a.outstandingBalance).toBe(180);
    expect(main.outstandingBalance).toBe(1050);
    expect(a.outstandingBalance).not.toBe(main.outstandingBalance);
  });

  it('consolidated customer ledger sums every account', async () => {
    const all = await buildConsolidatedCustomerLedger('CUST-1', { customer: CUSTOMER });
    expect(all.outstandingBalance).toBe(1530); // opening 1000 + 530
  });
});

describe('opening balance never leaks from Main to a branch', () => {
  beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.getAll.mockReset();
    mockDb.get.mockResolvedValue(CUSTOMER);
    mockDb.getAll.mockImplementation(async (store: string) =>
      store === 'invoices' ? INVOICES : store === 'customerPayments' ? PAYMENTS : []);
  });

  it('getCustomerOpeningBalance returns a NUMBER (the stored opening)', async () => {
    expect(await getCustomerOpeningBalance('CUST-1')).toBe(1000);
    expect(typeof (await getCustomerOpeningBalance('CUST-1'))).toBe('number');
  });

  it('returns 0 when the customer has no stored opening', async () => {
    mockDb.get.mockResolvedValue({ id: 'CUST-9', balance: 0 });
    expect(await getCustomerOpeningBalance('CUST-9')).toBe(0);
  });

  it('returns 0 when the underlying read throws', async () => {
    mockDb.get.mockRejectedValue(new Error('boom'));
    expect(await getCustomerOpeningBalance('CUST-1')).toBe(0);
  });

  it('Main uses the customer opening; a BRANCH reports it unresolved', async () => {
    expect(await getCustomerOpeningBalanceDetailed('CUST-1', mainAccountScope('CUST-1')))
      .toEqual({ opening: 1000, unresolved: false });
    expect(await getCustomerOpeningBalanceDetailed('CUST-1', branchA()))
      .toEqual({ opening: 0, unresolved: true });
  });

  it('a branch ledger never reuses the parent opening (outstanding = branch movements only)', async () => {
    const a = await buildCustomerLedger('CUST-1', { scope: branchA(), customer: CUSTOMER });
    expect(a.openingBalance).toBe(0);
    expect(a.openingUnresolved).toBe(true);
    expect(a.outstandingBalance).toBe(180); // NOT 1180
  });

  it('getCustomerOutstanding defaults to Main and excludes branch activity', async () => {
    expect(await getCustomerOutstanding('CUST-1', { customer: CUSTOMER })).toBe(1050);
  });
});

describe('a legacy row under a shared branch name is excluded AND flagged', () => {
  const SHARED_CUSTOMER = {
    id: 'CUST-2',
    subAccounts: [
      { id: 'SUB-X', name: 'Exam Centre' },
      { id: 'SUB-Y', name: 'Exam Centre' },
    ],
  };
  const ROWS = [
    { id: 'INV-X', customerId: 'CUST-2', subAccountId: 'SUB-X', totalAmount: 10, status: 'Unpaid' },
    { id: 'INV-LEGACY', customerId: 'CUST-2', subAccountName: 'Exam Centre', totalAmount: 75, status: 'Unpaid' },
  ];

  it('the ambiguous row is not attributed and is reported', () => {
    const scope = resolveAccountScope('CUST-2', 'SUB-X', SHARED_CUSTOMER);
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-2', invoices: ROWS, payments: [], scope, customer: SHARED_CUSTOMER,
    });
    expect(ledger.transactions.map((t) => t.reference)).toEqual(['INV-X']);
    expect(ledger.outstandingBalance).toBe(10);
    expect(ledger.ambiguousScopeRecords.map((r) => r.id)).toEqual(['INV-LEGACY']);
    expect(ledger.ambiguousScopeRecords[0].reason).toMatch(/ambiguous/);
  });

  it('the same legacy row is excluded from the sibling branch too', () => {
    const scope = resolveAccountScope('CUST-2', 'SUB-Y', SHARED_CUSTOMER);
    const ledger = buildLedgerFromRecords({
      customerId: 'CUST-2', invoices: ROWS, payments: [], scope, customer: SHARED_CUSTOMER,
    });
    expect(ledger.transactions).toEqual([]);
    expect(ledger.ambiguousScopeRecords.map((r) => r.id)).toEqual(['INV-LEGACY']);
  });

  it('the legacy row IS counted by the intentional consolidated aggregate', () => {
    const ledger = buildConsolidatedLedgerFromRecords({ customerId: 'CUST-2', invoices: ROWS, payments: [] });
    expect(ledger.outstandingBalance).toBe(85);
  });
});
