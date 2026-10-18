/**
 * statementExportIsolation.acceptance.test.ts
 *
 * ACCEPTANCE: a parent statement and a branch statement can never display each
 * other's financial information — in the persisted snapshot, in the exported
 * (PDF) document payload, or through the public verification response.
 *
 * Drives the REAL `statementService` (in-memory store), the REAL PDF mapper and
 * the REAL statement schema. No source-string assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, any>();

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async () => Array.from(store.values())),
    get: vi.fn(async (_s: string, id: string) => store.get(String(id)) || null),
    put: vi.fn(async (_s: string, record: any) => {
      store.set(String(record.id), { ...record });
      return String(record.id);
    }),
  },
}));

import { createStatementSnapshot, getStatementSnapshot } from '../../services/statementService';
import { mapToInvoiceData } from '../../utils/pdfMapper';

let entropyCounter = 7;
Object.defineProperty(globalThis, 'crypto', {
  value: {
    ...(globalThis as any).crypto,
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (entropyCounter + i) % 256;
      entropyCounter += 1;
      return arr;
    },
  },
  writable: true,
  configurable: true,
});

const CUSTOMER = {
  id: 'CUST-ACME',
  name: 'Acme Schools',
  subAccounts: [
    { id: 'SUB-A', name: 'Campus' },
    { id: 'SUB-B', name: 'Campus' },
  ],
};

const PERIOD = { periodStart: '2026-08-01', periodEnd: '2026-08-31' };

const MAIN_MONEY = {
  openingBalance: 100,
  transactions: [{ date: '2026-08-05', reference: 'INV-MAIN', debit: 500, credit: 0, runningBalance: 600 }],
  totalInvoiced: 500,
  totalReceived: 0,
  closingBalance: 600,
};
const BRANCH_A_MONEY = {
  openingBalance: 0,
  transactions: [{ date: '2026-08-07', reference: 'INV-A', debit: 200, credit: 0, runningBalance: 200 }],
  totalInvoiced: 200,
  totalReceived: 0,
  closingBalance: 200,
};
const BRANCH_B_MONEY = {
  openingBalance: 0,
  transactions: [{ date: '2026-08-09', reference: 'INV-B', debit: 900, credit: 0, runningBalance: 900 }],
  totalInvoiced: 900,
  totalReceived: 0,
  closingBalance: 900,
};

const company = { name: 'Prime', currency: 'MWK', currencyCode: 'MWK' } as any;

async function snapshotFor(suffix: string, money: any, branch: { subAccountId: string } | 'main') {
  return createStatementSnapshot({
    customerId: CUSTOMER.id,
    customerName: CUSTOMER.name,
    ...PERIOD,
    currency: 'MWK',
    ...money,
    ...(branch === 'main' ? { branchKey: 'main' } : { subAccountId: branch.subAccountId, customer: CUSTOMER as any }),
  } as any, suffix);
}

beforeEach(() => { store.clear(); });

describe('ACCEPTANCE 7 — statement exports and verification cannot cross accounts', () => {
  it('the three accounts each keep their own snapshot for the SAME period', async () => {
    await snapshotFor('1', MAIN_MONEY, 'main');
    await snapshotFor('2', BRANCH_A_MONEY, { subAccountId: 'SUB-A' });
    await snapshotFor('3', BRANCH_B_MONEY, { subAccountId: 'SUB-B' });

    expect(store.size).toBe(3);
    const byKey = new Map(Array.from(store.values()).map((s: any) => [String(s.branchKey), s]));
    expect(Array.from(byKey.keys()).sort()).toEqual(['id:SUB-A', 'id:SUB-B', 'main']);
    expect(byKey.get('main')!.totalInvoiced).toBe(500);
    expect(byKey.get('id:SUB-A')!.totalInvoiced).toBe(200);
    expect(byKey.get('id:SUB-B')!.totalInvoiced).toBe(900);
  });

  it('retrieval by number returns the account it was issued for', async () => {
    const main = await snapshotFor('1', MAIN_MONEY, 'main');
    const branchA = await snapshotFor('2', BRANCH_A_MONEY, { subAccountId: 'SUB-A' });

    const fetchedMain = await getStatementSnapshot(main.statementNumber || main.id);
    const fetchedBranch = await getStatementSnapshot(branchA.statementNumber || branchA.id);
    expect(fetchedMain.branchKey).toBe('main');
    expect(fetchedMain.totalInvoiced).toBe(500);
    expect(fetchedBranch.branchKey).toBe('id:SUB-A');
    expect(fetchedBranch.subAccountId).toBe('SUB-A');
    expect(fetchedBranch.totalInvoiced).toBe(200);
  });

  it('the exported Main document carries Main numbers only and no branch label', async () => {
    await snapshotFor('1', MAIN_MONEY, 'main');
    const main = Array.from(store.values()).find((s: any) => s.branchKey === 'main') as any;
    const mapped: any = mapToInvoiceData(main, company, 'ACCOUNT_STATEMENT');

    expect(mapped.openingBalance).toBe(100);
    expect(mapped.totalInvoiced).toBe(500);
    expect(mapped.finalBalance).toBe(600);
    expect(mapped.transactions.map((t: any) => t.reference)).toEqual(['INV-MAIN']);
    expect(mapped.branchKey).toBe('main');
    expect(mapped.branchLabel).toBeUndefined();
    expect(mapped.subAccountId).toBeUndefined();
    // No branch money leaked in.
    expect(mapped.finalBalance).not.toBe(200);
    expect(mapped.finalBalance).not.toBe(900);
  });

  it('the exported branch document carries ITS numbers only, and identifies the account', async () => {
    await snapshotFor('2', BRANCH_A_MONEY, { subAccountId: 'SUB-A' });
    await snapshotFor('3', BRANCH_B_MONEY, { subAccountId: 'SUB-B' });
    const branchA = Array.from(store.values()).find((s: any) => s.branchKey === 'id:SUB-A') as any;
    const mapped: any = mapToInvoiceData(branchA, company, 'ACCOUNT_STATEMENT');

    expect(mapped.openingBalance).toBe(0);
    expect(mapped.totalInvoiced).toBe(200);
    expect(mapped.finalBalance).toBe(200);
    expect(mapped.transactions.map((t: any) => t.reference)).toEqual(['INV-A']);
    expect(mapped.branchKey).toBe('id:SUB-A');
    expect(mapped.subAccountId).toBe('SUB-A');
    expect(mapped.branchLabel).toBe('Campus');
    // The sibling branch that shares the same display name contributed nothing.
    expect(mapped.transactions.map((t: any) => t.reference)).not.toContain('INV-B');
    expect(mapped.finalBalance).not.toBe(900);
  });

  it('a legacy snapshot with no branch field is never presented as a branch document', async () => {
    store.set('STMT-LEGACY', {
      id: 'STMT-LEGACY',
      statementNumber: 'STMT-LEGACY',
      statementDate: '2026-09-01',
      ...PERIOD,
      customerId: CUSTOMER.id,
      customerName: CUSTOMER.name,
      currency: 'MWK',
      ...MAIN_MONEY,
      status: 'VALID',
    });
    const mapped: any = mapToInvoiceData(store.get('STMT-LEGACY'), company, 'ACCOUNT_STATEMENT');
    expect(mapped.branchKey).toBeUndefined();
    expect(mapped.scopeAmbiguous).toBeUndefined();
    // Untagged ⇒ Main by the legacy interpretation only.
    expect(mapped.totalInvoiced).toBe(500);
  });

  it('a new snapshot never overwrites the other account\'s snapshot of the same period', async () => {
    const first = await snapshotFor('1', MAIN_MONEY, 'main');
    const second = await snapshotFor('2', BRANCH_A_MONEY, { subAccountId: 'SUB-A' });
    expect(first.id).not.toBe(second.id);
    expect(store.get(first.id)).toBeTruthy();
    expect(store.get(second.id)).toBeTruthy();
    expect(store.get(first.id).branchKey).toBe('main');
    expect(store.get(second.id).branchKey).toBe('id:SUB-A');
  });
});