/**
 * invoiceProcessPosting.test.ts
 *
 * Service-level regression tests driving transactionService.processInvoice
 * against an in-memory store stub (no IndexedDB):
 * 1. Unpaid stocked invoice posts AR + split COGS + deducts stock
 * 2. Draft invoice posts nothing (no AR, no revenue, no COGS, no deduction)
 * 3. Cancelled invoice posts nothing
 * 4. Service-only invoice credits 41200 with no COGS/inventory movement
 * 5. Duplicate processing is blocked (idempotency) with no extra entries
 * 6. updateInvoice guard: cancel/total-change rejected, settlement allowed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── In-memory dbService stub ──────────────────────────────────────────

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

// ─── Fixtures ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11210', code: '11210', account_number: '11210', name: 'National Bank', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11240', code: '11240', account_number: '11240', name: 'Mobile Money', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', allow_posting: false, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41200', code: '41200', account_number: '41200', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Accrued Expenses', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

const STOCK = [
  { id: 'CHALK', name: 'Chalk (box)', type: 'Stationery', stock: 500, cost: 2800 },
  { id: 'JOURNAL', name: 'Journal', type: 'Product', stock: 200, cost: 3173.5 },
];

function stockedInvoice(overrides: any = {}) {
  return {
    id: 'INV-T1001',
    date: new Date().toISOString(),
    customerId: 'CUST-T1',
    customerName: 'Test School',
    status: 'Unpaid',
    paymentStatus: 'Unpaid',
    paymentTerms: 'Net 30',
    totalAmount: 238000,
    paidAmount: 0,
    items: [
      { id: 'CHALK', productId: 'CHALK', name: 'Chalk (box)', type: 'Stationery', quantity: 40, price: 4000, cost: 2800 },
      { id: 'JOURNAL', productId: 'JOURNAL', name: 'Journal', type: 'Product', quantity: 12, price: 6500, cost: 3173.5 },
    ],
    ...overrides,
  } as any;
}

function serviceInvoice(overrides: any = {}) {
  return {
    id: 'INV-T1002',
    date: new Date().toISOString(),
    customerId: 'CUST-T1',
    customerName: 'Test School',
    status: 'Unpaid',
    paymentStatus: 'Unpaid',
    paymentTerms: 'Net 30',
    totalAmount: 100000,
    paidAmount: 0,
    items: [{ id: 'SVC1', name: 'Consulting', type: 'Service', quantity: 2, price: 50000 }],
    ...overrides,
  } as any;
}

async function seed() {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  for (const s of STOCK) await storeFor('inventory').put({ ...s });
}

const ledger = () => storeFor('ledger').getAll() as Promise<any[]>;

// ─── Tests ─────────────────────────────────────────────────────────────

describe('processInvoice postings', () => {
  beforeEach(seed);

  it('unpaid stocked invoice posts AR + COGS for stock-bearing lines and deducts their stock', async () => {
    await transactionService.processInvoice(stockedInvoice());
    const entries = await ledger();

    const ar = entries.filter((e) => String(e.id).startsWith('LG-INV-AR'));
    expect(ar).toHaveLength(1);
    expect(ar[0].debitAccountId).toBe('ACC-11310');
    expect(ar[0].creditAccountId).toBe('ACC-41100');
    expect(ar[0].amount).toBe(238000);
    expect(ar[0].referenceId).toBe('INV-T1001');

    // Only the stock-bearing Stationery line relieves inventory. The Product
    // line is produced via BOM without being stocked: no 11410 leg, no
    // deduction — its raw-material cost was captured at production time.
    const cogs = entries.filter((e) => String(e.id).startsWith('LG-COGS'));
    expect(cogs).toHaveLength(1);
    expect(cogs[0].creditAccountId).toBe('ACC-11420');
    expect(cogs[0].debitAccountId).toBe('ACC-51200');
    expect(cogs[0].amount).toBeCloseTo(112000, 2); // 40 x 2800

    const chalk = await storeFor('inventory').get('CHALK');
    const journal = await storeFor('inventory').get('JOURNAL');
    expect(chalk.stock).toBe(460);
    expect(journal.stock).toBe(200);
  });

  it('draft invoice posts nothing and deducts nothing', async () => {
    await transactionService.processInvoice(stockedInvoice({ id: 'INV-T1003', status: 'Draft' }));
    expect(await ledger()).toEqual([]);
    expect((await storeFor('inventory').get('CHALK')).stock).toBe(500);
  });

  it('cancelled invoice posts nothing', async () => {
    await transactionService.processInvoice(stockedInvoice({ id: 'INV-T1004', status: 'Cancelled' }));
    expect(await ledger()).toEqual([]);
    expect((await storeFor('inventory').get('CHALK')).stock).toBe(500);
  });

  it('service-only invoice credits 41200 with no COGS or stock movement', async () => {
    await transactionService.processInvoice(serviceInvoice());
    const entries = await ledger();
    const ar = entries.filter((e) => String(e.id).startsWith('LG-INV-AR'));
    expect(ar).toHaveLength(1);
    expect(ar[0].debitAccountId).toBe('ACC-11310');
    expect(ar[0].creditAccountId).toBe('ACC-41200');
    expect(ar[0].amount).toBe(100000);
    expect(entries.filter((e) => String(e.id).startsWith('LG-COGS'))).toEqual([]);
  });

  it('duplicate processing is blocked without new entries', async () => {
    await transactionService.processInvoice(stockedInvoice());
    const before = (await ledger()).length;
    await expect(transactionService.processInvoice(stockedInvoice())).rejects.toThrow();
    expect((await ledger()).length).toBe(before);
  });
});

describe('updateInvoice lifecycle guard (service level)', () => {
  beforeEach(async () => {
    await seed();
    await storeFor('invoices').put({ ...stockedInvoice(), status: 'Unpaid' });
  });

  it('rejects cancelling a posted invoice by edit', async () => {
    await expect(
      transactionService.updateInvoice({ ...stockedInvoice(), status: 'Cancelled' } as any)
    ).rejects.toThrow(/void/i);
  });

  it('rejects editing totals after posting', async () => {
    await expect(
      transactionService.updateInvoice({ ...stockedInvoice(), totalAmount: 200000 } as any)
    ).rejects.toThrow(/reissue/i);
  });

  it('allows settlement updates', async () => {
    await expect(
      transactionService.updateInvoice({ ...stockedInvoice(), status: 'Paid', paidAmount: 238000 } as any)
    ).resolves.toBeTruthy();
  });
});
