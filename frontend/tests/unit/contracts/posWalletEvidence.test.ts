/**
 * posWalletEvidence.test.ts — §5 POS Wallet discrepancy, documented as evidence.
 *
 * READ-ONLY w.r.t. production behaviour: this test PROVES the current
 * behaviour of the real processSale through the real transactionService and
 * FAILS IF THE BEHAVIOUR CHANGES. It does not change any production code.
 *
 * Established facts (with code references):
 *  1. POS UI offers Wallet and validates against walletBalance
 *     (views/pos/components/PaymentModal.tsx:199-206).
 *  2. processSale posts ledger DR 21300 (customerDepositAccount, which IS the
 *     wallet account per transactions/_internal.ts:41-43) / CR cash drawer
 *     for the Wallet-tendered retained amount
 *     (services/transactionService.ts:1142-1161).
 *  3. processSale NEVER decrements customers.walletBalance for that tender:
 *     the only walletBalance write in processSale (lines 653-1310) is the
 *     overpayment CREDIT at line ~1186.
 *
 * Consequence: the GL says the 21300 deposit liability fell while the stored
 * wallet balance says it did not. Compare with the canonical wallet-payment
 * paths (addCustomerPayment ~3163, recordOrderPayment ~7839) which deduct
 * customers.walletBalance AND write a wallet transaction.
 *
 * Resolution of this discrepancy requires an explicit finance decision, so
 * the production code is intentionally left untouched here.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const stores = new Map<string, Map<string, any>>();
function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => { m.set(String(rec.id ?? `k${m.size}`), rec); },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => { m.delete(String(id)); },
  };
}
vi.mock('../../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_n: string[], fn: any) => fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../../services/transactionService';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
      getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b),
    },
    configurable: true, writable: true,
  });
});

const ACCOUNTS = [
  { id: 'coa-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', is_active: true, allow_posting: true },
  { id: 'coa-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', is_active: true, allow_posting: true },
  { id: 'coa-41100', code: '41100', account_number: '41100', name: 'Sales Revenue', is_active: true, allow_posting: true },
  { id: 'coa-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', is_active: true, allow_posting: true },
  { id: 'coa-11400', code: '11400', account_number: '11400', name: 'Inventory', is_active: true, allow_posting: true },
];

const CUST = 'CUST-POS';

beforeEach(async () => {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await storeFor('customers').put({ id: CUST, name: 'POS Customer', walletBalance: 500000 });
});

const walletPaySale = (id: string, amount: number) => ({
  id,
  date: new Date().toISOString(),
  status: 'Paid',
  customerId: CUST,
  customerName: 'POS Customer',
  totalAmount: amount,
  items: [{ id: 'SVC-1', name: 'Counter service', type: 'Service', quantity: 1, price: amount }],
  payments: [{ id: `PMT-${id}`, method: 'Wallet', amount, date: new Date().toISOString() }],
});

describe('POS Wallet tender (evidence, behaviour locked)', () => {
  it('posts the 21300 deposit-liability debit for the tendered amount', async () => {
    await transactionService.processSale(walletPaySale('POS-W1', 100000) as any);
    const ledger = (await storeFor('ledger').getAll()) as any[];
    const payLeg = ledger.find(
      (e) => String(e.description || '').includes('POS-W1') && String(e.description || '').includes('Wallet'),
    );
    expect(payLeg).toBeTruthy();
    expect(payLeg.debitAccountId).toBe('coa-21300');
    expect(payLeg.amount).toBe(100000);
  });

  it('does NOT decrement customers.walletBalance for the tender (defect evidence)', async () => {
    await transactionService.processSale(walletPaySale('POS-W2', 100000) as any);
    expect((await storeFor('customers').get(CUST)).walletBalance).toBe(500000);
  });

  it('writes NO wallet transaction for the tender (compare: order/invoice wallet paths do)', async () => {
    await transactionService.processSale(walletPaySale('POS-W3', 100000) as any);
    const txs = (await storeFor('walletTransactions').getAll()) as any[];
    expect(txs.filter((t) => String(t.customerId) === CUST)).toHaveLength(0);
  });
});
