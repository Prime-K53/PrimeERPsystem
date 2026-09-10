/**
 * Reconciliation runner — read-only, Phase 2A
 *
 * Uses the existing supabaseRepository to query live data
 * and run reconciliation checks from the Reconciliation Matrix.
 */

const repo = require('../services/supabaseRepository.cjs');
const assert = require('node:assert/strict');

async function run() {
  console.log('=== Phase 2A Live Reconciliation ===\n');

  let passed = 0;
  let failed = 0;

  async function check(label, fn) {
    try {
      const result = await fn();
      if (result.pass) {
        console.log(`[PASS] ${label}`);
        passed++;
      } else {
        console.log(`[FAIL] ${label}: ${result.detail || 'see sample'}`);
        if (result.sample) console.log('  Sample:', JSON.stringify(result.sample).slice(0, 200));
        failed++;
      }
    } catch (err) {
      console.log(`[ERROR] ${label}: ${err.message}`);
      failed++;
    }
  }

  // 1. No orphan ledger entries
  await check('R-08 No orphan ledger entries (missing reference)', async () => {
    const rows = await repo.getAll('ledger_entries');
    const orphans = rows.filter(r => !r.reference_type || !r.reference_id);
    return { pass: orphans.length === 0, sample: orphans.slice(0, 5) };
  });

  // 2. No ledger entries with missing accounts
  await check('R-08 No orphan account entries', async () => {
    const entries = await repo.getAll('ledger_entries');
    const accounts = await repo.getAll('chart_of_accounts');
    const accountIds = new Set(accounts.map(a => a.id));
    const orphans = entries.filter(e => !accountIds.has(e.accountId));
    return { pass: orphans.length === 0, sample: orphans.slice(0, 5) };
  });

  // 3. No duplicate invoice numbers
  await check('R-09 No duplicate invoice numbers', async () => {
    const invoices = await repo.getAll('invoices');
    const counts = {};
    invoices.forEach(inv => {
      const n = inv.invoiceNumber;
      if (n) counts[n] = (counts[n] || 0) + 1;
    });
    const dupes = Object.entries(counts).filter(([_, c]) => c > 1);
    return { pass: dupes.length === 0, sample: dupes.slice(0, 5) };
  });

  // 4. No over-allocated payments
  await check('R-10 No over-allocated payments', async () => {
    const payments = await repo.getAll('customer_payments');
    const allocations = await repo.getAll('payment_allocation_lines');
    const byPayment = {};
    allocations.forEach(a => {
      const pid = a.paymentId;
      if (!byPayment[pid]) byPayment[pid] = 0;
      byPayment[pid] += Number(a.amount || 0);
    });
    const over = payments.filter(p => {
      const total = Number(p.amount || 0);
      const alloc = byPayment[p.id] || 0;
      return alloc > total + 0.01;
    });
    return { pass: over.length === 0, sample: over.slice(0, 5).map(p => ({ id: p.id, amount: p.amount, allocated: byPayment[p.id] })) };
  });

  // 5. No allocation > invoice outstanding
  await check('R-11 No allocation exceeds invoice outstanding', async () => {
    const invoices = await repo.getAll('invoices');
    const invMap = {};
    invoices.forEach(inv => {
      invMap[inv.id] = {
        total: Number(inv.totalAmount || 0),
        paid: Number(inv.paidAmount || 0),
        outstanding: Number(inv.totalAmount || 0) - Number(inv.paidAmount || 0),
      };
    });
    const allocations = await repo.getAll('payment_allocation_lines');
    const over = allocations.filter(a => {
      const inv = invMap[a.invoiceId];
      if (!inv) return false;
      return Number(a.amount || 0) > inv.outstanding + 0.01;
    });
    return { pass: over.length === 0, sample: over.slice(0, 5) };
  });

  // 6. No invoices without customer
  await check('R-No invoices without customer', async () => {
    const invoices = await repo.getAll('invoices');
    const bad = invoices.filter(inv => !inv.customerId && inv.customerId !== 0);
    return { pass: bad.length === 0, sample: bad.slice(0, 5).map(i => i.id) };
  });

  // 7. No payments without customer
  await check('R-No payments without customer', async () => {
    const payments = await repo.getAll('customer_payments');
    const bad = payments.filter(p => !p.customerId && p.customerId !== 0);
    return { pass: bad.length === 0, sample: bad.slice(0, 5).map(p => p.id) };
  });

  // 8. Customer balance parity (DB trigger vs application formula)
  await check('R-04 Customer balance parity', async () => {
    const customers = await repo.getAll('customers');
    const invoices = await repo.getAll('invoices');
    const payments = await repo.getAll('customer_payments');
    const byCustomerInvoices = {};
    invoices.forEach(inv => {
      const cid = inv.customerId;
      if (!byCustomerInvoices[cid]) byCustomerInvoices[cid] = { total: 0, creditNotes: 0 };
      const amt = Number(inv.totalAmount || 0);
      if (inv.status === 'credit_note') {
        byCustomerInvoices[cid].creditNotes += amt;
      } else if (!['draft', 'cancelled', 'voided'].includes(inv.status)) {
        byCustomerInvoices[cid].total += amt;
      }
    });
    const byCustomerPayments = {};
    payments.forEach(p => {
      const cid = p.customerId;
      if (!byCustomerPayments[cid]) byCustomerPayments[cid] = 0;
      if (!['cancelled', 'voided'].includes(p.status)) {
        byCustomerPayments[cid] += Number(p.amountApplied || p.amount || 0);
      }
    });
    const mismatches = customers.filter(c => {
      const cached = Number(c.outstandingBalance || 0);
      const opening = Number(c.balance || 0);
      const invTotal = byCustomerInvoices[c.id]?.total || 0;
      const creditNotes = byCustomerInvoices[c.id]?.creditNotes || 0;
      const payTotal = byCustomerPayments[c.id] || 0;
      const expected = opening + invTotal - payTotal - creditNotes;
      return Math.abs(cached - expected) > 0.01;
    });
    return { pass: mismatches.length === 0, sample: mismatches.slice(0, 5).map(c => ({ id: c.id, cached: c.outstandingBalance })) };
  });

  // 9. Bank balance parity
  await check('R-13 Bank balance parity', async () => {
    const accounts = await repo.getAll('bank_accounts');
    const transactions = await repo.getAll('bank_transactions');
    const byAccount = {};
    transactions.forEach(t => {
      const aid = t.bankAccountId;
      if (!byAccount[aid]) byAccount[aid] = 0;
      const type = (t.type || '').toLowerCase();
      if (type === 'deposit' || type === 'transfer_in') {
        byAccount[aid] += Number(t.amount || 0);
      } else {
        byAccount[aid] -= Number(t.amount || 0);
      }
    });
    const mismatches = accounts.filter(a => {
      const opening = Number(a.openingBalance || 0);
      const expected = opening + (byAccount[a.id] || 0);
      const actual = Number(a.currentBalance || 0);
      return Math.abs(expected - actual) > 0.01;
    });
    return { pass: mismatches.length === 0, sample: mismatches.slice(0, 5).map(a => ({ id: a.id, expected: a.openingBalance + (byAccount[a.id] || 0), actual: a.currentBalance })) };
  });

  // 10. AR vs customer outstanding sum
  await check('R-05 AR vs customer outstanding sum', async () => {
    const accounts = await repo.getAll('chart_of_accounts');
    const customers = await repo.getAll('customers');
    const arAccount = accounts.find(a => a.subtype === 'receivable');
    const arBalance = arAccount ? Number(arAccount.balance || 0) : 0;
    const customerSum = customers.reduce((s, c) => s + Number(c.outstandingBalance || 0), 0);
    const diff = Math.abs(arBalance - customerSum);
    return { pass: diff < 0.01, detail: `AR=${arBalance}, CustomerSum=${customerSum}, Diff=${diff}` };
  });

  // 11. Payment request firewall
  await check('R-20 Payment request firewall', async () => {
    const requests = await repo.getAll('payment_requests');
    const payments = await repo.getAll('customer_payments');
    const byRequestId = {};
    payments.forEach(p => {
      if (p.requestId) byRequestId[p.requestId] = (byRequestId[p.requestId] || 0) + 1;
    });
    const leaks = requests.filter(r => r.status === 'confirmed' && byRequestId[r.id]);
    return { pass: leaks.length === 0, sample: leaks.slice(0, 5).map(r => ({ id: r.id, status: r.status, payments: byRequestId[r.id] })) };
  });

  // 12. No voided allocations affecting paidAmount
  await check('R-18 No voided allocations affecting paidAmount', async () => {
    const allocations = await repo.getAll('payment_allocations');
    const voided = allocations.filter(a => ['voided', 'cancelled'].includes(a.status));
    return { pass: voided.length === 0, sample: voided.slice(0, 5).map(a => ({ id: a.id, status: a.status })) };
  });

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed out of ${passed + failed} checks ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
