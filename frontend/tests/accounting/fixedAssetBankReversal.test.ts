/**
 * fixedAssetBankReversal.test.ts
 *
 * Regression tests for the 11200 Bank Accounts distortion (K-3,413,300
 * investigation): fixed assets acquired from bank accounts were deleted
 * without reversing the FA_ACQUISITION journal, orphaning the bank-side
 * credits and permanently depressing the 11200 Bank Accounts balance.
 *
 * Locks the lifecycle contract:
 *   Create FA  -> FA_ACQUISITION         (Dr Fixed Asset / Cr Bank)
 *   Delete FA  -> FA_ACQUISITION_REVERSAL (Dr Bank / Cr Fixed Asset)
 * The reversal must always be posted — driven by the original acquisition
 * entry itself, never skipped because the caller supplied no accounts —
 * must be idempotent, must leave legitimate bank transactions untouched,
 * and must never patch the parent 11200 balance directly (it is a
 * non-postable GROUP whose balance is derived by hierarchical rollup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const memStores = vi.hoisted(() => ({ tables: new Map<string, Map<string, any>>() }));

vi.mock('../../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      getTable(name).set(String(obj.id ?? Math.random()), obj);
    },
    delete: async (id: string) => {
      getTable(name).delete(String(id));
    },
  });
  return {
    dbService: {
      getAll: async (table: string) => [...getTable(table).values()],
      get: async (table: string, id: string) => getTable(table).get(String(id)),
      getById: async (table: string, id: string) => getTable(table).get(String(id)) ?? null,
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id ?? Math.random()), obj);
      },
      delete: async (table: string, id: string) => {
        getTable(table).delete(String(id));
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
      createObjectStore: async () => { /* no-op for tests */ },
    },
  };
});

import { fixedAssetService } from '../../services/fixedAssetService';
import { dbService } from '../../services/db';
import {
  computeOwnBalances,
  computeHierarchicalRollup,
  isPostedLedgerEntry,
} from '../../services/accountingEngine';

