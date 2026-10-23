import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { openDB } from 'idb';

vi.unmock('idb');

import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';

const POSTING_ACCOUNTS = [
  { id: 'ACC-11310', code: '11310', name: 'Trade Debtors', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'RECEIVABLE', is_system_account: true, allow_posting: true },
  { id: 'ACC-21300', code: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', type: 'Liability', account_group: 'CURRENT_LIABILITY', subtype: 'PAYABLE', allow_posting: true },
  { id: 'ACC-11110', code: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'CASH', is_system_account: true, allow_posting: true },
  { id: 'ACC-11210', code: '11210', name: 'Bank Account', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'BANK', is_system_account: true, allow_posting: true },
  { id: 'ACC-11240', code: '11240', name: 'Mobile Money', account_type: 'ASSET', type: 'Asset', account_group: 'CURRENT_ASSET', subtype: 'MOBILE_MONEY', is_system_account: true, allow_posting: true },
  { id: 'ACC-41100', code: '41100', name: 'Product Sales', account_type: 'INCOME', type: 'Revenue', account_group: 'REVENUE', is_system_account: true, allow_posting: true },
];

async function seedFundingCustomer(customerId: string, accounts = POSTING_ACCOUNTS, walletBalance = 0) {
  await dbService.executeAtomicOperation(
    ['accounts', 'customers'],
    async (tx: { objectStore: (name: string) => { put: (record: unknown) => Promise<unknown> } }) => {
      for (const account of accounts) await tx.objectStore('accounts').put(account);
      await tx.objectStore('customers').put({ id: customerId, name: 'Atomic test customer', walletBalance });
    },
  );
}

function printingInvoice(id: string, customerId: string, paidAmount: number, status: string) {
  return {
    id,
    invoiceNumber: id,
    customerId,
    customerName: 'Atomic test customer',
    status,
    totalAmount: 40000,
    paidAmount,
    paymentMethod: 'Cash',
    originModule: 'printing_contract',
    reference: `PC-${id}`,
    date: '2026-10-18T00:00:00.000Z',
    items: [],
  } as any;
}

describe('dbService.executeAtomicOperation — IndexedDB transaction boundary', () => {
  it('rolls back writes across stores when a later operation fails', async () => {
    const suffix = crypto.randomUUID();
    const invoiceId = `ATOMIC-INV-${suffix}`;
    const ledgerId = `ATOMIC-LEDGER-${suffix}`;

    await expect(
      dbService.executeAtomicOperation(
        ['invoices', 'ledger'],
        async (tx: {
          objectStore: (name: string) => { put: (record: unknown) => Promise<unknown> };
        }) => {
          await tx.objectStore('invoices').put({ id: invoiceId });
          await tx.objectStore('ledger').put({ id: ledgerId });
          throw new Error('SIMULATED_ATOMIC_FAILURE');
        },
      ),
    ).rejects.toThrow('SIMULATED_ATOMIC_FAILURE');

    expect(await dbService.get('invoices', invoiceId)).toBeUndefined();
    expect(await dbService.get('ledger', ledgerId)).toBeUndefined();
  });

  it('serializes concurrent read-modify-write funding events in the real store', async () => {
    const suffix = crypto.randomUUID();
    const customerId = `ATOMIC-CUSTOMER-${suffix}`;
    const eventId = `wallet:contract:invoice:${suffix}:prepaid:10000`;
    await dbService.executeAtomicOperation(
      ['customers'],
      async (tx: { objectStore: (name: string) => { put: (record: unknown) => Promise<unknown> } }) =>
        tx.objectStore('customers').put({ id: customerId, walletBalance: 0 }),
    );

    const fundOnce = () => dbService.executeAtomicOperation(
      ['customers', 'walletTransactions', 'idempotencyKeys'],
      async (tx: {
        objectStore: (name: string) => {
          get: (id: string) => Promise<any>;
          put: (record: any) => Promise<unknown>;
        };
      }) => {
        const keys = tx.objectStore('idempotencyKeys');
        if (await keys.get(eventId)) return;

        const customers = tx.objectStore('customers');
        const customer = await customers.get(customerId);
        await customers.put({ ...customer, walletBalance: customer.walletBalance + 10000 });
        await tx.objectStore('walletTransactions').put({
          id: `ATOMIC-WTX-${suffix}`,
          customerId,
          amount: 10000,
          type: 'Deposit',
          idempotencyKey: eventId,
        });
        await keys.put({
          id: eventId,
          scope: 'contract_prepaid_funding',
          sourceId: suffix,
          createdAt: new Date().toISOString(),
        });
      },
    );

    // A second independent connection exercises the persistence lock, though
    // Vitest does not launch a separate browser tab.
    const secondConnection: any = await openDB('PrimeERP_Final_v3_Clean', 61);
    try {
      await Promise.all([
        fundOnce(),
        (async () => {
          const transaction = secondConnection.transaction(
            ['customers', 'walletTransactions', 'idempotencyKeys'],
            'readwrite',
          );
          const keys = transaction.objectStore('idempotencyKeys');
          if (!(await keys.get(eventId))) {
            const customers = transaction.objectStore('customers');
            const customer = await customers.get(customerId);
            await customers.put({ ...customer, walletBalance: customer.walletBalance + 10000 });
            await transaction.objectStore('walletTransactions').put({
              id: `ATOMIC-WTX-${suffix}`,
              customerId,
              amount: 10000,
              type: 'Deposit',
              idempotencyKey: eventId,
            });
            await keys.put({
              id: eventId,
              scope: 'contract_prepaid_funding',
              sourceId: suffix,
              createdAt: new Date().toISOString(),
            });
          }
          await transaction.done;
        })(),
      ]);
    } finally {
      secondConnection.close();
    }

    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(10000);
    expect((await dbService.getAll<any>('walletTransactions')).filter(
      (record) => record.id === `ATOMIC-WTX-${suffix}`,
    )).toHaveLength(1);
    expect(await dbService.get('idempotencyKeys', eventId)).toBeTruthy();
  });

  it('applies concurrent duplicate first instalments then a second instalment once each', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-INSTALLMENT-${suffix}`;
    const invoiceId = `ATOMIC-INVOICE-INSTALLMENT-${suffix}`;
    await seedFundingCustomer(customerId);

    const base = printingInvoice(invoiceId, customerId, 0, 'Unpaid');
    await Promise.all([
      transactionService.updateInvoice({ ...base, paidAmount: 10000, status: 'Partial' }),
      transactionService.updateInvoice({ ...base, paidAmount: 10000, status: 'Partial' }),
    ]);
    await transactionService.updateInvoice({ ...base, paidAmount: 20000, status: 'Partial' });

    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(20000);
    expect((await dbService.get<any>('invoices', invoiceId))?.paidAmount).toBe(20000);
    const funding = (await dbService.getAll<any>('walletTransactions')).filter(
      (record) => record.reference === invoiceId,
    );
    expect(funding.map((record) => record.amount)).toEqual([10000, 10000]);
    expect(new Set(funding.map((record) => record.id)).size).toBe(2);
  });

  it('serializes simultaneous funding for separate invoices sharing a customer', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-MULTI-${suffix}`;
    await seedFundingCustomer(customerId);
    const invoices = [1, 2, 3].map((index) =>
      printingInvoice(`ATOMIC-INVOICE-${index}-${suffix}`, customerId, 10000, 'Partial'),
    );

    await Promise.all(invoices.map((invoice) => transactionService.updateInvoice(invoice)));

    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(30000);
    const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
    const funding = (await dbService.getAll<any>('walletTransactions')).filter(
      (record) => invoiceIds.has(record.reference),
    );
    expect(funding).toHaveLength(3);
    expect(new Set(funding.map((record) => record.id)).size).toBe(3);
  });

  it('serializes concurrent assessment consumption through the production service', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-CONSUME-${suffix}`;
    const contractIds = [1, 2].map((index) => `ATOMIC-CONTRACT-${index}-${suffix}`);
    const itemIds = [1, 2].map((index) => `ATOMIC-ASSESSMENT-${index}-${suffix}`);
    await seedFundingCustomer(customerId, POSTING_ACCOUNTS, 20000);
    await dbService.executeAtomicOperation(
      ['assessmentContracts', 'contractAssessments', 'settings'],
      async (tx: { objectStore: (name: string) => { put: (record: unknown) => Promise<unknown> } }) => {
        await tx.objectStore('settings').put({ id: 'financial_closed_periods', value: [] });
        for (let index = 0; index < contractIds.length; index += 1) {
          await tx.objectStore('assessmentContracts').put({
            id: contractIds[index],
            contract_number: contractIds[index],
            customer_id: customerId,
            status: 'active',
            reserved_amount: 10000,
            consumed_amount: 0,
            version: 1,
          });
          await tx.objectStore('contractAssessments').put({
            id: itemIds[index],
            contract_id: contractIds[index],
            status: 'reserved',
            item_price: 10000,
            version: 1,
          });
        }
      },
    );

    await Promise.all(itemIds.map((assessmentItemId, index) =>
      transactionService.consumeContractAssessment({
        contractId: contractIds[index],
        assessmentItemId,
      }),
    ));

    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(0);
    const transactions = (await dbService.getAll<any>('walletTransactions')).filter(
      (record) => itemIds.some((itemId) => record.id === `WTX-${itemId}-CONSUMED`),
    );
    expect(transactions).toHaveLength(2);
    expect(new Set(transactions.map((record) => record.id)).size).toBe(2);
    expect((await dbService.getAll<any>('ledger')).filter(
      (record) => itemIds.includes(record.referenceId),
    )).toHaveLength(2);
    for (const itemId of itemIds) {
      expect((await dbService.get<any>('contractAssessments', itemId))?.status).toBe('consumed');
    }
  });

  it('creates a printing contract atomically when the closed-period registry is read inside the transaction', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-CONTRACT-${suffix}`;
    const contractId = `ATOMIC-CONTRACT-CREATE-${suffix}`;
    const itemId = `ATOMIC-ASSESSMENT-CREATE-${suffix}`;
    await seedFundingCustomer(customerId);
    // Persist the registry in IndexedDB so the async getSetting path would
    // open a separate transaction; the atomic operation must read it through
    // its own tx instead of letting the readwrite transaction auto-commit.
    await dbService.saveSetting('financial_closed_periods', []);

    const nowIso = new Date().toISOString();
    const result = await transactionService.createPrintingContractWithItems({
      contract: {
        id: contractId,
        contract_number: contractId,
        customer_id: customerId,
        company_id: 'ATOMIC-COMPANY',
        title: 'Atomic contract creation',
        status: 'draft',
        max_assessments: 2,
        prepaid_amount: 0,
        reserved_amount: 0,
        consumed_amount: 0,
        created_at: nowIso,
        updated_at: nowIso,
        version: 1,
      } as any,
      items: [{
        id: itemId,
        assessment_name: 'Atomic assessment',
        item_price: 1000,
        assessment_date: nowIso.slice(0, 10),
      }],
    });

    expect(result).toMatchObject({ success: true, contractId, reservedAmount: 1000, itemCount: 1 });
    expect(await dbService.get<any>('assessmentContracts', contractId)).toMatchObject({
      status: 'draft',
      reserved_amount: 1000,
      assessment_count: 1,
    });
    expect(await dbService.get<any>('contractAssessments', itemId)).toMatchObject({
      contract_id: contractId,
      status: 'reserved',
      item_price: 1000,
    });
  });

  it('refuses printing-contract creation inside a closed period without writing', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-CONTRACT-CLOSED-${suffix}`;
    const contractId = `ATOMIC-CONTRACT-CLOSED-${suffix}`;
    const itemId = `ATOMIC-ASSESSMENT-CLOSED-${suffix}`;
    await seedFundingCustomer(customerId);
    await dbService.saveSetting('financial_closed_periods', [{
      id: 'ATOMIC-FP-CLOSED',
      from: '2026-01-01',
      to: '2026-01-31',
      reason: 'Atomic close',
      closedAt: new Date().toISOString(),
      closedBy: 'test',
    }]);

    const nowIso = new Date().toISOString();
    await expect(transactionService.createPrintingContractWithItems({
      contract: {
        id: contractId,
        contract_number: contractId,
        customer_id: customerId,
        company_id: 'ATOMIC-COMPANY',
        title: 'Closed-period contract',
        status: 'draft',
        max_assessments: 1,
        prepaid_amount: 0,
        reserved_amount: 0,
        consumed_amount: 0,
        created_at: nowIso,
        updated_at: nowIso,
        version: 1,
      } as any,
      items: [{
        id: itemId,
        assessment_name: 'Closed-period assessment',
        item_price: 1000,
        assessment_date: '2026-01-15',
      }],
    })).rejects.toThrow(/closed.*not permitted within a closed financial period/i);

    expect(await dbService.get('assessmentContracts', contractId)).toBeUndefined();
    expect(await dbService.get('contractAssessments', itemId)).toBeUndefined();
    await dbService.saveSetting('financial_closed_periods', []);
  });

  it('rolls back actual invoice funding when account resolution fails after wallet writes', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-ACCOUNT-${suffix}`;
    const invoiceId = `ATOMIC-INVOICE-ACCOUNT-${suffix}`;
    await dbService.executeAtomicOperation(
      ['accounts'],
      async (tx: { objectStore: (name: string) => { delete: (id: string) => Promise<void> } }) =>
        tx.objectStore('accounts').delete('ACC-11110'),
    );
    await seedFundingCustomer(customerId, POSTING_ACCOUNTS.filter((account) => account.id !== 'ACC-11110'));

    await expect(
      transactionService.updateInvoice(printingInvoice(invoiceId, customerId, 10000, 'Partial')),
    ).rejects.toThrow(/account/i);

    expect(await dbService.get('invoices', invoiceId)).toBeUndefined();
    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(0);
    expect((await dbService.getAll<any>('walletTransactions')).filter(
      (record) => record.reference === invoiceId,
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('ledger')).filter(
      (record) => record.description?.includes(invoiceId),
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('customerPayments')).filter(
      (record) => record.reference === invoiceId,
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('idempotencyKeys')).filter(
      (record) => record.sourceId === invoiceId,
    )).toHaveLength(0);
  });

  it('rolls back actual overpayment processing when a later wallet write fails', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerId = `ATOMIC-CUSTOMER-OVERPAY-${suffix}`;
    const invoiceId = `INV-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const overpaymentTxId = `WALLET-OVERPAY-${invoiceId}`;
    await seedFundingCustomer(customerId);

    let failureInjected = false;
    const runAtomicOperation = dbService.executeAtomicOperation.bind(dbService);
    const executeSpy = vi.spyOn(dbService, 'executeAtomicOperation').mockImplementation(
      (async (stores: any[], operation: any) => runAtomicOperation(
        stores,
        async (tx: any) => operation({
          ...tx,
          objectStore: (storeName: string) => {
            const store = tx.objectStore(storeName);
            if (storeName !== 'walletTransactions') return store;
            return {
              ...store,
              put: async (record: any) => {
                if (record.id === overpaymentTxId) {
                  failureInjected = true;
                  throw new Error('SIMULATED_REAL_OVERPAYMENT_WRITE_FAILURE');
                }
                return store.put(record);
              },
            };
          },
        }),
      )) as any,
    );

    try {
      await expect(transactionService.processInvoice({
        ...printingInvoice(invoiceId, customerId, 15000, 'Paid'),
        invoiceNumber: invoiceId,
        totalAmount: 10000,
      })).rejects.toThrow(/SIMULATED_REAL_OVERPAYMENT_WRITE_FAILURE/);
    } finally {
      executeSpy.mockRestore();
    }

    expect(failureInjected).toBe(true);
    expect(await dbService.get('invoices', invoiceId)).toBeUndefined();
    expect((await dbService.get<any>('customers', customerId))?.walletBalance).toBe(0);
    expect((await dbService.getAll<any>('walletTransactions')).filter(
      (record) => record.reference === invoiceId,
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('ledger')).filter(
      (record) => record.referenceId === invoiceId,
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('customerPayments')).filter(
      (record) => record.reference === invoiceId,
    )).toHaveLength(0);
    expect((await dbService.getAll<any>('idempotencyKeys')).filter(
      (record) => record.sourceId === invoiceId,
    )).toHaveLength(0);
  });
});
