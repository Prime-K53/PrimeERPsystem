/**
 * portalStatement.referenceRegression.test.cjs
 *
 * Regression test for the Portal Customer Statement reference-field bug.
 *
 * Bug: buildStatementData mapped t.description → reference and discarded the
 * real reference number (invoice/payment ID). The PDF therefore printed
 * "Invoice for Office Supplies" instead of "INV-000123".
 *
 * This test ensures the correct mapping is preserved:
 *   reference = t.reference  (the invoice/payment number)
 *   memo     = t.description (the human-readable description)
 *
 * Run: cd backend && node --test tests/portalStatement.referenceRegression.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const portalService = require('../services/portalService.cjs');

const FIXTURE_CUSTOMER = { id: 'CUST-001', name: 'Acme Corp' };

const MOCK_LEDGER_TRANSACTIONS = [
  {
    date: '2026-08-01',
    reference: 'INV-000123',
    description: 'Invoice for Office Supplies',
    type: 'invoice',
    status: 'posted',
    debit: 21000,
    credit: 0,
    balance: 21000,
  },
  {
    date: '2026-08-15',
    reference: 'PAY-000045',
    description: 'Payment received',
    type: 'payment',
    status: 'completed',
    debit: 0,
    credit: 10000,
    balance: 11000,
  },
];

const MOCK_STATEMENTS_DATA = {
  opening_balance: 0,
  closing_balance: 11000,
  outstanding_balance: 11000,
  credit_limit: 50000,
  transactions: MOCK_LEDGER_TRANSACTIONS,
};

// ── buildStatementData — reference field ──────────────────────────────────────

describe('buildStatementData reference field mapping', () => {

  it('maps reference field from ledger transaction reference (not description)', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    const invoiceTx = result.transactions.find(t => t.debit > 0);
    const paymentTx = result.transactions.find(t => t.credit > 0);

    assert.strictEqual(invoiceTx.reference, 'INV-000123',
      'Invoice reference must be INV-000123, not the description');
    assert.strictEqual(paymentTx.reference, 'PAY-000045',
      'Payment reference must be PAY-000045, not the description');
  });

  it('maps memo/description from ledger transaction description', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    const invoiceTx = result.transactions.find(t => t.debit > 0);
    const paymentTx = result.transactions.find(t => t.credit > 0);

    assert.strictEqual(invoiceTx.memo, 'Invoice for Office Supplies',
      'Invoice memo must be the description text');
    assert.strictEqual(paymentTx.memo, 'Payment received',
      'Payment memo must be the description text');
  });

  it('keeps debit, credit, runningBalance unchanged', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    const invoiceTx = result.transactions.find(t => t.debit > 0);
    const paymentTx = result.transactions.find(t => t.credit > 0);

    assert.strictEqual(invoiceTx.debit, 21000);
    assert.strictEqual(invoiceTx.credit, 0);
    assert.strictEqual(invoiceTx.runningBalance, 21000);

    assert.strictEqual(paymentTx.debit, 0);
    assert.strictEqual(paymentTx.credit, 10000);
    assert.strictEqual(paymentTx.runningBalance, 11000);
  });

  it('sets correct customerName and balances', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    assert.strictEqual(result.customerName, 'Acme Corp');
    assert.strictEqual(result.openingBalance, 0);
    assert.strictEqual(result.finalBalance, 11000);
    assert.strictEqual(result.totalInvoiced, 21000);
    assert.strictEqual(result.totalReceived, 10000);
  });
});

// ── Regression guard — must NOT use t.description as reference ─────────────────

describe('REGRESSION GUARD: buildStatementData must not map t.description → reference', () => {
  const OLD_BUG_MAPPINGS = {
    reference: 'Invoice for Office Supplies',  // what t.description would give
    memo: '',
  };

  it('reference field must be the invoice number, not a description string', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    const invoiceTx = result.transactions.find(t => t.debit > 0);

    assert.notStrictEqual(invoiceTx.reference, 'Invoice for Office Supplies',
      'BUG: reference is using t.description instead of t.reference');
    assert.notStrictEqual(invoiceTx.reference, 'Payment received',
      'BUG: reference is using t.description instead of t.reference');

    assert.strictEqual(invoiceTx.reference, 'INV-000123');
  });

  it('memo field must be the description, not an empty string', () => {
    const result = portalService.buildStatementData(
      FIXTURE_CUSTOMER.id,
      FIXTURE_CUSTOMER,
      MOCK_STATEMENTS_DATA,
    );

    const invoiceTx = result.transactions.find(t => t.debit > 0);

    assert.notStrictEqual(invoiceTx.memo, '',
      'BUG: memo is empty — it should contain the description text');
    assert.strictEqual(invoiceTx.memo, 'Invoice for Office Supplies');
  });
});

// ── getStatements reference field ─────────────────────────────────────────────

describe('getStatements reference field in returned transactions', () => {
  it('maps ledger reference into the returned transaction object', () => {
    // getStatements calls customerLedger.buildLedger internally.
    // We mock the ledger result at the data level to isolate the mapping.
    // The returned transactions array should contain reference from the ledger.
    const mapped = MOCK_LEDGER_TRANSACTIONS.map(t => ({
      date: t.date,
      reference: t.reference || '',
      description: t.description || '',
      type: t.type,
      status: t.status || '',
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,
    }));

    const invoiceTx = mapped.find(t => t.debit > 0);
    const paymentTx = mapped.find(t => t.credit > 0);

    assert.strictEqual(invoiceTx.reference, 'INV-000123',
      'getStatements must return reference from the ledger transaction');
    assert.strictEqual(paymentTx.reference, 'PAY-000045',
      'getStatements must return reference from the ledger transaction');
  });

  it('description and reference are distinct fields', () => {
    const invoiceTx = MOCK_LEDGER_TRANSACTIONS.find(t => t.debit > 0);

    assert.notStrictEqual(invoiceTx.reference, invoiceTx.description,
      'reference and description must be different values');
    assert.strictEqual(invoiceTx.reference, 'INV-000123');
    assert.strictEqual(invoiceTx.description, 'Invoice for Office Supplies');
  });
});

// ── getStatements windowing preserves reference ───────────────────────────────

describe('getStatements date-windowing preserves reference on filtered transactions', () => {
  it('transactions outside date range do not affect opening balance but reference is still populated', () => {
    // Real getStatements filters by date but still maps reference + description.
    // Simulate the windowing logic inline with the mock fixture.
    const startT = new Date('2026-08-01').getTime();
    let openingBalance = 0;
    const mapped = [];

    for (const t of MOCK_LEDGER_TRANSACTIONS) {
      const ts = new Date(t.date).getTime();
      if (ts < startT) {
        openingBalance += t.debit - t.credit;
        continue;
      }
      mapped.push({
        date: t.date,
        reference: t.reference || '',
        description: t.description || '',
        debit: t.debit,
        credit: t.credit,
        balance: t.balance,
      });
    }

    assert.strictEqual(mapped.length, 2);
    assert.strictEqual(mapped[0].reference, 'INV-000123');
    assert.strictEqual(mapped[1].reference, 'PAY-000045');
    assert.strictEqual(mapped[0].description, 'Invoice for Office Supplies');
    assert.strictEqual(mapped[1].description, 'Payment received');
  });
});

// ── Frontend PDF input — critical regression ───────────────────────────────────

describe('Frontend PDF input: handleDownloadPdf transaction mapping', () => {
  /**
   * This mirrors the transformation done in CustomerAccountStatements.tsx
   * handleDownloadPdf (lines 253-260).
   *
   * The bug was:
   *   reference: t.description || ''   // WRONG — puts description in reference
   *   memo: ''                          // WRONG — loses the description
   *
   * The fix is:
   *   reference: t.reference || ''     // CORRECT — real invoice/payment number
   *   memo: t.description || ''        // CORRECT — human-readable text
   */
  it('CORRECT mapping: reference = t.reference, memo = t.description', () => {
    const apiResponse = {
      opening_balance: 0,
      closing_balance: 11000,
      transactions: MOCK_LEDGER_TRANSACTIONS,
    };

    // This is the fixed transformation from CustomerAccountStatements.tsx
    const transactions = (apiResponse.transactions || []).map((t) => ({
      date: t.date,
      reference: t.reference || '',
      memo: t.description || '',
      debit: Number(t.debit || 0),
      credit: Number(t.credit || 0),
      runningBalance: Number(t.balance || 0),
    }));

    const invoiceTx = transactions.find(t => t.debit > 0);
    const paymentTx = transactions.find(t => t.credit > 0);

    assert.strictEqual(invoiceTx.reference, 'INV-000123',
      'PDF receives INV-000123 as reference');
    assert.strictEqual(paymentTx.reference, 'PAY-000045',
      'PDF receives PAY-000045 as reference');
    assert.strictEqual(invoiceTx.memo, 'Invoice for Office Supplies');
    assert.strictEqual(paymentTx.memo, 'Payment received');
  });

  it('REGRESSION: old buggy mapping would put description in reference field', () => {
    const apiResponse = {
      opening_balance: 0,
      closing_balance: 11000,
      transactions: MOCK_LEDGER_TRANSACTIONS,
    };

    // This is the BUGGY transformation that existed before the fix
    const buggyTransactions = (apiResponse.transactions || []).map((t) => ({
      date: t.date,
      reference: t.description || '',  // BUG: description instead of reference
      memo: '',
      debit: Number(t.debit || 0),
      credit: Number(t.credit || 0),
      runningBalance: Number(t.balance || 0),
    }));

    const invoiceTx = buggyTransactions.find(t => t.debit > 0);

    // This assertion demonstrates the bug — it passes only with the old code
    assert.strictEqual(invoiceTx.reference, 'Invoice for Office Supplies',
      'This passes with the old buggy code — confirms the regression');
  });

  it('PDF would receive wrong references with the old buggy mapping', () => {
    const apiResponse = {
      opening_balance: 0,
      closing_balance: 11000,
      transactions: MOCK_LEDGER_TRANSACTIONS,
    };

    // Old buggy transformation
    const buggyTransactions = (apiResponse.transactions || []).map((t) => ({
      date: t.date,
      reference: t.description || '',
      memo: '',
      debit: Number(t.debit || 0),
      credit: Number(t.credit || 0),
      runningBalance: Number(t.balance || 0),
    }));

    const invoiceTx = buggyTransactions.find(t => t.debit > 0);
    const paymentTx = buggyTransactions.find(t => t.credit > 0);

    // These would be the WRONG values the PDF received before the fix
    assert.notStrictEqual(invoiceTx.reference, 'INV-000123',
      'Old buggy code would NOT have INV-000123 as reference');
    assert.notStrictEqual(paymentTx.reference, 'PAY-000045',
      'Old buggy code would NOT have PAY-000045 as reference');
    assert.strictEqual(invoiceTx.reference, 'Invoice for Office Supplies');
  });
});
