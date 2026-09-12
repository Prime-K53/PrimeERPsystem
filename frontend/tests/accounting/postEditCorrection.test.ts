/**
 * postEditCorrection.test.ts — STEP 14 regression tests for INV-P726/023 class
 * post-posting invoice edit corrections (K592,000 → K575,500 = K16,500).
 *
 * 1. Original posting           DR 11310 / CR revenue K592,000
 * 2. Post-posting reduction     DR revenue / CR 11310 K16,500
 * 3. Net accounting             AR = Revenue = K575,500
 * 4. Original journal preserved (still K592,000)
 * 5. Idempotency (run twice → one correction)
 * 6. Increase                   DR 11310 / CR revenue K18,000
 * 7. Non-accounting edit        no correction
 * 8. Controlled edit workflow   atomic invoice + correction
 * 9. Cancelled separation       correction rejected, void path only
 * 10. Services                  service-only corrections use 41200
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computePostEditCorrection } from '../../services/transactions/_internal';

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
  { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41200', code: '41200', account_number: '41200', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
];

const STOCK = [{ id: 'WIDGET', name: 'Widget', type: 'Product', stock: 1000, cost: 100 }];

function bigInvoice(overrides: any = {}) {
  return {
    id: 'INV-C2001',
    date: new Date().toISOString(),
    customerId: 'CUST-T1',
    customerName: 'Test School',
    status: 'Unpaid',
    paymentStatus: 'Unpaid',
    paymentTerms: 'Net 30',
    totalAmount: 592000,
    paidAmount: 0,
    items: [{ id: 'WIDGET', productId: 'WIDGET', name: 'Widget', type: 'Product', quantity: 148, price: 4000, cost: 100 }],
    ...overrides,
  } as any;
}

async function seed() {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  for (const s of STOCK) await storeFor('inventory').put({ ...s });
}

const ledger = () => storeFor('ledger').getAll() as Promise<any[]>;
const netArFor = async (invoiceId: string) => {
  const rows = (await ledger()).filter(
    (e) => e.referenceId === invoiceId || String(e.referenceId || '').startsWith(`${invoiceId}-POST-EDIT-CORRECTION`)
  );
  let net = 0;
  for (const e of rows) {
    if (e.debitAccountId === 'ACC-11310') net += Number(e.amount || 0);
    if (e.creditAccountId === 'ACC-11310') net -= Number(e.amount || 0);
  }
  return net;
};

// ─── Pure computation ──────────────────────────────────────────────────

describe('computePostEditCorrection', () => {
  const originals = [{ debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 592000 }];
  it('computes the K16,500 reduction', () => {
    const spec = computePostEditCorrection({
      invoiceId: 'INV-P726/023', currentTotal: 575500, originalArEntries: originals,
      priorCorrections: [], arAccountId: 'ACC-11310', revenueAccountId: 'ACC-41100',
    })!;
    expect(spec.direction).toBe('reduction');
    expect(spec.amount).toBe(16500);
    expect(spec.debitAccountId).toBe('ACC-41100');
    expect(spec.creditAccountId).toBe('ACC-11310');
    expect(spec.referenceId).toBe('INV-P726/023-POST-EDIT-CORRECTION');
  });
  it('returns null when books agree', () => {
    expect(computePostEditCorrection({
      invoiceId: 'INV-P726/023', currentTotal: 592000, originalArEntries: originals,
      priorCorrections: [], arAccountId: 'ACC-11310', revenueAccountId: 'ACC-41100',
    })).toBeNull();
  });
  it('nets prior corrections and sequences the next reference', () => {
    const spec = computePostEditCorrection({
      invoiceId: 'INV-P726/023', currentTotal: 570000, originalArEntries: originals,
      priorCorrections: [{ debitAccountId: 'ACC-41100', creditAccountId: 'ACC-11310', amount: 16500, referenceId: 'INV-P726/023-POST-EDIT-CORRECTION' }],
      arAccountId: 'ACC-11310', revenueAccountId: 'ACC-41100',
    })!;
    expect(spec.amount).toBe(5500);
    expect(spec.referenceId).toBe('INV-P726/023-POST-EDIT-CORRECTION-2');
  });
  it('STOPs on conflicting prior corrections', () => {
    expect(() => computePostEditCorrection({
      invoiceId: 'INV-X', currentTotal: 100, originalArEntries: originals,
      priorCorrections: [{ debitAccountId: 'ACC-99999', creditAccountId: 'ACC-11310', amount: 1, referenceId: 'X' }],
      arAccountId: 'ACC-11310', revenueAccountId: 'ACC-41100',
    })).toThrow(/STOP/);
  });
});

// ─── Service-level lifecycle ───────────────────────────────────────────

describe('post-edit correction lifecycle (service level)', () => {
  beforeEach(seed);

  it('Test 1 — original posting DR 11310 / CR revenue K592,000', async () => {
    await transactionService.processInvoice(bigInvoice());
    const ar = (await ledger()).filter((e) => String(e.id).startsWith('LG-INV-AR'));
    expect(ar).toHaveLength(1);
    expect(ar[0].debitAccountId).toBe('ACC-11310');
    expect(ar[0].creditAccountId).toBe('ACC-41100');
    expect(ar[0].amount).toBe(592000);
  });

  it('Test 2 — reduction posts DR revenue / CR 11310 K16,500', async () => {
    await transactionService.processInvoice(bigInvoice());
    // Simulate the legacy post-posting edit (direct record change, as happened
    // in production before the lifecycle guard existed).
    await storeFor('invoices').put({ ...bigInvoice(), totalAmount: 575500 });
    const res: any = await transactionService.postInvoiceEditCorrection('INV-C2001');
    expect(res.posted).toBe(true);
    expect(res.spec.amount).toBe(16500);
    expect(res.spec.debitAccountId).toBe('ACC-41100');
    expect(res.spec.creditAccountId).toBe('ACC-11310');
    expect(res.spec.referenceId).toBe('INV-C2001-POST-EDIT-CORRECTION');
  });

  it('Test 3 — net accounting AR = K575,500', async () => {
    await transactionService.processInvoice(bigInvoice());
    await storeFor('invoices').put({ ...bigInvoice(), totalAmount: 575500 });
    await transactionService.postInvoiceEditCorrection('INV-C2001');
    expect(await netArFor('INV-C2001')).toBe(575500);
  });

  it('Test 4 — original K592,000 journal preserved', async () => {
    await transactionService.processInvoice(bigInvoice());
    await storeFor('invoices').put({ ...bigInvoice(), totalAmount: 575500 });
    await transactionService.postInvoiceEditCorrection('INV-C2001');
    const ar = (await ledger()).filter((e) => String(e.id).startsWith('LG-INV-AR'));
    expect(ar).toHaveLength(1);
    expect(ar[0].amount).toBe(592000);
  });

  it('Test 5 — running twice still yields one correction', async () => {
    await transactionService.processInvoice(bigInvoice());
    await storeFor('invoices').put({ ...bigInvoice(), totalAmount: 575500 });
    const first: any = await transactionService.postInvoiceEditCorrection('INV-C2001');
    const second: any = await transactionService.postInvoiceEditCorrection('INV-C2001');
    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    const corrections = (await ledger()).filter((e) =>
      String(e.referenceId || '').startsWith('INV-C2001-POST-EDIT-CORRECTION')
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].amount).toBe(16500);
  });

  it('Test 6 — increase posts DR 11310 / CR revenue K18,000', async () => {
    await transactionService.processInvoice(bigInvoice({ id: 'INV-C2002' }));
    await storeFor('invoices').put({ ...bigInvoice({ id: 'INV-C2002' }), totalAmount: 610000 });
    const res: any = await transactionService.postInvoiceEditCorrection('INV-C2002');
    expect(res.posted).toBe(true);
    expect(res.spec.direction).toBe('increase');
    expect(res.spec.amount).toBe(18000);
    expect(res.spec.debitAccountId).toBe('ACC-11310');
    expect(res.spec.creditAccountId).toBe('ACC-41100');
    expect(await netArFor('INV-C2002')).toBe(610000);
  });

  it('Test 7 — non-accounting edit creates no correction', async () => {
    await transactionService.processInvoice(bigInvoice({ id: 'INV-C2004' }));
    const res: any = await transactionService.applyPostedInvoiceEdit({
      ...bigInvoice({ id: 'INV-C2004' }),
      notes: 'Call back Thursday',
    });
    expect(res.corrected).toBe(false);
    const corrections = (await ledger()).filter((e) =>
      String(e.referenceId || '').startsWith('INV-C2004-POST-EDIT-CORRECTION')
    );
    expect(corrections).toEqual([]);
  });

  it('Test 8 — controlled edit is atomic (invoice + correction)', async () => {
    await transactionService.processInvoice(bigInvoice({ id: 'INV-C2005' }));
    const res: any = await transactionService.applyPostedInvoiceEdit({
      ...bigInvoice({ id: 'INV-C2005' }),
      totalAmount: 575500,
      items: [{ id: 'WIDGET', productId: 'WIDGET', name: 'Widget', type: 'Product', quantity: 140, price: 4000, cost: 100 }],
    });
    expect(res.corrected).toBe(true);
    expect(res.spec.amount).toBe(16500);
    const saved = await storeFor('invoices').get('INV-C2005');
    expect(saved.totalAmount).toBe(575500);
    expect(await netArFor('INV-C2005')).toBe(575500);
  });

  it('Test 9 — cancelled invoices stay on the void path', async () => {
    await transactionService.processInvoice(bigInvoice({ id: 'INV-C2006' }));
    await storeFor('invoices').put({ ...bigInvoice({ id: 'INV-C2006' }), status: 'Cancelled' });
    await expect(transactionService.postInvoiceEditCorrection('INV-C2006')).rejects.toThrow(/voidInvoice/i);
    // And bare-edit cancellation is still blocked by the lifecycle guard.
    await expect(
      transactionService.updateInvoice({ ...bigInvoice({ id: 'INV-C2006' }), status: 'Cancelled' } as any)
    ).rejects.toThrow(/void/i);
  });

  it('Test 10 — service-only corrections use 41200', async () => {
    const svc = {
      id: 'INV-C2003', date: new Date().toISOString(), customerId: 'CUST-T1', customerName: 'Test School',
      status: 'Unpaid', paymentStatus: 'Unpaid', paymentTerms: 'Net 30', totalAmount: 100000, paidAmount: 0,
      items: [{ id: 'SVC', name: 'Consulting', type: 'Service', quantity: 2, price: 50000 }],
    } as any;
    await transactionService.processInvoice(svc);
    await storeFor('invoices').put({ ...svc, totalAmount: 90000 });
    const res: any = await transactionService.postInvoiceEditCorrection('INV-C2003');
    expect(res.posted).toBe(true);
    expect(res.spec.amount).toBe(10000);
    expect(res.spec.debitAccountId).toBe('ACC-41200');
    expect(res.spec.creditAccountId).toBe('ACC-11310');
  });
});
