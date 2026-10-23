/**
 * scheduleIssuanceStoreArgument.test.ts — the issuance transaction contract.
 *
 * `dbService.executeAtomicOperation(stores, fn)` opens ONE IndexedDB
 * transaction over the named stores, so the caller must pass an ARRAY of
 * store names: the implementation maps them (`stores.map(String)`).
 *
 * The schedule issuance used to pass a bare string. Every issuance therefore
 * aborted with "stores.map is not a function", and the staff UI surfaced it as
 * "Schedule generation failed: stores.map is not a function" — no schedule
 * could be generated at all.
 *
 * Every test mock of this API used to ignore the argument, so the defect was
 * invisible to the suite. This file pins the argument's shape with a faithful
 * mock (it maps the names exactly as the real implementation does) and asserts
 * the store the issuance actually opens.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const stores = new Map<string, Map<string, any>>();
const seenStoreNames: string[][] = [];

const storeFor = (name: string) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => {
      m.set(String(rec.id ?? `k${m.size}`), rec);
    },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => { m.delete(String(id)); },
  };
};

vi.mock('../../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (names: string[], fn: any) => {
      // Exactly what the real implementation does with the argument.
      const storeNames = [...new Set((names as any).map(String))];
      if (storeNames.length === 0) {
        throw new Error('executeAtomicOperation requires at least one object store.');
      }
      seenStoreNames.push(storeNames);
      return fn({ objectStore: (n: string) => storeFor(n) });
    },
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

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

beforeEach(() => {
  stores.clear();
  seenStoreNames.length = 0;
});

const contract = (over: Record<string, any> = {}) => ({
  id: 'CID-ARG',
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  contract_number: 'PC-ARG/001',
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

const item = (over: Record<string, any> = {}) => ({
  id: 'A-ARG-1',
  contract_id: 'CID-ARG',
  assessment_name: 'Assessment',
  status: 'reserved',
  item_price: 50000,
  assessment_date: '2026-02-02',
  ...over,
});

describe('schedule issuance opens its transaction correctly', () => {
  it('passes the store names as an ARRAY (a bare string has no .map)', async () => {
    const issued = await contractDocumentService.issueScheduleVersion({
      contract: contract() as any,
      items: [item()] as any,
      customerName: 'Arg School',
    });
    expect(issued.id).toBe('SCH-CID-ARG-v1');
    expect(seenStoreNames.length).toBeGreaterThan(0);
    for (const names of seenStoreNames) {
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain('contractDocuments');
    }
  }, 30000);

  it('issues the schedule instead of aborting with "stores.map is not a function"', async () => {
    // The exact failure the staff UI reported.
    let failure: unknown = null;
    try {
      await contractDocumentService.issueScheduleVersion({
        contract: contract() as any,
        items: [item()] as any,
        customerName: 'Arg School',
      });
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeNull();
    const rows = await storeFor('contractDocuments').getAll();
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe('SCH-CID-ARG-v1');
    expect(String(rows[0].status)).toBe('VALID');
  }, 30000);
});
