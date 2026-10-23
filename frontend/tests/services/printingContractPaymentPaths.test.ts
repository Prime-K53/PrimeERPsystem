/**
 * printingContractPaymentPaths.test.ts — the two routes that settle a
 * printing-contract invoice.
 *
 * A printing contract is collected IN ADVANCE, so settling its invoice must
 * do BOTH legs in one transaction:
 *   1. the cash receipt  — Dr Cash / Cr 11310 AR (the invoice's receivable),
 *   2. the prepaid funding — the customer's wallet is credited, because the
 *      wallet is the denormalised cache of the 21300 Customer Deposits
 *      liability and it is what assessment consumption debits.
 *
 * Both routes are covered here: the mark-paid route (updateInvoice) and the
 * Receive Payment route (addCustomerPayment). They must be mutually
 * exclusive — the same money can never be counted twice.
 */

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
import type { Invoice, WalletTransaction, LedgerEntry } from '../../types';

const ACCOUNTS = [
  { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'RECEIVABLE', is_system_account: true, allow_posting: true },
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', subtype: 'PAYABLE', allow_posting: true },
  { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'CASH', is_system_account: true, allow_posting: true },
  { id: 'ACC-11210', code: '11210', account_number: '11210', name: 'Bank Account', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'BANK', is_system_account: true, allow_posting: true },
  { id: 'ACC-11240', code: '11240', account_number: '11240', name: 'Mobile Money', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'MOBILE_MONEY', is_system_account: true, allow_posting: true },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', type: 'Revenue', account_group: 'REVENUE', is_system_account: true, allow_posting: true },
];

function seedAccounts() {
  stores.clear();
  for (const a of ACCOUNTS) storeFor('accounts').put(a);
}

function makePrintingContractInvoice(overrides: any = {}): Invoice {
  return {
    id: 'INV-PC-0001',
    invoiceNumber: 'INV-PC-0001',
    customerId: 'CUST-1',
    customerName: 'Acme School',
    status: 'Unpaid',
    totalAmount: 5000,
    paidAmount: 0,
    paymentMethod: 'Cash',
    originModule: 'printing_contract',
    reference: 'PC-0001',
    referenceDoc: 'PC-0001',
    date: '2026-10-18T00:00:00Z',
    items: [],
    ...overrides,
  } as Invoice;
}

function makeOrdinaryInvoice(overrides: any = {}): Invoice {
  return {
    id: 'INV-ORD-0001',
    invoiceNumber: 'INV-ORD-0001',
    customerId: 'CUST-1',
    customerName: 'Acme School',
    status: 'Unpaid',
    totalAmount: 5000,
    paidAmount: 0,
    paymentMethod: 'Cash',
    originModule: 'sales',
    date: '2026-10-18T00:00:00Z',
    items: [],
    ...overrides,
  } as Invoice;
}

async function seedCustomer(balance = 0) {
  await storeFor('customers').put({ id: 'CUST-1', name: 'Acme School', walletBalance: balance });
}

async function walletBalance() {
  const c = await storeFor('customers').get('CUST-1');
  return Number(c?.walletBalance || 0);
}

async function walletTxs() {
  return (await storeFor('walletTransactions').getAll()) as WalletTransaction[];
}

async function ledgerEntries() {
  return (await storeFor('ledger').getAll()) as LedgerEntry[];
}

const cashEntries = async () =>
  (await ledgerEntries()).filter((e: any) => e.debitAccountId === 'ACC-11110' || e.debitAccountId === 'ACC-11210' || e.debitAccountId === 'ACC-11240');

const fundingTxs = async () =>
  (await walletTxs()).filter((tx: any) => tx.data?.type === 'CONTRACT_PREPAID_FUNDING');

const receivePayment = (invoiceId: string, amount: number, id: string) => ({
  id,
  date: '2026-10-18T00:00:00Z',
  customerId: 'CUST-1',
  customerName: 'Acme School',
  amount,
  paymentMethod: 'Cash',
  reference: invoiceId,
  notes: '',
  allocations: [{ invoiceId, amount }],
  status: 'Cleared',
  reconciled: false,
});

