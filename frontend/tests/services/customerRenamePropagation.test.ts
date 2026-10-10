import { describe, it, expect, beforeEach, vi } from 'vitest';

// The service under test writes through dbService; store access is faked so
// the rename rules can be asserted without IndexedDB.
const storeRows: Record<string, Array<Record<string, any>>> = {};
const puts: Array<{ store: string; record: Record<string, any> }> = [];

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn((storeName: string) => Promise.resolve(storeRows[storeName] || [])),
    get: vi.fn(() => Promise.resolve(null)),
    put: vi.fn((storeName: string, record: Record<string, any>) => {
      puts.push({ store: storeName, record });
      return Promise.resolve(String(record.id));
    }),
  },
}));

import {
  CUSTOMER_NAME_PROPAGATION_TARGETS,
  planCustomerRename,
  propagateCustomerRename,
  resolveCustomerDisplayName,
} from '../../services/customerRenamePropagation';

const resetState = () => {
  for (const key of Object.keys(storeRows)) delete storeRows[key];
  puts.length = 0;
};

describe('resolveCustomerDisplayName', () => {
  it('uses businessName, then companyName, then the legacy name', () => {
    expect(resolveCustomerDisplayName({ businessName: 'Acme Ltd', companyName: 'Acme', name: 'Acme' })).toBe('Acme Ltd');
    expect(resolveCustomerDisplayName({ companyName: 'Acme Ltd', name: 'Acme' })).toBe('Acme Ltd');
    expect(resolveCustomerDisplayName({ name: '  Acme  ' })).toBe('Acme');
    expect(resolveCustomerDisplayName(null)).toBe('');
  });
});

describe('planCustomerRename', () => {
  const base = {
    customerId: 'CUST-1',
    previousName: 'Acme',
    nextName: 'Acme Ltd',
    rowsByStore: {} as Record<string, Array<Record<string, any>>>,
    otherCustomerNames: [] as string[],
  };

  it('renames linked rows in every propagated store', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        sales: [{ id: 'S1', customerId: 'CUST-1', customerName: 'Acme', totalAmount: 10 }],
        invoices: [{ id: 'INV-1', customerId: 'CUST-1', customer_name: 'Acme', totalAmount: 10 }],
        customerPayments: [{ id: 'P1', customerId: 'CUST-1', customerName: 'Acme' }],
      },
    });

    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.map((entry) => entry.store).sort()).toEqual(['customerPayments', 'invoices', 'sales']);
    expect(plan.entries.find((e) => e.store === 'invoices')!.patch).toEqual({ customer_name: 'Acme Ltd' });
    expect(plan.entries.find((e) => e.store === 'sales')!.patch).toEqual({ customerName: 'Acme Ltd' });
  });

  it('never touches rows linked to another customer', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        sales: [{ id: 'S2', customerId: 'CUST-2', customerName: 'Acme' }],
      },
    });
    expect(plan.entries).toHaveLength(0);
  });

  it('renames unlinked legacy rows that still carry the previous name', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        quotations: [{ id: 'Q1', customerName: 'acme', total: 5 }],
      },
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].patch).toEqual({ customerName: 'Acme Ltd' });
  });

  it('leaves unlinked rows alone when another customer answers to the previous name', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        quotations: [{ id: 'Q1', customerName: 'Acme', total: 5 }],
      },
      otherCustomerNames: ['Acme'],
    });
    expect(plan.entries).toHaveLength(0);
    expect(plan.ambiguousPreviousName).toBe(true);
  });

  it('fills a missing denormalized name on linked rows only', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        sales: [{ id: 'S3', customerId: 'CUST-1' }],
        quotations: [{ id: 'Q2' }],
      },
    });
    expect(plan.entries).toEqual([
      { store: 'sales', id: 'S3', patch: { customerName: 'Acme Ltd' } },
    ]);
  });

  it('skips soft-deleted rows and unchanged names', () => {
    const plan = planCustomerRename({
      ...base,
      rowsByStore: {
        sales: [
          { id: 'S4', customerId: 'CUST-1', customerName: 'Acme', deleted: true },
          { id: 'S5', customerId: 'CUST-1', customerName: 'Acme', deletedAt: '2026-01-01T00:00:00Z' },
          { id: 'S6', customerId: 'CUST-1', customerName: 'Acme Ltd' },
        ],
      },
    });
    expect(plan.entries).toHaveLength(0);
  });

  it('is a no-op when the name did not change', () => {
    const plan = planCustomerRename({
      ...base,
      nextName: ' ACME ',
      rowsByStore: {
        sales: [{ id: 'S7', customerId: 'CUST-1', customerName: 'Acme' }],
      },
    });
    expect(plan.entries).toHaveLength(0);
  });

  it('covers every configured store in the planner', () => {
    for (const target of CUSTOMER_NAME_PROPAGATION_TARGETS) {
      const plan = planCustomerRename({
        ...base,
        rowsByStore: {
          [target.store]: [{ id: 'ROW-1', customerId: 'CUST-1', customerName: 'Acme' }],
        },
      });
      expect(plan.entries).toEqual([
        { store: target.store, id: 'ROW-1', patch: { customerName: 'Acme Ltd' } },
      ]);
    }
  });
});

describe('propagateCustomerRename', () => {
  beforeEach(() => {
    resetState();
  });

  it('writes the merged row for every renamed transaction', async () => {
    storeRows.customers = [
      { id: 'CUST-1', name: 'Acme', email: 'c1@example.com' },
      { id: 'CUST-2', name: 'Acme', email: 'c2@example.com' },
    ];
    storeRows.sales = [
      { id: 'S1', customerId: 'CUST-1', customerName: 'Acme', totalAmount: 100 },
      { id: 'S2', customerId: 'CUST-2', customerName: 'Acme', totalAmount: 50 },
      { id: 'S3', customerId: 'CUST-1', customerName: 'Acme Ltd', totalAmount: 10 },
    ];
    storeRows.invoices = [
      { id: 'INV-1', customerId: 'CUST-1', customerName: 'Acme', totalAmount: 100, notes: 'keep me' },
    ];
    storeRows.customerPayments = [
      { id: 'P1', customerName: 'Acme', amount: 20 },
    ];

    const result = await propagateCustomerRename({
      customerId: 'CUST-1',
      previousName: 'Acme',
      nextName: 'Acme Ltd',
    });

    // S3 already carries the new name; S2 belongs to another customer; P1 is
    // unlinked but the previous name is ambiguous (CUST-2 still answers to it).
    expect(result.updatedRecords).toBe(2);
    expect(result.stores.sort()).toEqual(['invoices', 'sales']);
    expect(result.ambiguousPreviousName).toBe(true);

    const invoiceWrite = puts.find((p) => p.store === 'invoices')!;
    expect(invoiceWrite.record).toEqual({
      id: 'INV-1',
      customerId: 'CUST-1',
      customerName: 'Acme Ltd',
      totalAmount: 100,
      notes: 'keep me',
    });
  });

  it('does not read or write anything when the name is unchanged', async () => {
    const result = await propagateCustomerRename({
      customerId: 'CUST-1',
      previousName: 'Acme Ltd',
      nextName: 'Acme Ltd',
    });
    expect(result.updatedRecords).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it('does nothing when there is no previous name to replace', async () => {
    const result = await propagateCustomerRename({
      customerId: 'CUST-1',
      previousName: '',
      nextName: 'Acme Ltd',
    });
    expect(result.updatedRecords).toBe(0);
    expect(puts).toHaveLength(0);
  });
});
