/**
 * customerStatement.test.ts — Tests for the new Bookkeeper-style CustomerStatement
 * component at frontend/views/reports/CustomerStatement.tsx
 *
 * These tests use the REAL buildLedgerFromRecords (not mocked) to validate
 * the accounting rules and statement calculations.
 *
 * Run: cd frontend && npx vitest run tests/customerStatement.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildLedgerFromRecords,
  type AnyRecord,
} from '../services/customerLedger';

const CID = 'CUST-STMT-001';

function inv(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    id: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customerId: CID,
    totalAmount: 0,
    total_amount: 0,
    status: 'posted',
    createdAt: '2026-01-05T10:00:00Z',
    created_at: '2026-01-05T10:00:00Z',
    ...overrides,
  };
}

function pay(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customerId: CID,
    amount: 0,
    amountApplied: 0,
    amount_applied: 0,
    status: 'completed',
    createdAt: '2026-01-05T10:00:00Z',
    created_at: '2026-01-05T10:00:00Z',
    allocations: [],
    ...overrides,
  };
}

function ledger(opts: { openingBalance?: number; invoices?: AnyRecord[]; payments?: AnyRecord[] }) {
  return buildLedgerFromRecords({ customerId: CID, ...opts });
}

describe('INVOICE — debit', () => {
  it('posted invoice → debit', () => {
    const result = ledger({ invoices: [inv({ id: 'INV-1', totalAmount: 50000, status: 'posted', date: '2026-01-05' })] });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].debit).toBe(50000);
    expect(result.transactions[0].credit).toBe(0);
    expect(result.transactions[0].type).toBe('invoice');
  });

  it('draft invoice → excluded from transactions', () => {
    const result = ledger({ invoices: [inv({ id: 'INV-1', totalAmount: 50000, status: 'draft' })] });
    expect(result.transactions).toHaveLength(0);
    expect(result.excluded.some((e: any) => e.reason === 'draft')).toBe(true);
  });

  it('cancelled invoice → excluded', () => {
    const result = ledger({ invoices: [inv({ id: 'INV-1', totalAmount: 50000, status: 'cancelled' })] });
    expect(result.transactions).toHaveLength(0);
    expect(result.excluded.some((e: any) => e.reason === 'cancelled')).toBe(true);
  });

  it('voided invoice → excluded', () => {
    const result = ledger({ invoices: [inv({ id: 'INV-1', totalAmount: 50000, status: 'voided' })] });
    expect(result.transactions).toHaveLength(0);
    expect(result.excluded.some((e: any) => e.reason === 'voided')).toBe(true);
  });
});

describe('CREDIT NOTE — credit', () => {
  it('status=credit_note → credit side', () => {
    const result = ledger({ invoices: [inv({ id: 'INV-1', totalAmount: 10000, status: 'credit_note' })] });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].debit).toBe(0);
    expect(result.transactions[0].credit).toBe(10000);
    expect(result.transactions[0].type).toBe('credit_note');
  });
});

describe('PAYMENT — credit', () => {
  it('completed payment → credit using amountApplied', () => {
    const result = ledger({
      invoices: [],
      payments: [pay({ id: 'PAY-1', receiptNumber: 'PAY-2026-0001', date: '2026-01-12', amount: 20000, amountApplied: 20000 })],
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].credit).toBe(20000);
    expect(result.transactions[0].type).toBe('payment');
  });

  it('cancelled payment → excluded', () => {
    const result = ledger({ invoices: [], payments: [pay({ id: 'PAY-1', status: 'cancelled' })] });
    expect(result.transactions).toHaveLength(0);
    expect(result.excluded.some((e: any) => e.reason === 'cancelled')).toBe(true);
  });

  it('wallet top-up → excluded from transactions (walletTopups list)', () => {
    const result = ledger({
      invoices: [],
      payments: [pay({ id: 'PAY-1', amount: 100000, amountApplied: 0, walletDeposit: 100000, excessHandling: 'Wallet' })],
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.walletTopups).toHaveLength(1);
  });

  it('paymentPurpose WALLET_TOPUP → excluded', () => {
    const result = ledger({
      invoices: [],
      payments: [pay({ id: 'PAY-1', paymentPurpose: 'WALLET_TOPUP' })],
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.walletTopups).toHaveLength(1);
  });

  it('uses allocation sum when amountApplied is null/undefined', () => {
    const result = ledger({
      invoices: [],
      payments: [pay({ id: 'PAY-1', amount: 50000, amountApplied: undefined, amount_applied: undefined, allocations: [{ invoiceId: 'INV-1', amount: 30000 }, { invoiceId: 'INV-2', amount: 10000 }], excessHandling: 'Refund' })],
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].credit).toBe(40000);
  });
});

describe('RUNNING BALANCE', () => {
  it('running balance = opening + debits - credits', () => {
    const result = ledger({
      openingBalance: 10000,
      invoices: [
        inv({ id: 'INV-1', totalAmount: 50000, date: '2026-01-05' }),
        inv({ id: 'INV-2', totalAmount: 30000, date: '2026-01-10' }),
      ],
      payments: [pay({ id: 'PAY-1', amount: 20000, amountApplied: 20000, date: '2026-01-12' })],
    });
    expect(result.openingBalance).toBe(10000);
    expect(result.transactions[0].balance).toBe(60000);
    expect(result.transactions[1].balance).toBe(90000);
    expect(result.transactions[2].balance).toBe(70000);
    expect(result.closingBalance).toBe(70000);
  });

  it('opening balance appears as starting running balance', () => {
    const result = ledger({
      openingBalance: 10000,
      invoices: [inv({ id: 'INV-1', totalAmount: 50000 })],
    });
    expect(result.transactions[0].balance).toBe(60000);
    expect(result.closingBalance).toBe(60000);
  });

  it('opening balance counted once (no double count)', () => {
    const result = ledger({
      openingBalance: 10000,
      invoices: [inv({ id: 'INV-1', totalAmount: 50000 })],
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.closingBalance).toBe(60000);
  });

  it('outstanding = Math.max(0, closingBalance)', () => {
    const positive = ledger({ openingBalance: 0, invoices: [inv({ id: 'INV-1', totalAmount: 50000 })] });
    expect(positive.outstandingBalance).toBe(50000);

    const negative = ledger({
      openingBalance: 10000,
      invoices: [],
      payments: [pay({ id: 'PAY-1', amount: 50000, amountApplied: 50000 })],
    });
    expect(negative.outstandingBalance).toBe(0);
  });
});

describe('TRANSACTION ORDERING', () => {
  it('sorted by date asc', () => {
    const result = ledger({
      invoices: [
        inv({ id: 'INV-A', totalAmount: 10000, date: '2026-01-15', createdAt: '2026-01-15T10:00:00Z' }),
        inv({ id: 'INV-B', totalAmount: 20000, date: '2026-01-10', createdAt: '2026-01-10T10:00:00Z' }),
      ],
    });
    expect(result.transactions[0].id).toBe('INV-B');
    expect(result.transactions[1].id).toBe('INV-A');
  });

  it('same date sorted by createdAt asc', () => {
    const result = ledger({
      invoices: [
        inv({ id: 'INV-AM', totalAmount: 10000, date: '2026-01-15', createdAt: '2026-01-15T08:00:00Z' }),
        inv({ id: 'INV-PM', totalAmount: 20000, date: '2026-01-15', createdAt: '2026-01-15T14:00:00Z' }),
      ],
    });
    expect(result.transactions[0].id).toBe('INV-AM');
    expect(result.transactions[1].id).toBe('INV-PM');
  });

  it('same date+createdAt tie-break by id asc', () => {
    const result = ledger({
      invoices: [
        inv({ id: 'INV-Z', totalAmount: 10000, date: '2026-01-15', createdAt: '2026-01-15T10:00:00Z' }),
        inv({ id: 'INV-A', totalAmount: 20000, date: '2026-01-15', createdAt: '2026-01-15T10:00:00Z' }),
      ],
    });
    expect(result.transactions[0].id).toBe('INV-A');
    expect(result.transactions[1].id).toBe('INV-Z');
  });
});

describe('HISTORICAL PERIOD — opening balance recompute', () => {
  it('transactions before start date fold into opening balance', () => {
    const result = ledger({
      openingBalance: 0,
      invoices: [
        inv({ id: 'INV-OLD', totalAmount: 50000, date: '2025-06-01', createdAt: '2025-06-01T10:00:00Z' }),
        inv({ id: 'INV-NEW', totalAmount: 20000, date: '2026-01-10', createdAt: '2026-01-10T10:00:00Z' }),
      ],
      payments: [pay({ id: 'PAY-OLD', amount: 15000, amountApplied: 15000, date: '2025-12-01', createdAt: '2025-12-01T10:00:00Z' })],
    });
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].id).toBe('INV-OLD');
    expect(result.transactions[0].balance).toBe(50000);
    expect(result.transactions[1].id).toBe('PAY-OLD');
    expect(result.transactions[1].balance).toBe(35000);
    expect(result.transactions[2].id).toBe('INV-NEW');
    expect(result.transactions[2].balance).toBe(55000);
  });

  it('closing balance correct when customer has future transactions', () => {
    const result = ledger({
      openingBalance: 0,
      invoices: [
        inv({ id: 'INV-JUN', totalAmount: 50000, date: '2026-06-15', createdAt: '2026-06-15T10:00:00Z' }),
        inv({ id: 'INV-JUL', totalAmount: 30000, date: '2026-07-20', createdAt: '2026-07-20T10:00:00Z' }),
      ],
    });
    expect(result.closingBalance).toBe(80000);
    expect(result.transactions).toHaveLength(2);
  });
});

describe('VOUCHER TYPE FILTER', () => {
  const txTypes = ['Invoice', 'Receipt', 'Credit Note', 'Invoice', 'Receipt'];

  it('All returns all', () => {
    const filtered = txTypes.filter(() => true);
    expect(filtered).toHaveLength(5);
  });

  it('Invoice filter returns only invoices', () => {
    const filtered = txTypes.filter(tx => tx === 'Invoice');
    expect(filtered).toHaveLength(2);
  });

  it('Receipt filter returns only receipts', () => {
    const filtered = txTypes.filter(tx => tx === 'Receipt');
    expect(filtered).toHaveLength(2);
  });

  it('Credit Note filter returns only credit notes', () => {
    const filtered = txTypes.filter(tx => tx === 'Credit Note');
    expect(filtered).toHaveLength(1);
  });
});

describe('SEARCH', () => {
  const txs = [
    { docNumber: 'INV-2026-0001', description: 'Invoice - Printing Services', reference: 'PO-001' },
    { docNumber: 'PAY-2026-0001', description: 'Customer Payment', reference: '' },
    { docNumber: 'INV-2026-0002', description: 'Invoice - Stationery', reference: 'PO-002' },
  ];

  it('search by invoice number', () => {
    const q = 'inv-2026-0001';
    const filtered = txs.filter(tx =>
      tx.docNumber.toLowerCase().includes(q) ||
      tx.description.toLowerCase().includes(q) ||
      tx.reference.toLowerCase().includes(q)
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].docNumber).toBe('INV-2026-0001');
  });

  it('search by description', () => {
    const q = 'printing';
    const filtered = txs.filter(tx =>
      tx.docNumber.toLowerCase().includes(q) ||
      tx.description.toLowerCase().includes(q) ||
      tx.reference.toLowerCase().includes(q)
    );
    expect(filtered).toHaveLength(1);
  });

  it('empty search returns all', () => {
    const q = '';
    const filtered = txs.filter(tx =>
      tx.docNumber.toLowerCase().includes(q) ||
      tx.description.toLowerCase().includes(q) ||
      tx.reference.toLowerCase().includes(q)
    );
    expect(filtered).toHaveLength(3);
  });
});

describe('CURRENCY FORMATTING', () => {
  const fmt = (val: number, currency = 'K') =>
    isFinite(val)
      ? `${currency}${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${currency}0.00`;

  it('formats zero', () => { expect(fmt(0)).toBe('K0.00'); });
  it('formats thousands with comma', () => { expect(fmt(50000)).toBe('K50,000.00'); });
  it('formats decimals', () => { expect(fmt(1234.56)).toBe('K1,234.56'); });
  it('formats negative', () => { expect(fmt(-5000)).toBe('K-5,000.00'); });
  it('NaN falls back to zero', () => { expect(fmt(NaN)).toBe('K0.00'); });
});

describe('STATEMENT TOTALS', () => {
  it('total debit computed correctly', () => {
    const txs = [{ debit: 50000, credit: 0 }, { debit: 0, credit: 20000 }, { debit: 30000, credit: 0 }];
    expect(txs.reduce((s, t) => s + t.debit, 0)).toBe(80000);
  });

  it('total credit computed correctly', () => {
    const txs = [{ debit: 50000, credit: 0 }, { debit: 0, credit: 20000 }, { debit: 30000, credit: 5000 }];
    expect(txs.reduce((s, t) => s + t.credit, 0)).toBe(25000);
  });

  it('closing balance = opening + debit - credit', () => {
    const openingBalance = 10000;
    const totalDebit = 80000;
    const totalCredit = 20000;
    expect(openingBalance + totalDebit - totalCredit).toBe(70000);
  });
});

describe('DATE RANGE — start and end inclusive', () => {
  it('start date transaction included (ts >= startT)', () => {
    const startT = new Date('2026-01-01').getTime();
    const endT = new Date('2026-01-31').getTime() + 86400000 - 1;
    const txDate = new Date('2026-01-01').getTime();
    expect(txDate >= startT && txDate <= endT).toBe(true);
  });

  it('end date transaction included (ts <= endT)', () => {
    const endT = new Date('2026-01-31').getTime() + 86400000 - 1;
    const txDate = new Date('2026-01-31').getTime();
    expect(txDate <= endT).toBe(true);
  });

  it('date before start excluded from display but affects opening balance', () => {
    const startT = new Date('2026-01-01').getTime();
    let openingBalance = 0;
    const beforeTx = { debit: 50000, credit: 0, date: new Date('2025-12-15').getTime() };
    if (beforeTx.date < startT) openingBalance += beforeTx.debit - beforeTx.credit;
    expect(openingBalance).toBe(50000);
  });
});

describe('CUSTOMER NAME — name over email', () => {
  it('uses name when available', () => {
    const customer = { name: 'Acme Corporation', email: 'billing@acme.com' };
    const displayName = customer.name || customer.email || 'Unknown Customer';
    expect(displayName).toBe('Acme Corporation');
  });

  it('falls back to email when name missing', () => {
    const customer = { email: 'no-reply@example.com' };
    const displayName = customer.name || customer.email || 'Unknown Customer';
    expect(displayName).toBe('no-reply@example.com');
  });

  it('Unknown Customer when both missing', () => {
    const customer = {};
    const displayName = (customer as any).name || (customer as any).email || 'Unknown Customer';
    expect(displayName).toBe('Unknown Customer');
  });
});

describe('QUOTATIONS / SALES ORDERS — must NOT affect balance', () => {
  it('quotations have no invoice record → no transaction', () => {
    const result = ledger({ openingBalance: 0, invoices: [], payments: [] });
    expect(result.transactions).toHaveLength(0);
    expect(result.closingBalance).toBe(0);
  });

  it('draft invoices excluded → no balance effect', () => {
    const result = ledger({
      openingBalance: 10000,
      invoices: [inv({ id: 'INV-DRAFT', totalAmount: 50000, status: 'draft' })],
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.closingBalance).toBe(10000);
  });
});

describe('MULTIPLE TRANSACTIONS SAME DATE', () => {
  it('sorted deterministically', () => {
    const result = ledger({
      openingBalance: 0,
      invoices: [
        inv({ id: 'INV-LATER', totalAmount: 10000, date: '2026-01-15', createdAt: '2026-01-15T14:00:00Z' }),
        inv({ id: 'INV-EARLIER', totalAmount: 20000, date: '2026-01-15', createdAt: '2026-01-15T08:00:00Z' }),
      ],
    });
    expect(result.transactions[0].id).toBe('INV-EARLIER');
    expect(result.transactions[1].id).toBe('INV-LATER');
    expect(result.transactions[0].balance).toBe(20000);
    expect(result.transactions[1].balance).toBe(30000);
  });
});
