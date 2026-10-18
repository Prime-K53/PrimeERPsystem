/**
 * paymentAllocationScope.test.cjs — BACKEND allocation enforcement.
 *
 * Drives the REAL `backend/services/paymentAllocationService.cjs` (the
 * authoritative server-side allocation boundary) against an injected,
 * in-memory repository. Proves the server refuses:
 *   - Main -> branch / branch -> Main allocation;
 *   - sibling-branch allocation;
 *   - cross-customer allocation even when the branch names match;
 *   - a legacy name-only allocation whose name is shared (ambiguous);
 *   - a branch id the customer does not own;
 * and that a refused allocation performs NO write. Also proves the outstanding
 * / suggest reads are scope-aware and that a read FAILURE is surfaced instead
 * of being reported as "no outstanding invoices".
 *
 * Removing the scope gate makes every "refuses" assertion fail.
 *
 * Run: cd backend && node --test tests/paymentAllocationScope.test.cjs
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../services/supabaseRepository.cjs');

// ── Injected in-memory repository ────────────────────────────────────────────
let state;

function row(id, data) {
  return { id, data: { id, ...data } };
}

function matchesFilter(record, filters) {
  for (const [key, expr] of Object.entries(filters || {})) {
    if (!String(expr).startsWith('eq.')) continue;
    const wanted = String(expr).slice(3);
    const value = parseIntPath(record, key);
    if (String(value) !== wanted) return false;
  }
  return true;
}

function parseIntPath(record, key) {
  // Supports 'data->>field' and plain 'field'.
  const m = /^data->>(.+)$/.exec(key);
  const source = m ? (record.data || {}) : record;
  return source[m ? m[1] : key];
}

function installRepo() {
  repo.isConfigured = () => true;

  repo.getAllStrict = async (table, filters = {}) => {
    if (state.failReads) {
      throw new Error(`Failed to read ${table} from Supabase (query returned no data)`);
    }
    const rows = state[table] || [];
    return rows.filter((r) => matchesFilter(r, filters));
  };

  repo.getById = async (table, id) => {
    if (table === 'customers') return state.customersById[String(id)] || null;
    const rows = state[table] || [];
    return rows.find((r) => String(r.id) === String(id)) || null;
  };

  const entity = (table) => ({
    getAll: async (filters = {}) => (state[table] || []).filter((r) => matchesFilter(r, filters)),
    getById: async (id) => (state[table] || []).find((r) => String(r.id) === String(id)) || null,
    upsert: async (record) => {
      state.writes.push({ table, record });
      if (record && record.id != null) {
        state[table] = state[table] || [];
        const idx = state[table].findIndex((r) => String(r.id) === String(record.id));
        const next = { id: record.id, ...record };
        if (idx >= 0) state[table][idx] = next; else state[table].push(next);
      }
      return record;
    },
    softDelete: async (id) => {
      state.rollbacks.push({ table, id: String(id) });
      state[table] = (state[table] || []).filter((r) => String(r.id) !== String(id));
      return null;
    },
  });

  repo.invoices = entity('invoices');
  repo.customerPayments = entity('customer_payments');
  repo.paymentAllocations = entity('payment_allocations');
  repo.paymentAllocationLines = entity('payment_allocation_lines');
  repo.upsert = async (table, record) => entity(table).upsert(record);
  repo.softDelete = async (table, id) => {
    state.rollbacks.push({ table, id: String(id) });
    state[table] = (state[table] || []).filter((r) => String(r.id) !== String(id));
    return null;
  };
}

const PaymentAllocationService = require('../services/paymentAllocationService.cjs');

const CUSTOMER_SHARED = {
  id: 'CUST-SHARED',
  name: 'Alpha Schools',
  subAccounts: [
    { id: 'SUB-A', name: 'Exam Centre' },
    { id: 'SUB-B', name: 'Exam Centre' },
    { id: 'SUB-C', name: 'Fees' },
  ],
};

function baselineState() {
  return {
    failReads: false,
    writes: [],
    rollbacks: [],
    customersById: { 'CUST-SHARED': CUSTOMER_SHARED },
    customers: [row('CUST-SHARED', CUSTOMER_SHARED)],
    invoices: [
      row('INV-MAIN', { customerId: 'CUST-SHARED', total_amount: 100, paid_amount: 0, status: 'unpaid' }),
      row('INV-A', { customerId: 'CUST-SHARED', subAccountId: 'SUB-A', subAccountName: 'Exam Centre', total_amount: 100, paid_amount: 0, status: 'unpaid' }),
      row('INV-B', { customerId: 'CUST-SHARED', subAccountId: 'SUB-B', subAccountName: 'Exam Centre', total_amount: 100, paid_amount: 0, status: 'unpaid' }),
      row('INV-LEGACY', { customerId: 'CUST-SHARED', subAccountName: 'Exam Centre', total_amount: 100, paid_amount: 0, status: 'unpaid' }),
      row('INV-OTHER', { customerId: 'CUST-2', subAccountId: 'SUB-A', subAccountName: 'Exam Centre', total_amount: 100, paid_amount: 0, status: 'unpaid' }),
    ],
    customer_payments: [],
    payment_allocations: [],
    payment_allocation_lines: [],
  };
}

function service() {
  return new PaymentAllocationService();
}

async function expectCode(fn, code) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected a rejection with code ${code}`);
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code} (${caught.message})`);
  return caught;
}

beforeEach(() => {
  state = baselineState();
  installRepo();
});

describe('getOutstandingInvoices — scope-aware strict reads', () => {
  it('Main returns only untagged invoices', async () => {
    const svc = service();
    const scope = require('../services/customerAccountScope.cjs').mainAccountScope('CUST-SHARED');
    const rows = await svc.getOutstandingInvoices('CUST-SHARED', { scope, customer: CUSTOMER_SHARED });
    assert.deepEqual(rows.map((r) => r.id), ['INV-MAIN']);
  });

  it('branch A returns only branch A invoices (never Main or sibling)', async () => {
    const svc = service();
    const { resolveAccountScope } = require('../services/customerAccountScope.cjs');
    const scope = resolveAccountScope('CUST-SHARED', 'SUB-A', CUSTOMER_SHARED);
    const rows = await svc.getOutstandingInvoices('CUST-SHARED', { scope, customer: CUSTOMER_SHARED });
    assert.deepEqual(rows.map((r) => r.id), ['INV-A']);
  });

  it('a read FAILURE is surfaced, never reported as "no outstanding invoices"', async () => {
    state.failReads = true;
    const svc = service();
    const { mainAccountScope } = require('../services/customerAccountScope.cjs');
    await assert.rejects(
      () => svc.getOutstandingInvoices('CUST-SHARED', { scope: mainAccountScope('CUST-SHARED'), customer: CUSTOMER_SHARED }),
      /Failed to read/
    );
  });
});

describe('suggestAllocation — obeys the requested scope', () => {
  it('suggests only the branch invoices for a branch scope', async () => {
    const svc = service();
    const { resolveAccountScope } = require('../services/customerAccountScope.cjs');
    const scope = resolveAccountScope('CUST-SHARED', 'SUB-B', CUSTOMER_SHARED);
    const suggestions = await svc.suggestAllocation('CUST-SHARED', 500, { scope, customer: CUSTOMER_SHARED });
    assert.deepEqual(suggestions.map((s) => s.invoiceId), ['INV-B']);
    assert.equal(suggestions[0].suggestedAmount, 100);
  });
});

describe('allocatePayment — ownership is enforced server-side', () => {
  it('refuses a Main payment allocated to a branch invoice', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-1', customerId: 'CUST-SHARED', amount: 100 }, [{ invoiceId: 'INV-A', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'ECROSS_ACCOUNT'
    );
  });

  it('refuses a branch payment allocated to a Main invoice', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-2', customerId: 'CUST-SHARED', subAccountId: 'SUB-A', amount: 100 }, [{ invoiceId: 'INV-MAIN', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'ECROSS_ACCOUNT'
    );
  });

  it('refuses a sibling-branch allocation', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-3', customerId: 'CUST-SHARED', subAccountId: 'SUB-B', amount: 100 }, [{ invoiceId: 'INV-A', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'ECROSS_ACCOUNT'
    );
  });

  it('refuses a cross-customer allocation even when branch names match', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-4', customerId: 'CUST-SHARED', subAccountId: 'SUB-A', amount: 100 }, [{ invoiceId: 'INV-OTHER', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'ECROSS_ACCOUNT'
    );
  });

  it('refuses a legacy name-only allocation whose name is shared', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-5', customerId: 'CUST-SHARED', subAccountName: 'Exam Centre', amount: 100 }, [{ invoiceId: 'INV-LEGACY', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'EAMBIGUOUS_SCOPE'
    );
  });

  it('refuses a branch the customer does not own', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-6', customerId: 'CUST-SHARED', subAccountId: 'SUB-UNKNOWN', amount: 100 }, [{ invoiceId: 'INV-MAIN', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'EINVALID_SCOPE'
    );
  });

  it('loads the parent customer itself when the caller does not supply it', async () => {
    const svc = service();
    // No opts.customer — the service must load CUST-SHARED and still refuse.
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-7', customerId: 'CUST-SHARED', subAccountId: 'SUB-A', amount: 100 }, [{ invoiceId: 'INV-B', amount: 100 }], 'MWK', {}),
      'ECROSS_ACCOUNT'
    );
  });

  it('performs NO write at all when an allocation is refused', async () => {
    const svc = service();
    await expectCode(
      () => svc.allocatePayment({ id: 'PAY-8', customerId: 'CUST-SHARED', amount: 100 }, [{ invoiceId: 'INV-A', amount: 100 }], 'MWK', { customer: CUSTOMER_SHARED }),
      'ECROSS_ACCOUNT'
    );
    // Ownership is validated BEFORE persistence: nothing was written, so no
    // compensating rollback was even required.
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.rollbacks, []);
    assert.deepEqual(state.payment_allocations, []);
    assert.deepEqual(state.payment_allocation_lines, []);
    assert.equal(state.invoices.find((r) => r.id === 'INV-A').data.paid_amount, 0);
  });

  it('ALLOWS a same-branch (SUB-A) allocation of a branch invoice', async () => {
    const svc = service();
    const result = await svc.allocatePayment(
      { id: 'PAY-10', customerId: 'CUST-SHARED', subAccountId: 'SUB-A', amount: 100 },
      [{ invoiceId: 'INV-A', amount: 100 }],
      'MWK',
      { customer: CUSTOMER_SHARED }
    );
    assert.equal(result.totalAllocated, 100);
    const allocationWrite = state.writes.find((w) => w.table === 'payment_allocations');
    const lineWrite = state.writes.find((w) => w.table === 'payment_allocation_lines');
    const invoiceWrite = state.writes.find((w) => w.table === 'invoices');
    assert.ok(allocationWrite, 'allocation row written');
    assert.ok(lineWrite, 'allocation line written');
    assert.ok(invoiceWrite, 'invoice updated');
    assert.equal(invoiceWrite.record.data.paid_amount, 100);
    assert.equal(invoiceWrite.record.data.status, 'paid');
  });
});

describe('resolvePaymentScope — the stable branch id always wins', () => {
  it('uses the embedded id even when a (stale) name is present', () => {
    const svc = service();
    const scope = svc.resolvePaymentScope(
      { id: 'P', customerId: 'CUST-SHARED', subAccountId: 'SUB-B', subAccountName: 'Fees' },
      { customer: CUSTOMER_SHARED }
    );
    assert.equal(scope.branchKey, 'id:SUB-B');
  });

  it('returns null when the payment has no customer', () => {
    const svc = service();
    assert.equal(svc.resolvePaymentScope({ id: 'P' }, {}), null);
  });
});

describe('reverseAllocation — the ownership gate applies to reversals too', () => {
  function seedCrossScopeAllocation() {
    state.customer_payments.push(row('PAY-R', { customerId: 'CUST-SHARED', subAccountId: 'SUB-A', amount: 100 }));
    state.payment_allocations.push(row('ALLOC-R', { payment_id: 'PAY-R', total_allocated: 100 }));
    state.payment_allocation_lines.push(row('LINE-R', { allocation_id: 'ALLOC-R', invoice_id: 'INV-B', amount: 100 }));
    // Must NOT be flushed on refusal (the reversal would be a cross-account repair).
    state.writes = [];
  }

  it('refuses to reverse an allocation that crosses accounts', async () => {
    seedCrossScopeAllocation();
    const svc = service();
    await expectCode(() => svc.reverseAllocation('ALLOC-R', { customer: CUSTOMER_SHARED }), 'ECROSS_ACCOUNT');
    assert.deepEqual(state.writes, []);
    assert.equal(state.payment_allocations[0].data.reversed, undefined);
  });
});
