/**
 * paymentAllocationScope.test.ts — allocation enforcement at the authoritative
 * local persistence boundary (`transactionService`).
 *
 * The screen filters invoices by account, but UI filtering is NOT the
 * safeguard. These tests drive the real `addCustomerPayment` /
 * `updateCustomerPayment` code paths and prove the boundary refuses:
 *   - a Main payment against a branch invoice (and the reverse);
 *   - a branch payment against a SIBLING branch;
 *   - a cross-CUSTOMER allocation even when the branch names match;
 *   - a legacy name-only allocation whose name is shared by two branches;
 *   - a branch id that does not belong to the selected customer;
 * and that a rejected attempt writes NOTHING.
 *
 * Removing the scope gate makes every "rejects" assertion below fail.
 *
 * Run: cd frontend && npx vitest run tests/paymentAllocationScope.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { stores, storeFor } = vi.hoisted(() => {
  const stores = new Map<string, Map<string, any>>();
  function storeFor(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      get: async (id: string) => m.get(String(id)),
      put: async (rec: any) => {
        m.set(String(rec.id ?? rec.key ?? `k${m.size}`), rec);
      },
      getAll: async () => Array.from(m.values()),
      delete: async (id: string) => {
        m.delete(String(id));
      },
    };
  }
  return { stores, storeFor };
});

vi.mock('../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
  },
}));

import { transactionService } from '../services/transactionService';

const CUSTOMER = {
  id: 'CUST-1',
  name: 'Alpha Schools',
  balance: 0,
  walletBalance: 0,
  subAccounts: [
    { id: 'SUB-A', name: 'Exam Centre' },
    { id: 'SUB-B', name: 'Exam Centre' }, // same name, different branch
    { id: 'SUB-C', name: 'Fees' },
  ],
};

const OTHER_CUSTOMER = {
  id: 'CUST-2',
  name: 'Beta Academy',
  subAccounts: [{ id: 'SUB-A', name: 'Exam Centre' }],
};

const INV_MAIN = { id: 'INV-MAIN', customerId: 'CUST-1', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };
const INV_A = { id: 'INV-A', customerId: 'CUST-1', subAccountId: 'SUB-A', subAccountName: 'Exam Centre', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };
const INV_B = { id: 'INV-B', customerId: 'CUST-1', subAccountId: 'SUB-B', subAccountName: 'Exam Centre', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };
const INV_C = { id: 'INV-C', customerId: 'CUST-1', subAccountId: 'SUB-C', subAccountName: 'Fees', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };
const INV_LEGACY = { id: 'INV-LEGACY', customerId: 'CUST-1', subAccountName: 'Exam Centre', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };
const INV_OTHER = { id: 'INV-OTHER', customerId: 'CUST-2', subAccountId: 'SUB-A', subAccountName: 'Exam Centre', totalAmount: 100, paidAmount: 0, status: 'Unpaid' };

const ALL_INVOICES = [INV_MAIN, INV_A, INV_B, INV_C, INV_LEGACY, INV_OTHER];

async function seed() {
  stores.clear();
  await storeFor('customers').put(CUSTOMER);
  await storeFor('customers').put(OTHER_CUSTOMER);
  for (const inv of ALL_INVOICES) await storeFor('invoices').put({ ...inv });
}

function payment(overrides: Record<string, any>) {
  return {
    id: `PAY-${Math.random().toString(36).slice(2, 8)}`,
    customerId: 'CUST-1',
    customerName: 'Alpha Schools',
    amount: 100,
    date: '2026-10-01',
    paymentMethod: 'Cash',
    status: 'Cleared',
    excessHandling: 'Change',
    allocations: [],
    ...overrides,
  } as any;
}

async function expectCode(fn: () => Promise<unknown>, code: string) {
  let caught: any = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected rejection with code ${code}`).toBeTruthy();
  expect(caught.code).toBe(code);
}

describe('addCustomerPayment — account-scope enforcement', () => {
  beforeEach(seed);

  it('rejects a MAIN payment allocated to a BRANCH invoice', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({ allocations: [{ invoiceId: 'INV-A', amount: 100 }] })),
      'ECROSS_ACCOUNT',
    );
  });

  it('rejects a BRANCH payment allocated to a MAIN invoice', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-A', subAccountName: 'Exam Centre',
        allocations: [{ invoiceId: 'INV-MAIN', amount: 100 }],
      })),
      'ECROSS_ACCOUNT',
    );
  });

  it('rejects a SIBLING-branch allocation (A -> B)', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-B', subAccountName: 'Exam Centre',
        allocations: [{ invoiceId: 'INV-A', amount: 100 }],
      })),
      'ECROSS_ACCOUNT',
    );
  });

  it('rejects a CROSS-CUSTOMER allocation even when the branch names match', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-A', subAccountName: 'Exam Centre',
        allocations: [{ invoiceId: 'INV-OTHER', amount: 100 }],
      })),
      'ECROSS_ACCOUNT',
    );
  });

  it('rejects a legacy name-only allocation when the branch name is shared', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({
        subAccountName: 'Exam Centre', // no stable id; shared by SUB-A and SUB-B
        allocations: [{ invoiceId: 'INV-LEGACY', amount: 100 }],
      })),
      'EAMBIGUOUS_SCOPE',
    );
  });

  it('rejects a branch the customer does not own', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-UNKNOWN',
        allocations: [{ invoiceId: 'INV-MAIN', amount: 100 }],
      })),
      'EINVALID_SCOPE',
    );
  });

  it('writes NOTHING when an allocation is refused', async () => {
    await expectCode(
      () => transactionService.addCustomerPayment(payment({ allocations: [{ invoiceId: 'INV-A', amount: 100 }] })),
      'ECROSS_ACCOUNT',
    );
    expect(await storeFor('customerPayments').getAll()).toEqual([]);
    // the invoice is untouched
    expect((await storeFor('invoices').get('INV-A')).paidAmount).toBe(0);
  });

  it('does NOT block a legitimate same-account (Main -> Main) allocation at the gate', async () => {
    let code: string | undefined;
    try {
      await transactionService.addCustomerPayment(payment({ allocations: [{ invoiceId: 'INV-MAIN', amount: 100 }] }));
    } catch (err: any) {
      code = err?.code;
    }
    expect(['ECROSS_ACCOUNT', 'EAMBIGUOUS_SCOPE', 'EINVALID_SCOPE']).not.toContain(code);
  });

  it('does NOT block a branch payment whose display name resolves unambiguously', async () => {
    let code: string | undefined;
    try {
      await transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-C', subAccountName: 'Fees',
        allocations: [{ invoiceId: 'INV-C', amount: 100 }],
      }));
    } catch (err: any) {
      code = err?.code;
    }
    expect(['ECROSS_ACCOUNT', 'EAMBIGUOUS_SCOPE', 'EINVALID_SCOPE']).not.toContain(code);
  });

  it('a branch payment may settle a legacy name-only invoice of the SAME unique branch', async () => {
    await storeFor('invoices').put({ id: 'INV-C-LEGACY', customerId: 'CUST-1', subAccountName: 'Fees', totalAmount: 40, paidAmount: 0, status: 'Unpaid' });
    let code: string | undefined;
    try {
      await transactionService.addCustomerPayment(payment({
        subAccountId: 'SUB-C', subAccountName: 'Fees',
        allocations: [{ invoiceId: 'INV-C-LEGACY', amount: 40 }],
      }));
    } catch (err: any) {
      code = err?.code;
    }
    expect(['ECROSS_ACCOUNT', 'EAMBIGUOUS_SCOPE', 'EINVALID_SCOPE']).not.toContain(code);
  });
});

describe('updateCustomerPayment — account identity is a financial field', () => {
  beforeEach(seed);

  it('refuses to re-point a posted payment at a different branch', async () => {
    const existing = {
      id: 'PAY-EDIT-1', customerId: 'CUST-1', customerName: 'Alpha Schools',
      amount: 50, date: '2026-10-01', paymentMethod: 'Cash', status: 'Cleared',
      subAccountId: 'SUB-A', allocations: [],
    };
    await storeFor('customerPayments').put(existing);

    await expect(
      transactionService.updateCustomerPayment({ ...existing, subAccountId: 'SUB-B', subAccountName: 'Exam Centre' } as any),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses to move a payment between customers', async () => {
    const existing = {
      id: 'PAY-EDIT-2', customerId: 'CUST-1', customerName: 'Alpha Schools',
      amount: 50, date: '2026-10-01', paymentMethod: 'Cash', status: 'Cleared', allocations: [],
    };
    await storeFor('customerPayments').put(existing);

    await expect(
      transactionService.updateCustomerPayment({ ...existing, customerId: 'CUST-2' } as any),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows a metadata-only edit that leaves the account unchanged', async () => {
    const existing = {
      id: 'PAY-EDIT-3', customerId: 'CUST-1', customerName: 'Alpha Schools',
      amount: 50, date: '2026-10-01', paymentMethod: 'Cash', status: 'Cleared',
      subAccountId: 'SUB-C', subAccountName: 'Fees', reference: 'old', notes: 'old', allocations: [],
    };
    await storeFor('customerPayments').put(existing);

    await transactionService.updateCustomerPayment({
      ...existing, reference: 'new ref', notes: 'updated',
    } as any);

    const stored = await storeFor('customerPayments').get('PAY-EDIT-3');
    expect(stored.reference).toBe('new ref');
    expect(stored.subAccountId).toBe('SUB-C');
  });
});
