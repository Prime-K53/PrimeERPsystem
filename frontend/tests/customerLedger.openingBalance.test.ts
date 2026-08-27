/**
 * customerLedger.openingBalance.test.ts — Opening vs Outstanding balance
 * correctness. Proves:
 *   - The opening balance lives on `customer.balance` and is the single
 *     source of truth for "where the customer began".
 *   - The ledger includes the opening balance exactly once (no double count).
 *   - Outstanding = opening + invoices/debits − payments − credit notes.
 *   - Canonical offline-first service (buildCustomerLedger / getCustomerBalance
 *     / getCustomerOutstanding) reads the opening balance from the local
 *     customer record when no override is supplied.
 *
 * Run: cd frontend && npx vitest run tests/customerLedger.openingBalance.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { get: vi.fn(), getAll: vi.fn() },
}));

vi.mock('../services/db', () => ({ dbService: mockDb }));

import {
  buildLedgerFromRecords,
  getCustomerOpeningBalance,
  buildCustomerLedger,
  getCustomerBalance,
  getCustomerOutstanding,
  type AnyRecord,
} from '../services/customerLedger';

const CID = 'CUST-OPEN-001';

function inv(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    id: `INV-${Math.random().toString(36).slice(2, 7)}`,
    customerId: CID,
    totalAmount: 0,
    total_amount: 0,
    status: 'posted',
    createdAt: '2026-08-22T10:00:00Z',
    created_at: '2026-08-22T10:00:00Z',
    ...overrides,
  };
}

function pay(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    id: `PAY-${Math.random().toString(36).slice(2, 7)}`,
    customerId: CID,
    amount: 0,
    amountApplied: 0,
    amount_applied: 0,
    status: 'completed',
    createdAt: '2026-08-22T12:00:00Z',
    created_at: '2026-08-22T12:00:00Z',
    allocations: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockDb.get.mockReset();
  mockDb.getAll.mockReset();
  mockDb.getAll.mockResolvedValue([]);
  mockDb.get.mockResolvedValue({ id: CID, balance: 0 });
});

// ── Opening balance source of truth ─────────────────────────────────────────

describe('getCustomerOpeningBalance', () => {
  it('returns the stored customer.balance', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 7500 });
    expect(await getCustomerOpeningBalance(CID)).toBe(7500);
  });

  it('returns 0 when the customer record is missing', async () => {
    mockDb.get.mockResolvedValue(undefined);
    expect(await getCustomerOpeningBalance(CID)).toBe(0);
  });

  it('returns 0 when the store read throws', async () => {
    mockDb.get.mockRejectedValue(new Error('offline'));
    expect(await getCustomerOpeningBalance(CID)).toBe(0);
  });
});

// ── Pure ledger includes opening balance exactly once ──────────────────────

describe('buildLedgerFromRecords opening balance', () => {
  it('opening appears as the starting running balance', () => {
    const result = buildLedgerFromRecords({
      customerId: CID,
      invoices: [inv({ id: 'INV-1', totalAmount: 50000, total_amount: 50000 })],
      payments: [],
      openingBalance: 10000,
    });
    expect(result.openingBalance).toBe(10000);
    expect(result.transactions[0].balance).toBe(60000);
    expect(result.closingBalance).toBe(60000);
    expect(result.outstandingBalance).toBe(60000);
  });

  it('does NOT add opening again when transactions are present (no double count)', () => {
    const result = buildLedgerFromRecords({
      customerId: CID,
      invoices: [inv({ id: 'INV-1', totalAmount: 50000, total_amount: 50000 })],
      payments: [],
      openingBalance: 10000,
    });
    // One invoice only → exactly one transaction; opening counted once.
    expect(result.transactions).toHaveLength(1);
    expect(result.closingBalance).toBe(10000 + 50000);
  });
});

// ── Canonical offline-first service ─────────────────────────────────────────

describe('buildCustomerLedger (offline-first)', () => {
  it('falls back to the stored opening balance when none is supplied', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 5000 });
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'invoices') return [inv({ id: 'INV-1', totalAmount: 10000, total_amount: 10000 })];
      if (store === 'customerPayments') return [];
      return [];
    });
    const ledger = await buildCustomerLedger(CID);
    expect(ledger.openingBalance).toBe(5000);
    expect(ledger.closingBalance).toBe(15000);
  });

  it('respects an explicit openingBalance override', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 9999 });
    const ledger = await buildCustomerLedger(CID, { openingBalance: 100 });
    expect(ledger.openingBalance).toBe(100);
  });

  it('opening + invoice + payment + credit note', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 2000 });
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'invoices')
        return [
          inv({ id: 'INV-1', totalAmount: 100000, total_amount: 100000, createdAt: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00Z' }),
          inv({ id: 'CN-1', totalAmount: 20000, total_amount: 20000, status: 'credit_note', createdAt: '2026-08-03T10:00:00Z', created_at: '2026-08-03T10:00:00Z' }),
        ];
      if (store === 'customerPayments')
        return [pay({ id: 'PAY-1', amountApplied: 40000, amount_applied: 40000, amount: 40000, createdAt: '2026-08-02T10:00:00Z', created_at: '2026-08-02T10:00:00Z' })];
      return [];
    });
    const ledger = await buildCustomerLedger(CID);
    // 2000 + 100000 - 40000 - 20000 = 42000
    expect(ledger.closingBalance).toBe(42000);
    expect(ledger.outstandingBalance).toBe(42000);
    const cn = ledger.transactions.find((t) => t.type === 'credit_note');
    expect(cn).toBeDefined();
  });

  it('a customer with no transactions owes exactly the opening balance', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 3500 });
    const ledger = await buildCustomerLedger(CID);
    expect(ledger.transactions).toHaveLength(0);
    expect(ledger.closingBalance).toBe(3500);
    expect(ledger.outstandingBalance).toBe(3500);
  });

  it('a credit (negative) balance clamps outstanding to 0 but keeps the real closing', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: -1000 });
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'invoices') return [inv({ id: 'INV-1', totalAmount: 10000, total_amount: 10000 })];
      if (store === 'customerPayments') return [pay({ id: 'PAY-1', amountApplied: 15000, amount_applied: 15000, amount: 15000 })];
      return [];
    });
    const ledger = await buildCustomerLedger(CID);
    // -1000 + 10000 - 15000 = -6000
    expect(ledger.closingBalance).toBe(-6000);
    expect(ledger.outstandingBalance).toBe(0);
  });
});

describe('getCustomerBalance / getCustomerOutstanding', () => {
  it('getCustomerOutstanding includes the opening balance', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 2500 });
    mockDb.getAll.mockImplementation(async (store: string) => {
      if (store === 'invoices') return [inv({ id: 'INV-1', totalAmount: 8000, total_amount: 8000 })];
      return [];
    });
    expect(await getCustomerOutstanding(CID)).toBe(10500);
  });

  it('getCustomerBalance exposes opening, closing and clamped outstanding', async () => {
    mockDb.get.mockResolvedValue({ id: CID, balance: 4000 });
    const result = await getCustomerBalance(CID);
    expect(result.openingBalance).toBe(4000);
    expect(result.closingBalance).toBe(4000);
    expect(result.outstandingBalance).toBe(4000);
  });
});
