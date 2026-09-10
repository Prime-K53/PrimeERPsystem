/**
 * Opening-cash duplicate protection regression tests.
 *
 * A mount race once stamped one K500 OPENING_BALANCE row per reload because
 * the auto-post decided on the empty pre-load snapshot. Covered here:
 *  - the post decision never fires before loading completes
 *  - duplicates are detected (posted only; drafts/voids/corrected ignored)
 *  - repair posts ONE balanced correcting journal, preserves originals,
 *    and is a no-op on re-run
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
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id ?? Math.random()), obj);
      },
      delete: async (table: string, id: string) => {
        getTable(table).delete(String(id));
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

import {
  decideOpeningCashPost,
  findDuplicateOpeningCash,
  repairDuplicateOpeningCash,
  OPENING_CASH_BALANCE_REFERENCE,
} from '../../services/openingBalanceService';
import { computeTrialBalance } from '../../services/accountingEngine';
import { dbService } from '../../services/db';

const ACCOUNTS = [
  { id: '11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', type: 'Asset', parent_account_id: '11100', allow_posting: true },
  { id: '31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', type: 'Equity', parent_account_id: '30000', allow_posting: true },
];

const openingRow = (id: string, date: string, extra: any = {}) => ({
  id,
  date,
  description: 'System Initialization: Opening Cash Balance',
  debitAccountId: '11110',
  creditAccountId: '31000',
  amount: 500,
  referenceId: OPENING_CASH_BALANCE_REFERENCE,
  reconciled: true,
  ...extra,
});

function seed(ledger: any[]) {
  memStores.tables.clear();
  memStores.tables.set('accounts', new Map(ACCOUNTS.map((a: any) => [String(a.id), a])));
  memStores.tables.set('ledger', new Map(ledger.map((e: any) => [String(e.id), e])));
  memStores.tables.set('idempotencyKeys', new Map());
}

beforeEach(() => {
  memStores.tables.clear();
});

describe('opening-cash duplicate protection', () => {
  it('never posts before loading completes', () => {
    expect(decideOpeningCashPost({ loaded: false, entries: [], openingBalance: 500 }).action).toBe('skip-not-loaded');
    expect(decideOpeningCashPost({ loaded: true, entries: [], openingBalance: 0 }).action).toBe('skip-not-loaded');
    expect(decideOpeningCashPost({ loaded: true, entries: [], openingBalance: 500 }).action).toBe('post');
  });

  it('skips when a post exists; warns instead of resurrecting on activity', () => {
    const existing = [openingRow('LG-1', '2026-09-09T00:00:00.000Z')];
    expect(decideOpeningCashPost({ loaded: true, entries: existing, openingBalance: 500 }).action).toBe('skip-present');
    const activity = [{ id: 'LG-S', date: '2026-09-10', debitAccountId: '11110', creditAccountId: '41100', amount: 100 }];
    expect(decideOpeningCashPost({ loaded: true, entries: activity, openingBalance: 500 }).action).toBe('warn-missing');
  });

  it('detects 59 posted rows as 58 duplicates keeping the earliest', () => {
    const rows: any[] = [];
    for (let i = 0; i < 59; i += 1) {
      rows.push(openingRow(`LG-DUP-${String(i).padStart(2, '0')}`, `2026-09-10T10:${String(i % 60).padStart(2, '0')}:00.000Z`));
    }
    // Noise that must NOT count: draft, voided, and an already-corrected row.
    rows.push(openingRow('LG-DRAFT', '2026-09-10T11:00:00.000Z', { status: 'Draft', amount: 500 }));
    rows.push(openingRow('LG-VOID', '2026-09-10T11:01:00.000Z', { status: 'voided', amount: 500 }));
    const report = findDuplicateOpeningCash(rows);
    expect(report.postedCount).toBe(59);
    expect(report.duplicateIds.length).toBe(58);
    expect(report.keptId).toBe('LG-DUP-00');
    expect(report.correctionAmount).toBe(58 * 500);
  });

  it('ignores rows already neutralised by a prior correction', () => {
    const rows = [openingRow('LG-1', '2026-09-09'), openingRow('LG-2', '2026-09-10'), openingRow('LG-3', '2026-09-10')];
    const first = findDuplicateOpeningCash(rows);
    expect(first.duplicateIds).toEqual(['LG-2', 'LG-3']);
    const withCorrection = [
      ...rows,
      { id: 'LG-FIX', date: '2026-09-11', debitAccountId: '31000', creditAccountId: '11110', amount: 1000, referenceId: 'OPENING-BALANCE-CORRECTION', correctsOpeningIds: ['LG-2', 'LG-3'] },
    ];
    expect(findDuplicateOpeningCash(withCorrection).duplicateIds).toEqual([]);
  });

  it('repair posts ONE balanced correction, preserves originals, and is a no-op on re-run', async () => {
    const rows: any[] = [];
    for (let i = 0; i < 59; i += 1) {
      rows.push(openingRow(`LG-DUP-${String(i).padStart(2, '0')}`, '2026-09-10T10:00:00.000Z'));
    }
    seed(rows);

    const result = await repairDuplicateOpeningCash('test repair');
    expect(result.repaired).toBe(true);
    expect(result.duplicatesFound).toBe(58);
    expect(result.keptId).toBe('LG-DUP-00');
    expect(result.correctionAmount).toBe(29000);
    expect(result.entriesPosted).toBe(1);

    const ledger = await dbService.getAll<any>('ledger');
    // History preserved: 59 originals + 1 correction (nothing deleted).
    expect(ledger.length).toBe(60);
    const correction = ledger.find((e: any) => e.referenceId === 'OPENING-BALANCE-CORRECTION');
    expect(correction).toBeDefined();
    expect(correction.debitAccountId).toBe('31000');
    expect(correction.creditAccountId).toBe('11110');
    expect(correction.amount).toBe(29000);
    expect(correction.correctsOpeningIds.length).toBe(58);
    // Net cash effect: 59x500 debits minus 29000 correction = 500.
    const netCash = ledger.reduce(
      (s: number, e: any) => s + (e.debitAccountId === '11110' ? e.amount : 0) - (e.creditAccountId === '11110' ? e.amount : 0),
      0
    );
    expect(netCash).toBe(500);

    const trial = computeTrialBalance(ACCOUNTS as any[], ledger as any[]);
    expect(trial.isBalanced).toBe(true);

    const second = await repairDuplicateOpeningCash('test repair');
    expect(second.repaired).toBe(false);
    expect(second.entriesPosted).toBe(0);
    expect((await dbService.getAll<any>('ledger')).length).toBe(60);
  });

  it('repair reports no-op when at most one opening exists', async () => {
    seed([openingRow('LG-1', '2026-09-09T00:00:00.000Z')]);
    const result = await repairDuplicateOpeningCash('test');
    expect(result.repaired).toBe(false);
    expect((await dbService.getAll<any>('ledger')).length).toBe(1);
  });
});
