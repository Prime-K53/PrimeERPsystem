/**
 * scheduleIssuanceIdentity.test.ts — Phase 2C.
 *
 * Pins the identity/concurrency rules of schedule issuance:
 *   1. Documents are keyed by the STABLE contract id, not the human-readable
 *      contract number — live production has two different contracts numbered
 *      `PC-P726/022`, and number-keying let one overwrite the other.
 *   2. Repeat/concurrent issuance of unchanged content converges on ONE version
 *      and leaves exactly one VALID document per contract.
 *   3. A partial failure (insert committed, supersede did not) is repaired by
 *      the next issuance instead of leaving two VALID versions forever.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const stores = new Map<string, Map<string, any>>();
/** Every write the service performs, in order — the sync queue's order. */
const putLog: Array<{ id: string; status: string; version: number }> = [];
function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => {
      if (name === 'contractDocuments') {
        putLog.push({ id: String(rec.id), status: String(rec.status), version: Number(rec.version || 0) });
      }
      m.set(String(rec.id ?? `k${m.size}`), rec);
    },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => { m.delete(String(id)); },
  };
}
vi.mock('../../../services/db', () => ({
  dbService: {
    // Faithful to the real implementation: the store names are MAPPED before
    // the transaction opens, so a caller that passes a bare string (which has
    // no `.map`) fails here exactly as it does in production. The previous
    // mock ignored the argument, which hid "stores.map is not a function" and
    // aborted every schedule issuance.
    executeAtomicOperation: async (names: string[], fn: any) => {
      const storeNames = [...new Set((names as any).map(String))];
      if (storeNames.length === 0) {
        throw new Error('executeAtomicOperation requires at least one object store.');
      }
      return fn({ objectStore: (n: string) => storeFor(n) });
    },
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

import { dbService } from '../../../services/db';
import { contractDocumentService } from '../../../services/contractDocumentService';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
      getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b),
    },
    configurable: true,
    writable: true,
  });
});

beforeEach(() => { stores.clear(); putLog.length = 0; });

const contract = (over: Record<string, any> = {}) => ({
  id: 'CID-A',
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  contract_number: 'PC-DUP/001',
  status: 'active',
  version: 1,
  prepaid_amount: 100000,
  reserved_amount: 100000,
  consumed_amount: 0,
  available_funds: 100000,
  max_assessments: 2,
  assessment_price: 50000,
  starts_at: '2026-01-05T00:00:00.000Z',
  ends_at: '2026-12-31T00:00:00.000Z',
  ...over,
});

const items = (contractId: string) => [
  { id: 'A-1', contract_id: contractId, assessment_name: 'Paper 1', item_price: 50000, assessment_date: '2026-02-10', status: 'reserved' },
  { id: 'A-2', contract_id: contractId, assessment_name: 'Paper 2', item_price: 50000, assessment_date: '2026-03-10', status: 'reserved' },
];

const issue = (c: any, its: any[]) => contractDocumentService.issueScheduleVersion({
  contract: c,
  items: its as any,
  customerName: 'School',
});

const docs = async () => storeFor('contractDocuments').getAll();

describe('schedule document identity', () => {
  it('keeps two contracts with the same human number as separate documents', async () => {
    // Live production shape: PC-P726/022 exists twice (cancelled + active).
    const a = contract({ id: 'CID-AAA', contract_number: 'PC-P726/022' });
    const b = contract({ id: 'CID-BBB', contract_number: 'PC-P726/022' });

    const docA = await issue(a, items('CID-AAA'));
    const docB = await issue(b, items('CID-BBB'));

    expect(docA.id).not.toBe(docB.id);
    expect(docA.id).toContain('CID-AAA');
    expect(docB.id).toContain('CID-BBB');
    expect(docA.documentNumber).toBe('PC-P726/022');
    expect(docB.documentNumber).toBe('PC-P726/022');

    const all = await docs();
    expect(all).toHaveLength(2);
    // Neither contract overwrote the other's record.
    expect(all.filter((d) => d.contract_id === 'CID-AAA')).toHaveLength(1);
    expect(all.filter((d) => d.contract_id === 'CID-BBB')).toHaveLength(1);
  });

  it('converges concurrent issuance of unchanged content on one version', async () => {
    const c = contract();
    const its = items('CID-A');

    const [first, second] = await Promise.all([issue(c, its), issue(c, its)]);

    expect(first.id).toBe(second.id);
    expect(first.documentVersion).toBe(1);
    const all = await docs();
    expect(all).toHaveLength(1);
    expect(all.filter((d) => d.status === 'VALID')).toHaveLength(1);
  });

  it('does not churn a version when the request is retried', async () => {
    const c = contract();
    const its = items('CID-A');
    const first = await issue(c, its);
    const retry = await issue(c, its);

    expect(retry.id).toBe(first.id);
    expect(retry.documentVersion).toBe(1);
    expect(await docs()).toHaveLength(1);
  });
});