describe('printing-contract invoice settlement — both legs in one transaction', () => {
  beforeEach(() => {
    seedAccounts();
    vi.clearAllMocks();
    (window.localStorage as any).getItem.mockReturnValue(null);
  });

  describe('Receive Payment route (addCustomerPayment)', () => {
    it('funds the wallet and posts the cash leg exactly once', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());

      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-1') as any);

      // Leg 2 — the prepaid funding: the money is now spendable against the
      // contract's assessments.
      expect(await walletBalance()).toBe(5000);
      const funded = await fundingTxs();
      expect(funded).toHaveLength(1);
      expect(funded[0].amount).toBe(5000);
      expect(funded[0].reference).toBe('INV-PC-0001');
      expect(funded[0].idempotencyKey).toBe('wallet:contract:invoice:INV-PC-0001:prepaid:5000');

      // Leg 1 — the cash receipt: Dr Cash / Cr AR, once.
      const cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].amount).toBe(5000);
      expect(cash[0].creditAccountId).toBe('ACC-11310');

      // The invoice is settled.
      const invoice = await storeFor('invoices').get('INV-PC-0001');
      expect(invoice.paidAmount).toBe(5000);
      expect(invoice.status).toBe('Paid');
    });

    it('does not fund the wallet for an ordinary invoice', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makeOrdinaryInvoice());

      await transactionService.addCustomerPayment(receivePayment('INV-ORD-0001', 5000, 'PAY-ORD') as any);

      expect(await walletBalance()).toBe(0);
      expect(await fundingTxs()).toHaveLength(0);
      expect(await cashEntries()).toHaveLength(1);
    });

    it('a partial payment funds only the settled part', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice({ totalAmount: 10000 }));

      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 4000, 'PAY-2') as any);

      expect(await walletBalance()).toBe(4000);
      expect((await fundingTxs())[0].idempotencyKey).toBe('wallet:contract:invoice:INV-PC-0001:prepaid:4000');
    });
  });

  describe('mark-paid route (updateInvoice)', () => {
    it('posts the cash leg once and reports the payment as settled', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());

      const result: any = await transactionService.updateInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' })
      );

      expect(result.paymentSettled).toBe(true);
      expect(await walletBalance()).toBe(5000);
      expect(await fundingTxs()).toHaveLength(1);

      // Exactly one cash leg — the caller must not post a second payment.
      const cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].amount).toBe(5000);
    });

    it('an ordinary invoice settlement is not reported as settled by the service', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makeOrdinaryInvoice());

      const result: any = await transactionService.updateInvoice(
        makeOrdinaryInvoice({ paidAmount: 5000, status: 'Paid' })
      );

      expect(result.paymentSettled).toBe(false);
      expect(await walletBalance()).toBe(0);
    });
  });

  describe('the routes are mutually exclusive', () => {
    it('paying via Receive Payment then marking the invoice paid: one cash leg, one funding', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());

      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-3') as any);
      expect(await walletBalance()).toBe(5000);

      // The operator then clicks "Mark Paid" — the invoice is already settled,
      // so there is no new money and nothing may be posted twice.
      const result: any = await transactionService.updateInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' })
      );

      expect(result.paymentSettled).toBe(false);
      expect(await walletBalance()).toBe(5000);
      expect(await fundingTxs()).toHaveLength(1);
      expect(await cashEntries()).toHaveLength(1);
    });

    it('one instalment per route: the wallet is funded with the full total exactly once', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice({ totalAmount: 10000 }));

      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-4') as any);
      expect(await walletBalance()).toBe(5000);

      await transactionService.updateInvoice(
        makePrintingContractInvoice({ totalAmount: 10000, paidAmount: 10000, status: 'Paid' })
      );

      expect(await walletBalance()).toBe(10000);
      const funded = await fundingTxs();
      expect(funded.map((tx: any) => tx.amount)).toEqual([5000, 5000]);
      // Two instalments → two cash legs, each for its own money.
      expect(await cashEntries()).toHaveLength(2);
    });
  });
});
