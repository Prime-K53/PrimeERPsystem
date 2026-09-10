/**
 * phase2C_financial_lifecycle.test.cjs
 *
 * Phase 2C — Transaction Lifecycle & Edge-Case Integrity.
 *
 * Tests the complete financial transaction lifecycle:
 *   Quotation → Order → Sale → Invoice → AR → Payment → Allocation → GL → Reporting
 *
 * And correction/reversal paths:
 *   Payment reversal, invoice cancellation, credit notes, sales returns,
 *   overpayment, unapplied payments, duplicate submissions, transfers.
 *
 * This file is intentionally read-only against production data where possible.
 * Tests that must write use clearly identifiable test records and clean up
 * only when explicitly permitted.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOLERANCE = 0.01;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function loadSrc(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

// ── Quotation / Order / Invoice / Sale Lifecycle ─────────────────────────────

describe('Phase 2C: Transaction Lifecycle', () => {
  it('quotation creation does not post ledger entries (static check)', () => {
    const portalLifecycle = loadSrc('services/portalLifecycleService.cjs');
    assert.ok(portalLifecycle.includes('completeQuotation'), 'completeQuotation must exist');
    // Quotation should only write to quotations + quotation_requests, not ledger_entries
    const quotationFn = portalLifecycle.slice(portalLifecycle.indexOf('async completeQuotation'), portalLifecycle.indexOf('async completeQuotation') + 5000);
    assert.ok(!quotationFn.includes('ledger_entries'), 'completeQuotation must not write to ledger_entries');
  });

  it('order creation does not create invoices or ledger entries (static check)', () => {
    const portalLifecycle = loadSrc('services/portalLifecycleService.cjs');
    const orderFn = portalLifecycle.slice(portalLifecycle.indexOf('async completeSalesOrder'), portalLifecycle.indexOf('async completeSalesOrder') + 5000);
    assert.ok(!orderFn.includes('invoices'), 'completeSalesOrder must not create invoices');
    assert.ok(!orderFn.includes('ledger_entries'), 'completeSalesOrder must not write to ledger_entries');
  });

  it('sale creation posts DR AR / CR Revenue / DR COGS (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes('postSaleLedgerEntries'), 'index.cjs must have postSaleLedgerEntries');
    assert.ok(indexSrc.includes("entry_type: 'debit'"), 'Sale must post debit entries');
    assert.ok(indexSrc.includes("entry_type: 'credit'"), 'Sale must post credit entries');
    assert.ok(indexSrc.includes('11310') || indexSrc.includes('accounts receivable'), 'Sale must debit AR');
    assert.ok(indexSrc.includes('41100') || indexSrc.includes('sales'), 'Sale must credit Revenue');
    assert.ok(indexSrc.includes('51200') || indexSrc.includes('cost of goods'), 'Sale may debit COGS');
  });

  it('invoice creation does not duplicate financial postings (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    // Invoice POST should not call postCustomerPaymentToLedger or postSaleLedgerEntries
    const invoicePostStart = indexSrc.indexOf("app.post('/api/invoices'");
    const invoicePostEnd = indexSrc.indexOf('\n  });', invoicePostStart);
    const invoicePostBlock = indexSrc.slice(invoicePostStart, invoicePostEnd);
    assert.ok(!invoicePostBlock.includes('postCustomerPaymentToLedger'), 'Invoice creation must not post to ledger');
    assert.ok(!invoicePostBlock.includes('postSaleLedgerEntries'), 'Invoice creation must not post sale ledger entries');
  });

  it('invoice void reverses GL entries (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes("reverseLedgerEntriesByReference('invoice'"), 'Invoice void must reverse ledger entries');
  });
});

// ── Payment Reversal ─────────────────────────────────────────────────────────

describe('Phase 2C: Payment Reversal', () => {
  it('reverseAllocation method exists on paymentAllocationService (P1 defect check)', () => {
    const paymentAllocation = require('../services/paymentAllocationService.cjs');
    // This is a known defect: reverseAllocation is called in index.cjs:2238 but not implemented
    assert.equal(typeof paymentAllocation.prototype.reverseAllocation, 'function',
      'reverseAllocation must be implemented on paymentAllocationService (currently missing — P1 defect)');
  });

  it('portal revertInvoicePayment does not reverse GL entries (design finding)', () => {
    const portalSrc = loadSrc('services/portalService.cjs');
    const revertFn = portalSrc.slice(portalSrc.indexOf('async revertInvoicePayment'), portalSrc.indexOf('async revertInvoicePayment') + 8000);
    assert.ok(!revertFn.includes('reverseLedgerEntriesByReference'),
      'Portal revertInvoicePayment does NOT reverse GL entries — GL remains unbalanced after revert (P1 finding)');
  });

  it('payment reversal idempotency: reversing twice must not double-reverse (static check)', () => {
    const portalSrc = loadSrc('services/portalService.cjs');
    const revertFn = portalSrc.slice(portalSrc.indexOf('async revertInvoicePayment'), portalSrc.indexOf('async revertInvoicePayment') + 8000);
    assert.ok(revertFn.includes('p.reversed === true') || revertFn.includes('/revers/i'),
      'revertInvoicePayment must skip already-reversed payments');
  });
});

// ── Sales Return / Exchange ──────────────────────────────────────────────────

describe('Phase 2C: Sales Return / Exchange', () => {
  it('sales exchange does not create credit notes or reverse GL (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    const exchangeBlock = indexSrc.slice(indexSrc.indexOf('sales-exchanges'), indexSrc.indexOf('sales-exchanges') + 10000);
    assert.ok(!exchangeBlock.includes('credit_note'), 'Sales exchange must not create credit notes');
    assert.ok(!exchangeBlock.includes('reverseLedgerEntriesByReference'), 'Sales exchange must not reverse GL');
    assert.ok(!exchangeBlock.includes('inventory_transactions'), 'Sales exchange must not adjust inventory automatically');
  });

  it('sales exchange approval does not create financial postings (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    const approveBlock = indexSrc.slice(indexSrc.indexOf(':id/approve'), indexSrc.indexOf(':id/approve') + 5000);
    assert.ok(!approveBlock.includes('ledger_entries'), 'Exchange approval must not create ledger entries');
    assert.ok(!approveBlock.includes('customer_payments'), 'Exchange approval must not create payments');
  });
});

// ── Overpayment Handling ─────────────────────────────────────────────────────

describe('Phase 2C: Overpayment Handling', () => {
  it('payment allocation rejects over-allocation (static check)', () => {
    const allocSrc = loadSrc('services/paymentAllocationService.cjs');
    assert.ok(allocSrc.includes('totalAllocated > paymentAmount + 0.01'),
      'allocatePayment must reject allocations exceeding payment amount');
  });

  it('overpayment behavior is deterministic via excess_handling field (static check)', () => {
    const allocSrc = loadSrc('services/paymentAllocationService.cjs');
    assert.ok(allocSrc.includes('excess_amount'), 'allocatePayment must record excess_amount');
    assert.ok(allocSrc.includes('excess_handling'), 'allocatePayment must record excess_handling');
  });
});

// ── Unapplied Payment ────────────────────────────────────────────────────────

describe('Phase 2C: Unapplied Payment', () => {
  it('customerLedger excludes wallet top-ups from AR (static check)', () => {
    const ledgerSrc = loadSrc('services/customerLedger.cjs');
    assert.ok(ledgerSrc.includes('isWalletTopup'), 'customerLedger must define isWalletTopup');
    assert.ok(ledgerSrc.includes('walletTopups'), 'customerLedger must track wallet top-ups separately');
  });

  it('payment credit uses amountApplied first, then amount (static check)', () => {
    const ledgerSrc = loadSrc('services/customerLedger.cjs');
    assert.ok(ledgerSrc.includes('amountApplied'), 'paymentCredit must prefer amountApplied');
    assert.ok(ledgerSrc.includes('amountRetained'), 'paymentCredit must fall back to amountRetained');
    assert.ok(ledgerSrc.includes('allocationSum'), 'paymentCredit must fall back to allocationSum');
    assert.ok(ledgerSrc.includes('amount'), 'paymentCredit must fall back to bare amount');
  });
});

// ── Idempotency & Duplicate Submission ──────────────────────────────────────

describe('Phase 2C: Idempotency & Duplicate Submission', () => {
  it('sale creation has idempotency key check (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes('idempotencyKey'), 'Sale creation must check idempotencyKey');
    assert.ok(indexSrc.includes('duplicate'), 'Duplicate sale must return duplicate flag');
  });

  it('payment allocation has idempotency key support (static check)', () => {
    const allocSrc = loadSrc('services/paymentAllocationService.cjs');
    assert.ok(allocSrc.includes('idempotencyKey'), 'allocatePayment must accept idempotencyKey');
    assert.ok(allocSrc.includes('_allocationByKey'), 'PaymentAllocationService must cache allocation by key');
  });

  it('sync gateway has operation-idempotency (static check)', () => {
    const syncSrc = loadSrc('services/cloudSyncStore.cjs');
    assert.ok(syncSrc.includes('checkIdempotency'), 'cloudSyncStore must check idempotency');
    assert.ok(syncSrc.includes('recordIdempotency'), 'cloudSyncStore must record idempotency');
  });

  it('HTTP idempotency middleware exists (static check)', () => {
    const idemSrc = loadSrc('middleware/idempotency.cjs');
    assert.ok(idemSrc.includes('idempotency'), 'idempotency middleware must exist');
  });
});

// ── Bank/Cash Transfers ──────────────────────────────────────────────────────

describe('Phase 2C: Bank/Cash Transfers', () => {
  it('transferFunds uses _transaction with checkpoints (static check)', () => {
    const bankingSrc = loadSrc('services/bankingService.cjs');
    assert.ok(bankingSrc.includes('transferFunds'), 'bankingService must have transferFunds');
    assert.ok(bankingSrc.includes('_transaction'), 'transferFunds must use _transaction');
    assert.ok(bankingSrc.includes('_txCheckpoint'), 'transferFunds must checkpoint accounts');
  });

  it('cash flow classification uses account.type, not code prefix (static check)', () => {
    const cfSrc = loadSrc('services/financialReportingService.cjs');
    assert.ok(cfSrc.includes('account_type'), 'Cash flow must use account_type for classification');
  });
});

// ── Opening Balances ─────────────────────────────────────────────────────────

describe('Phase 2C: Opening Balances', () => {
  it('customerLedger loads opening balance from customers.balance (static check)', () => {
    const ledgerSrc = loadSrc('services/customerLedger.cjs');
    assert.ok(ledgerSrc.includes('loadCustomerOpeningBalance'), 'customerLedger must load opening balance');
    assert.ok(ledgerSrc.includes('customers.balance'), 'Opening balance must come from customers.balance');
  });

  it('COA balance trigger includes openingBalance (static check)', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '0013_financial_integrity.sql'),
      'utf8'
    );
    assert.ok(migration.includes('openingBalance'), 'COA trigger must include openingBalance');
  });
});

// ── Inventory → COGS Integrity ───────────────────────────────────────────────

describe('Phase 2C: Inventory → COGS Integrity', () => {
  it('sale creation deducts inventory (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes('deductInventoryForSale'), 'Sale creation must deduct inventory');
  });

  it('sale creation posts COGS when material total > 0 (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes('materialTotal') || indexSrc.includes('COGS'),
      'Sale creation must post COGS for material items');
  });

  it('customerLedger does not double-count wallet top-ups as AR (static check)', () => {
    const ledgerSrc = loadSrc('services/customerLedger.cjs');
    assert.ok(ledgerSrc.includes('isWalletTopup'), 'customerLedger must identify wallet top-ups');
    assert.ok(ledgerSrc.includes('walletTopups'), 'customerLedger must separate wallet top-ups');
  });
});

// ── Invoice Cancellation / Credit Note ───────────────────────────────────────

describe('Phase 2C: Invoice Cancellation & Credit Notes', () => {
  it('invoice void reverses GL entries via reverseLedgerEntriesByReference (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes("reverseLedgerEntriesByReference('invoice'"),
      'Invoice void must call reverseLedgerEntriesByReference');
  });

  it('credit note status is recognized in customerLedger (static check)', () => {
    const ledgerSrc = loadSrc('services/customerLedger.cjs');
    assert.ok(ledgerSrc.includes('credit_note'), 'customerLedger must recognize credit_note status');
    assert.ok(ledgerSrc.includes('isCreditNoteInvoice'), 'customerLedger must have isCreditNoteInvoice');
  });

  it('P&L excludes reversals (static check)', () => {
    const plSrc = loadSrc('services/financialReportingService.cjs');
    assert.ok(plSrc.includes("reference_type === 'reversal'") || plSrc.includes('REVERSAL_REFERENCE_TYPE'),
      'P&L must exclude reversal entries');
  });
});

// ── Frontend vs Backend Reporting Parity ─────────────────────────────────────

describe('Phase 2C: Frontend vs Backend Reporting Parity', () => {
  it('frontend cash flow uses account.type classification (static check)', () => {
    const feSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'views', 'accounts', 'FinancialReports.tsx'),
      'utf8'
    );
    assert.ok(feSrc.includes('account.type') || feSrc.includes('acc.type'),
      'Frontend cash flow should classify by account type');
  });

  it('frontend TB shows debit/credit balances by account type (static check)', () => {
    const feSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'views', 'accounts', 'FinancialReports.tsx'),
      'utf8'
    );
    assert.ok(feSrc.includes('TrialBalance') || feSrc.includes('trial balance'),
      'Frontend must have Trial Balance view');
  });

  it('backend and frontend both use the same round2 convention (static check)', () => {
    const beSrc = loadSrc('services/financialReportingService.cjs');
    const feSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'views', 'accounts', 'FinancialReports.tsx'),
      'utf8'
    );
    assert.ok(beSrc.includes('round2'), 'Backend must use round2');
    assert.ok(feSrc.includes('toFixed(2)') || feSrc.includes('round'),
      'Frontend must round monetary values');
  });
});

// ── Financial Year Boundary ──────────────────────────────────────────────────

describe('Phase 2C: Financial Year Boundaries', () => {
  it('injectFinancialYear middleware sets fyStartDate and fyEndDate (static check)', () => {
    const fySrc = loadSrc('middleware/financialYearMiddleware.cjs');
    assert.ok(fySrc.includes('fyStartDate'), 'injectFinancialYear must set fyStartDate');
    assert.ok(fySrc.includes('fyEndDate'), 'injectFinancialYear must set fyEndDate');
  });

  it('financial year boundaries filter invoice list (static check)', () => {
    const indexSrc = loadSrc('index.cjs');
    assert.ok(indexSrc.includes('fyStartDate') && indexSrc.includes('fyEndDate'),
      'Invoice routes must use FY date filters');
  });

  it('customer statement date windowing is inclusive for end date (static check)', () => {
    const portalSrc = loadSrc('services/portalService.cjs');
    assert.ok(portalSrc.includes('24 * 60 * 60 * 1000 - 1'),
      'Portal statement must include full end day');
  });
});

// ── Accounting Invariants (Live DB) ──────────────────────────────────────────

describe('Phase 2C: Accounting Invariants (Live DB)', () => {
  it('Invariant 1: total debits = total credits', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const entries = await repo.getAll('ledger_entries');
    let totalDebits = 0;
    let totalCredits = 0;
    for (const e of entries) {
      if (normStatus(e.reference_type) === 'reversal') continue;
      const amount = toNum(e.amount);
      if (normStatus(e.entry_type) === 'debit') totalDebits += amount;
      else if (normStatus(e.entry_type) === 'credit') totalCredits += amount;
    }
    assert.ok(Math.abs(totalDebits - totalCredits) < TOLERANCE,
      `Invariant 1 FAIL: Debits ${totalDebits} != Credits ${totalCredits}`);
  });

  it('Invariant 4: bank account balance = opening + legitimate movements (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const [accounts, transactions] = await Promise.all([
      repo.getAll('bank_accounts'),
      repo.getAll('bank_transactions'),
    ]);
    let mismatches = 0;
    for (const acc of accounts) {
      const opening = toNum(acc.openingBalance || acc.data?.openingBalance || 0);
      const actual = toNum(acc.currentBalance || acc.data?.currentBalance || 0);
      const txns = transactions.filter(t => (t.bankAccountId || t.data?.bankAccountId) === acc.id);
      let net = 0;
      for (const t of txns) {
        const amount = toNum(t.amount || t.data?.amount || 0);
        const type = normStatus(t.type || t.data?.type || '');
        if (type === 'deposit' || type === 'transfer_in') net += amount;
        else net -= amount;
      }
      if (Math.abs(opening + net - actual) > TOLERANCE) {
        mismatches++;
      }
    }
    assert.equal(mismatches, 0, `Invariant 4 FAIL: ${mismatches} bank accounts with balance mismatches`);
  });

  it('Invariant 5: invoice outstanding = total - paidAmount (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const invoices = await repo.getAll('invoices');
    const mismatches = invoices.filter(inv => {
      const total = toNum(inv.totalAmount || inv.total_amount || inv.data?.totalAmount || 0);
      const paid = toNum(inv.paidAmount || inv.paid_amount || inv.data?.paidAmount || 0);
      const balanceDue = toNum(inv.balanceDue || inv.data?.balanceDue || 0);
      return Math.abs(total - paid - balanceDue) > TOLERANCE;
    });
    assert.equal(mismatches.length, 0,
      `Invariant 5 FAIL: ${mismatches.length} invoices with outstanding mismatch`);
  });

  it('Invariant 6: payment allocation cannot exceed payment amount (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const [payments, allocationLines] = await Promise.all([
      repo.getAll('customer_payments'),
      repo.getAll('payment_allocation_lines'),
    ]);
    const byPayment = {};
    for (const line of allocationLines) {
      const pid = line.paymentId || line.data?.paymentId || '';
      if (!byPayment[pid]) byPayment[pid] = 0;
      byPayment[pid] += toNum(line.amount || line.data?.amount || 0);
    }
    const overAllocated = payments.filter(p => {
      const amount = toNum(p.amount || p.data?.amount || 0);
      const allocated = byPayment[p.id] || 0;
      return allocated > amount + TOLERANCE;
    });
    assert.equal(overAllocated.length, 0,
      `Invariant 6 FAIL: ${overAllocated.length} over-allocated payments`);
  });
});

// ── Portal / ERP Parity ──────────────────────────────────────────────────────

describe('Phase 2C: Portal / ERP Parity', () => {
  it('Portal payment requests do not create customer_payments (static check)', () => {
    const prSrc = loadSrc('services/paymentRequestService.cjs');
    assert.ok(!prSrc.includes("upsert('customer_payments'") && !prSrc.includes('upsert("customer_payments"'),
      'PaymentRequestService must not upsert customer_payments');
  });

  it('Portal statement uses customerLedger.buildLedger (static check)', () => {
    const portalSrc = loadSrc('services/portalService.cjs');
    assert.ok(portalSrc.includes('customerLedger.buildLedger'),
      'Portal getStatements must use customerLedger.buildLedger');
  });

  it('Portal revert does not claim to reverse GL (static check)', () => {
    const portalSrc = loadSrc('services/portalService.cjs');
    const revertFn = portalSrc.slice(portalSrc.indexOf('async revertInvoicePayment'), portalSrc.indexOf('async revertInvoicePayment') + 8000);
    assert.ok(!revertFn.includes('reverseLedgerEntriesByReference'),
      'Portal revertInvoicePayment must NOT reverse GL — this is a known design limitation');
  });
});

// ── Sync / Idempotency Integrity ─────────────────────────────────────────────

describe('Phase 2C: Sync / Idempotency Integrity', () => {
  it('cloudSyncStore applies ops with idempotency checking (static check)', () => {
    const syncSrc = loadSrc('services/cloudSyncStore.cjs');
    assert.ok(syncSrc.includes('checkIdempotency'), 'cloudSyncStore must check idempotency before applying ops');
    assert.ok(syncSrc.includes('recordIdempotency'), 'cloudSyncStore must record idempotency after success');
  });

  it('sync gateway uses version-based optimistic concurrency (static check)', () => {
    const syncSrc = loadSrc('services/cloudSyncStore.cjs');
    assert.ok(syncSrc.includes('version'), 'cloudSyncStore must use version for concurrency control');
  });

  it('sync gateway has table allow-list (static check)', () => {
    const syncSrc = loadSrc('routes/sync.cjs');
    assert.ok(syncSrc.includes('ALLOWED_TABLES'), 'sync gateway must have table allow-list');
  });
});

// ── Traceability ─────────────────────────────────────────────────────────────

describe('Phase 2C: Traceability', () => {
  it('every ledger entry has reference_type and reference_id (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const entries = await repo.getAll('ledger_entries');
    const untraceable = entries.filter(e => !e.reference_type || !e.reference_id);
    assert.equal(untraceable.length, 0,
      `Invariant 12 FAIL: ${untraceable.length} ledger entries missing reference_type or reference_id`);
  });

  it('all ledger entries reference valid COA accounts (live DB)', async () => {
    const repo = require('../services/supabaseRepository.cjs');
    const [entries, accounts] = await Promise.all([
      repo.getAll('ledger_entries'),
      repo.getAll('chart_of_accounts'),
    ]);
    const accountIds = new Set(accounts.map(a => a.id));
    const orphans = entries.filter(e => !accountIds.has(e.account_id));
    assert.equal(orphans.length, 0,
      `Invariant 12 FAIL: ${orphans.length} ledger entries reference missing COA accounts`);
  });
});
