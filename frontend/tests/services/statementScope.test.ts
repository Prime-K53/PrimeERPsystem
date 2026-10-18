/**
 * statementScope.test.ts — statement snapshots are per-ACCOUNT documents.
 *
 * Proves:
 *   1. a Main statement and a branch statement for the SAME customer + period
 *      NEVER supersede each other (they are different documents);
 *   2. two statements for the same account + period DO supersede (unchanged);
 *   3. branches are isolated from each other;
 *   4. the canonical scope (incl. the stable branch id) is persisted on new
 *      snapshots, so verification cannot present a branch statement as Main;
 *   5. a legacy snapshot with NO branch field is treated as Main ONLY when the
 *      new snapshot is Main. If the new snapshot is a BRANCH, the legacy
 *      snapshot is left untouched and the new one is flagged `scopeAmbiguous`.
 *
 * Removing the scope-aware supersede rule fails tests 1, 3 and 5.
 *
 * Run: cd frontend && npx vitest run tests/services/statementScope.test.ts
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

import {
  createStatementSnapshot,
  getStatementSnapshot,
  snapshotScopeKey,
  isLegacyScopedSnapshot,
} from '../../services/statementService';

let entropyCounter = 1;
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

const BASE = {
  customerId: 'CUST-1',
  customerName: 'Alpha Schools',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  currency: 'MWK',
  openingBalance: 100,
  transactions: [],
  totalInvoiced: 500,
  totalReceived: 200,
  closingBalance: 400,
};

const MAIN = { ...BASE, branchKey: 'main' };
const BRANCH_A = { ...BASE, branchKey: 'id:SUB-A', subAccountId: 'SUB-A', branchLabel: 'Exam Centre' };
const BRANCH_B = { ...BASE, branchKey: 'id:SUB-B', subAccountId: 'SUB-B', branchLabel: 'Exam Centre' };

/** Insert a pre-existing LEGACY snapshot (predates account scope). */
function seedLegacySnapshot(id: string) {
  store.set(id, {
    id,
    statementNumber: id,
    statementDate: '2026-09-01',
    periodStart: BASE.periodStart,
    periodEnd: BASE.periodEnd,
    customerId: BASE.customerId,
    customerName: BASE.customerName,
    currency: 'MWK',
    openingBalance: 100,
    transactions: [],
    totalInvoiced: 500,
    totalReceived: 200,
    closingBalance: 400,
    status: 'VALID',
  });
}

beforeEach(() => store.clear());

describe('scope is persisted on new snapshots', () => {
  it('a Main snapshot records the Main scope key', async () => {
    const s = await createStatementSnapshot(MAIN, null);
    expect(s.branchKey).toBe('main');
    expect(s.subAccountId).toBeUndefined();
  });

  it('a branch snapshot records its canonical key, stable id and label', async () => {
    const s = await createStatementSnapshot(BRANCH_A, null);
    expect(s.branchKey).toBe('id:SUB-A');
    expect(s.subAccountId).toBe('SUB-A');
    expect(s.branchLabel).toBe('Exam Centre');
    expect(s.scopeAmbiguous).toBeUndefined();
  });

  it('scope key prefers the stable branch id', () => {
    expect(snapshotScopeKey({ subAccountId: 'SUB-A', branchKey: 'name:exam-centre' })).toBe('id:SUB-A');
    expect(snapshotScopeKey({ branchKey: 'name:Exam Centre' })).toBe('name:exam-centre');
    expect(snapshotScopeKey({ branchKey: 'name:exam-centre' })).toBe('name:exam-centre');
    expect(snapshotScopeKey({ branchKey: 'main' })).toBe('main');
    expect(snapshotScopeKey(undefined)).toBe('main');
  });

  it('recognises a legacy snapshot (no branch field)', () => {
    expect(isLegacyScopedSnapshot({})).toBe(true);
    expect(isLegacyScopedSnapshot({ branchKey: '' })).toBe(true);
    expect(isLegacyScopedSnapshot({ branchKey: 'main' })).toBe(false);
    expect(isLegacyScopedSnapshot({ subAccountId: 'SUB-A' })).toBe(false);
  });
});

