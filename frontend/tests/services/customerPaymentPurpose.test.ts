/**
 * customerPaymentPurpose.test.ts — inferred paymentPurpose is persisted
 * top-level on the customer-payment row in the SAME put that writes it.
 * Drives the real `transactionService.addCustomerPayment` write path.
 * Run: cd frontend && npx vitest run tests/services/customerPaymentPurpose.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { stores, storeFor } = vi.hoisted(() => {
  const stores = new Map<string, Map<string, any>>();
  function storeFor(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      get: async (id: string) => m.get(String(id)),
      put: async (rec: any) => {
        m.set(String(rec.id ?? rec.key ?? `k${m.size}`), rec);
      },
      getAll: async () => Array.from(m.values()),
      delete: async (id: string) => {
        m.delete(String(id));
      },
    };
  }
  return { stores, storeFor };
});

vi.mock('../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
  },
}));

import { transactionService } from '../../services/transactionService';
import { isWalletTopup, isCollectionReceipt } from '../../services/customerLedger';

const CUSTOMER = { id: 'CUST-1', name: 'Alpha Schools', balance: 0, walletBalance: 1000000 };
const INV = { id: 'INV-1', customerId: 'CUST-1', totalAmount: 100000, paidAmount: 0, status: 'Unpaid' };

async function seed() {
  stores.clear();
  await storeFor('customers').put({ ...CUSTOMER });
  await storeFor('invoices').put({ ...INV });
}

function basePayment(overrides: Record<string, any> = {}) {
  return {
    id: `PAY-${Math.random().toString(36).slice(2, 8)}`,
    customerId: 'CUST-1',
    customerName: 'Alpha Schools',
    date: '2026-10-06T10:00:00.000Z',
    paymentMethod: 'Cash',
    status: 'Cleared',
    ...overrides,
  } as any;
}

describe('addCustomerPayment persists inferred paymentPurpose', () => {
  beforeEach(seed);

  it('1. fresh wallet top-up persists WALLET_TOPUP top-level and in snapshot', async () => {
    const p = basePayment({
      amount: 50000, allocations: [], excessHandling: 'Wallet', paymentMethod: 'Cash',
    });
    await transactionService.addCustomerPayment(p);
    const stored = await storeFor('customerPayments').get(p.id);
    expect(stored.paymentPurpose).toBe('WALLET_TOPUP');
    expect(stored.receiptSnapshot.paymentPurpose).toBe('WALLET_TOPUP');
    expect(isWalletTopup(stored)).toBe(true);
  });

  it('2. fresh invoice payment persists INVOICE_PAYMENT top-level and in snapshot', async () => {
    const p = basePayment({
      amount: 60000,
      allocations: [{ invoiceId: 'INV-1', amount: 60000 }],
      excessHandling: 'Change',
    });
    await transactionService.addCustomerPayment(p);
    const stored = await storeFor('customerPayments').get(p.id);
    expect(stored.paymentPurpose).toBe('INVOICE_PAYMENT');
    expect(stored.receiptSnapshot.paymentPurpose).toBe('INVOICE_PAYMENT');
    expect(isWalletTopup(stored)).toBe(false);
    expect(isCollectionReceipt(stored, '2026-10-06')).toBe(true);
  });

  it('3. purpose survives serialization (stored row = sync payload shape)', async () => {
    const p = basePayment({
      amount: 50000, allocations: [], excessHandling: 'Wallet', paymentMethod: 'Cash',
    });
    await transactionService.addCustomerPayment(p);
    const stored = await storeFor('customerPayments').get(p.id);
    const reserialized = JSON.parse(JSON.stringify(stored));
    expect(reserialized.paymentPurpose).toBe('WALLET_TOPUP');
    expect(reserialized.receiptSnapshot.paymentPurpose).toBe('WALLET_TOPUP');
    expect('payment_purpose' in reserialized).toBe(false);
    expect(isWalletTopup(reserialized)).toBe(true);
  });

  it('4. legacy records missing the field classify via fallback signals', async () => {
    const legacyTopup = {
      id: 'LEG-1', customerId: 'CUST-1', customerName: 'Alpha Schools',
      date: '2026-10-06T10:00:00.000Z', method: 'Wallet', paymentMethod: 'Wallet',
      allocations: [], excessHandling: 'Wallet', walletDeposit: 40000,
      amountRetained: 40000,
      receiptSnapshot: { amountRetained: 40000, walletDeposit: 40000 },
      status: 'Cleared',
    };
    expect(isWalletTopup(legacyTopup as never)).toBe(true);
    expect(isCollectionReceipt(legacyTopup as never, '2026-10-06')).toBe(false);
  });

  it('5. legitimate external Wallet-method receipt is not excluded', async () => {
    const p = basePayment({
      amount: 40000,
      paymentMethod: 'Wallet',
      allocations: [{ invoiceId: 'INV-1', amount: 40000 }],
      excessHandling: 'Change',
    });
    await transactionService.addCustomerPayment(p);
    const stored = await storeFor('customerPayments').get(p.id);
    expect(stored.paymentPurpose).toBe('INVOICE_PAYMENT');
    expect(isWalletTopup(stored)).toBe(false);
    expect(isCollectionReceipt(stored, '2026-10-06')).toBe(true);
  });

  it('6. repeated persistence does not change purpose; explicit purpose wins', async () => {
    const p = basePayment({
      amount: 50000, allocations: [], excessHandling: 'Wallet', paymentMethod: 'Cash',
      paymentPurpose: 'WALLET_TOPUP',
    });
    await transactionService.addCustomerPayment(p);
    const stored = await storeFor('customerPayments').get(p.id);
    expect(stored.paymentPurpose).toBe('WALLET_TOPUP');
    const reserialized = JSON.parse(JSON.stringify(stored));
    await storeFor('customerPayments').put(reserialized);
    const again = await storeFor('customerPayments').get(p.id);
    expect(again.paymentPurpose).toBe('WALLET_TOPUP');
    expect(again.receiptSnapshot.paymentPurpose).toBe('WALLET_TOPUP');
  });
});
