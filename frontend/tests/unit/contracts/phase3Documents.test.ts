/**
 * phase3Documents.test.ts — Phase 3 §4 automatic immutable documents.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

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

vi.mock('../../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
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
    value: { ...((globalThis as Record<string, unknown>).crypto ?? {}), subtle: webcrypto.subtle, getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b) },
    configurable: true,
    writable: true,
  });
});

const CONTRACT_ID = 'PC-1';
function contract(overrides: any = {}) {
  return {
    id: CONTRACT_ID, company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
    contract_number: 'PC-2026-0001', title: 'Exam printing', status: 'active',
    prepaid_amount: 1000000, consumed_amount: 0, reserved_amount: 1000000,
    max_assessments: 10, assessment_price: 100000, assessment_type: 'examination',
    assessment_count: 10, version: 1, data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}
function items(n = 10, consumed = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `A-${i + 1}`, contract_id: CONTRACT_ID, company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
    assessment_type: 'examination', assessment_name: `Assessment ${i + 1}`,
    assessment_date: '2026-03-15', status: i < consumed ? 'consumed' : 'reserved',
    item_price: 100000, consumed_at: i < consumed ? '2026-03-20' : undefined,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
  }));
}

beforeEach(() => {
  stores.clear();
});

describe('schedule versioning (§4.1)', () => {
  it('refuses to issue a schedule before activation', async () => {
    await expect(
      contractDocumentService.issueScheduleVersion({
        contract: contract({ status: 'draft' }) as any,
        items: items() as any,
        customerName: 'Test School',
      }),
    ).rejects.toThrow(/only after successful activation/);
    expect(await storeFor('contractDocuments').getAll()).toHaveLength(0);
  });

  it('issues v1 on activation and v2 after amendment, preserving v1', async () => {
    const v1 = await contractDocumentService.issueScheduleVersion({
      contract: contract({ version: 1 }) as any, items: items() as any, customerName: 'Test School',
    });
    expect(v1.documentVersion).toBe(1);
    expect(v1.status).toBe('VALID');
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const v2 = await contractDocumentService.issueScheduleVersion({
      contract: contract({ version: 2 }) as any, items: items() as any, customerName: 'Test School',
    });
    expect(v2.documentVersion).toBe(2);
    const all = await storeFor('contractDocuments').getAll();
    expect(all).toHaveLength(2);
    const storedV1: any = await storeFor('contractDocuments').get(v1.id);
    expect(storedV1.status).toBe('SUPERSEDED');
    expect(storedV1.supersededBy).toBe(v2.id);
  });

  it('returns the existing version for the same contract version (idempotent)', async () => {
    const a = await contractDocumentService.issueScheduleVersion({
      contract: contract({ version: 1 }) as any, items: items() as any, customerName: 'Test School',
    });
    const b = await contractDocumentService.issueScheduleVersion({
      contract: contract({ version: 1 }) as any, items: items() as any, customerName: 'Test School',
    });
    expect(a.id).toBe(b.id);
    expect(await storeFor('contractDocuments').getAll()).toHaveLength(1);
  });
});

describe('completion receipts (§4.2)', () => {
  it('issues exactly one receipt per consumed assessment (1/10)', async () => {
    const all = items(10, 1);
    const c: any = contract({ version: 2, consumed_amount: 100000, reserved_amount: 900000 });
    const item: any = all.find((it: any) => it.id === 'A-1');
    const r1 = await contractDocumentService.issueCompletionReceipt({
      contract: c, item, items: all as any, sequence: 1,
      amountDebited: 100000, walletBalanceAfter: 900000,
      walletTransactionId: 'WTX-A-1-CONSUMED', ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
      customerName: 'Test School', consumedAtIso: '2026-03-20',
    });
    expect(r1.documentNumber).toContain('PCR-');
    const r2 = await contractDocumentService.issueCompletionReceipt({
      contract: c, item, items: all as any, sequence: 1,
      amountDebited: 100000, walletBalanceAfter: 900000,
      walletTransactionId: 'WTX-A-1-CONSUMED', ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
      customerName: 'Test School', consumedAtIso: '2026-03-20',
    });
    expect(r2.id).toBe(r1.id);
    expect(await storeFor('contractDocuments').getAll()).toHaveLength(1);
  });

  it('refuses a receipt for a reserved (failed) assessment', async () => {
    const all = items(10, 0);
    await expect(
      contractDocumentService.issueCompletionReceipt({
        contract: contract() as any, item: all[0] as any, items: all as any, sequence: 1,
        amountDebited: 100000, walletBalanceAfter: 1000000,
        walletTransactionId: 'WTX-A-1-CONSUMED', ledgerEntryId: 'LG-X',
        customerName: 'Test School',
      }),
    ).rejects.toThrow(/consumed assessment is required/);
  });

  it('verifies a persisted receipt hash and detects tampering', async () => {
    const all = items(10, 1);
    const c: any = contract({ version: 2, consumed_amount: 100000, reserved_amount: 900000 });
    const item: any = all.find((it: any) => it.id === 'A-1');
    const r = await contractDocumentService.issueCompletionReceipt({
      contract: c, item, items: all as any, sequence: 1,
      amountDebited: 100000, walletBalanceAfter: 900000,
      walletTransactionId: 'WTX-A-1-CONSUMED', ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
      customerName: 'Test School', consumedAtIso: '2026-03-20',
    });
    const ok = await contractDocumentService.verifyPersistedDocument(r.id);
    expect(ok.ok).toBe(true);
    // Tamper with frozen content.
    const stored: any = await storeFor('contractDocuments').get(r.id);
    await storeFor('contractDocuments').put({ ...stored, content: { ...stored.content, amountDebited: 999999 } });
    const bad = await contractDocumentService.verifyPersistedDocument(r.id);
    expect(bad.ok).toBe(false);
  });

  it('returns not-found for a missing document', async () => {
    const res = await contractDocumentService.verifyPersistedDocument('NOPE');
    expect(res.ok).toBe(false);
  });
});