describe('partial-failure recovery', () => {
  it('repairs two VALID versions on the next issuance', async () => {
    const c = contract();
    const v1 = await issue(c, items('CID-A'));
    expect(v1.documentVersion).toBe(1);

    // Material change → a new version is required.
    const amended = contract({ version: 2, prepaid_amount: 120000, reserved_amount: 120000, available_funds: 120000 });
    const amendedItems = [
      { id: 'A-1', contract_id: 'CID-A', assessment_name: 'Paper 1', item_price: 60000, assessment_date: '2026-02-10', status: 'reserved' },
      { id: 'A-2', contract_id: 'CID-A', assessment_name: 'Paper 2', item_price: 60000, assessment_date: '2026-03-10', status: 'reserved' },
    ];

    // Simulate an interrupted issue: the insert lands, the supersede throws.
    // (The real IndexedDB transaction aborts atomically; this mock has no
    // rollback, which is exactly the worst case a retry must repair.)
    const original = (dbService as any).executeAtomicOperation;
    (dbService as any).executeAtomicOperation = async (_n: string[], fn: any) => fn({
      objectStore: (name: string) => {
        const s = storeFor(name);
        return {
          ...s,
          put: async (rec: any) => {
            if (rec.status === 'SUPERSEDED') throw new Error('simulated supersede failure');
            return s.put(rec);
          },
        };
      },
    });

    await expect(issue(amended, amendedItems)).rejects.toThrow(/simulated supersede failure/);
    (dbService as any).executeAtomicOperation = original;

    // Worst case before retry: two rows, both VALID.
    const broken = await docs();
    expect(broken.filter((d) => d.status === 'VALID')).toHaveLength(2);

    // A retry of the SAME content must reconcile, not return early on the
    // duplicate and leave two current versions.
    const healed = await issue(amended, amendedItems);
    expect(healed.documentVersion).toBe(2);

    const after = await docs();
    const valid = after.filter((d) => d.status === 'VALID');
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe(healed.id);
    expect(valid[0].documentVersion).toBe(2);
    const superseded = after.filter((d) => d.status === 'SUPERSEDED');
    expect(superseded).toHaveLength(1);
    expect(superseded[0].id).toBe(v1.id);
    expect(superseded[0].supersededBy).toBe(healed.id);
  });
});

describe('publication order and OCC base version (Phase 2D)', () => {
  it('publishes the new version BEFORE superseding the previous one', async () => {
    // The database validates `supersededBy` against a row that already
    // exists, and the sync queue preserves the order of the transaction's
    // writes. Publishing the supersede first would leave the contract with
    // no current schedule if the device died in between.
    const c = contract();
    const v1 = await issue(c, items('CID-A'));
    putLog.length = 0;

    const amended = contract({ version: 2, prepaid_amount: 120000, reserved_amount: 120000, available_funds: 120000 });
    const amendedItems = [
      { id: 'A-1', contract_id: 'CID-A', assessment_name: 'Paper 1', item_price: 60000, assessment_date: '2026-02-10', status: 'reserved' },
      { id: 'A-2', contract_id: 'CID-A', assessment_name: 'Paper 2', item_price: 60000, assessment_date: '2026-03-10', status: 'reserved' },
    ];
    const v2 = await issue(amended, amendedItems);

    const published = putLog.find((e) => e.id === v2.id);
    const retired = putLog.find((e) => e.id === v1.id);
    expect(published).toBeDefined();
    expect(retired).toBeDefined();
    expect(published!.status).toBe('VALID');
    expect(retired!.status).toBe('SUPERSEDED');
    // The insert is written first, so the supersede's reference resolves.
    expect(putLog.indexOf(published!)).toBeLessThan(putLog.indexOf(retired!));
  });

  it('keeps the optimistic-concurrency base the server returned', async () => {
    // `contract_documents.version` is the SERVER's row version: the sync
    // gateway's write is conditional on it (`version = eq.<payload.version>`)
    // and the server answers `base + 1`. The local copy must therefore carry
    // the base the server last returned — advancing it locally would make the
    // first supersede fail its own precondition. The next pull refreshes it.
    const c = contract();
    const v1 = await issue(c, items('CID-A'));
    expect(v1.version).toBe(1);

    const amended = contract({ version: 2, prepaid_amount: 120000, reserved_amount: 120000, available_funds: 120000 });
    const amendedItems = [
      { id: 'A-1', contract_id: 'CID-A', assessment_name: 'Paper 1', item_price: 60000, assessment_date: '2026-02-10', status: 'reserved' },
      { id: 'A-2', contract_id: 'CID-A', assessment_name: 'Paper 2', item_price: 60000, assessment_date: '2026-03-10', status: 'reserved' },
    ];
    await issue(amended, amendedItems);

    const stored = await storeFor('contractDocuments').get(v1.id);
    expect(stored.status).toBe('SUPERSEDED');
    // The base is unchanged: the server still holds version 1 for this row
    // until the supersede lands.
    expect(stored.version).toBe(1);
  });
});

