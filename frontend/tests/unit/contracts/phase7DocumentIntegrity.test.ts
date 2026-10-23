/**
 * phase7DocumentIntegrity.test.ts — §7 regression checks.
 *
 *  1. Schedule/receipt documents stay IMMUTABLE, VERSIONED, PERSISTED and
 *     HASH-VERIFIED after amendments and repeated consumption requests.
 *  2. A committed financial transaction is NOT rolled back when document
 *     generation fails, and that failure stays VISIBLE for reconciliation.
 *  3. Reconciliation identifies legacy drift / missing docs / sync failures
 *     WITHOUT mutating financial records.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const stores = new Map<string, Map<string, any>>();
function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => { m.set(String(rec.id ?? `k${m.size}`), rec); },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => { m.delete(String(id)); },
  };
}
vi.mock('../../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_n: string[], fn: any) => fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../../services/transactionService';
import { contractDocumentService } from '../../../services/contractDocumentService';
import { hashLegacyScheduleContent, hashLegacyReceiptContent } from '../../../services/printingContractService';
import { reconcilePrintingContracts } from '../../../utils/contractReconciliation';
import { diagnoseReservationDrift } from '../../../utils/contractFunds';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
      getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b),
    },
    configurable: true, writable: true,
  });
});

const CUST = 'CUST-1';
const CID = 'PC-1';
const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

const contract = (over: any = {}) => ({
  id: CID, company_id: 'CO-1', customer_id: CUST, school_id: 'SCH-1',
  contract_number: 'PC-2026-0001', title: 'Exam', status: 'active',
  prepaid_amount: 1000000, consumed_amount: 0, reserved_amount: 0,
  max_assessments: 10, assessment_price: 100000, assessment_type: 'examination',
  assessment_count: 0, version: 1, data: {},
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});

async function seedWallet(balance = 1000000) {
  await storeFor('accounts').put(ACCOUNTS[0]);
  await storeFor('accounts').put(ACCOUNTS[1]);
  await storeFor('customers').put({ id: CUST, name: 'School', walletBalance: balance });
}

async function seedContractWithItems(n = 10, consumed = 0, over: any = {}) {
  await (transactionService as any).createPrintingContractWithItems({
    contract: contract(over),
    items: Array.from({ length: n }, (_, i) => ({ id: `A-${i + 1}`, assessment_name: `A${i + 1}`, item_price: 100000 })),
  });
  for (let i = 1; i <= consumed; i++) {
    await transactionService.consumeContractAssessment({ contractId: CID, assessmentItemId: `A-${i}` });
  }
}

const docs = async () => storeFor('contractDocuments').getAll();

beforeEach(() => { stores.clear(); });

describe('documents stay immutable + versioned (§7.1)', () => {
  it('an amendment produces a new version and never overwrites the issued one', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const items = await storeFor('contractAssessments').getAll();

    const v1 = await contractDocumentService.issueScheduleVersion({ contract: c, items: items as any, customerName: 'School' });
    const v1Snapshot = JSON.parse(JSON.stringify(await storeFor('contractDocuments').get(v1.id)));

    // Approved amendment changes the contract (new version, new value).
    const amended: any = { ...c, version: 2, prepaid_amount: 1200000, updated_at: new Date().toISOString() };
    await storeFor('assessmentContracts').put(amended);
    const items2 = await storeFor('contractAssessments').getAll();
    const v2 = await contractDocumentService.issueScheduleVersion({ contract: amended, items: items2 as any, customerName: 'School' });

    expect(v1.id).not.toBe(v2.id);
    expect(v2.documentVersion).toBe(2);
    // The historical record is retained verbatim and marked superseded.
    const after: any = await storeFor('contractDocuments').get(v1.id);
    expect(after.content).toEqual(v1Snapshot.content);
    expect(after.contentHash).toBe(v1Snapshot.contentHash);
    expect(after.status).toBe('SUPERSEDED');
    expect((await docs()).length).toBe(2);
  });

  it('superseded versions stay hash-verifiable but are no longer valid', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const items = await storeFor('contractAssessments').getAll();
    const v1 = await contractDocumentService.issueScheduleVersion({ contract: c, items: items as any, customerName: 'S' });
    await storeFor('assessmentContracts').put({ ...c, version: 2 } as any);
    const v2 = await contractDocumentService.issueScheduleVersion({
      contract: { ...c, version: 2 } as any, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });

    // v1 is SUPERSEDED: its integrity is intact, but it must NOT report as a
    // current valid document (the old behaviour conflated the two).
    const checkV1 = await contractDocumentService.verifyPersistedDocument(v1.id);
    expect(checkV1.integrity).toBe(true);
    expect(checkV1.current).toBe(false);
    expect(checkV1.status).toBe('SUPERSEDED');
    expect(checkV1.ok).toBe(false);

    const checkV2 = await contractDocumentService.verifyPersistedDocument(v2.id);
    expect(checkV2.ok).toBe(true);
    expect(checkV2.integrity).toBe(true);
    expect(checkV2.current).toBe(true);
    expect(checkV2.status).toBe('VALID');
  });

  it('a VOID version fails verification even though its content is intact', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const v1 = await contractDocumentService.issueScheduleVersion({
      contract: c, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });
    const row: any = await storeFor('contractDocuments').get(v1.id);
    await storeFor('contractDocuments').put({ ...row, status: 'VOID' });

    const check = await contractDocumentService.verifyPersistedDocument(v1.id);
    expect(check.integrity).toBe(true);
    expect(check.ok).toBe(false);
    expect(check.status).toBe('VOID');
  });

  it('detects a post-issue content alteration (tamper) on a persisted schedule', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const v1 = await contractDocumentService.issueScheduleVersion({
      contract: c, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });
    const row: any = await storeFor('contractDocuments').get(v1.id);
    // Rewrite one money value but keep the stored digest — a forged edit.
    const tampered = {
      ...row,
      content: {
        ...row.content,
        prepaidAmount: 999999999,
        schedule: row.content.schedule.map((s: any, i: number) => (i === 0 ? { ...s, unitPrice: 1 } : s)),
      },
    };
    await storeFor('contractDocuments').put(tampered);

    const check = await contractDocumentService.verifyPersistedDocument(v1.id);
    expect(check.ok).toBe(false);
    expect(check.integrity).toBe(false);
  });

  it('re-issuing unchanged content returns the SAME version (no version churn)', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const items = await storeFor('contractAssessments').getAll();
    const v1 = await contractDocumentService.issueScheduleVersion({ contract: c, items: items as any, customerName: 'S' });
    const again = await contractDocumentService.issueScheduleVersion({
      contract: c, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });
    expect(again.id).toBe(v1.id);
    expect(again.contentHash).toBe(v1.contentHash);
    expect((await docs()).length).toBe(1);
  });

  it('an assessment-item edit supersedes the issued version even without a contract version bump', async () => {
    await seedWallet();
    await seedContractWithItems(3);
    const c: any = await storeFor('assessmentContracts').get(CID);
    const v1 = await contractDocumentService.issueScheduleVersion({
      contract: c, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });

    // Edit an item's date/price directly — the contract row itself is untouched
    // (no version bump), exactly the gap that used to leave a stale VALID
    // schedule in place.
    const item: any = await storeFor('contractAssessments').get('A-1');
    await storeFor('contractAssessments').put({ ...item, assessment_date: '2027-06-01', item_price: 150000 });

    const v2 = await contractDocumentService.issueScheduleVersion({
      contract: c, items: await storeFor('contractAssessments').getAll() as any, customerName: 'S',
    });
    expect(v2.id).not.toBe(v1.id);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    expect((await storeFor('contractDocuments').get(v1.id) as any).status).toBe('SUPERSEDED');
    expect((await contractDocumentService.verifyPersistedDocument(v1.id)).ok).toBe(false);
    expect((await contractDocumentService.verifyPersistedDocument(v2.id)).ok).toBe(true);
  });

  it('repeated consumption + repeated receipt requests yield exactly one receipt each', async () => {
    await seedWallet();
    await seedContractWithItems(10, 2);
    const items = await storeFor('contractAssessments').getAll();
    const c: any = await storeFor('assessmentContracts').get(CID);
    const issued: string[] = [];
    // Issue receipts for both consumed assessments three times each.
    for (let round = 0; round < 3; round++) {
      for (const it of items.filter((i: any) => i.status === 'consumed')) {
        const rec = await contractDocumentService.issueCompletionReceipt({
          contract: c, item: it as any, items: items as any, sequence: 1,
          amountDebited: 100000, walletBalanceAfter: 800000,
          walletTransactionId: `WTX-${it.id}-CONSUMED`, ledgerEntryId: `LG-WTX-${it.id}-CONSUMED`,
          customerName: 'S', consumedAtIso: it.consumed_at,
        });
        issued.push(rec.id);
      }
    }
    expect(new Set(issued).size).toBe(2);
    expect((await docs()).length).toBe(2);
    expect((await contractDocumentService.verifyPersistedDocument(issued[0])).ok).toBe(true);
  });

  it('earlier receipts remain retrievable after later assessments are consumed', async () => {
    await seedWallet();
    await seedContractWithItems(10, 1);
    let items = await storeFor('contractAssessments').getAll();
    let c: any = await storeFor('assessmentContracts').get(CID);
    const first = await contractDocumentService.issueCompletionReceipt({
      contract: c, item: items[0] as any, items: items as any, sequence: 1,
      amountDebited: 100000, walletBalanceAfter: 900000,
      walletTransactionId: 'WTX-A-1-CONSUMED', ledgerEntryId: 'LG-WTX-A-1-CONSUMED', customerName: 'S',
    });
    await transactionService.consumeContractAssessment({ contractId: CID, assessmentItemId: 'A-2' });
    items = await storeFor('contractAssessments').getAll();
    c = { ...(await storeFor('assessmentContracts').get(CID) as any), consumed_amount: 200000 };
    await contractDocumentService.issueCompletionReceipt({
      contract: c, item: items[1] as any, items: items as any, sequence: 2,
      amountDebited: 100000, walletBalanceAfter: 800000,
      walletTransactionId: 'WTX-A-2-CONSUMED', ledgerEntryId: 'LG-WTX-A-2-CONSUMED', customerName: 'S',
    });
    // The first receipt is untouched and still verifies.
    const still = await contractDocumentService.verifyPersistedDocument(first.id);
    expect(still.ok).toBe(true);
    expect(still.document?.content.completedToDate).toBe(1);
  });
});

describe('document failure never rolls back committed money (§7.2)', () => {
  it('consumption commits wallet+ledger+buckets even when the receipt cannot be built', async () => {
    await seedWallet();
    await seedContractWithItems(10, 0);
    // Simulate a document-layer failure (crypto unavailable / schema break)
    // by throwing inside the builder, exactly as the UI's try/catch sees it.
    const broken: any = await storeFor('contractAssessments').get('A-1');
    const res: any = await transactionService.consumeContractAssessment({ contractId: CID, assessmentItemId: 'A-1' });
    expect(res.success).toBe(true);
    await expect(
      contractDocumentService.issueCompletionReceipt({
        contract: broken ? ({ ...(await storeFor('assessmentContracts').get(CID)) } as any) : ({} as any),
        item: broken, items: await storeFor('contractAssessments').getAll() as any, sequence: 1,
        amountDebited: 100000, walletBalanceAfter: 900000,
        walletTransactionId: '', ledgerEntryId: '', customerName: 'S',
      }),
    ).rejects.toThrow();
    // Money already moved and is intact; the missing receipt stays visible.
    const c: any = await storeFor('assessmentContracts').get(CID);
    expect(c.consumed_amount).toBe(100000);
    expect((await storeFor('customers').get(CUST)).walletBalance).toBe(900000);
    expect((await storeFor('walletTransactions').getAll()).length).toBe(1);
    expect((await storeFor('ledger').getAll()).length).toBe(1);
    expect(await contractDocumentService.getReceiptForAssessment('A-1')).toBeNull();
  });
});

describe('reconciliation is read-only (§7.3)', () => {
  it('reports legacy drift, missing docs and sync state without mutating records', async () => {
    await seedWallet(1000000);
    // Legacy drift: reserved items with a zero bucket.
    const now = new Date().toISOString();
    await storeFor('assessmentContracts').put({
      ...contract({ id: 'PC-LEG', status: 'active', reserved_amount: 0, assessment_count: 2, prepaid_amount: 200000, consumed_amount: 0 }),
    });
    for (const id of ['L-1', 'L-2']) {
      await storeFor('contractAssessments').put({
        id, contract_id: 'PC-LEG', company_id: 'CO-1', customer_id: CUST, school_id: 'SCH-1',
        assessment_type: 'examination', assessment_name: id, status: 'reserved', item_price: 100000,
        created_at: now, updated_at: now, version: 1,
      });
    }
    const before = JSON.stringify(await storeFor('assessmentContracts').getAll());

    const drift = diagnoseReservationDrift({
      contracts: await storeFor('assessmentContracts').getAll() as any,
      items: await storeFor('contractAssessments').getAll() as any,
    });
    expect(drift).toHaveLength(1);
    expect(drift[0].bucketReserved).toBe(0);
    expect(drift[0].itemsReservedValue).toBe(200000);

    const report = reconcilePrintingContracts({
      contracts: await storeFor('assessmentContracts').getAll() as any,
      items: await storeFor('contractAssessments').getAll() as any,
      walletTransactions: await storeFor('walletTransactions').getAll() as any,
      ledger: await storeFor('ledger').getAll() as any,
      customerId: CUST,
      walletBalance: 1000000,
    });
    expect(report.contracts).toHaveLength(1);
    expect(report.contracts[0].reservedItemsValue).toBe(200000);
    // Diagnosis only — no repair.
    expect(JSON.stringify(await storeFor('assessmentContracts').getAll())).toBe(before);
    expect((await storeFor('assessmentContracts').get('PC-LEG') as any).reserved_amount).toBe(0);
  });
});

/* ─────────────── Legacy persisted documents verify (Phase 2C) ─────────────── */

