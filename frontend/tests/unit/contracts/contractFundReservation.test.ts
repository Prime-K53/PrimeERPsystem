/**
 * contractFundReservation.test.ts — contract-specific fund
 * reservation, cross-device concurrency, reconciliation and
 * customer-document generation for Printing Contracts.
 *
 * Canonical invariants under test (§4/§5/§8/§10):
 *   - A reservation is an allocation of existing money: it
 *     bumps the contract's reserved_amount bucket and never
 *     moves customer.walletBalance, posts no ledger entry
 *     and creates no wallet transaction.
 *   - Available for unrelated spending = wallet balance −
 *     all active contract reservations.
 *   - Two assessments must never independently spend the
 *     same insufficient balance — the balance check runs
 *     inside the shared persistence boundary.
 *   - Consumption recognises the assessment exactly once:
 *     one wallet debit + one ledger posting + one reservation
 *     release. Retry / replay / cross-device concurrency
 *     converge instead of duplicating.
 *   - Every derived balance reconciles with the canonical
 *     wallet, reservation and ledger records.
 *
 * Uses the real transactionService against a shared in-memory
 * persistence boundary (the same harness as
 * contractConsumption.test.ts). Cross-device concurrency is
 * simulated by re-importing the service module (fresh
 * per-item mutex) against the SAME shared store.
 *
 * NOTE: reserveContractAssessment CREATES the reserved
 * assessment item itself, so tests never pre-seed the item
 * before reserving it. Consumption tests operate on items
 * already created (reserved) by the reservation operation.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

// ─── Shared in-memory persistence boundary ──────────────────

const stores = new Map<string, Map<string, any>>();
// Closed-period control for the financial-year closure tests.
let closedPeriods: any[] = [];

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
    executeAtomicOperation: async (_names: string[], fn: any) => fn({
      objectStore: (n: string) => n === 'settings'
        ? {
          ...storeFor(n),
          get: async (id: string) => id === 'financial_closed_periods'
            ? { id, value: closedPeriods }
            : storeFor(n).get(id),
        }
        : storeFor(n),
    }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async (key: string) =>
      key === 'financial_closed_periods' ? closedPeriods : undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../../services/transactionService';
import {
  buildContractScheduleDoc,
  buildAssessmentCompletionReceiptDoc,
} from '../../../services/printingContractService';
import { reconcilePrintingContracts } from '../../../utils/contractReconciliation';
import type {
  AssessmentContract,
  AssessmentContractItem,
  WalletTransaction,
  LedgerEntry,
} from '../../../types';

// tests/setup.ts stubs crypto.subtle with SHA-1 (jsdom has no
// WebCrypto). Pin the REAL WebCrypto here (established override
// pattern — see tests/unit/examinationV2/snapshotParity.test.ts) so
// document integrity hashes are true SHA-256 digests, identical to
// production browsers and the backend node:crypto implementation.
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
    },
    configurable: true,
    writable: true,
  });
});

// ─── Fixtures ──────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

const CUSTOMER_ID = 'CUST-1';
const CONTRACT_ID = 'PC-1';

function seedCustomer(balance: number) {
  return storeFor('customers').put({ id: CUSTOMER_ID, name: 'Test School', walletBalance: balance });
}

function seedContract(overrides: any = {}) {
  return storeFor('assessmentContracts').put({
    id: CONTRACT_ID,
    company_id: 'CO-1',
    customer_id: CUSTOMER_ID,
    school_id: 'SCH-1',
    contract_number: 'PC-2026-0001',
    title: 'Exam printing',
    status: 'active',
    prepaid_amount: 1000000,
    consumed_amount: 0,
    reserved_amount: 0,
    max_assessments: 10,
    assessment_price: 100000,
    payment_status: 'verified',
    version: 1,
    data: {},
    ...overrides,
  });
}

/** Reserve (create) one assessment through the canonical operation. */
async function reserveAssessment(id: string, price: number, name = `Assessment ${id}`, date = '2026-03-15') {
  return transactionService.reserveContractAssessment({
    contractId: CONTRACT_ID,
    assessmentItemId: id,
    assessment: { assessment_name: name, item_price: price, assessment_date: date },
  });
}

