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
  { id: 'ACC-11220', code: '11220', account_number: '11220', name: 'FCB Bank', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11230', code: '11230', account_number: '11230', name: 'Standard Bank', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11240', code: '11240', account_number: '11240', name: 'Mobile Money', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-52900', code: '52900', account_number: '52900', name: 'Bank Charges', account_type: 'EXPENSE', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
];

async function seed() {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
}

const ledger = () => storeFor('ledger').getAll() as Promise<any[]>;
const transfers = () => storeFor('transfers').getAll() as Promise<any[]>;
const bankTxns = () => storeFor('bankTransactions').getAll() as Promise<any[]>;

const baseTransfer = (overrides: any = {}) => ({
  id: 'TRF-T1',
  date: new Date().toISOString(),
  amount: 100000,
  fromAccountId: '11220',
  toAccountId: '11210',
  description: 'Test transfer',
  reference: 'TRF-T1',
  ...overrides,
});

function nets(entries: any[]) {
  const byAcct: Record<string, number> = {};
  for (const e of entries) {
    byAcct[e.debitAccountId] = (byAcct[e.debitAccountId] || 0) + e.amount;
    byAcct[e.creditAccountId] = (byAcct[e.creditAccountId] || 0) - e.amount;
  }
  return byAcct;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('transfer lifecycle (CRUD + fee + void)', () => {
  beforeEach(seed);

  it('create posts balanced main legs and marks Completed', async () => {
    await transactionService.executeTransfer(baseTransfer());
    const entries = await ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0].debitAccountId).toBe('ACC-11210');
    expect(entries[0].creditAccountId).toBe('ACC-11220');
    expect(entries[0].amount).toBe(100000);
    expect(entries[0].referenceId).toBe('TRF-T1');
    const rows = await transfers();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('Completed');
  });

  it('COA-code refs resolve (payment accounts work as endpoints)', async () => {
    await transactionService.executeTransfer(baseTransfer({ id: 'TRF-T2', fromAccountId: '11240', toAccountId: '11230' }));
    const entries = await ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0].debitAccountId).toBe('ACC-11230');
    expect(entries[0].creditAccountId).toBe('ACC-11240');
  });

  it('create with fee posts fee legs DR expense / CR source', async () => {
    await transactionService.executeTransfer(baseTransfer({ id: 'TRF-T3', feeAmount: 2500, feeAccountId: '52900' }));
    const entries = await ledger();
    expect(entries).toHaveLength(2);
    const fee = entries.find((e) => String(e.id).startsWith('LG-TRF-FEE'));
    expect(fee).toBeDefined();
    expect(fee.debitAccountId).toBe('ACC-52900');
    expect(fee.creditAccountId).toBe('ACC-11220');
    expect(fee.amount).toBe(2500);
    // Source nets: -100000 transfer -2500 fee.
    const n = nets(entries);
    expect(n['ACC-11220']).toBe(-102500);
    expect(n['ACC-11210']).toBe(100000);
    expect(n['ACC-52900']).toBe(2500);
  });

  it('duplicate create with the same id is blocked', async () => {
    await transactionService.executeTransfer(baseTransfer());
    await expect(transactionService.executeTransfer(baseTransfer())).rejects.toThrow();
    expect(await ledger()).toHaveLength(1);
  });

  it('same from/to and bad accounts are rejected', async () => {
    await expect(transactionService.executeTransfer(baseTransfer({ id: 'X1', toAccountId: '11220' }))).rejects.toThrow(/same/i);
    await expect(transactionService.executeTransfer(baseTransfer({ id: 'X2', fromAccountId: 'NOPE' }))).rejects.toThrow();
  });

  it('metadata-only edit posts no new legs', async () => {
    await transactionService.executeTransfer(baseTransfer());
    const res: any = await transactionService.updateTransfer('TRF-T1', {
      description: 'Corrected memo',
      reference: 'REF-2',
    });
    expect(res.reposted).toBe(false);
    expect(await ledger()).toHaveLength(1);
    const rows = await transfers();
    expect(rows[0].description).toBe('Corrected memo');
    expect(rows[0].reference).toBe('REF-2');
  });

  it('financial edit reverses old legs and posts corrected legs', async () => {
    await transactionService.executeTransfer(baseTransfer({ feeAmount: 2500, feeAccountId: '52900' }));
    const res: any = await transactionService.updateTransfer('TRF-T1', { amount: 60000 });
    expect(res.reposted).toBe(true);
    const entries = await ledger();
    // 2 original + 2 reversals + 2 corrected = 6
    expect(entries).toHaveLength(6);
    const rows = await transfers();
    expect(rows[0].editCount).toBe(1);
    expect(rows[0].amount).toBe(60000);
    // Net effect equals a single 60k + 2.5k-fee transfer.
    const n = nets(entries);
    expect(n['ACC-11220']).toBe(-62500);
    expect(n['ACC-11210']).toBe(60000);
    expect(n['ACC-52900']).toBe(2500);
  });

  it('editing a voided transfer is blocked', async () => {
    await transactionService.executeTransfer(baseTransfer());
    await transactionService.voidTransfer('TRF-T1', 'duplicate entry');
    await expect(transactionService.updateTransfer('TRF-T1', { description: 'x' })).rejects.toThrow(/voided/i);
  });

  it('void posts reversals, marks Voided, and nets postings to zero', async () => {
    await transactionService.executeTransfer(baseTransfer({ feeAmount: 2500, feeAccountId: '52900' }));
    await transactionService.voidTransfer('TRF-T1', 'entered in error');
    const entries = await ledger();
    // 2 original + 2 reversals = 4
    expect(entries).toHaveLength(4);
    const n = nets(entries);
    expect(n['ACC-11220']).toBe(0);
    expect(n['ACC-11210']).toBe(0);
    expect(n['ACC-52900']).toBe(0);
    const rows = await transfers();
    expect(rows[0].status).toBe('Voided');
    expect(rows[0].voidReason).toBe('entered in error');
  });

  it('double void and void-without-reason are blocked', async () => {
    await transactionService.executeTransfer(baseTransfer());
    await transactionService.voidTransfer('TRF-T1', 'oops');
    await expect(transactionService.voidTransfer('TRF-T1', 'again')).rejects.toThrow(/already voided/i);
    await expect(transactionService.voidTransfer('MISSING', 'x')).rejects.toThrow(/not found/i);
    await transactionService.executeTransfer(baseTransfer({ id: 'TRF-T9' }));
    await expect(transactionService.voidTransfer('TRF-T9', '  ')).rejects.toThrow(/reason/i);
  });

  it('void reverses mirrored bank transactions without duplicating on retry-guard', async () => {
    await transactionService.executeTransfer(baseTransfer());
    const before = await bankTxns();
    // Mirrors only exist when a bank row matches; with an empty bank store the
    // kernel seeds sample rows — count whatever mirrors reference this transfer.
    const owned = (list: any[]) => list.filter((t: any) =>
      ['TRF-OUT-TRF-T1', 'TRF-IN-TRF-T1', 'TRF-T1'].includes(t.reference));
    const ownedBefore = owned(before);
    await transactionService.voidTransfer('TRF-T1', 'reversal check');
    const after = await bankTxns();
    const reversals = after.filter((t: any) => String(t.reference || '').startsWith('TRF-REV-'));
    expect(reversals.length).toBe(ownedBefore.length);
    for (const rev of reversals) {
      const orig = ownedBefore.find((o: any) => `TRF-REV-${o.reference}` === rev.reference);
      expect(orig).toBeDefined();
      expect(rev.amount).toBe(orig.amount);
      expect(rev.type).not.toBe(orig.type);
    }
  });
});