describe('completion receipts under one contract (Phase 2D)', () => {
  const receiptContract = (over: Record<string, any> = {}) => contract({
    prepaid_amount: 100000,
    reserved_amount: 50000,
    consumed_amount: 50000,
    ...over,
  });

  const consumed = (id: string, seq: number) => ({
    id,
    contract_id: 'CID-A',
    assessment_name: `Paper ${seq}`,
    assessment_grade: 'Standard 8',
    assessment_subject: 'All',
    item_price: 50000,
    status: 'consumed',
    consumed_at: '2026-10-20T10:00:00.000Z',
  });

  it('issues an independent receipt per consumed assessment', async () => {
    const c = receiptContract();
    const first = consumed('A-1', 1);
    const second = consumed('A-2', 2);

    const r1 = await contractDocumentService.issueCompletionReceipt({
      contract: c as any,
      item: first as any,
      items: [first, second] as any,
      sequence: 1,
      amountDebited: 50000,
      walletBalanceAfter: 50000,
      walletTransactionId: 'WTX-1',
      ledgerEntryId: 'LG-1',
      customerName: 'School',
      consumedAtIso: '2026-10-20T10:00:00.000Z',
    });
    const r2 = await contractDocumentService.issueCompletionReceipt({
      contract: c as any,
      item: second as any,
      items: [first, second] as any,
      sequence: 2,
      amountDebited: 50000,
      walletBalanceAfter: 0,
      walletTransactionId: 'WTX-2',
      ledgerEntryId: 'LG-2',
      customerName: 'School',
      consumedAtIso: '2026-10-20T11:00:00.000Z',
    });

    // Distinct rows, distinct assessment items, distinct tokens.
    expect(r1.id).not.toBe(r2.id);
    expect(r1.assessmentItemId).toBe('A-1');
    expect(r2.assessmentItemId).toBe('A-2');
    expect(r1.verificationToken).not.toBe(r2.verificationToken);

    // The receipt NUMBER is per contract, so the version is the per-contract
    // receipt sequence: (documentNumber, documentVersion) must stay unique or
    // the server's number index rejects the second receipt.
    expect(r1.documentNumber).toBe(r2.documentNumber);
    expect(r1.documentVersion).toBe(1);
    expect(r2.documentVersion).toBe(2);
    const key = (d: any) => `${d.documentNumber}#${d.documentVersion}`;
    expect(key(r1)).not.toBe(key(r2));

    const all = await storeFor('contractDocuments').getAll();
    expect(all.filter((d: any) => d.documentType === 'printing_contract_completion_receipt')).toHaveLength(2);

    // Both receipts still verify against their own stored digest.
    expect((await contractDocumentService.verifyPersistedDocument(r1.id)).ok).toBe(true);
    expect((await contractDocumentService.verifyPersistedDocument(r2.id)).ok).toBe(true);
  });

  it('never issues a second receipt for the same assessment', async () => {
    const c = receiptContract();
    const first = consumed('A-1', 1);
    const args = {
      contract: c as any,
      item: first as any,
      items: [first] as any,
      sequence: 1,
      amountDebited: 50000,
      walletBalanceAfter: 50000,
      walletTransactionId: 'WTX-1',
      ledgerEntryId: 'LG-1',
      customerName: 'School',
      consumedAtIso: '2026-10-20T10:00:00.000Z',
    };
    const first1 = await contractDocumentService.issueCompletionReceipt(args);
    const first2 = await contractDocumentService.issueCompletionReceipt(args);
    expect(first2.id).toBe(first1.id);
    expect(await storeFor('contractDocuments').getAll()).toHaveLength(1);
  });
});
