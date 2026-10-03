/**
 * officialDocumentRendererAliases.test.cjs
 *
 * The public verification registry resolves the STORED ERP record
 * (statement_snapshots / customer_payments envelopes), while the canonical
 * renderer validates canonical document field names. normalizeRecordForRenderer
 * is the single naming bridge between the two.
 *
 * These tests pin the bridge for the stored statement snapshot and the stored
 * customer receipt, and pin its two invariants: it only fills MISSING
 * canonical keys and it never mutates the record it was given.
 */
const { normalizeRecordForRenderer, toCanonicalRendererType } = require('../services/officialDocumentService.cjs');

const statementSnapshot = () => ({
  id: 'STMT-P726/021',
  statementNumber: 'STMT-P726/021',
  statementDate: '2026-10-03',
  periodStart: '2026-01-01',
  periodEnd: '2026-10-03',
  customerId: 'CUST-9',
  customerName: 'Mlunduni Primary School',
  currency: 'MWK',
  openingBalance: 0,
  transactions: [{ date: '2026-10-01', reference: 'INV-P726/093', debit: 65000, credit: 0, runningBalance: 65000 }],
  totalInvoiced: 65000,
  totalReceived: 0,
  closingBalance: 65000,
  status: 'VALID',
  verificationToken: 'f'.repeat(64),
});

describe('normalizeRecordForRenderer — statement snapshot to ACCOUNT_STATEMENT contract', () => {
  it('maps the public statement slug to the canonical renderer type', () => {
    expect(toCanonicalRendererType('statement')).toBe('ACCOUNT_STATEMENT');
    expect(toCanonicalRendererType('receipt')).toBe('RECEIPT');
  });

  it('fills the canonical statement fields the renderer requires', () => {
    const record = normalizeRecordForRenderer(statementSnapshot(), 'ACCOUNT_STATEMENT');
    expect(record.startDate).toBe('2026-01-01');
    expect(record.endDate).toBe('2026-10-03');
    expect(record.openingBalance).toBe(0);
    // The frozen snapshot persists the closing total as closingBalance; the
    // renderer's closing-balance field is finalBalance.
    expect(record.finalBalance).toBe(65000);
    expect(record.customerName).toBe('Mlunduni Primary School');
    expect(record.date).toBe('2026-10-03');
    expect(Array.isArray(record.transactions)).toBe(true);
    expect(record.transactions).toHaveLength(1);
  });

  it('keeps the verification identity the QR payload is built from', () => {
    const record = normalizeRecordForRenderer(statementSnapshot(), 'ACCOUNT_STATEMENT');
    expect(record.statementNumber).toBe('STMT-P726/021');
    expect(record.verificationToken).toBe('f'.repeat(64));
  });

  it('never overwrites an already canonical field', () => {
    const record = normalizeRecordForRenderer({
      ...statementSnapshot(),
      startDate: '2026-02-01',
      endDate: '2026-09-30',
      finalBalance: 999,
    }, 'ACCOUNT_STATEMENT');
    expect(record.startDate).toBe('2026-02-01');
    expect(record.endDate).toBe('2026-09-30');
    expect(record.finalBalance).toBe(999);
  });

  it('does not mutate the stored record', () => {
    const stored = statementSnapshot();
    normalizeRecordForRenderer(stored, 'ACCOUNT_STATEMENT');
    expect(stored.startDate).toBeUndefined();
    expect(stored.finalBalance).toBeUndefined();
  });

  it('leaves invoice records untouched by the statement aliases', () => {
    const invoice = { id: 'INV-P726/093', invoiceNumber: 'INV-P726/093', date: '2026-09-01', closingBalance: 5 };
    const record = normalizeRecordForRenderer(invoice, 'INVOICE');
    expect(record.startDate).toBeUndefined();
    expect(record.finalBalance).toBeUndefined();
    expect(record.invoiceNumber).toBe('INV-P726/093');
  });
});

describe('normalizeRecordForRenderer — customer receipt to RECEIPT contract', () => {
  it('uses the payment record id as the official receipt number', () => {
    const record = normalizeRecordForRenderer({
      id: 'PAY-P726/021',
      date: '2026-09-03',
      customerName: 'Acme School',
      amount: 70000,
      paymentMethod: 'Bank',
      verificationToken: 'a'.repeat(64),
    }, 'RECEIPT');
    expect(record.receiptNumber).toBe('PAY-P726/021');
    expect(record.customerName).toBe('Acme School');
    expect(record.paymentMethod).toBe('Bank');
    expect(record.amountReceived).toBe(70000);
  });

  it('never replaces an explicit receipt number', () => {
    const record = normalizeRecordForRenderer({ id: 'PAY-1', receiptNumber: 'RCT-9', customerName: 'X', paymentMethod: 'Cash', amount: 5 }, 'RECEIPT');
    expect(record.receiptNumber).toBe('RCT-9');
  });

  it('does not stamp a receipt number onto non-receipt documents', () => {
    const record = normalizeRecordForRenderer({ id: 'INV-1' }, 'INVOICE');
    expect(record.receiptNumber).toBeUndefined();
    expect(record.amountReceived).toBeUndefined();
  });
});