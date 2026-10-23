/**
 * canonicalInvoiceSettlement.test.ts — ONE settlement rule for every route.
 *
 * Settling an invoice means two things at once: the cash receipt that clears
 * the receivable, and — for a printing contract, which is collected IN
 * ADVANCE — the prepaid wallet credit that lets the assessments be drawn
 * down later. Both legs land in one transaction.
 *
 * The three entry points that can settle an invoice (issue-as-paid, Mark
 * Paid, Receive Payment) must not drift apart:
 *   - the cash lands in the SAME account on every route (the account the
 *     operator chose, or the one the payment method implies);
 *   - the wallet is funded with the SAME money on every route;
 *   - voiding a settlement unwinds the prepaid funding, so the customer
 *     never keeps the money in their wallet AND gets the cash back;
 *   - a voided settlement can be settled again (the funding key is released).
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

async function seedCustomer(balance = 0) {
  await storeFor('customers').put({ id: 'CUST-1', name: 'Acme School', walletBalance: balance });
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
    salesAccountId: '41100',
    date: '2026-10-18T00:00:00Z',
    items: [],
    ...overrides,
  } as Invoice;
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

const fundingTxs = async () =>
  (await walletTxs()).filter((tx: any) => tx.data?.type === 'CONTRACT_PREPAID_FUNDING');

/** The cash receipts: Dr <cash account> / Cr 11310 AR. */
const cashEntries = async () =>
  (await ledgerEntries()).filter((e: any) => e.creditAccountId === 'ACC-11310');

const receivePayment = (invoiceId: string, amount: number, id: string, overrides: any = {}) => ({
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
  ...overrides,
});

describe('canonical invoice settlement — one rule for every route', () => {
  beforeEach(() => {
    seedAccounts();
    vi.clearAllMocks();
    (window.localStorage as any).getItem.mockReturnValue(null);
  });

  describe('the cash lands in the SAME account on every route', () => {
    it('the operator\'s chosen account wins on all three routes', async () => {
      // Receive Payment
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(
        receivePayment('INV-PC-0001', 5000, 'PAY-A', { accountId: 'ACC-11210' }) as any,
      );
      let cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');

      // Mark Paid
      seedAccounts();
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.updateInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid', accountId: 'ACC-11210' }) as any,
      );
      cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');

      // Issue as paid
      seedAccounts();
      await seedCustomer(0);
      await transactionService.processInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid', accountId: 'ACC-11210' }) as any,
      );
      cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');
    });

    it('Card without a chosen account lands in the bank on every route', async () => {
      // The issue-as-paid route used to book a Card payment to the cash
      // drawer (a stray `else` bound to the wrong branch), so the same
      // payment landed in a different account depending on the route.
      await seedCustomer(0);
      await transactionService.processInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid', paymentMethod: 'Card' }) as any,
      );
      let cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');

      // The same route on an ordinary invoice hit the mis-bound branch.
      seedAccounts();
      await seedCustomer(0);
      await transactionService.processInvoice(
        makeOrdinaryInvoice({ paidAmount: 5000, status: 'Paid', paymentMethod: 'Card' }) as any,
      );
      cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');

      seedAccounts();
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(
        receivePayment('INV-PC-0001', 5000, 'PAY-C', { paymentMethod: 'Card' }) as any,
      );
      cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');

      seedAccounts();
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.updateInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid', paymentMethod: 'Card' }) as any,
      );
      cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11210');
    });

    it('Mobile Money lands in the mobile-money account on every route', async () => {
      await seedCustomer(0);
      await transactionService.processInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid', paymentMethod: 'Mobile Money' }) as any,
      );
      const cash = await cashEntries();
      expect(cash).toHaveLength(1);
      expect(cash[0].debitAccountId).toBe('ACC-11240');
    });
  });

  describe('voiding a settlement unwinds the prepaid funding', () => {
    it('voiding a Receive Payment returns the wallet credit', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-V') as any);

      expect(await walletBalance()).toBe(5000);
      expect(await fundingTxs()).toHaveLength(1);

      await transactionService.voidCustomerPayment('PAY-V', 'operator mistake');

      // The wallet credit is gone — the customer does not keep the money
      // AND get the cash back.
      expect(await walletBalance()).toBe(0);
      const reversals = (await walletTxs()).filter((tx: any) => tx.data?.type === 'CONTRACT_PREPAID_FUNDING_REVERSAL');
      expect(reversals).toHaveLength(1);
      expect(reversals[0].amount).toBe(5000);

      // The invoice is open again.
      const invoice = await storeFor('invoices').get('INV-PC-0001');
      expect(Number(invoice.paidAmount)).toBe(0);
    });

    it('voiding a Mark Paid settlement returns the wallet credit', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.updateInvoice(
        makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' }) as any,
      );
      expect(await walletBalance()).toBe(5000);

      const payment = (await storeFor('customerPayments').getAll())[0] as any;
      expect(payment).toBeTruthy();
      await transactionService.voidCustomerPayment(payment.id, 'operator mistake');

      expect(await walletBalance()).toBe(0);
    });

    it('voiding the invoice returns the wallet credit', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-I') as any);
      expect(await walletBalance()).toBe(5000);

      await transactionService.voidInvoice('INV-PC-0001', 'contract cancelled');

      expect(await walletBalance()).toBe(0);
      const reversals = (await walletTxs()).filter((tx: any) => tx.data?.type === 'CONTRACT_PREPAID_FUNDING_REVERSAL');
      expect(reversals).toHaveLength(1);
    });

    it('a voided settlement can be settled again', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-R1') as any);
      await transactionService.voidCustomerPayment('PAY-R1', 'operator mistake');
      expect(await walletBalance()).toBe(0);

      // The funding key was released, so the same invoice can be paid again.
      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-R2') as any);

      expect(await walletBalance()).toBe(5000);
      const funded = await fundingTxs();
      expect(funded).toHaveLength(1);
      expect(funded[0].data.payment_id).toBe('PAY-R2');
    });

    it('a settlement is refused when the prepaid funds were already consumed', async () => {
      await seedCustomer(0);
      await storeFor('invoices').put(makePrintingContractInvoice());
      await transactionService.addCustomerPayment(receivePayment('INV-PC-0001', 5000, 'PAY-C1') as any);

      // The customer spends the prepaid funds on an assessment, so the
      // wallet no longer holds them.
      const customer = await storeFor('customers').get('CUST-1');
      await storeFor('customers').put({ ...customer, walletBalance: 1000 });

      await expect(
        transactionService.voidCustomerPayment('PAY-C1', 'operator mistake'),
      ).rejects.toThrow(/already been consumed/i);

      // Nothing was written — the wallet is untouched.
      expect(await walletBalance()).toBe(1000);
    });
  });
});