describe('Main and branch snapshots never supersede each other', () => {
  it('issuing a branch statement AFTER a Main statement leaves both VALID', async () => {
    const main = await createStatementSnapshot(MAIN, null);
    const branch = await createStatementSnapshot(BRANCH_A, null);

    expect(branch.statementNumber).not.toBe(main.statementNumber);
    expect((await getStatementSnapshot(main.statementNumber))?.status).toBe('VALID');
    expect((await getStatementSnapshot(branch.statementNumber))?.status).toBe('VALID');
  });

  it('issuing a Main statement AFTER a branch statement leaves both VALID', async () => {
    const branch = await createStatementSnapshot(BRANCH_A, null);
    const main = await createStatementSnapshot(MAIN, null);

    expect((await getStatementSnapshot(branch.statementNumber))?.status).toBe('VALID');
    expect((await getStatementSnapshot(main.statementNumber))?.status).toBe('VALID');
  });

  it('two DIFFERENT branches do not supersede each other', async () => {
    const a = await createStatementSnapshot(BRANCH_A, null);
    const b = await createStatementSnapshot(BRANCH_B, null);

    expect((await getStatementSnapshot(a.statementNumber))?.status).toBe('VALID');
    expect((await getStatementSnapshot(b.statementNumber))?.status).toBe('VALID');
  });
});

describe('same-account snapshots still supersede (behaviour preserved)', () => {
  it('two Main statements for the same period supersede', async () => {
    const a = await createStatementSnapshot(MAIN, null);
    const b = await createStatementSnapshot({ ...MAIN, closingBalance: 450 }, null);

    const aNow = await getStatementSnapshot(a.statementNumber);
    expect(aNow?.status).toBe('SUPERSEDED');
    expect(aNow?.supersededBy).toBe(b.statementNumber);
    expect(b.status).toBe('VALID');
  });

  it('two statements for the SAME branch supersede', async () => {
    const a = await createStatementSnapshot(BRANCH_A, null);
    const b = await createStatementSnapshot({ ...BRANCH_A, closingBalance: 450 }, null);

    const aNow = await getStatementSnapshot(a.statementNumber);
    expect(aNow?.status).toBe('SUPERSEDED');
    expect(aNow?.supersededBy).toBe(b.statementNumber);
  });

  it('a Main statement does NOT supersede a branch statement of the same period', async () => {
    const a = await createStatementSnapshot(BRANCH_A, null);
    await createStatementSnapshot(MAIN, null);
    expect((await getStatementSnapshot(a.statementNumber))?.status).toBe('VALID');
  });
});

describe('legacy snapshots are handled safely, never overwritten', () => {
  it('a legacy snapshot IS superseded by a new Main statement (legacy-Main interpretation)', async () => {
    seedLegacySnapshot('STMT-LEGACY-1');
    const main = await createStatementSnapshot(MAIN, null);

    const legacy = await getStatementSnapshot('STMT-LEGACY-1');
    expect(legacy?.status).toBe('SUPERSEDED');
    expect(legacy?.supersededBy).toBe(main.statementNumber);
    expect(main.scopeAmbiguous).toBeUndefined();
  });

  it('a legacy snapshot is NOT superseded by a BRANCH statement and the branch is FLAGGED', async () => {
    seedLegacySnapshot('STMT-LEGACY-2');
    const branch = await createStatementSnapshot(BRANCH_A, null);

    const legacy = await getStatementSnapshot('STMT-LEGACY-2');
    expect(legacy?.status).toBe('VALID'); // left untouched, never auto-superseded
    expect(legacy?.supersededBy).toBeUndefined();
    expect(branch.scopeAmbiguous).toBe(true);
  });

  it('a legacy snapshot is not touched by a different-branch statement either', async () => {
    seedLegacySnapshot('STMT-LEGACY-3');
    await createStatementSnapshot(BRANCH_B, null);
    expect((await getStatementSnapshot('STMT-LEGACY-3'))?.status).toBe('VALID');
  });
});
