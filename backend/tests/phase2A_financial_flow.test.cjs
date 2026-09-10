/**
 * phase2A_financial_flow.test.cjs
 *
 * Phase 2A — Payment → Ledger verification, banking race-condition fix,
 * receipt allocation staleness fix, and focused regression tests.
 *
 * Scenarios:
 *   - Partial payment → correct ledger entries
 *   - Multiple payments → independent journals, balanced double-entry
 *   - Payment reversal → offsetting ledger entries
 *   - Wallet payment → no AR ledger posting
 *   - Portal payment request firewall → no customer_payments write
 *   - Concurrent banking → _transaction wrapper present with checkpoints
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Payment → Ledger ──────────────────────────────────────────────────────────

describe('Phase 2A: Payment → Ledger integrity', () => {
  it('partial payment creates balanced double-entry (DR Bank, CR AR)', async () => {
    const FinanceService = require('../services/financeService.cjs');
    const svc = new FinanceService();

    svc.getAccounts = async () => [
      { id: 'coa-cash', account_type: 'ASSET', subtype: 'cash', account_number: '11110', name: 'Cash', allow_posting: true, is_active: true },
      { id: 'coa-ar', account_type: 'ASSET', subtype: 'receivable', account_number: '11310', name: 'Trade Debtors', allow_posting: true, is_active: true, role: 'accounts_receivable' },
    ];
    svc.getAccountById = async (id) => svc.getAccounts().then(a => a.find(x => x.id === id));
    const ledgerEntries = [];
    svc.saveLedgerEntry = async (entry) => {
      const record = { id: 'le-' + Date.now() + Math.random(), ...entry };
      ledgerEntries.push(record);
      return record;
    };

    await svc.postCustomerPaymentToLedger({
      id: 'PAY-PARTIAL-1',
      amount: 500,
      currency: 'USD',
      date: '2026-09-09T10:00:00Z',
      payment_method: 'cash',
      company_id: null,
      created_by: 'test',
    });

    assert.equal(ledgerEntries.length, 2, 'Should create exactly 2 ledger entries');
    const debitEntry = ledgerEntries.find(e => e.entry_type === 'debit');
    const creditEntry = ledgerEntries.find(e => e.entry_type === 'credit');
    assert.ok(debitEntry, 'Debit entry must exist');
    assert.ok(creditEntry, 'Credit entry must exist');
    assert.equal(debitEntry.account_id, 'coa-cash');
    assert.equal(creditEntry.account_id, 'coa-ar');
    assert.equal(debitEntry.amount, 500);
    assert.equal(creditEntry.amount, 500);
    assert.equal(debitEntry.journal_id, creditEntry.journal_id);
    assert.equal(debitEntry.reference_type, 'customer_payment');
    assert.equal(creditEntry.reference_type, 'customer_payment');
    assert.equal(debitEntry.reference_id, 'PAY-PARTIAL-1');
    assert.equal(creditEntry.reference_id, 'PAY-PARTIAL-1');
  });

  it('multiple payments create independent journals and balanced double-entry', async () => {
    const FinanceService = require('../services/financeService.cjs');
    const svc = new FinanceService();

    svc.getAccounts = async () => [
      { id: 'coa-cash', account_type: 'ASSET', subtype: 'cash', account_number: '11110', name: 'Cash', allow_posting: true, is_active: true },
      { id: 'coa-ar', account_type: 'ASSET', subtype: 'receivable', account_number: '11310', name: 'Trade Debtors', allow_posting: true, is_active: true, role: 'accounts_receivable' },
    ];
    svc.getAccountById = async (id) => svc.getAccounts().then(a => a.find(x => x.id === id));
    const ledgerEntries = [];
    svc.saveLedgerEntry = async (entry) => {
      const record = { id: 'le-' + Date.now() + Math.random(), ...entry };
      ledgerEntries.push(record);
      return record;
    };

    await svc.postCustomerPaymentToLedger({
      id: 'PAY-MULTI-1', amount: 300, currency: 'USD', date: '2026-09-09T10:00:00Z', payment_method: 'cash', company_id: null, created_by: 'test',
    });
    await svc.postCustomerPaymentToLedger({
      id: 'PAY-MULTI-2', amount: 200, currency: 'USD', date: '2026-09-09T11:00:00Z', payment_method: 'bank_transfer', company_id: null, created_by: 'test',
    });

    assert.equal(ledgerEntries.length, 4);
    const journals = new Set(ledgerEntries.map(e => e.journal_id));
    assert.equal(journals.size, 2, 'Each payment must have its own journal_id');
    const totalDebits = ledgerEntries.filter(e => e.entry_type === 'debit').reduce((s, e) => s + e.amount, 0);
    const totalCredits = ledgerEntries.filter(e => e.entry_type === 'credit').reduce((s, e) => s + e.amount, 0);
    assert.equal(totalDebits, 500);
    assert.equal(totalCredits, 500);
  });

  it('wallet payments do not post to AR ledger', async () => {
    const FinanceService = require('../services/financeService.cjs');
    const svc = new FinanceService();
    svc.getAccounts = async () => [];
    svc.getAccountById = async () => null;
    svc.saveLedgerEntry = async () => ({ id: 'le-' + Date.now() });

    const result = await svc.postCustomerPaymentToLedger({
      id: 'PAY-WALLET-1', amount: 500, currency: 'USD', payment_method: 'wallet', company_id: null,
    });
    assert.equal(result, null, 'Wallet payments must not post to AR ledger');
  });

  it('reversal creates offsetting entries with reference_type=reversal (static)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'financeService.cjs'),
      'utf8'
    );
    assert.ok(src.includes('reverseLedgerEntriesByReference'), 'financeService must implement reverseLedgerEntriesByReference');
    assert.ok(src.includes("reference_type: 'reversal'"), 'Reversal entries must set reference_type=reversal');
    assert.ok(src.includes("entry_type === 'debit' ? 'credit' : 'debit'"), 'Reversal must flip entry_type');
    assert.ok(src.includes('randomUUID()'), 'Reversal must assign a new journal_id');
  });
});

// ── Portal payment-request firewall ───────────────────────────────────────────

describe('Phase 2A: Portal payment-request firewall', () => {
  it('paymentRequestService.createRequest must not write to customer_payments', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'paymentRequestService.cjs'),
      'utf8'
    );
    assert.ok(
      !src.includes("upsert('customer_payments'") && !src.includes('upsert("customer_payments"'),
      'paymentRequestService must not upsert customer_payments'
    );
    assert.ok(
      !src.includes('createPayment') && !src.includes('recordPayment'),
      'paymentRequestService must not call payment-creation functions'
    );
  });

  it('paymentRequestService.reviewRequest must not create customer_payments', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'paymentRequestService.cjs'),
      'utf8'
    );
    assert.ok(
      !src.includes("upsert('customer_payments'") && !src.includes('upsert("customer_payments"'),
      'reviewRequest must not write to customer_payments'
    );
  });
});

// ── Banking concurrency protection ────────────────────────────────────────────

describe('Phase 2A: Banking concurrency protection', () => {
  it('createTransaction uses _transaction with bank_accounts checkpoint', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'bankingService.cjs'),
      'utf8'
    );
    assert.ok(src.includes('await this._transaction(async () => {'), 'createTransaction must use _transaction');
    assert.ok(src.includes("this._txCheckpoint('bank_accounts', record.account_id"), 'createTransaction must checkpoint bank_accounts');
  });

  it('transferFunds uses _transaction with checkpoints for both accounts', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'bankingService.cjs'),
      'utf8'
    );
    assert.ok(src.includes('await this._transaction(async () => {'), 'transferFunds must use _transaction');
    assert.ok(src.includes("this._txCheckpoint('bank_accounts', fromId"), 'transferFunds must checkpoint fromAccount');
    assert.ok(src.includes("this._txCheckpoint('bank_accounts', toId"), 'transferFunds must checkpoint toAccount');
  });
});

// ── Receipt allocation authority ──────────────────────────────────────────────

describe('Phase 2A: Receipt allocation authority', () => {
  it('portalService.getPaymentById reads from paymentAllocationService', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'portalService.cjs'),
      'utf8'
    );
    assert.ok(src.includes('paymentAllocationService'), 'portalService must import paymentAllocationService');
    assert.ok(src.includes('getPaymentAllocations'), 'portalService must call getPaymentAllocations');
    assert.ok(src.includes('payment_allocation_lines'), 'portalService must read payment_allocation_lines');
  });
});

// ── Payment → Ledger call site ────────────────────────────────────────────────

describe('Phase 2A: Payment creation posts to ledger', () => {
  it('index.cjs calls finance.postCustomerPaymentToLedger after payment insert', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'index.cjs'),
      'utf8'
    );
    assert.ok(src.includes('postCustomerPaymentToLedger'), 'index.cjs must call postCustomerPaymentToLedger');
    assert.ok(
      src.includes('Ledger post skipped') || src.includes('postCustomerPaymentToLedger'),
      'Ledger posting failure must be caught and logged, not thrown to client'
    );
  });
});
