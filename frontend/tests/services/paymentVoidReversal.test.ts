import { describe, it, expect, beforeEach, vi } from 'vitest';

const stores = new Map<string, Map<string, any>>();
const storeViews = new Map<string, any>();
let atomicTail = Promise.resolve();

function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  if (!storeViews.has(name)) {
    storeViews.set(name, {
      get: async (id: string) => stores.get(name)!.get(String(id)),
      put: async (rec: any) => {
        const current = stores.get(name)!;
        current.set(String(rec.id ?? rec.key ?? `k${current.size}`), rec);
      },
      getAll: async () => Array.from(stores.get(name)!.values()),
      delete: async (id: string) => { stores.get(name)!.delete(String(id)); },
    });
  }
  return storeViews.get(name);
}

vi.mock('../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (names: string[], fn: any) => {
      const previous = atomicTail;
      let release!: () => void;
      atomicTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const before = new Map(
        names.map((name) => [
          name,
          new Map(Array.from(stores.get(name) || [], ([id, value]) => [id, structuredClone(value)])),
        ]),
      );
      try {
        return await fn({ objectStore: (name: string) => storeFor(name) });
      } catch (error) {
        for (const [name, snapshot] of before) stores.set(name, snapshot);
        throw error;
      } finally {
        release();
      }
    },
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../services/transactionService';
import type { LedgerEntry } from '../../types';

const ACCOUNTS = [
  { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'RECEIVABLE', is_system_account: true, allow_posting: true },
  { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'CASH', is_system_account: true, allow_posting: true },
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', subtype: 'PAYABLE', allow_posting: true },
];

function seedAccounts() {
  stores.clear();
  for (const a of ACCOUNTS) storeFor('accounts').put(a);
}

function seedPayment(id: string, amount: number, debitAccountId: string, creditAccountId: string) {
  storeFor('customerPayments').put({
    id,
    date: '2026-10-18T00:00:00Z',
    customerId: 'CUST-1',
    customerName: 'Acme School',
    amount,
    amountRetained: amount,
    paymentMethod: 'Cash',
    accountId: debitAccountId,
    status: 'Cleared',
    reconciled: false,
    allocations: [],
  });
  storeFor('ledger').put({
    id: `LG-${id}`,
    date: '2026-10-18T00:00:00Z',
    description: `Payment #${id}`,
    debitAccountId,
    creditAccountId,
    amount,
    referenceId: id,
    reconciled: false,
  });
  storeFor('customers').put({ id: 'CUST-1', name: 'Acme School', walletBalance: 0 });
}

describe('payment void reversal integrity', () => {
  beforeEach(() => {
    seedAccounts();
    vi.clearAllMocks();
    (window.localStorage as any).getItem.mockReturnValue(null);
  });

  it('reverses the original posted journal exactly', async () => {
    seedPayment('PAY-TEST-001', 34000, 'ACC-11110', 'ACC-11310');
    await transactionService.voidCustomerPayment('PAY-TEST-001', 'operator mistake');
    const entries = (await storeFor('ledger').getAll()) as LedgerEntry[];
    const reversal = entries.find((e) => e.reversesEntryId === 'LG-PAY-TEST-001');
    expect(reversal).toBeTruthy();
    expect(reversal!.debitAccountId).toBe('ACC-11310');
    expect(reversal!.creditAccountId).toBe('ACC-11110');
    expect(reversal!.amount).toBe(34000);
    const payment = await storeFor('customerPayments').get('PAY-TEST-001');
    expect(payment.status).toBe('Voided');
  });

  it('reverses PAY-P726/050-style wallet payment to account 21300', async () => {
    seedPayment('PAY-TEST-002', 180000, 'ACC-21300', 'ACC-11310');
    await transactionService.voidCustomerPayment('PAY-TEST-002', 'operator mistake');
    const entries = (await storeFor('ledger').getAll()) as LedgerEntry[];
    const reversal = entries.find((e) => e.reversesEntryId === 'LG-PAY-TEST-002');
    expect(reversal).toBeTruthy();
    expect(reversal!.debitAccountId).toBe('ACC-11310');
    expect(reversal!.creditAccountId).toBe('ACC-21300');
    expect(reversal!.amount).toBe(180000);
  });

  it('does not create a duplicate reversal on retry', async () => {
    seedPayment('PAY-TEST-003', 10000, 'ACC-11110', 'ACC-11310');
    await transactionService.voidCustomerPayment('PAY-TEST-003', 'operator mistake');
    await expect(transactionService.voidCustomerPayment('PAY-TEST-003', 'operator mistake')).rejects.toThrow(/already voided/i);
    const entries = (await storeFor('ledger').getAll()) as LedgerEntry[];
    const reversals = entries.filter((e) => e.reversesEntryId === 'LG-PAY-TEST-003');
    expect(reversals).toHaveLength(1);
  });
});