/**
 * prepaidFundingLifecycle.test.ts — prepaid wallet funding for printing
 * contract invoices.
 *
 * Canonical invariants under test:
 *   - Invoice issued but unpaid: NO prepaid funding is created (walletBalance
 *     unchanged, no wallet transaction, no idempotency key).
 *   - Valid prepaid payment confirmed: walletBalance is credited exactly once,
 *     traceable to invoice + payment via deterministic references.
 *   - Repeated payment confirmation: no duplicate wallet credit, no duplicate
 *     ledger posting, idempotency key blocks re-funding.
 *   - Ordinary (non-printing-contract) invoice settlement: NO reusable wallet
 *     credit — walletBalance unchanged.
 *   - Invoice payment + wallet funding + assessment consumption do not
 *     double-count cash, customer deposits, or revenue.
 *
 * Uses the real transactionService.processInvoice / updateInvoice against an
 * in-memory dbService stub (same harness as contractConsumption.test.ts).
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
    id: 'INV-PREPAID-0001',
    invoiceNumber: 'INV-PREPAID-0001',
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
    customerName: 'Walk-in Customer',
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

async function idempotencyKeys() {
  return (await storeFor('idempotencyKeys').getAll()) as any[];
}

describe('prepaid funding lifecycle — processInvoice', () => {
  beforeEach(() => {
    seedAccounts();
    vi.clearAllMocks();
    (window.localStorage as any).getItem.mockReturnValue(null);
  });

  it('invoice issued but unpaid: no prepaid funding is created', async () => {
    await seedCustomer(0);
    const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });
    await transactionService.processInvoice(inv);

    expect(await walletBalance()).toBe(0);
    expect(await walletTxs()).toHaveLength(0);
    expect(await idempotencyKeys()).toHaveLength(1); // only the invoice idempotency key
  });

  it('valid prepaid payment confirmed: wallet credited once, traceable to invoice', async () => {
    await seedCustomer(0);
    const inv = makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' });
    const res = await transactionService.processInvoice(inv);

    expect(res.success).toBe(true);
    expect(await walletBalance()).toBe(5000);

    const txs = await walletTxs();
    expect(txs).toHaveLength(1);
    const fundingTx = txs[0];
    expect(fundingTx.type).toBe('Deposit');
    expect(fundingTx.amount).toBe(5000);
    expect(fundingTx.customerId).toBe('CUST-1');
    expect(fundingTx.reference).toBe('INV-PREPAID-0001');
    expect(fundingTx.data.type).toBe('CONTRACT_PREPAID_FUNDING');
    expect(fundingTx.data.invoice_id).toBe('INV-PREPAID-0001');
    expect(fundingTx.data.contract_number).toBe('PC-0001');
    expect(fundingTx.data.customer_id).toBe('CUST-1');
    const keys = await idempotencyKeys();
    const fundingKey = keys.find((k: any) => k.scope === 'contract_prepaid_funding' && k.id === 'wallet:contract:invoice:INV-PREPAID-0001:prepaid:5000');
    expect(fundingKey).toBeTruthy();
    expect(fundingKey.sourceId).toBe('INV-PREPAID-0001');
    expect(fundingTx.idempotencyKey).toBe('wallet:contract:invoice:INV-PREPAID-0001:prepaid:5000');

    // Ledger: invoice Dr AR / Cr Customer Deposits + payment Dr Cash / Cr AR
    const entries = await ledgerEntries();
    const arEntries = entries.filter((e: any) => e.debitAccountId === 'ACC-11310');
    const cdEntries = entries.filter((e: any) => e.creditAccountId === 'ACC-21300');
    expect(arEntries.length).toBeGreaterThanOrEqual(1);
    expect(cdEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('repeated payment confirmation: no duplicate credit or ledger posting', async () => {
    await seedCustomer(0);
    const inv = makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' });

    // First call succeeds
    await transactionService.processInvoice(inv);
    expect(await walletBalance()).toBe(5000);
    expect(await walletTxs()).toHaveLength(1);

    // Second call with same invoice id: invoice idempotency key blocks reprocessing
    await expect(transactionService.processInvoice(inv)).rejects.toThrow(/Duplicate financial request/);
    expect(await walletBalance()).toBe(5000);
    expect(await walletTxs()).toHaveLength(1);
    const entries = await ledgerEntries();
    // Ledger count unchanged (invoice AR entry not duplicated either)
    expect(entries.filter((e: any) => e.debitAccountId === 'ACC-11310')).toHaveLength(1);
  });

  it('ordinary invoice settlement: no reusable wallet credit', async () => {
    await seedCustomer(0);
    const inv = makeOrdinaryInvoice({ paidAmount: 5000, status: 'Paid' });
    await transactionService.processInvoice(inv);

    expect(await walletBalance()).toBe(0);
    expect(await walletTxs()).toHaveLength(0);
  });

  it('prepaid funding + consumption: no double-counting of cash, deposits, revenue', async () => {
    await seedCustomer(0);

    // 1. Issue and pay prepaid invoice
    const inv = makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' });
    await transactionService.processInvoice(inv);
    expect(await walletBalance()).toBe(5000);

    const entriesAfterPayment = await ledgerEntries();
    const arDr = entriesAfterPayment.filter((e: any) => e.debitAccountId === 'ACC-11310').length;
    const cdCr = entriesAfterPayment.filter((e: any) => e.creditAccountId === 'ACC-21300').length;
    const cashDr = entriesAfterPayment.filter((e: any) => e.debitAccountId === 'ACC-11110').length;
    expect(arDr).toBe(1);
    expect(cdCr).toBe(1);
    expect(cashDr).toBe(1);

    // 2. Seed contract and reserved assessment for consumption
    await storeFor('assessmentContracts').put({
      id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
      contract_number: 'PC-0001', title: 'Exam printing', status: 'active',
      prepaid_amount: 5000, consumed_amount: 0, reserved_amount: 5000,
      max_assessments: 1, assessment_price: 5000,
      payment_status: 'verified', version: 1, data: {},
    });
    await storeFor('contractAssessments').put({
      id: 'A-1', contract_id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1',
      school_id: 'SCH-1', assessment_name: 'Assessment 1', status: 'reserved',
      item_price: 5000, version: 1,
    });

    // 3. Consume assessment: wallet debit + ledger DR Customer Deposits / CR Revenue
    const consumeRes = await transactionService.consumeContractAssessment({
      contractId: 'PC-1', assessmentItemId: 'A-1',
    });
    expect(consumeRes.success).toBe(true);
    expect(await walletBalance()).toBe(0);

    const finalEntries = await ledgerEntries();
    const revCr = finalEntries.filter((e: any) => e.creditAccountId === 'ACC-41100' && e.amount === 5000);
    expect(revCr).toHaveLength(1); // revenue recognised once at consumption

    // Total ledger: 3 entries (invoice AR, invoice CD credit, payment cash, consumption DR/CD+CR/revenue)
    // Verify no duplicate revenue: exactly one CR to revenue account
    const allRevCr = finalEntries.filter((e: any) => e.creditAccountId === 'ACC-41100');
    expect(allRevCr).toHaveLength(1);
  });

  // ─── Partial payments ───

  describe('partial payments via updateInvoice', () => {
    beforeEach(() => {
      seedAccounts();
      vi.clearAllMocks();
      (window.localStorage as any).getItem.mockReturnValue(null);
    });

    it('first instalment then second instalment: cumulative wallet funding', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });

      // First instalment: K10,000 of K20,000
      const first = { ...inv, paidAmount: 10000, status: 'Partial' };
      await transactionService.updateInvoice(first);
      expect(await walletBalance()).toBe(10000);
      expect(await walletTxs()).toHaveLength(1);

      // Second instalment: remaining K10,000
      const second = { ...inv, paidAmount: 20000, status: 'Paid' };
      await transactionService.updateInvoice(second);
      expect(await walletBalance()).toBe(20000);
      expect(await walletTxs()).toHaveLength(2);

      // Verify each wallet tx has distinct idempotency keys
      const txs = await walletTxs();
      expect(txs[0].idempotencyKey).toBe('wallet:contract:invoice:INV-PREPAID-0001:prepaid:10000');
      expect(txs[1].idempotencyKey).toBe('wallet:contract:invoice:INV-PREPAID-0001:prepaid:20000');
    });

    it('retry of the same payment event: no duplicate effects', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });

      // First call
      const first = { ...inv, paidAmount: 10000, status: 'Partial' };
      await transactionService.updateInvoice(first);
      expect(await walletBalance()).toBe(10000);
      const txCount1 = (await walletTxs()).length;
      const ledgerCount1 = (await ledgerEntries()).length;

      // Retry with same cumulative total
      await transactionService.updateInvoice(first);
      expect(await walletBalance()).toBe(10000);
      expect((await walletTxs()).length).toBe(txCount1);
      expect((await ledgerEntries()).length).toBe(ledgerCount1);
    });

    it('repeated updateInvoice calls with unchanged totals: no duplicate effects', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });

      const first = { ...inv, paidAmount: 10000, status: 'Partial' };
      await transactionService.updateInvoice(first);
      await transactionService.updateInvoice(first);
      await transactionService.updateInvoice(first);

      expect(await walletBalance()).toBe(10000);
      expect((await walletTxs()).length).toBe(1);
    });

    it('legitimate later payment through updateInvoice after processInvoice', async () => {
      await seedCustomer(0);

      // processInvoice with initial payment
      const initial = makePrintingContractInvoice({ totalAmount: 20000, paidAmount: 10000, status: 'Partial' });
      await transactionService.processInvoice(initial);
      expect(await walletBalance()).toBe(10000);

      // Later, updateInvoice increases cumulative to 20000
      const later = makePrintingContractInvoice({ totalAmount: 20000, paidAmount: 20000, status: 'Paid' });
      await transactionService.updateInvoice(later);
      expect(await walletBalance()).toBe(20000);
      expect((await walletTxs()).length).toBe(2);
    });

    it('overpayment: correct invoice settlement and wallet-credit allocation', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ totalAmount: 10000, paidAmount: 15000, status: 'Paid' });
      await transactionService.processInvoice(inv);

      expect(await walletBalance()).toBe(15000);
      const txs = await walletTxs();
      expect(txs.map((tx) => tx.amount).sort((a, b) => a - b)).toEqual([5000, 10000]);
      const payment = (await storeFor('customerPayments').getAll()).find(
        (record: any) => record.reference === inv.id,
      );
      expect(payment.amount).toBe(15000);
      expect(payment.allocations).toEqual([{ invoiceId: inv.id, amount: 10000 }]);
      expect(payment.walletDeposit).toBe(5000);

      const entries = await ledgerEntries();
      expect(entries).toContainEqual(expect.objectContaining({
        description: `Payment for Invoice #${inv.id}`,
        debitAccountId: 'ACC-11110',
        creditAccountId: 'ACC-11310',
        amount: 10000,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        description: `Overpayment for Invoice #${inv.id}`,
        debitAccountId: 'ACC-11110',
        creditAccountId: 'ACC-21300',
        amount: 5000,
      }));
      const countsBeforeRetry = {
        wallet: txs.length,
        ledger: entries.length,
        payments: (await storeFor('customerPayments').getAll()).length,
      };
      await expect(transactionService.processInvoice(inv)).rejects.toThrow(/Duplicate financial request/);
      expect(await walletBalance()).toBe(15000);
      expect(await walletTxs()).toHaveLength(countsBeforeRetry.wallet);
      expect(await ledgerEntries()).toHaveLength(countsBeforeRetry.ledger);
      expect(await storeFor('customerPayments').getAll()).toHaveLength(countsBeforeRetry.payments);
    });

    it('rejects a payment decrease without changing any financial records', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });

      const first = { ...inv, paidAmount: 10000, status: 'Partial' };
      await transactionService.updateInvoice(first);
      expect(await walletBalance()).toBe(10000);

      const before = {
        invoice: await storeFor('invoices').get(inv.id),
        customer: await storeFor('customers').get('CUST-1'),
        walletTransactions: await walletTxs(),
        ledger: await ledgerEntries(),
        customerPayments: await storeFor('customerPayments').getAll(),
        idempotencyKeys: await idempotencyKeys(),
      };
      const corrected = { ...inv, paidAmount: 5000, status: 'Partial' };
      await expect(transactionService.updateInvoice(corrected)).rejects.toThrow(
        /refund\/reversal process/i,
      );

      expect(await storeFor('invoices').get(inv.id)).toEqual(before.invoice);
      expect(await storeFor('customers').get('CUST-1')).toEqual(before.customer);
      expect(await walletTxs()).toEqual(before.walletTransactions);
      expect(await ledgerEntries()).toEqual(before.ledger);
      expect(await storeFor('customerPayments').getAll()).toEqual(before.customerPayments);
      expect(await idempotencyKeys()).toEqual(before.idempotencyKeys);
    });

    it('Cash payment method credits wallet and uses Cash Drawer account', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 5000, paymentMethod: 'Cash', status: 'Paid' });
      await transactionService.processInvoice(inv);

      expect(await walletBalance()).toBe(5000);
      const entries = await ledgerEntries();
      const cashDr = entries.filter((e: any) => e.debitAccountId === 'ACC-11110');
      expect(cashDr.length).toBe(1);
    });

    it('Card/Bank Transfer payment method credits wallet and uses Bank account', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 5000, paymentMethod: 'Card', status: 'Paid' });
      await transactionService.processInvoice(inv);

      expect(await walletBalance()).toBe(5000);
      const entries = await ledgerEntries();
      const bankDr = entries.filter((e: any) => e.debitAccountId === 'ACC-11210');
      expect(bankDr.length).toBe(1);
    });

    it('Mobile Money payment method credits wallet and uses Mobile Money account', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 5000, paymentMethod: 'Mobile Money', status: 'Paid' });
      await transactionService.processInvoice(inv);

      expect(await walletBalance()).toBe(5000);
      const entries = await ledgerEntries();
      const mmDr = entries.filter((e: any) => e.debitAccountId === 'ACC-11240');
      expect(mmDr.length).toBe(1);
    });

    it('Wallet payment method does not double-credit the wallet', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 5000, paymentMethod: 'Wallet', status: 'Paid' });
      await transactionService.processInvoice(inv);

      // Wallet payment: ledger debits Customer Deposits, but wallet funding still credits customer.walletBalance
      // The wallet balance reflects the prepaid funds available, not double-counted
      expect(await walletBalance()).toBe(5000);
    });
  });

  // ─── Concurrency and failure atomicity ────────────────────────────────────────
  // These guard the invariant that two simultaneous or retried requests for
  // the same instalment event cannot produce duplicate wallet credits, duplicate
  // ledger entries, or split financial commits across stores.

  describe('concurrent and retried same-instalment events', () => {
    beforeEach(() => {
      seedAccounts();
      vi.clearAllMocks();
      (window.localStorage as any).getItem.mockReturnValue(null);
    });

    it('two concurrent updates with the same cumulative total → one wallet tx', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });
      const first = { ...inv, paidAmount: 10000, status: 'Partial' };

      // Promise.all launches both calls; the idempotency key reserves first so
      // the second sees fundingKey already present and skips funding entirely.
      // (The production code still records a payment row per call — that is by
      // design — but wallet funding must occur exactly once.)
      const [r1, r2] = await Promise.allSettled([
        transactionService.updateInvoice(first),
        transactionService.updateInvoice(first),
      ]);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('fulfilled'); // idempotent retry, no throw

      expect(await walletBalance()).toBe(10000);
      expect((await walletTxs())).toHaveLength(1);
      const walletKeys = (await idempotencyKeys()).filter((k: any) => k.scope === 'contract_prepaid_funding');
      expect(walletKeys).toHaveLength(1);
    });

    it('two concurrent first instalments then second instalment → exactly two distinct wallet txs', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ totalAmount: 40000, paidAmount: 0, status: 'Unpaid' });

      // Both instalments arrive "simultaneously". Cumulative keys are distinct
      // (10k vs 20k), so each reserves its own idempotency key and both apply.
      const [p1, p2] = await Promise.all([
        transactionService.updateInvoice({ ...inv, paidAmount: 10000, status: 'Partial' }),
        transactionService.updateInvoice({ ...inv, paidAmount: 20000, status: 'Partial' }),
      ]);
      expect([p1, p2].every(Boolean)).toBe(true);

      expect(await walletBalance()).toBe(20000);
      const txs = await walletTxs();
      expect(txs).toHaveLength(2);
      // First instalment funds K10,000; second instalment funds the remaining
      // K10,000 increment (paidIncrease = newPaid - existingPaid).
      expect(txs[0].amount).toBe(10000);
      expect(txs[1].amount).toBe(10000);
      // Distinct idempotency keys ⇒ two separate funding events, no duplication.
      const keys = await idempotencyKeys();
      expect(keys.filter((k: any) => k.scope === 'contract_prepaid_funding')).toHaveLength(2);
    });

    it('three simultaneous payments for three different invoices → all funded once', async () => {
      await seedCustomer(0);
      const invA = makePrintingContractInvoice({ id: 'INV-CON-0001', totalAmount: 10000, paidAmount: 10000, status: 'Paid' });
      const invB = makePrintingContractInvoice({ id: 'INV-CON-0002', totalAmount: 10000, paidAmount: 10000, status: 'Paid' });
      const invC = makePrintingContractInvoice({ id: 'INV-CON-0003', totalAmount: 10000, paidAmount: 10000, status: 'Paid' });

      await Promise.all([
        transactionService.processInvoice(invA),
        transactionService.processInvoice(invB),
        transactionService.processInvoice(invC),
      ]);

      expect(await walletBalance()).toBe(30000);
      expect((await walletTxs())).toHaveLength(3);
      const keys = await idempotencyKeys();
      expect(keys.filter((k: any) => k.scope === 'contract_prepaid_funding')).toHaveLength(3);
    });
  });

  describe('failure atomicity', () => {
    beforeEach(() => {
      seedAccounts();
      vi.clearAllMocks();
      (window.localStorage as any).getItem.mockReturnValue(null);
    });

    it('funding-tx write failure mid-operation leaves no wallet tx, no ledger entry', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });
      const beforeWallet = await walletBalance();
      const beforeTxs = (await walletTxs()).length;
      const beforeLedger = (await ledgerEntries()).length;
      const paymentsBefore = (await storeFor('customerPayments').getAll()).length;

      // Force the FIRST financial write (the wallet funding transaction) to throw.
      // This happens inside the funded block, after the customer update and the
      // idempotency-key reservation, but BEFORE the payment ledger entry is
      // created — so executeAtomicOperation rolls back everything together.
      const walletStore = storeFor('walletTransactions');
      const origPut = walletStore.put.bind(walletStore);
      walletStore.put = async (rec: any) => {
        throw new Error('SIMULATED_WTX_PUT_FAILURE');
      };

      await expect(
        transactionService.updateInvoice({ ...inv, paidAmount: 10000, status: 'Partial' })
      ).rejects.toThrow(/SIMULATED_WTX_PUT_FAILURE/);

      // Nothing written: wallet unchanged, no extra wallet tx, no extra ledger
      // entry, no duplicate customerPayment record.
      expect(await walletBalance()).toBe(beforeWallet);
      expect((await walletTxs()).length).toBe(beforeTxs);
      expect((await ledgerEntries()).length).toBe(beforeLedger);
      expect((await storeFor('customerPayments').getAll())).toHaveLength(paymentsBefore);

      walletStore.put = origPut;
    });

    it('account-resolution failure rolls back the invoice and every funding effect', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ paidAmount: 0, status: 'Unpaid' });
      await storeFor('invoices').put(inv);
      await storeFor('accounts').delete('ACC-11110');

      const before = {
        invoice: await storeFor('invoices').get(inv.id),
        customer: await storeFor('customers').get('CUST-1'),
        walletTransactions: await walletTxs(),
        ledger: await ledgerEntries(),
        customerPayments: await storeFor('customerPayments').getAll(),
        idempotencyKeys: await idempotencyKeys(),
      };

      await expect(
        transactionService.updateInvoice({ ...inv, paidAmount: 10000, status: 'Partial' }),
      ).rejects.toThrow(/account/i);

      expect(await storeFor('invoices').get(inv.id)).toEqual(before.invoice);
      expect(await storeFor('customers').get('CUST-1')).toEqual(before.customer);
      expect(await walletTxs()).toEqual(before.walletTransactions);
      expect(await ledgerEntries()).toEqual(before.ledger);
      expect(await storeFor('customerPayments').getAll()).toEqual(before.customerPayments);
      expect(await idempotencyKeys()).toEqual(before.idempotencyKeys);
    });

    it('overpayment failure after processing begins rolls back all invoice effects', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({
        totalAmount: 10000,
        paidAmount: 15000,
        status: 'Paid',
        id: 'INV-9901',
        invoiceNumber: 'INV-9901',
      });
      const before = {
        customer: await storeFor('customers').get('CUST-1'),
        walletTransactions: await walletTxs(),
        ledger: await ledgerEntries(),
        customerPayments: await storeFor('customerPayments').getAll(),
        idempotencyKeys: await idempotencyKeys(),
      };

      const walletStore = storeFor('walletTransactions');
      const originalPut = walletStore.put;
      walletStore.put = async (record: any) => {
        if (record.id === 'WALLET-OVERPAY-INV-9901') {
          throw new Error('SIMULATED_OVERPAYMENT_WALLET_FAILURE');
        }
        return originalPut(record);
      };

      try {
        await expect(transactionService.processInvoice(inv)).rejects.toThrow(
          /SIMULATED_OVERPAYMENT_WALLET_FAILURE/,
        );
      } finally {
        walletStore.put = originalPut;
      }

      expect(await storeFor('invoices').get(inv.id)).toBeUndefined();
      expect(await storeFor('customers').get('CUST-1')).toEqual(before.customer);
      expect(await walletTxs()).toEqual(before.walletTransactions);
      expect(await ledgerEntries()).toEqual(before.ledger);
      expect(await storeFor('customerPayments').getAll()).toEqual(before.customerPayments);
      expect(await idempotencyKeys()).toEqual(before.idempotencyKeys);
    });

    it('wallet txId uniqueness during concurrent consume prevents double debits', async () => {
      await seedCustomer(100000);
      // Fund invoice via processInvoice (single paid event): K5,000 prepaid →
      // wallet K105,000 (seed K100,000 + funded K5,000).
      const inv = makePrintingContractInvoice({ paidAmount: 5000, status: 'Paid' });
      await transactionService.processInvoice(inv);
      expect(await walletBalance()).toBe(105000);

      // Seed two contracts that can each consume K5,000 from the same wallet.
      for (const pc of [
        { id: 'PC-A', contract_number: 'PC-0001', prepaid_amount: 5000, consumed_amount: 0, reserved_amount: 5000, max_assessments: 1, assessment_price: 5000, status: 'active' },
        { id: 'PC-B', contract_number: 'PC-0002', prepaid_amount: 5000, consumed_amount: 0, reserved_amount: 5000, max_assessments: 1, assessment_price: 5000, status: 'active' },
      ]) {
        await storeFor('assessmentContracts').put({ ...pc, company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1', payment_status: 'verified', version: 1, data: {} });
      }
      await storeFor('contractAssessments').put({ id: 'A-1', contract_id: 'PC-A', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1', assessment_name: 'Assessment 1', status: 'reserved', item_price: 5000, version: 1 });
      await storeFor('contractAssessments').put({ id: 'A-2', contract_id: 'PC-B', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1', assessment_name: 'Assessment 2', status: 'reserved', item_price: 5000, version: 1 });

      // Both assessments consume K5,000 from the same wallet simultaneously.
      // The per-item wallet txId uniqueness guard prevents a double debit; total
      // debit is K10,000 (not K20,000).
      const [r1, r2] = await Promise.allSettled([
        transactionService.consumeContractAssessment({ contractId: 'PC-A', assessmentItemId: 'A-1' }),
        transactionService.consumeContractAssessment({ contractId: 'PC-B', assessmentItemId: 'A-2' }),
      ]);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('fulfilled');

      // Two deductions + two revenue credits; wallet drained by K10,000.
      expect(await walletBalance()).toBe(95000);
      expect((await ledgerEntries()).filter((e: any) => e.debitAccountId === 'ACC-21300')).toHaveLength(2);
      const consumptionTxs = (await walletTxs()).filter(
        (tx) => tx.data?.type === 'ASSESSMENT_CONSUMPTION',
      );
      expect(consumptionTxs).toHaveLength(2);
      expect(new Set(consumptionTxs.map((tx) => tx.id)).size).toBe(2);
    });
  });

  describe('assessment consumption after multiple instalments', () => {
    beforeEach(() => {
      seedAccounts();
      vi.clearAllMocks();
      (window.localStorage as any).getItem.mockReturnValue(null);
    });

    it('two instalments fund the wallet; two consumptions consume exactly once with no double-count', async () => {
      await seedCustomer(0);
      const inv = makePrintingContractInvoice({ totalAmount: 40000, paidAmount: 0, status: 'Unpaid' });

      // First instalment: K10,000 → wallet K10,000
      await transactionService.updateInvoice({ ...inv, paidAmount: 10000, status: 'Partial' });
      expect(await walletBalance()).toBe(10000);

      // Second instalment: remaining K30,000 → wallet K40,000
      await transactionService.updateInvoice({ ...inv, paidAmount: 40000, status: 'Paid' });
      expect(await walletBalance()).toBe(40000);

      // Two assessment items, each priced K20,000, consumable from the funded wallet.
      await storeFor('assessmentContracts').put({
        id: 'PC-2', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
        contract_number: 'PC-0002', title: 'Multi-instalment contract', status: 'active',
        prepaid_amount: 40000, consumed_amount: 0, reserved_amount: 40000,
        max_assessments: 2, assessment_price: 20000,
        payment_status: 'verified', version: 1, data: {},
      });
      await storeFor('contractAssessments').put({
        id: 'B-1', contract_id: 'PC-2', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 1', status: 'reserved',
        item_price: 20000, version: 1,
      });
      await storeFor('contractAssessments').put({
        id: 'B-2', contract_id: 'PC-2', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 2', status: 'reserved',
        item_price: 20000, version: 1,
      });

      // Consume both assessments.
      const [r1, r2] = await Promise.all([
        transactionService.consumeContractAssessment({ contractId: 'PC-2', assessmentItemId: 'B-1' }),
        transactionService.consumeContractAssessment({ contractId: 'PC-2', assessmentItemId: 'B-2' }),
      ]);
      expect([r1, r2].every(Boolean)).toBe(true);

      // Wallet fully consumed; exactly two ledger DEDUCTION entries (one per
      // assessment), no duplicate revenue recognition.
      expect(await walletBalance()).toBe(0);
      const dedEntries = (await ledgerEntries()).filter((e: any) => e.debitAccountId === 'ACC-21300');
      expect(dedEntries).toHaveLength(2);
      const revCr = (await ledgerEntries()).filter((e: any) => e.creditAccountId === 'ACC-41100');
      expect(revCr).toHaveLength(2);
    });
  });

  // ─── Cross-contract aggregate reservations ───

  describe('cross-contract aggregate reservation protection', () => {
    beforeEach(() => {
      seedAccounts();
      vi.clearAllMocks();
      (window.localStorage as any).getItem.mockReturnValue(null);
    });

    it('two contracts for same customer: aggregate reservations protected at consumption', async () => {
      await seedCustomer(319200);

      // Contract 1: reserved_amount 239400 (3 x 79800)
      await storeFor('assessmentContracts').put({
        id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
        contract_number: 'PC-0001', title: 'Contract 1', status: 'active',
        prepaid_amount: 239400, consumed_amount: 0, reserved_amount: 239400,
        max_assessments: 3, assessment_price: 79800,
        payment_status: 'verified', version: 1, data: {},
      });
      await storeFor('contractAssessments').put({
        id: 'A-1', contract_id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 1', status: 'reserved',
        item_price: 79800, version: 1,
      });
      await storeFor('contractAssessments').put({
        id: 'A-2', contract_id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 2', status: 'reserved',
        item_price: 79800, version: 1,
      });
      await storeFor('contractAssessments').put({
        id: 'A-3', contract_id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 3', status: 'reserved',
        item_price: 79800, version: 1,
      });

      // Contract 2: reserved_amount 79800 (1 x 79800)
      await storeFor('assessmentContracts').put({
        id: 'PC-2', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
        contract_number: 'PC-0002', title: 'Contract 2', status: 'active',
        prepaid_amount: 79800, consumed_amount: 0, reserved_amount: 79800,
        max_assessments: 1, assessment_price: 79800,
        payment_status: 'verified', version: 1, data: {},
      });
      await storeFor('contractAssessments').put({
        id: 'A-4', contract_id: 'PC-2', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 4', status: 'reserved',
        item_price: 79800, version: 1,
      });

      // Total active reservations: 239400 + 79800 = 319200 == wallet balance
      // All 4 assessments can be consumed (each consumes K79,800)
      await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-1' });
      await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-2' });
      await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-3' });
      await transactionService.consumeContractAssessment({ contractId: 'PC-2', assessmentItemId: 'A-4' });

      expect(await walletBalance()).toBe(0);
    });

    it('wallet balance K0 with active reservations K319,200: consumption rejected', async () => {
      await seedCustomer(0);

      await storeFor('assessmentContracts').put({
        id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
        contract_number: 'PC-0001', title: 'Contract 1', status: 'active',
        prepaid_amount: 319200, consumed_amount: 0, reserved_amount: 319200,
        max_assessments: 4, assessment_price: 79800,
        payment_status: 'verified', version: 1, data: {},
      });
      await storeFor('contractAssessments').put({
        id: 'A-1', contract_id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1',
        school_id: 'SCH-1', assessment_name: 'Assessment 1', status: 'reserved',
        item_price: 79800, version: 1,
      });

      await expect(
        transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-1' })
      ).rejects.toThrow(/INSUFFICIENT_WALLET_FUNDS/);
      expect(await walletBalance()).toBe(0);
      expect((await storeFor('contractAssessments').get('A-1')).status).toBe('reserved');
    });
  });
});