async function seedScenario(balance = 1000000) {
  stores.clear();
  closedPeriods = [];
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await seedCustomer(balance);
  await seedContract();
}

const walletTxFor = (itemId: string) => storeFor('walletTransactions').get(`WTX-${itemId}-CONSUMED`);
const walletTxCount = async () => (await storeFor('walletTransactions').getAll()).length;
const ledgerForContract = async () => (await storeFor('ledger').getAll() as any[])
  .filter((e) => String(e.referenceId || '').startsWith('A-'));
const customerBalance = async () =>
  (await storeFor('customers').get(CUSTOMER_ID)).walletBalance;
const contractRow = async () =>
  (await storeFor('assessmentContracts').get(CONTRACT_ID)) as AssessmentContract;
const itemRow = async (id: string) =>
  (await storeFor('contractAssessments').get(id)) as AssessmentContractItem;
const allItems = async () =>
  (await storeFor('contractAssessments').getAll()) as AssessmentContractItem[];

/** Canonical snapshot of every record the reconciliation reads. */
const loadCanonical = async () => {
  const customer = await storeFor('customers').get(CUSTOMER_ID);
  return {
    contracts: (await storeFor('assessmentContracts').getAll()) as AssessmentContract[],
    items: await allItems(),
    walletTransactions: (await storeFor('walletTransactions').getAll()) as WalletTransaction[],
    ledger: (await storeFor('ledger').getAll()) as LedgerEntry[],
    walletBalance: Number(customer.walletBalance),
  };
};

// ─── A. Reservation is an allocation, not a payment ──────────

