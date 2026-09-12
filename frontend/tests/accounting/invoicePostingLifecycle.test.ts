/**
 * invoicePostingLifecycle.test.ts
 *
 * Regression tests for the receivables/inventory/COGS posting rules:
 * 1. Draft/Cancelled invoices post nothing (AR, revenue, COGS, inventory)
 * 2. Service-only invoices credit 41200 Service Income (never 41100)
 * 3. Mixed invoices split COGS across 11410/11420/11430 by line cost
 *    (DR 51200 total = CR 11410 + CR 11420 + CR 11430)
 * 4. Services never relieve inventory
 * 5. Posted invoices are immutable by bare edit (cancel/total/lines guard)
 *
 * Covers spec sections: AR model (3), inventory classification (7, 12),
 * services (10), fulfillment vs payment (13), idempotency-adjacent lifecycle (20).
 */

import { describe, it, expect } from 'vitest';
import {
  isPostedInvoiceStatus,
  isServiceOnlyInvoice,
  resolveInvoiceRevenueAccount,
  assertInvoiceEditable,
  calculateCogsLegsPerInventoryAccount,
} from '../../services/transactions/_internal';

// ─── Fixtures ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', allow_posting: false, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', parent_account_id: 'ACC-11400', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
];

const INVENTORY = [
  { id: 'CHALK', name: 'Chalk (box)', type: 'Stationery', stock: 500, cost: 2800 },
  { id: 'JOURNAL', name: 'Student Management Journal', type: 'Product', stock: 200, cost: 3173.5 },
  { id: 'BOOK', name: 'Exercise Book', type: 'Finished Good', stock: 100, cost: 1500 },
];

const byId = (id: string) => (item: any) => item.productId || item.id || id;

// ─── 1. Active-status gate ─────────────────────────────────────────────

describe('isPostedInvoiceStatus', () => {
  it.each(['Unpaid', 'Partial', 'Paid', 'Approved', 'Overdue'])('posts for active status %s', (s) => {
    expect(isPostedInvoiceStatus(s)).toBe(true);
  });
  it.each(['Draft', 'Cancelled'])('posts nothing for %s', (s) => {
    expect(isPostedInvoiceStatus(s)).toBe(false);
  });
});

// ─── 2. Service-only detection + revenue routing ───────────────────────

describe('service revenue routing (41200)', () => {
  it('detects service-only invoices', () => {
    expect(isServiceOnlyInvoice([{ type: 'Service' }, { type: 'Service' }])).toBe(true);
    expect(isServiceOnlyInvoice([{ type: 'Service' }, { type: 'Product' }])).toBe(false);
    expect(isServiceOnlyInvoice([{ type: 'Product' }])).toBe(false);
    expect(isServiceOnlyInvoice([])).toBe(false);
  });

  it('routes service-only invoices to 41200 when no explicit account', () => {
    const inv = { items: [{ type: 'Service', quantity: 2, price: 50000 }] };
    expect(resolveInvoiceRevenueAccount(inv, '41100')).toBe('41200');
  });

  it('keeps stocked and mixed invoices on the default sales account', () => {
    expect(resolveInvoiceRevenueAccount({ items: [{ type: 'Product' }] }, '41100')).toBe('41100');
    expect(resolveInvoiceRevenueAccount({ items: [{ type: 'Service' }, { type: 'Product' }] }, '41100')).toBe('41100');
    expect(resolveInvoiceRevenueAccount({ items: [] }, '41100')).toBe('41100');
  });

  it('explicit salesAccountId always wins', () => {
    expect(resolveInvoiceRevenueAccount({ salesAccountId: '41100', items: [{ type: 'Service' }] }, '41100')).toBe('41100');
    expect(resolveInvoiceRevenueAccount({ salesAccountId: '41200', items: [{ type: 'Product' }] }, '41100')).toBe('41200');
  });
});

// ─── 3. COGS split across inventory accounts ───────────────────────────