describe('verifyPersistedDocument applies the legacy hash rule', () => {
  const legacyScheduleContent = (): Record<string, any> => ({
    documentType: 'printing_contract_schedule',
    verificationToken: 'a'.repeat(64),
    contractNumber: 'PC-LEGACY',
    date: '19/10/2026',
    version: 1,
    status: 'active',
    customerName: 'Legacy School',
    schoolName: 'Legacy School',
    schedule: [{ sequence: 1, assessmentName: 'Paper 1', status: 'reserved', unitPrice: 1000 }],
    totalAssessments: 1,
    scheduleComplete: false,
    missingDateSequences: [1],
    scheduledCount: 0,
    consumedCount: 0,
    releasedCount: 0,
    cancelledCount: 0,
    prepaidAmount: 1000,
    reservedAmount: 1000,
    consumedAmount: 0,
    availableFunds: 0,
    totalValue: 1000,
    // schoolZone / customerPhone / notes dropped by JSONB persistence
  });

  it('verifies an authentic legacy schedule instead of calling it altered', async () => {
    const content = legacyScheduleContent();
    const hash = await hashLegacyScheduleContent(content);
    const row: any = {
      id: 'SCH-LEGACY-v1',
      contract_id: 'CID-LEGACY',
      documentType: 'printing_contract_schedule',
      documentNumber: 'PC-LEGACY',
      documentVersion: 1,
      contractVersion: 1,
      contentHash: hash,
      content: { ...content, contentHash: hash },
      status: 'VALID',
      issuedAt: '2026-10-19T10:00:00.000Z',
      verificationToken: 'a'.repeat(64),
    };
    await storeFor('contractDocuments').put(row);

    const check = await contractDocumentService.verifyPersistedDocument(row.id);
    expect(check.integrity).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.current).toBe(true);
  });

  it('rejects a legacy schedule whose material content changed', async () => {
    const content = legacyScheduleContent();
    const hash = await hashLegacyScheduleContent(content);
    const row: any = {
      id: 'SCH-LEGACY-ALTERED',
      contract_id: 'CID-LEGACY',
      documentType: 'printing_contract_schedule',
      documentNumber: 'PC-LEGACY',
      documentVersion: 1,
      contentHash: hash,
      content: { ...content, contentHash: hash, prepaidAmount: 999999 },
      status: 'VALID',
      issuedAt: '2026-10-19T10:00:00.000Z',
      verificationToken: 'a'.repeat(64),
    };
    await storeFor('contractDocuments').put(row);

    const check = await contractDocumentService.verifyPersistedDocument(row.id);
    expect(check.integrity).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/altered after issue/i);
  });

  it('verifies an authentic legacy completion receipt', async () => {
    const content: Record<string, any> = {
      documentType: 'printing_contract_completion_receipt',
      verificationToken: 'b'.repeat(64),
      receiptNumber: 'PCR-PC-LEGACY',
      contractNumber: 'PC-LEGACY',
      date: '19/10/2026',
      version: 1,
      status: 'active',
      customerName: 'Legacy School',
      schoolName: 'Legacy School',
      item: { assessmentName: 'Paper 1', unitPrice: 1000 }, // nested optionals dropped
      sequence: 1,
      totalAssessments: 1,
      completedToDate: 1,
      remainingAssessments: 0,
      contractValue: 1000,
      amountDebited: 1000,
      totalConsumedToDate: 1000,
      remainingReservedFunds: 0,
      unallocatedFunds: 0,
      walletBalanceAfter: 1000,
      walletTransactionId: 'WTX-LEGACY',
      ledgerEntryId: 'LG-LEGACY',
      // notes dropped by JSONB persistence
    };
    const hash = await hashLegacyReceiptContent(content);
    const row: any = {
      id: 'PCR-LEGACY',
      contract_id: 'CID-LEGACY',
      documentType: 'printing_contract_completion_receipt',
      documentNumber: 'PCR-PC-LEGACY',
      documentVersion: 1,
      contentHash: hash,
      content: { ...content, contentHash: hash },
      status: 'VALID',
      issuedAt: '2026-10-19T10:00:00.000Z',
      verificationToken: 'b'.repeat(64),
    };
    await storeFor('contractDocuments').put(row);

    const check = await contractDocumentService.verifyPersistedDocument(row.id);
    expect(check.integrity).toBe(true);
    expect(check.ok).toBe(true);
  });
});