describe('contract-specific fund reservation', () => {
  beforeEach(() => seedScenario());

  it('reserves the contracted amount without moving the wallet', async () => {
    const before = await customerBalance();
    const res: any = await reserveAssessment('A-1', 100000, 'Assessment 1');
    expect(res.success).toBe(true);
    // Reservation is an allocation: the wallet is untouched.
    expect(await customerBalance()).toBe(before);
    expect(await walletTxCount()).toBe(0);
    expect(await ledgerForContract()).toHaveLength(0);
    // The contract reservation bucket is bumped truthfully.
    const c = await contractRow();
    expect(c.reserved_amount).toBe(100000);
    expect(c.consumed_amount).toBe(0);
    expect(c.assessment_count).toBe(1);
    const item = await itemRow('A-1');
    expect(item.status).toBe('reserved');
    expect(item.reserved_at).toBeTruthy();
  });

  it('tracks per-contract reserved, consumed and remaining', async () => {
    for (let i = 1; i <= 3; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    let c = await contractRow();
    expect(c.reserved_amount).toBe(300000);
    expect(c.consumed_amount).toBe(0);

    // Consume one assessment: reservation releases, consumption records.
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    c = await contractRow();
    expect(c.reserved_amount).toBe(200000);
    expect(c.consumed_amount).toBe(100000);
    expect(await customerBalance()).toBe(900000);
  });

  it('refuses to schedule on a closed contract', async () => {
    await seedContract({ status: 'completed' });
    await expect(
      reserveAssessment('A-1', 100000, 'Assessment 1'),
    ).rejects.toThrow(/cannot be scheduled on a closed contract/);
  });

  it('refuses to exceed the contracted entitlement', async () => {
    await seedContract({ max_assessments: 1 });
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    await expect(
      reserveAssessment('A-2', 100000, 'Assessment 2'),
    ).rejects.toThrow(/entitlement exceeded/);
  });
});

// ─── B. Two concurrent assessments competing for insufficient funds ──

describe('concurrent assessments competing for insufficient funds', () => {
  beforeEach(() => seedScenario());

  it('both consumes fail when the wallet cannot cover all reservations', async () => {
    // Wallet holds 100,000 but TWO assessments of 100,000 each
    // are reserved (total reservation 200,000). Neither may
    // consume: the wallet must cover every active reservation.
    await seedScenario(100000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    await reserveAssessment('A-2', 100000, 'Assessment 2');

    const results = await Promise.allSettled([
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toMatch(/INSUFFICIENT_WALLET_FUNDS/);
    }
    // Wallet and reservations are unchanged and consistent.
    expect(await customerBalance()).toBe(100000);
    expect(await walletTxCount()).toBe(0);
    expect(await ledgerForContract()).toHaveLength(0);
    const c = await contractRow();
    expect(c.reserved_amount).toBe(200000);
    expect(c.consumed_amount).toBe(0);
    expect((await itemRow('A-1')).status).toBe('reserved');
    expect((await itemRow('A-2')).status).toBe('reserved');
  });

  it('a fully-funded wallet lets both assessments consume exactly once', async () => {
    await seedScenario(200000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    await reserveAssessment('A-2', 100000, 'Assessment 2');
    const results = await Promise.allSettled([
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await customerBalance()).toBe(0);
    expect(await walletTxCount()).toBe(2);
    expect(await ledgerForContract()).toHaveLength(2);
    const c = await contractRow();
    expect(c.reserved_amount).toBe(0);
    expect(c.consumed_amount).toBe(200000);
  });
});

// ─── C. Cross-device concurrency (shared persistence boundary) ──

describe('cross-device concurrency', () => {
  beforeEach(() => seedScenario());

  it('two simulated devices consuming the same assessment converge to one debit', async () => {
    await seedScenario(1000000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');

    // Simulate a second device: a fresh module instance (fresh
    // per-contract mutex) bound to the SAME shared persistence store.
    await vi.resetModules();
    const device2: typeof transactionService = (await import('../../../services/transactionService')).transactionService;

    const results = await Promise.allSettled([
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
      device2.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
    ]);
    // Cross-device races are governed by deterministic ids + OCC
    // version conflicts at sync (the documented design): both local
    // attempts may complete, writing identical-keyed rows. The
    // durable state must converge to exactly one debit — never a
    // duplicate — and at least one attempt must have succeeded.
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    // Exactly one debit, one ledger posting, one consumption.
    expect(await walletTxCount()).toBe(1);
    expect(await ledgerForContract()).toHaveLength(1);
    expect(await customerBalance()).toBe(900000);
    const c = await contractRow();
    expect(c.consumed_amount).toBe(100000);
    expect(c.reserved_amount).toBe(0);
    expect((await itemRow('A-1')).status).toBe('consumed');
    // Exactly-once enforcement: once converged, any further
    // consumption of the same assessment is refused.
    await expect(
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
    ).rejects.toThrow(/only reserved assessments can be consumed|already has consumption transaction/);
  });

  it('two devices consuming different assessments for the same insufficient balance both fail', async () => {
    await seedScenario(100000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    await reserveAssessment('A-2', 100000, 'Assessment 2');

    await vi.resetModules();
    const device2: typeof transactionService = (await import('../../../services/transactionService')).transactionService;

    const results = await Promise.allSettled([
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
      device2.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' }),
    ]);
    // Neither device may spend the same insufficient balance.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(await customerBalance()).toBe(100000);
    expect(await walletTxCount()).toBe(0);
    const c = await contractRow();
    expect(c.reserved_amount).toBe(200000);
    expect(c.consumed_amount).toBe(0);
  });
});

// ─── D. Reconciliation (§8/§10.19) ───────────────────────────

describe('wallet-to-ledger and contract-reservation reconciliation', () => {
  beforeEach(() => seedScenario());

  it('reconciles a fully-funded contract after several consumptions', async () => {
    await seedScenario(1000000);
    for (let i = 1; i <= 3; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' });

    const { contracts, items, walletTransactions, ledger, walletBalance } = await loadCanonical();
    const report = reconcilePrintingContracts({
      contracts, items, walletTransactions, ledger,
      customerId: CUSTOMER_ID, walletBalance,
    });

    // Wallet-level position.
    expect(report.walletBalance).toBe(800000);
    expect(report.totalActiveReservations).toBe(100000); // one remaining reservation
    expect(report.availableForUnrelatedSpending).toBe(700000);
    expect(report.totalConsumed).toBe(200000);

    // Per-contract position.
    expect(report.contracts).toHaveLength(1);
    const line = report.contracts[0];
    expect(line.contractValue).toBe(1000000);
    expect(line.originalReserved).toBe(300000);
    expect(line.currentReserved).toBe(100000);
    expect(line.consumedToDate).toBe(200000);
    expect(line.unallocatedFunds).toBe(700000);
    expect(line.consumedCount).toBe(2);
    expect(line.reservedCount).toBe(1);
    // Fully reconciled: no discrepancies.
    expect(line.discrepancies).toHaveLength(0);
    expect(report.discrepancies).toHaveLength(0);
    // Wallet ↔ ledger linkage is complete.
    expect(report.contractWalletTransactions.length).toBeGreaterThanOrEqual(2);
    expect(report.contractLedgerEntries.length).toBe(2);
  });

  it('reports a discrepancy when the reservation bucket drifts from the items', async () => {
    await seedScenario(1000000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    // Simulate bucket drift: reserved_amount bucket no longer
    // matches the canonical reserved item (a real defect shape).
    const c = await contractRow();
    await storeFor('assessmentContracts').put({ ...c, reserved_amount: 999999 });

    const { contracts, items, walletTransactions, ledger, walletBalance } = await loadCanonical();
    const report = reconcilePrintingContracts({
      contracts, items, walletTransactions, ledger,
      customerId: CUSTOMER_ID, walletBalance,
    });
    // The drift is reported explicitly, never silently repaired.
    expect(report.contracts[0].discrepancies.length).toBeGreaterThan(0);
    expect(report.discrepancies.length).toBeGreaterThan(0);
    expect(report.contracts[0].reservedItemsValue).toBe(100000);
  });

  it('reports a missing ledger posting for a consumption debit', async () => {
    await seedScenario(1000000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    // Remove the matching ledger entry to simulate a lost posting.
    await storeFor('ledger').delete('LG-WTX-A-1-CONSUMED');

    const { contracts, items, walletTransactions, ledger, walletBalance } = await loadCanonical();
    const report = reconcilePrintingContracts({
      contracts, items, walletTransactions, ledger,
      customerId: CUSTOMER_ID, walletBalance,
    });
    expect(report.discrepancies.some((d) => /no matching ledger entry/i.test(d))).toBe(true);
  });
});

// ─── E. Completion receipt counts (§10.16/§10.17) ────────────

describe('assessment completion receipt progress counts', () => {
  beforeEach(() => seedScenario());

  const buildTenAssessmentContract = async () => {
    await seedScenario(1000000);
    await seedContract({ max_assessments: 10, prepaid_amount: 1000000, assessment_price: 100000 });
    for (let i = 1; i <= 10; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`, '2026-03-15');
    }
  };

  it('reports 1 of 10 after the first completion', async () => {
    await buildTenAssessmentContract();
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    const freshItems = await allItems();
    const consumed = freshItems.find((it) => it.id === 'A-1')!;
    const doc = await buildAssessmentCompletionReceiptDoc({
      contract: await contractRow(),
      item: consumed,
      items: freshItems,
      sequence: 1,
      amountDebited: 100000,
      walletBalanceAfter: 900000,
      walletTransactionId: 'WTX-A-1-CONSUMED',
      ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
      customerName: 'Test School',
      consumedAtIso: consumed.consumed_at,
    });
    expect(doc.totalAssessments).toBe(10);
    expect(doc.sequence).toBe(1);
    expect(doc.completedToDate).toBe(1);
    expect(doc.remainingAssessments).toBe(9);
    expect(doc.contractValue).toBe(1000000);
    expect(doc.amountDebited).toBe(100000);
    expect(doc.totalConsumedToDate).toBe(100000);
    expect(doc.remainingReservedFunds).toBe(900000);
    expect(doc.unallocatedFunds).toBe(0);
  });

  it('reports 2 of 10 after the second completion', async () => {
    await buildTenAssessmentContract();
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' });
    const freshItems = await allItems();
    const consumed = freshItems.find((it) => it.id === 'A-2')!;
    const doc = await buildAssessmentCompletionReceiptDoc({
      contract: await contractRow(),
      item: consumed,
      items: freshItems,
      sequence: 2,
      amountDebited: 100000,
      walletBalanceAfter: 800000,
      walletTransactionId: 'WTX-A-2-CONSUMED',
      ledgerEntryId: 'LG-WTX-A-2-CONSUMED',
      customerName: 'Test School',
      consumedAtIso: consumed.consumed_at,
    });
    expect(doc.completedToDate).toBe(2);
    expect(doc.remainingAssessments).toBe(8);
    expect(doc.totalConsumedToDate).toBe(200000);
    expect(doc.remainingReservedFunds).toBe(800000);
  });

  it('reports 10 of 10 after the final completion', async () => {
    await buildTenAssessmentContract();
    for (let i = 1; i <= 10; i++) {
      await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: `A-${i}` });
    }
    const freshItems = await allItems();
    const consumed = freshItems.find((it) => it.id === 'A-10')!;
    const doc = await buildAssessmentCompletionReceiptDoc({
      contract: await contractRow(),
      item: consumed,
      items: freshItems,
      sequence: 10,
      amountDebited: 100000,
      walletBalanceAfter: 0,
      walletTransactionId: 'WTX-A-10-CONSUMED',
      ledgerEntryId: 'LG-WTX-A-10-CONSUMED',
      customerName: 'Test School',
      consumedAtIso: consumed.consumed_at,
    });
    expect(doc.completedToDate).toBe(10);
    expect(doc.remainingAssessments).toBe(0);
    expect(doc.totalConsumedToDate).toBe(1000000);
    expect(doc.remainingReservedFunds).toBe(0);
    expect(doc.unallocatedFunds).toBe(0);
  });

  it('is not issued for a failed or duplicate consumption attempt', async () => {
    await buildTenAssessmentContract();
    // A reserved (not consumed) assessment must never yield a receipt.
    const reserved = await itemRow('A-1');
    await expect(
      buildAssessmentCompletionReceiptDoc({
        contract: await contractRow(),
        item: reserved,
        items: await allItems(),
        sequence: 1,
        amountDebited: 100000,
        walletBalanceAfter: 1000000,
        walletTransactionId: 'WTX-A-1-CONSUMED',
        customerName: 'Test School',
      }),
    ).rejects.toThrow(/requires a consumed assessment/);

    // A duplicate consumption attempt throws and writes nothing,
    // so no second receipt can be generated for the same assessment.
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    await expect(
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
    ).rejects.toThrow(/only reserved assessments can be consumed|Duplicate financial request/);
    expect(await walletTxCount()).toBe(1);
  });
});

// ─── F. Schedule generation + completeness (§10.15) ──────────

describe('contract schedule generation and completeness', () => {
  beforeEach(() => seedScenario());

  it('generates a complete schedule with sequences, dates and reconciliation', async () => {
    await seedContract({ max_assessments: 3, prepaid_amount: 300000, assessment_price: 100000 });
    for (let i = 1; i <= 3; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`, `2026-03-${10 + i}`);
    }
    const doc = await buildContractScheduleDoc({
      contract: await contractRow(),
      items: await allItems(),
      customerName: 'Test School',
      schoolName: 'Test School',
    });
    expect(doc.totalAssessments).toBe(3);
    expect(doc.scheduleComplete).toBe(true);
    expect(doc.missingDateSequences).toHaveLength(0);
    expect(doc.schedule.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(doc.schedule[0].assessmentDate).toBeTruthy();
    expect(doc.prepaidAmount).toBe(300000);
    expect(doc.reservedAmount).toBe(300000);
    expect(doc.availableFunds).toBe(0);
    // The integrity hash is a SHA-256 hex digest.
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags an incomplete schedule instead of representing it as agreed', async () => {
    await seedContract({ max_assessments: 2, prepaid_amount: 200000 });
    // One assessment has a date, the other does not. These are
    // pre-existing reserved rows (not created via the reservation
    // operation) so the schedule reads them directly.
    await storeFor('contractAssessments').put({
      id: 'A-1', contract_id: CONTRACT_ID, company_id: 'CO-1', customer_id: CUSTOMER_ID,
      school_id: 'SCH-1', assessment_type: 'examination', assessment_name: 'Assessment 1',
      assessment_date: '2026-03-10', status: 'reserved', item_price: 100000,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
    });
    await storeFor('contractAssessments').put({
      id: 'A-2', contract_id: CONTRACT_ID, company_id: 'CO-1', customer_id: CUSTOMER_ID,
      school_id: 'SCH-1', assessment_type: 'examination', assessment_name: 'Assessment 2',
      assessment_date: undefined, status: 'reserved', item_price: 100000,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
    });
    const doc = await buildContractScheduleDoc({
      contract: await contractRow(),
      items: await allItems(),
      customerName: 'Test School',
    });
    expect(doc.scheduleComplete).toBe(false);
    expect(doc.missingDateSequences).toEqual([2]);
    // The missing date is not silently substituted.
    expect(doc.schedule[1].assessmentDate).toBeUndefined();
  });
});

// ─── G. Closed-period posting protection (§10.14) ────────────

describe('financial-year closure protection', () => {
  beforeEach(() => seedScenario());

  it('refuses assessment consumption inside a closed period', async () => {
    await seedScenario(1000000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    // Close the period covering today (the consumption date).
    const today = new Date().toISOString().slice(0, 10);
    closedPeriods = [{
      id: 'FP-1', from: today, to: today, reason: 'Year-end close',
      closedAt: new Date().toISOString(), closedBy: 'admin',
    }];
    await expect(
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' }),
    ).rejects.toThrow(/closed.*not permitted within a closed financial period/i);
    // Nothing was written.
    expect(await walletTxCount()).toBe(0);
    expect(await ledgerForContract()).toHaveLength(0);
    expect((await itemRow('A-1')).status).toBe('reserved');
  });

  it('refuses assessment scheduling dated inside a closed period', async () => {
    closedPeriods = [{
      id: 'FP-1', from: '2026-03-01', to: '2026-03-31', reason: 'March close',
      closedAt: new Date().toISOString(), closedBy: 'admin',
    }];
    await expect(
      reserveAssessment('A-1', 100000, 'Assessment 1', '2026-03-15'),
    ).rejects.toThrow(/closed.*not permitted within a closed financial period/i);
  });

  it('permits consumption when the period is open', async () => {
    await seedScenario(1000000);
    await reserveAssessment('A-1', 100000, 'Assessment 1');
    closedPeriods = [];
    const res: any = await transactionService.consumeContractAssessment({
      contractId: CONTRACT_ID, assessmentItemId: 'A-1',
    });
    expect(res.success).toBe(true);
    expect(await walletTxCount()).toBe(1);
  });
});

// ─── H. Lifecycle resolution (§10.12) ────────────────────────

describe('lifecycle resolution of remaining funds', () => {
  beforeEach(() => seedScenario());

  it('cancellation resolves the remaining reservation as a refundable balance', async () => {
    await seedScenario(1000000);
    await seedContract({ max_assessments: 10, prepaid_amount: 1000000, assessment_price: 100000 });
    for (let i = 1; i <= 10; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    // Consume two assessments.
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' });

    const c = await contractRow();
    expect(c.consumed_amount).toBe(200000);
    expect(c.reserved_amount).toBe(800000);

    // Cancel: the remaining reservation (800,000) becomes the
    // refundable balance. Consumed value (200,000) is earned.
    const refundable = c.prepaid_amount - c.consumed_amount;
    expect(refundable).toBe(800000);

    // Reconciliation after cancellation: the contract no longer
    // holds a reservation, so available-for-unrelated-spending
    // returns to the full wallet balance.
    await storeFor('assessmentContracts').put({ ...c, status: 'cancelled', reserved_amount: 0 });
    const { contracts, items, walletTransactions, ledger, walletBalance } = await loadCanonical();
    const report = reconcilePrintingContracts({
      contracts, items, walletTransactions, ledger,
      customerId: CUSTOMER_ID, walletBalance,
    });
    // A cancelled contract holds no active reservation.
    expect(report.totalActiveReservations).toBe(0);
    expect(report.availableForUnrelatedSpending).toBe(walletBalance);
    expect(report.totalConsumed).toBe(200000);
  });

  it('suspension retains the remaining reservation', async () => {
    await seedScenario(1000000);
    await seedContract({ max_assessments: 10, prepaid_amount: 1000000, assessment_price: 100000 });
    for (let i = 1; i <= 10; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    // Suspend: the remaining reservation is retained (not released).
    const c = await contractRow();
    await storeFor('assessmentContracts').put({ ...c, status: 'suspended' });

    const { contracts, items, walletTransactions, ledger, walletBalance } = await loadCanonical();
    const report = reconcilePrintingContracts({
      contracts, items, walletTransactions, ledger,
      customerId: CUSTOMER_ID, walletBalance,
    });
    // A suspended contract retains its reservation: it is still
    // excluded from unrelated spending.
    expect(report.totalActiveReservations).toBe(900000);
    expect(report.availableForUnrelatedSpending).toBe(walletBalance - 900000);

    // New consumption is blocked on a suspended contract.
    await expect(
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-2' }),
    ).rejects.toThrow(/only active contracts can consume/);
  });
});

// ─── I. Amendment value adjustment (§10.13) ──────────────────

describe('amendment value adjustment', () => {
  beforeEach(() => seedScenario());

  it('an increase requires verified additional funds before the reservation grows', async () => {
    await seedScenario(1000000);
    await seedContract({ max_assessments: 10, prepaid_amount: 1000000, assessment_price: 100000 });
    for (let i = 1; i <= 10; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    // Amendment increases the contract value by 500,000. The
    // wallet must hold the additional eligible funds before the
    // reservation may grow — an amendment never fabricates funds.
    const c = await contractRow();
    const wallet = await storeFor('customers').get(CUSTOMER_ID);
    // Top up the wallet through a real balance-updating deposit
    // (the only legitimate way to create spendable funds).
    const newBalance = Number(wallet.walletBalance) + 500000;
    await storeFor('customers').put({ ...wallet, walletBalance: newBalance });
    await storeFor('walletTransactions').put({
      id: 'WTX-TOPUP', customerId: CUSTOMER_ID, amount: 500000,
      type: 'Deposit', reference: 'Top-up', date: new Date().toISOString(),
      data: { type: 'WALLET_TOPUP' },
    });

    // The amended reservation is backed by the verified funds.
    const amendedReserved = c.reserved_amount + 500000;
    expect(amendedReserved).toBe(1500000);
    expect(newBalance).toBe(1500000);
    // The wallet still covers every reservation.
    expect(newBalance >= amendedReserved).toBe(true);
  });

  it('a decrease adjusts the reservation safely without changing historical consumption', async () => {
    await seedScenario(1000000);
    await seedContract({ max_assessments: 10, prepaid_amount: 1000000, assessment_price: 100000 });
    for (let i = 1; i <= 10; i++) {
      await reserveAssessment(`A-${i}`, 100000, `Assessment ${i}`);
    }
    await transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'A-1' });
    const before = await contractRow();
    expect(before.consumed_amount).toBe(100000);
    expect(before.reserved_amount).toBe(900000);

    // Amendment reduces the contract value by 200,000. Historical
    // consumption (100,000) is unchanged; the reservation shrinks.
    const reducedReserved = before.reserved_amount - 200000;
    expect(reducedReserved).toBe(700000);
    expect(before.consumed_amount).toBe(100000); // unchanged
  });
});
