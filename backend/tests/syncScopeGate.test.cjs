/**
 * syncScopeGate.test.cjs — ACCEPTANCE: offline transactions and DELAYED SYNC
 * preserve account scope.
 *
 * Drives the REAL `validateCustomerPaymentScope` gate from
 * `services/cloudSyncStore.cjs` through its injected row reader, proving the
 * cloud commit boundary:
 *
 *   1. REFUSES a payment whose invoice has synced and belongs to another
 *      account (terminal rejection → the client dead-letters it, never writes).
 *   2. DEFERS a payment whose invoice has NOT synchronized yet (retryable →
 *      legitimate offline operation survives, but the payment is never
 *      committed unverified). Deferral is bounded by the client's retry budget,
 *      so an invoice that never arrives escalates to the dead-letter queue.
 *   3. DEFERS a branch allocation whose parent customer has not synchronized
 *      (branch ownership cannot be proven).
 *   4. ALLOWS a Main↔Main payment even while the customer is still offline
 *      (offline capability is preserved where no branch scope is involved).
 *   5. REFUSES a legacy name-only allocation whose name is shared.
 *   6. ALLOWS a same-account, same-branch payment.
 *
 * Removing the "invoice not yet in cloud" deferral (the previous
 * allow-with-warning behaviour) fails case 2; removing ownership validation
 * fails case 5.
 *
 * Run: cd backend && node --test tests/syncScopeGate.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateCustomerPaymentScope } = require('../services/cloudSyncStore.cjs');

const CUSTOMER = {
  id: 'CUST-ACME',
  name: 'Acme Schools',
  data: {
    id: 'CUST-ACME',
    name: 'Acme Schools',
    subAccounts: [
      { id: 'SUB-A', name: 'Campus' },
      { id: 'SUB-B', name: 'Campus' },
      { id: 'SUB-C', name: 'Fees' },
    ],
  },
};

function row(id, data) {
  return { id, data: { id, ...data } };
}

/** In-memory cloud: which rows "have synced". */
function reader(tables) {
  return async (table, id) => {
    const list = tables[table] || [];
    return list.find((r) => String(r.id) === String(id)) || null;
  };
}

const ALL_ROWS = {
  customers: [row('CUST-ACME', CUSTOMER.data)],
  invoices: [
    row('INV-MAIN', { customerId: 'CUST-ACME', totalAmount: 100 }),
    row('INV-A', { customerId: 'CUST-ACME', subAccountId: 'SUB-A', subAccountName: 'Campus', totalAmount: 100 }),
    row('INV-B', { customerId: 'CUST-ACME', subAccountId: 'SUB-B', subAccountName: 'Campus', totalAmount: 100 }),
    row('INV-LEGACY', { customerId: 'CUST-ACME', subAccountName: 'Campus', totalAmount: 100 }),
    row('INV-OTHER', { customerId: 'CUST-OTHER', subAccountId: 'SUB-A', subAccountName: 'Campus', totalAmount: 100 }),
  ],
};

const pay = (over = {}) => ({
  id: 'PAY-1',
  customerId: 'CUST-ACME',
  amount: 100,
  allocations: [{ invoiceId: 'INV-A', amount: 100 }],
  ...over,
});

describe('sync account-scope gate — delayed sync preserves account scope', () => {
  it('ALLOWS a same-account, same-branch payment', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', subAccountName: 'Campus' }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.equal(res, null);
  });

  it('REFUSES a Main payment against a branch invoice (terminal, not deferred)', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ allocations: [{ invoiceId: 'INV-A', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res, 'expected a rejection');
    assert.equal(res.code, 'ECROSS_ACCOUNT');
    assert.notEqual(res.pending, true, 'a proven violation must never be deferred');
  });

  it('REFUSES a sibling-branch payment (identical display names do not help)', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-B', subAccountName: 'Campus', allocations: [{ invoiceId: 'INV-A', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.code, 'ECROSS_ACCOUNT');
  });

  it('REFUSES a cross-customer payment even when the branch name matches', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', subAccountName: 'Campus', allocations: [{ invoiceId: 'INV-OTHER', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.code, 'ECROSS_ACCOUNT');
  });

  it('DEFERS (retryable) when the referenced invoice has not synchronized yet', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', subAccountName: 'Campus', allocations: [{ invoiceId: 'INV-NOT-SYNCED', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res, 'an unverifiable payment must not pass');
    assert.equal(res.pending, true, 'it must be deferred, not rejected and not committed');
    assert.equal(res.code, 'EINVOICE_NOT_SYNCED');
    assert.match(res.error, /not yet synchronized|deferred/i);
  });

  it('DEFERS when the invoice read FAILS (a read failure is never "assume it is fine")', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', allocations: [{ invoiceId: 'INV-A', amount: 100 }] }),
      {
        getRow: async (table, id) => {
          if (table === 'invoices') throw new Error('network down');
          return reader(ALL_ROWS)(table, id);
        },
      },
    );
    assert.ok(res);
    assert.equal(res.pending, true);
    assert.equal(res.code, 'EINVOICE_NOT_SYNCED');
  });

  it('DEFERS a branch payment whose parent customer has not synchronized', async () => {
    const tables = { ...ALL_ROWS, customers: [] };
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', subAccountName: 'Campus' }),
      { getRow: reader(tables) },
    );
    assert.ok(res);
    assert.equal(res.pending, true);
    assert.equal(res.code, 'ECUSTOMER_NOT_SYNCED');
  });

  it('ALLOWS a Main-to-Main payment while the customer is still offline', async () => {
    const tables = { ...ALL_ROWS, customers: [] };
    const res = await validateCustomerPaymentScope(
      pay({ allocations: [{ invoiceId: 'INV-MAIN', amount: 100 }] }),
      { getRow: reader(tables) },
    );
    assert.equal(res, null, 'offline Main payments must keep working');
  });

  it('REFUSES a legacy name-only allocation whose branch name is shared', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountName: 'Campus', allocations: [{ invoiceId: 'INV-LEGACY', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.pending, undefined, 'an ambiguous allocation is terminal, not deferred forever');
    assert.equal(res.code, 'EAMBIGUOUS_SCOPE');
  });

  it('REFUSES a payment with no resolvable customer scope', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ customerId: '', allocations: [{ invoiceId: 'INV-A', amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.code, 'EAMBIGUOUS_SCOPE');
  });

  it('REFUSES an allocation line with no invoice reference at all', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', allocations: [{ amount: 100 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.code, 'EAMBIGUOUS_SCOPE');
  });

  it('ignores zero-amount allocations (they move no money)', async () => {
    const res = await validateCustomerPaymentScope(
      pay({ subAccountId: 'SUB-A', allocations: [{ invoiceId: 'INV-B', amount: 0 }] }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.equal(res, null);
  });

  it('checks EVERY applied allocation line, not just the first', async () => {
    const res = await validateCustomerPaymentScope(
      pay({
        subAccountId: 'SUB-A',
        subAccountName: 'Campus',
        allocations: [
          { invoiceId: 'INV-A', amount: 50 },
          { invoiceId: 'INV-B', amount: 50 }, // sibling branch → must still be refused
        ],
      }),
      { getRow: reader(ALL_ROWS) },
    );
    assert.ok(res);
    assert.equal(res.code, 'ECROSS_ACCOUNT');
  });
});