// ---------------------------------------------------------------------------
// COA fragment — single-company, 5-digit chart, no tenant fields.
// 11200 "Bank Accounts" is a non-postable GROUP parent of the three
// postable bank leaves, exactly like the live chart.
// ---------------------------------------------------------------------------
const ACCOUNTS = [
  { id: 'ACC-11200', code: '11200', account_number: '11200', name: 'Bank Accounts', account_type: 'ASSET', type: 'Asset', subtype: 'BANK', parent_account_id: 'ACC-11000', allow_posting: false, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
  { id: 'ACC-11210', code: '11210', account_number: '11210', name: 'National Bank', account_type: 'ASSET', type: 'Asset', subtype: 'BANK', parent_account_id: 'ACC-11200', allow_posting: true, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
  { id: 'ACC-11220', code: '11220', account_number: '11220', name: 'FDH Bank', account_type: 'ASSET', type: 'Asset', subtype: 'BANK', parent_account_id: 'ACC-11200', allow_posting: true, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
  { id: 'ACC-11230', code: '11230', account_number: '11230', name: 'NBS Bank', account_type: 'ASSET', type: 'Asset', subtype: 'BANK', parent_account_id: 'ACC-11200', allow_posting: true, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
  { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Accounts Receivable', account_type: 'ASSET', type: 'Asset', parent_account_id: 'ACC-11000', allow_posting: true, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
  { id: 'ACC-12100', code: '12100', account_number: '12100', name: 'Fixed Assets', account_type: 'ASSET', type: 'Asset', parent_account_id: 'ACC-12000', allow_posting: true, normal_balance: 'DEBIT', is_active: true, opening_balance: 0 },
] as any[];

/**
 * The six legitimate bank transactions for the period (customer payments
 * received into bank accounts). These must NEVER be reversed or modified
 * by the fixed-asset lifecycle or its repair.
 */
const LEGITIMATE_PAYMENTS = [
  { id: 'LG-PAY-032', date: '2026-09-24', description: 'Payment P726/032', debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11310', amount: 54000, referenceId: 'PAY-P726/032', reconciled: true, entryType: 'PAYMENT' },
  { id: 'LG-PAY-029', date: '2026-09-22', description: 'Payment P726/029', debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11310', amount: 705000, referenceId: 'PAY-P726/029', reconciled: true, entryType: 'PAYMENT' },
  { id: 'LG-PAY-027', date: '2026-09-20', description: 'Payment P726/027', debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11310', amount: 175000, referenceId: 'PAY-P726/027', reconciled: true, entryType: 'PAYMENT' },
  { id: 'LG-PAY-021', date: '2026-01-24', description: 'Payment P726/021', debitAccountId: 'ACC-11210', creditAccountId: 'ACC-11310', amount: 70000, referenceId: 'PAY-P726/021', reconciled: true, entryType: 'PAYMENT' },
  { id: 'LG-PAY-024', date: '2026-09-18', description: 'Payment P726/024', debitAccountId: 'ACC-11230', creditAccountId: 'ACC-11310', amount: 251000, referenceId: 'PAY-P726/024', reconciled: true, entryType: 'PAYMENT' },
  { id: 'LG-PAY-022', date: '2026-09-15', description: 'Payment P726/022', debitAccountId: 'ACC-11220', creditAccountId: 'ACC-11310', amount: 300000, referenceId: 'PAY-P726/022', reconciled: true, entryType: 'PAYMENT' },
] as any[];

const bankAsset = (code: string, name: string, cost: number, extra: any = {}) => ({
  asset_code: code,
  name,
  category: 'other',
  acquisition_date: '2026-10-04',
  acquisition_cost: cost,
  salvage_value: 0,
  useful_life_years: 5,
  depreciation_method: 'straight_line',
  status: 'active',
  funding_source: 'Bank',
  ...extra,
}) as any;

function seed(ledger: any[] = LEGITIMATE_PAYMENTS, fixedAssets: any[] = []) {
  memStores.tables.clear();
  memStores.tables.set('accounts', new Map(ACCOUNTS.map((a: any) => [String(a.id), { ...a }])));
  memStores.tables.set('ledger', new Map(ledger.map((e: any) => [String(e.id), { ...e }])));
  memStores.tables.set('fixedAssets', new Map(fixedAssets.map((a: any) => [String(a.id), { ...a }])));
  memStores.tables.set('idempotencyKeys', new Map());
}

const bankBalance = (ledger: any[], accountId: string) =>
  ledger
    .filter((e: any) => isPostedLedgerEntry(e))
    .reduce(
      (sum: number, e: any) =>
        sum +
        (e.debitAccountId === accountId ? Number(e.amount) : 0) -
        (e.creditAccountId === accountId ? Number(e.amount) : 0),
      0
    );

const rollup11200 = (ledger: any[]) => {
  const own = computeOwnBalances(ACCOUNTS, ledger as any);
  const rollup = computeHierarchicalRollup(ACCOUNTS, own);
  return { own, rollup, total: rollup['ACC-11200'] };
};

beforeEach(() => {
  seed();
});

describe('fixed asset bank reversal — 11200 Bank Accounts integrity', () => {
  it('1. baseline: the six legitimate payments roll up to exactly K1,555,000', () => {
    const { own, rollup, total } = rollup11200(LEGITIMATE_PAYMENTS);
    expect(own['ACC-11210']).toBe(1004000); // 54,000 + 705,000 + 175,000 + 70,000
    expect(own['ACC-11220']).toBe(300000);
    expect(own['ACC-11230']).toBe(251000);
    expect(own['ACC-11200']).toBe(0); // GROUP parent has no own postings
    expect(rollup['ACC-11210']).toBe(1004000);
    expect(rollup['ACC-11220']).toBe(300000);
    expect(rollup['ACC-11230']).toBe(251000);
    expect(total).toBe(1555000);
  });

  it('2. lifecycle: create FA from bank drops 11200; delete restores it even with no accounts supplied', async () => {
    // Create a K4,500,000 delivery van funded from the bank account.
    const created = await fixedAssetService.create(
      bankAsset('FA-0001', 'Delivery Van', 4500000, { category: 'motor_vehicle' }),
      ACCOUNTS
    );
    expect(created.id).toBe('FA-0001');

    let ledger = await dbService.getAll<any>('ledger');
    const acquisition = ledger.find((e: any) => e.entryType === 'FA_ACQUISITION');
    expect(acquisition).toBeDefined();
    expect(acquisition.debitAccountId).toBe('ACC-12100');
    expect(acquisition.creditAccountId).toBe('ACC-11210');
    expect(acquisition.amount).toBe(4500000);
    expect(acquisition.referenceId).toBe('FA-ACQ-FA-0001');

    // Balance drops by the acquisition cost: 1,555,000 - 4,500,000.
    expect(rollup11200(ledger).total).toBe(-2945000);

    // Delete the asset — the caller supplies NO accounts (the historical
    // bug: the reversal was skipped when accounts were empty).
    const deleted = await fixedAssetService.delete('FA-0001', []);
    expect(deleted).toBe(true);

    ledger = await dbService.getAll<any>('ledger');
    const reversal = ledger.find((e: any) => e.entryType === 'FA_ACQUISITION_REVERSAL');
    expect(reversal).toBeDefined();
    expect(reversal.referenceId).toBe('FA-ACQ-REV-FA-0001');
    expect(reversal.debitAccountId).toBe('ACC-11210'); // bank restored
    expect(reversal.creditAccountId).toBe('ACC-12100'); // fixed asset relieved
    expect(reversal.amount).toBe(4500000);
    expect(isPostedLedgerEntry(reversal)).toBe(true);

    // Balance restored to exactly the legitimate baseline.
    const { own, total } = rollup11200(ledger);
    expect(own['ACC-11210']).toBe(1004000);
    expect(total).toBe(1555000);

    // Asset row is gone.
    expect(await fixedAssetService.getById('FA-0001')).toBeNull();
  });

  it('3. deleting fixed assets leaves the legitimate bank transactions untouched', async () => {
    // Mirror the live incident: two assets acquired from National Bank,
    // then deleted — alongside the six legitimate payments.
    const car = await fixedAssetService.create(
      bankAsset('FA-0001', 'Delivery Car', 4500000, { category: 'motor_vehicle' }),
      ACCOUNTS
    );
    const printer = await fixedAssetService.create(
      bankAsset('FA-0002', '3015 Printer', 350000, { category: 'other' }),
      ACCOUNTS
    );

    let ledger = await dbService.getAll<any>('ledger');
    expect(rollup11200(ledger).total).toBe(1555000 - 4850000); // -3,295,000

    expect(await fixedAssetService.delete(car.id, [])).toBe(true);
    expect(await fixedAssetService.delete(printer.id, [])).toBe(true);

    ledger = await dbService.getAll<any>('ledger');

    // The six legitimate payments are byte-for-byte unchanged.
    const legitimateNow = LEGITIMATE_PAYMENTS.map((p) =>
      ledger.find((e: any) => e.id === p.id)
    );
    legitimateNow.forEach((row, i) => {
      expect(row).toBeDefined();
      expect(row.debitAccountId).toBe(LEGITIMATE_PAYMENTS[i].debitAccountId);
      expect(row.creditAccountId).toBe(LEGITIMATE_PAYMENTS[i].creditAccountId);
      expect(row.amount).toBe(LEGITIMATE_PAYMENTS[i].amount);
      expect(row.referenceId).toBe(LEGITIMATE_PAYMENTS[i].referenceId);
    });

    // Exactly two reversals were added — one per deleted asset.
    const reversals = ledger.filter((e: any) => e.entryType === 'FA_ACQUISITION_REVERSAL');
    expect(reversals.length).toBe(2);
    expect(reversals.reduce((s: number, e: any) => s + e.amount, 0)).toBe(4850000);

    // Per-account balances restored to the legitimate baseline.
    const { own, total } = rollup11200(ledger);
    expect(own['ACC-11210']).toBe(1004000);
    expect(own['ACC-11220']).toBe(300000);
    expect(own['ACC-11230']).toBe(251000);
    expect(total).toBe(1555000);
  });

  it('4. double reversal attempt posts no duplicate and never over-reverses', async () => {
    const created = await fixedAssetService.create(
      bankAsset('FA-0001', 'Delivery Van', 4500000, { category: 'motor_vehicle' }),
      ACCOUNTS
    );

    // First delete posts the reversal.
    expect(await fixedAssetService.delete(created.id, [])).toBe(true);
    let ledger = await dbService.getAll<any>('ledger');
    expect(ledger.filter((e: any) => e.entryType === 'FA_ACQUISITION_REVERSAL').length).toBe(1);
    expect(rollup11200(ledger).total).toBe(1555000);

    // A retry (double-click / sync replay) calls the reversal again with
    // the same asset — it must be a no-op.
    const asset = { ...created, status: 'active' } as any;
    const second = await fixedAssetService.reverseAcquisitionJournal(asset, ACCOUNTS);
    expect(second).toBeNull();

    ledger = await dbService.getAll<any>('ledger');
    const reversals = ledger.filter((e: any) => e.entryType === 'FA_ACQUISITION_REVERSAL');
    expect(reversals.length).toBe(1); // still exactly one
    expect(rollup11200(ledger).total).toBe(1555000); // not over-reversed
  });

  it('5. parent 11200 is derived by rollup, never patched directly', async () => {
    const created = await fixedAssetService.create(
      bankAsset('FA-0001', 'Delivery Van', 4500000, { category: 'motor_vehicle' }),
      ACCOUNTS
    );
    await fixedAssetService.delete(created.id, []);

    const ledger = await dbService.getAll<any>('ledger');

    // 11200 is a non-postable GROUP.
    const parent = ACCOUNTS.find((a: any) => a.id === 'ACC-11200');
    expect(parent.allow_posting).toBe(false);

    // No ledger row ever posts to the parent — its balance is always
    // computed from the children, never written.
    const parentPostings = ledger.filter(
      (e: any) => e.debitAccountId === 'ACC-11200' || e.creditAccountId === 'ACC-11200'
    );
    expect(parentPostings.length).toBe(0);

    // Rollup equals the sum of the children's own balances.
    const { own, rollup, total } = rollup11200(ledger);
    expect(total).toBe(own['ACC-11210'] + own['ACC-11220'] + own['ACC-11230']);
    expect(total).toBe(1555000);
    expect(rollup['ACC-11200']).toBe(1555000);

    // The repair path never writes a `balance` field onto account rows.
    const storedAccounts = await dbService.getAll<any>('accounts');
    for (const acc of storedAccounts) {
      expect('balance' in acc).toBe(false);
    }
  });
});
