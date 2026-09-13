/**
 * statementService.test.ts — immutable verifiable statement snapshots.
 *
 * Proves: stable number + stable token per snapshot; later statements get a
 * NEW identity while the original still verifies as itself (SUPERSEDED);
 * snapshot content is frozen (later input changes cannot mutate history).
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
  voidStatementSnapshot,
} from '../../services/statementService';

// The global test setup stubs crypto.getRandomValues as identity (zero
// bytes), which would mint identical tokens. Restore uniqueness with a
// counter so multi-snapshot identity tests are meaningful.
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

const INPUT = {
  customerId: 'CUST-1',
  customerName: 'Snapshot School',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  currency: 'MWK',
  openingBalance: 100,
  transactions: [
    { date: '2026-08-05', reference: 'INV-1', memo: 'Invoice', debit: 500, credit: 0, runningBalance: 600 },
  ],
  totalInvoiced: 500,
  totalReceived: 200,
  closingBalance: 400,
};

beforeEach(() => {
  store.clear();
});

describe('statement snapshots', () => {
  it('issues a numbered snapshot with a stable 64-hex token', async () => {
    const a = await createStatementSnapshot(INPUT, null);
    expect(a.statementNumber).toMatch(/^STMT-/);
    expect(a.id).toBe(a.statementNumber);
    expect(a.verificationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(a.status).toBe('VALID');
    expect(a.closingBalance).toBe(400);
  });

  it('a later statement gets a new identity; the original stays verifiable as SUPERSEDED', async () => {
    const a = await createStatementSnapshot(INPUT, null);
    const b = await createStatementSnapshot({ ...INPUT, closingBalance: 450 }, null);

    expect(b.statementNumber).not.toBe(a.statementNumber);
    expect(b.verificationToken).not.toBe(a.verificationToken);

    const aNow = await getStatementSnapshot(a.statementNumber);
    expect(aNow?.status).toBe('SUPERSEDED');
    expect(aNow?.supersededBy).toBe(b.statementNumber);
    // History is frozen — the original keeps its own totals + token.
    expect(aNow?.closingBalance).toBe(400);
    expect(aNow?.verificationToken).toBe(a.verificationToken);

    expect(b.status).toBe('VALID');
  });

  it('void marks the snapshot without deleting it', async () => {
    const a = await createStatementSnapshot(INPUT, null);
    await voidStatementSnapshot(a.statementNumber);
    const now = await getStatementSnapshot(a.statementNumber);
    expect(now?.status).toBe('VOID');
    expect(now?.verificationToken).toBe(a.verificationToken);
  });

  it('different periods do not supersede each other', async () => {
    const a = await createStatementSnapshot(INPUT, null);
    const b = await createStatementSnapshot({ ...INPUT, periodStart: '2026-09-01', periodEnd: '2026-09-30' }, null);
    expect((await getStatementSnapshot(a.statementNumber))?.status).toBe('VALID');
    expect(b.status).toBe('VALID');
  });
});