describe('calculateCogsLegsPerInventoryAccount', () => {
  it('splits mixed Stationery/Product invoices by line cost', async () => {
    const items = [
      { id: 'CHALK', type: 'Stationery', quantity: 40, cost: 2800 },
      { id: 'JOURNAL', type: 'Product', quantity: 12, cost: 3173.5 },
    ];
    const legs = await calculateCogsLegsPerInventoryAccount(items, INVENTORY, byId(''), ACCOUNTS, null);
    expect(legs).toHaveLength(2);
    const byCode = Object.fromEntries(legs.map((l) => [l.inventoryAccountCode, l]));
    // Stationery -> 11420 Raw Materials; Product -> 11410 Merchandise
    expect(byCode['11420'].amount).toBeCloseTo(112000, 2);
    expect(byCode['11410'].amount).toBeCloseTo(38082, 2);
    expect(byCode['11420'].inventoryAccountId).toBe('ACC-11420');
    expect(byCode['11410'].inventoryAccountId).toBe('ACC-11410');
    // DR 51200 total must equal the sum of inventory credits
    const total = legs.reduce((s, l) => s + l.amount, 0);
    expect(total).toBeCloseTo(150082, 2);
  });

  it('never relieves inventory for service lines', async () => {
    const items = [{ id: 'SVC', type: 'Service', quantity: 2, price: 50000, cost: 0 }];
    const legs = await calculateCogsLegsPerInventoryAccount(items, INVENTORY, byId(''), ACCOUNTS, null);
    expect(legs).toEqual([]);
  });

  it('skips zero-cost and zero-quantity lines', async () => {
    const noCostInventory = [{ id: 'FREE', name: 'Free sample', type: 'Product', stock: 10, cost: 0 }];
    const items = [
      { id: 'CHALK', type: 'Stationery', quantity: 0, cost: 2800 },
      { id: 'FREE', type: 'Product', quantity: 12, cost: 0 },
    ];
    const legs = await calculateCogsLegsPerInventoryAccount(items, noCostInventory, byId(''), ACCOUNTS, null);
    expect(legs).toEqual([]);
  });

  it('falls back to the inventory master cost when the line carries none', async () => {
    // Same hierarchy as calculateItemsCost: line snapshot first, master cost next.
    const items = [{ id: 'JOURNAL', type: 'Product', quantity: 12, cost: 0 }];
    const legs = await calculateCogsLegsPerInventoryAccount(items, INVENTORY, byId(''), ACCOUNTS, null);
    expect(legs).toHaveLength(1);
    expect(legs[0].inventoryAccountCode).toBe('11410');
    expect(legs[0].amount).toBeCloseTo(12 * 3173.5, 2);
  });

  it('keeps unknown types in the historical default bucket (11410)', async () => {
    const items = [{ id: 'ODD', type: 'Mystery', quantity: 3, cost: 1000 }];
    const legs = await calculateCogsLegsPerInventoryAccount(
      items, [{ id: 'ODD', cost: 1000 }], byId(''), ACCOUNTS, null
    );
    expect(legs).toHaveLength(1);
    expect(legs[0].inventoryAccountCode).toBe('11410');
    expect(legs[0].amount).toBeCloseTo(3000, 2);
  });

  it('resolves finished goods to 11430', async () => {
    const items = [{ id: 'BOOK', type: 'Finished Good', quantity: 4, cost: 1500 }];
    const legs = await calculateCogsLegsPerInventoryAccount(items, INVENTORY, byId(''), ACCOUNTS, null);
    expect(legs).toHaveLength(1);
    expect(legs[0].inventoryAccountCode).toBe('11430');
    expect(legs[0].inventoryAccountId).toBe('ACC-11430');
    expect(legs[0].amount).toBeCloseTo(6000, 2);
  });

  it('returns no legs for empty invoices', async () => {
    expect(await calculateCogsLegsPerInventoryAccount([], INVENTORY, byId(''), ACCOUNTS, null)).toEqual([]);
  });
});

// ─── 4. Posted-invoice edit guard ──────────────────────────────────────

describe('assertInvoiceEditable', () => {
  const posted = {
    id: 'INV-1',
    status: 'Unpaid',
    totalAmount: 575500,
    items: [{ id: 'CHALK', quantity: 40, price: 4000 }],
  };

  it('allows settlement transitions (Paid + paidAmount)', () => {
    expect(() => assertInvoiceEditable(posted, { ...posted, status: 'Paid', paidAmount: 575500 })).not.toThrow();
  });

  it('allows notes-only edits on posted invoices', () => {
    expect(() => assertInvoiceEditable(posted, { ...posted, notes: 'hello' })).not.toThrow();
  });

  it('allows any edit while still a draft', () => {
    const draft = { ...posted, status: 'Draft' };
    expect(() => assertInvoiceEditable(draft, { ...draft, status: 'Cancelled', totalAmount: 1, items: [] })).not.toThrow();
  });

  it('allows creating (no existing record)', () => {
    expect(() => assertInvoiceEditable(undefined, posted)).not.toThrow();
  });

  it('blocks cancelling a posted invoice by edit', () => {
    expect(() => assertInvoiceEditable(posted, { ...posted, status: 'Cancelled' })).toThrow(/void/i);
  });

  it('blocks editing totals after posting', () => {
    expect(() => assertInvoiceEditable(posted, { ...posted, totalAmount: 592000 })).toThrow(/void and reissue/i);
  });

  it('blocks editing lines after posting', () => {
    const changed = { ...posted, items: [{ id: 'CHALK', quantity: 41, price: 4000 }], totalAmount: 579500 };
    expect(() => assertInvoiceEditable(posted, changed)).toThrow(/void and reissue/i);
  });
});
