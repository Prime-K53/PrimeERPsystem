/**
 * Financial Reconciliation Script
 *
 * Reads through the existing Supabase repository and runs read-only
 * reconciliation checks against the live database.
 *
 * Run: node backend/scripts/runReconciliation.cjs
 */

const repo = require('../services/supabaseRepository.cjs');
const customerLedger = require('../services/customerLedger.cjs');
const paymentAllocationService = require('../services/paymentAllocationService.cjs');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

const CLOSED_INVOICE_STATUSES = new Set(['draft', 'cancelled', 'voided']);
const CLOSED_PAYMENT_STATUSES = new Set(['cancelled', 'voided']);

async function all(table) {
  try {
    return await repo.getAll(table);
  } catch (err) {
    console.warn(`[Reconciliation] Failed to read ${table}: ${err.message}`);
    return [];
  }
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    return { name, ...result };
  } catch (err) {
    return { name, status: 'ERROR', error: err.message, rows: 0 };
  }
}

async function main() {
  console.log('=== Financial Reconciliation ===\n');

  const [
    invoices,
    payments,
    customers,
    ledgerEntries,
    coaAccounts,
    paymentAllocations,
    paymentAllocationLines,
    bankAccounts,
    bankTransactions,
  ] = await Promise.all([
    all('invoices'),
    all('customer_payments'),
    all('customers'),
    all('ledger_entries'),
    all('chart_of_accounts'),
    all('payment_allocations'),
    all('payment_allocation_lines'),
    all('bank_accounts'),
    all('bank_transactions'),
  ]);

  const invoiceMap = new Map((invoices || []).map(i => [i.id, i]));
  const paymentMap = new Map((payments || []).map(p => [p.id, p]));
  const coaMap = new Map((coaAccounts || []).map(a => [a.id, a]));

  // R-01: Invoice total reconciliation
  const invoiceTotalMismatches = (invoices || []).filter(inv => {
    const d = inv.data || inv;
    const subtotal = toNum(d.subtotal);
    const tax = toNum(d.taxAmount ?? d.tax_amount);
    const delivery = toNum(d.deliveryFee ?? d.delivery_fee ?? d.otherCharges);
    const discount = toNum(d.discount ?? d.discountAmount ?? d.discount_amount);
    const total = toNum(d.totalAmount ?? d.total);
    const expected = round2(subtotal - discount + tax + delivery);
    return Math.abs(expected - total) > 0.01;
  });

  // R-02: Invoice paidAmount vs allocations
  const allocByInvoice = new Map();
  for (const line of paymentAllocationLines || []) {
    const ld = line.data || line;
    const invId = ld.invoice_id || ld.invoiceId;
    if (!invId) continue;
    const pa = paymentAllocations.find(a => a.id === (ld.allocation_id || ld.allocationId));
    if (pa) {
      const pd = pa.data || pa;
      const status = normStatus(pd.status);
      if (status === 'voided' || status === 'cancelled') continue;
    }
    allocByInvoice.set(invId, (allocByInvoice.get(invId) || 0) + toNum(ld.amount));
  }
  const paidAmountMismatches = (invoices || []).filter(inv => {
    const d = inv.data || inv;
    const cached = toNum(d.paidAmount ?? d.paid_amount);
    const actual = allocByInvoice.get(inv.id) || 0;
    return Math.abs(cached - actual) > 0.01;
  });

  // R-03: Invoice status vs paidAmount
  const statusMismatches = (invoices || []).filter(inv => {
    const d = inv.data || inv;
    const total = toNum(d.totalAmount ?? d.total);
    const paid = toNum(d.paidAmount ?? d.paid_amount);
    const status = normStatus(d.status);
    if (total <= 0) return false;
    if (paid >= total && !['paid', 'voided', 'cancelled'].includes(status)) return true;
    if (paid > 0 && paid < total && !['partial', 'unpaid', 'overdue'].includes(status)) return true;
    return false;
  });

  // R-04: Payment without customer
  const paymentsWithoutCustomer = (payments || []).filter(p => {
    const d = p.data || p;
    const cid = d.customerId || d.customer_id;
    return !cid || String(cid).trim() === '';
  });

  // R-05: Invoice without customer
  const invoicesWithoutCustomer = (invoices || []).filter(inv => {
    const d = inv.data || inv;
    const cid = d.customerId || d.customer_id;
    return !cid || String(cid).trim() === '';
  });

  // R-06: Allocations without payment
  const allocPaymentIds = new Set((paymentAllocations || []).map(a => a.id));
  const orphanAllocs = (paymentAllocationLines || []).filter(line => {
    const ld = line.data || line;
    const allocId = ld.allocation_id || ld.allocationId;
    const pa = paymentAllocations.find(a => a.id === allocId);
    if (!pa) return true;
    const payId = (pa.data || pa).payment_id || (pa.data || pa).paymentId;
    return !payId || !paymentMap.has(payId);
  });

  // R-07: Allocations without invoice
  const orphanLineAllocs = (paymentAllocationLines || []).filter(line => {
    const ld = line.data || line;
    const invId = ld.invoice_id || ld.invoiceId;
    return !invId || !invoiceMap.has(invId);
  });

  // R-08: Over-allocated payments
  const overallocatedPayments = [];
  for (const pay of payments || []) {
    const pd = pay.data || pay;
    const payAmount = toNum(pd.amount);
    const allocs = paymentAllocations.filter(a => (a.data || a).payment_id === pay.id || (a.data || a).paymentId === pay.id);
    let totalAllocated = 0;
    for (const pa of allocs) {
      const lines = paymentAllocationLines.filter(l => (l.data || l).allocation_id === pa.id);
      for (const line of lines) {
        const ld = line.data || line;
        totalAllocated += toNum(ld.amount);
      }
    }
    if (totalAllocated > payAmount + 0.01) {
      overallocatedPayments.push({ id: pay.id, amount: payAmount, allocated: totalAllocated });
    }
  }

  // R-09: Allocation > invoice outstanding
  const overallocatedInvoices = [];
  for (const line of paymentAllocationLines || []) {
    const ld = line.data || line;
    const invId = ld.invoice_id || ld.invoiceId;
    const allocAmount = toNum(ld.amount);
    const inv = invoiceMap.get(invId);
    if (!inv) continue;
    const id = inv.data || inv;
    const total = toNum(id.totalAmount ?? id.total);
    const paid = toNum(id.paidAmount ?? id.paid_amount);
    const outstanding = total - paid;
    if (allocAmount > outstanding + 0.01) {
      overallocatedInvoices.push({ lineId: line.id, invoiceId: invId, allocated: allocAmount, outstanding });
    }
  }

  // R-10: Orphan ledger entries
  const orphanLedger = (ledgerEntries || []).filter(le => {
    const d = le.data || le;
    return !d.reference_type || !d.reference_id || !d.account_id;
  });

  // R-11: Ledger entries with missing accounts
  const ledgerMissingAccount = (ledgerEntries || []).filter(le => {
    const d = le.data || le;
    return !coaMap.has(d.account_id);
  });

  // R-12: Unbalanced journals
  const journalNet = new Map();
  for (const le of ledgerEntries || []) {
    const d = le.data || le;
    const jid = d.journal_id;
    if (!jid) continue;
    const amt = toNum(d.amount);
    const type = normStatus(d.entry_type);
    const net = journalNet.get(jid) || 0;
    journalNet.set(jid, type === 'debit' ? net + amt : net - amt);
  }
  const unbalancedJournals = [...journalNet.entries()].filter(([, net]) => Math.abs(net) > 0.01);

  // R-13: Posting to inactive accounts
  const inactiveAccountPostings = (ledgerEntries || []).filter(le => {
    const d = le.data || le;
    const acct = coaMap.get(d.account_id);
    if (!acct) return false;
    const ad = acct.data || acct;
    const isActive = ad.is_active !== false && ad.is_active !== 0;
    return !isActive;
  });

  // R-14: Duplicate invoice numbers
  const invoiceNumbers = new Map();
  for (const inv of invoices || []) {
    const d = inv.data || inv;
    const num = d.invoiceNumber || d.invoice_number;
    if (!num) continue;
    invoiceNumbers.set(num, (invoiceNumbers.get(num) || 0) + 1);
  }
  const duplicateInvoices = [...invoiceNumbers.entries()].filter(([, count]) => count > 1);

  // R-15: Duplicate payment numbers
  const paymentNumbers = new Map();
  for (const p of payments || []) {
    const d = p.data || p;
    const num = d.paymentNumber || d.payment_number;
    if (!num) continue;
    paymentNumbers.set(num, (paymentNumbers.get(num) || 0) + 1);
  }
  const duplicatePayments = [...paymentNumbers.entries()].filter(([, count]) => count > 1);

  // R-16: Duplicate ledger postings
  const ledgerRefs = new Map();
  for (const le of ledgerEntries || []) {
    const d = le.data || le;
    const key = `${d.reference_type}:${d.reference_id}:${d.account_id}`;
    ledgerRefs.set(key, (ledgerRefs.get(key) || 0) + 1);
  }
  const duplicateLedger = [...ledgerRefs.entries()].filter(([, count]) => count > 1);

  // R-17: Customer outstanding balance check
  const customerBalanceIssues = [];
  for (const c of customers || []) {
    const cd = c.data || c;
    const cid = c.id;
    const opening = toNum(cd.balance);
    const invTotal = (invoices || [])
      .filter(i => { const id = i.data || i; return (id.customerId || id.customer_id) === cid && !CLOSED_INVOICE_STATUSES.has(normStatus(id.status)); })
      .reduce((s, i) => s + toNum((i.data || i).totalAmount ?? (i.data || i).total), 0);
    const payTotal = (payments || [])
      .filter(p => { const pd = p.data || p; return (pd.customerId || pd.customer_id) === cid && !CLOSED_PAYMENT_STATUSES.has(normStatus(pd.status)); })
      .reduce((s, p) => s + toNum((p.data || p).amountApplied ?? (p.data || p).amount), 0);
    const cnTotal = (invoices || [])
      .filter(i => { const id = i.data || i; return (id.customerId || id.customer_id) === cid && normStatus(id.status) === 'credit_note'; })
      .reduce((s, i) => s + toNum((i.data || i).totalAmount ?? (i.data || i).total), 0);
    const expected = round2(opening + invTotal - payTotal - cnTotal);
    const actual = round2(toNum(cd.outstandingBalance));
    if (Math.abs(expected - actual) > 0.01) {
      customerBalanceIssues.push({ customerId: cid, name: cd.name, expected, actual, diff: round2(expected - actual) });
    }
  }

  // R-18: Bank account balance check
  const bankBalanceIssues = [];
  for (const ba of bankAccounts || []) {
    const bd = ba.data || ba;
    const opening = toNum(bd.openingBalance);
    let txTotal = 0;
    for (const bt of bankTransactions || []) {
      const btd = bt.data || bt;
      if (btd.bankAccountId !== ba.id && btd.account_id !== ba.id) continue;
      const amt = toNum(btd.amount);
      const type = normStatus(btd.type);
      if (type === 'deposit' || type === 'transfer_in') txTotal += amt;
      else txTotal -= amt;
    }
    const expected = round2(opening + txTotal);
    const actual = round2(toNum(bd.currentBalance));
    if (Math.abs(expected - actual) > 0.01) {
      bankBalanceIssues.push({ accountId: ba.id, name: bd.account_name, expected, actual });
    }
  }

  // Print results
  const checks = [
    { name: 'R-01 Invoice total reconciliation', rows: invoiceTotalMismatches.length, status: invoiceTotalMismatches.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-02 Invoice paidAmount vs allocations', rows: paidAmountMismatches.length, status: paidAmountMismatches.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-03 Invoice status vs paidAmount', rows: statusMismatches.length, status: statusMismatches.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-04 Payments without customer', rows: paymentsWithoutCustomer.length, status: paymentsWithoutCustomer.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-05 Invoices without customer', rows: invoicesWithoutCustomer.length, status: invoicesWithoutCustomer.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-06 Allocations without payment', rows: orphanAllocs.length, status: orphanAllocs.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-07 Allocations without invoice', rows: orphanLineAllocs.length, status: orphanLineAllocs.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-08 Over-allocated payments', rows: overallocatedPayments.length, status: overallocatedPayments.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-09 Allocation > invoice outstanding', rows: overallocatedInvoices.length, status: overallocatedInvoices.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-10 Orphan ledger entries', rows: orphanLedger.length, status: orphanLedger.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-11 Ledger entries with missing accounts', rows: ledgerMissingAccount.length, status: ledgerMissingAccount.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-12 Unbalanced journals', rows: unbalancedJournals.length, status: unbalancedJournals.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-13 Posting to inactive accounts', rows: inactiveAccountPostings.length, status: inactiveAccountPostings.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-14 Duplicate invoice numbers', rows: duplicateInvoices.length, status: duplicateInvoices.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-15 Duplicate payment numbers', rows: duplicatePayments.length, status: duplicatePayments.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-16 Duplicate ledger postings', rows: duplicateLedger.length, status: duplicateLedger.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-17 Customer outstanding balance mismatch', rows: customerBalanceIssues.length, status: customerBalanceIssues.length === 0 ? 'PASS' : 'FAIL' },
    { name: 'R-18 Bank account balance mismatch', rows: bankBalanceIssues.length, status: bankBalanceIssues.length === 0 ? 'PASS' : 'FAIL' },
  ];

  let passCount = 0;
  let failCount = 0;
  for (const check of checks) {
    const icon = check.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${check.name}: ${check.status} (${check.rows} rows)`);
    if (check.status === 'PASS') passCount++;
    else failCount++;
  }

  console.log(`\n=== Summary: ${passCount} passed, ${failCount} failed ===`);

  if (failCount > 0) {
    console.log('\n=== Failed Check Details ===');
    for (const check of checks) {
      if (check.status !== 'FAIL') continue;
      console.log(`\n--- ${check.name} ---`);
      if (check.name === 'R-01 Invoice total reconciliation') {
        for (const inv of invoiceTotalMismatches.slice(0, 10)) {
          const d = inv.data || inv;
          console.log(`  Invoice ${d.invoiceNumber || inv.id}: total=${d.totalAmount}`);
        }
      } else if (check.name === 'R-02 Invoice paidAmount vs allocations') {
        for (const inv of paidAmountMismatches.slice(0, 10)) {
          const d = inv.data || inv;
          const actual = allocByInvoice.get(inv.id) || 0;
          console.log(`  Invoice ${d.invoiceNumber || inv.id}: cached=${d.paidAmount}, actual=${actual}`);
        }
      } else if (check.name === 'R-03 Invoice status vs paidAmount') {
        for (const inv of statusMismatches.slice(0, 10)) {
          const d = inv.data || inv;
          console.log(`  Invoice ${d.invoiceNumber || inv.id}: status=${d.status}, paid=${d.paidAmount}, total=${d.totalAmount}`);
        }
      } else if (check.name === 'R-17 Customer outstanding balance mismatch') {
        for (const issue of customerBalanceIssues.slice(0, 10)) {
          console.log(`  Customer ${issue.name}: expected=${issue.expected}, actual=${issue.actual}, diff=${issue.diff}`);
        }
      } else if (check.name === 'R-18 Bank account balance mismatch') {
        for (const issue of bankBalanceIssues.slice(0, 10)) {
          console.log(`  Account ${issue.name}: expected=${issue.expected}, actual=${issue.actual}`);
        }
      }
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[Reconciliation] Fatal:', err);
  process.exit(1);
});
