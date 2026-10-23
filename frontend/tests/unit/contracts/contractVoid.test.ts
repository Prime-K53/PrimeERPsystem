/**
 * contractVoid.test.ts — Cancel vs Void semantics for printing contracts.
 *
 * Canonical invariants under test:
 *   CANCEL stops the contract and releases ONLY the remaining reservation
 *   (200 reserved / 50 consumed / 150 remaining → 150 released). The consumed
 *   assessment and the money already debited stay untouched — no credit is
 *   ever posted.
 *
 *   VOID is the compensating reversal: every consumed assessment is reversed
 *   with exactly one deterministic Credit wallet transaction and one reversing
 *   ledger entry, the customer wallet is credited once with the total actually
 *   debited, remaining reserved items are released, items become terminal
 *   `voided`, and the contract becomes terminal `voided` with zeroed buckets
 *   and the full before-state preserved in `data.void`.
 *
 *   Both operations fail closed: missing consumption evidence (wallet tx or
 *   ledger entry), an existing reversal credit, a closed financial year or a
 *   closed period registry entry refuse the operation BEFORE any write.
 *   Repeating a void is idempotent and posts no second credit.
 *
 * Uses the real transactionService against the in-memory dbService harness
 * (same pattern as contractConsumption.test.ts / phase1ReservationGuard.test.ts).
 */

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

vi.mock('../../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    delete: async (s: string, id: string) => storeFor(s).delete(id),
    getSetting: async () => undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../../services/transactionService';
import { customerFundingPosition } from '../../../utils/contractFunds';
import { reconcilePrintingContracts } from '../../../utils/contractReconciliation';

// ─── Fixtures ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

const CUSTOMER_ID = 'CUST-1';
const CONTRACT_ID = 'PC-1';

async function seedCustomer(balance: number) {
  return storeFor('customers').put({ id: CUSTOMER_ID, name: 'Test School', walletBalance: balance });
}

async function seedContract(overrides: any = {}) {
  return storeFor('assessmentContracts').put({
    id: CONTRACT_ID,
    company_id: 'CO-1',
    customer_id: CUSTOMER_ID,
    school_id: 'SCH-1',
    contract_number: 'PC-2026-0001',
    title: 'Term 3 exam printing',
    status: 'active',
    prepaid_amount: 200000,
    consumed_amount: 0,
    reserved_amount: 200000,
    assessment_count: 4,
    max_assessments: 4,
    assessment_price: 50000,
    assessment_type: 'examination',
    payment_status: 'verified',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    data: {},
    ...overrides,
  });
}

async function seedItem(id: string, price: number, overrides: any = {}) {
  return storeFor('contractAssessments').put({
    id,
    contract_id: CONTRACT_ID,
    company_id: 'CO-1',
    customer_id: CUSTOMER_ID,
    school_id: 'SCH-1',
    assessment_name: `Assessment ${id}`,
    status: 'reserved',
    item_price: price,
    version: 1,
    ...overrides,
  });
}

/**
 * 200,000 reserved / 50,000 consumed / 150,000 remaining.
 * Wallet starts at 1,000,000 and the canonical consumption debits 50,000.
 */
async function seedConsumedScenario(balance = 1000000) {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await seedCustomer(balance);
  await seedContract({ reserved_amount: 200000 });
  await seedItem('C-1', 50000);
  await seedItem('R-1', 50000);
  await seedItem('R-2', 50000);
  await seedItem('R-3', 50000);
  await transactionService.consumeContractAssessment({
    contractId: CONTRACT_ID,
    assessmentItemId: 'C-1',
  });
}

const walletRows = async () => (await storeFor('walletTransactions').getAll()) as any[];
const ledgerRows = async () => (await storeFor('ledger').getAll()) as any[];
const itemIdsWithStatus = async (status: string) =>
  ((await storeFor('contractAssessments').getAll()) as any[])
    .filter((it) => String(it?.status || '') === status)
    .map((it) => String(it.id))
    .sort();

// ─── A. Cancel releases only the remaining reservation ─────────────────

describe('cancel: stops the contract and releases only the remaining reservation', () => {
  beforeEach(() => seedConsumedScenario());

  it('releases the 150,000 remaining and preserves the 50,000 consumed', async () => {
    const res: any = await transactionService.cancelPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'Customer withdrew before the term',
      performedBy: 'u-1',
    });

    expect(res.success).toBe(true);
    expect(res.already).toBe(false);
    expect(res.status).toBe('cancelled');
    expect(res.releasedValue).toBe(150000);

    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('cancelled');
    // Commercial value and consumed history survive a cancel untouched.
    expect(contract.prepaid_amount).toBe(200000);
    expect(contract.consumed_amount).toBe(50000);
    expect(contract.reserved_amount).toBe(0);
    expect(contract.cancelled_at).toBeTruthy();
    expect(contract.data.closure).toMatchObject({
      status: 'cancelled',
      releasedValue: 150000,
      reason: 'Customer withdrew before the term',
      by: 'u-1',
    });

    expect(await itemIdsWithStatus('consumed')).toEqual(['C-1']);
    expect(await itemIdsWithStatus('released')).toEqual(['R-1', 'R-2', 'R-3']);
    expect(await itemIdsWithStatus('voided')).toEqual([]);

    // Money already consumed is NOT returned by a cancel.
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(950000);
    const txs = await walletRows();
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('Deduction');
    expect(txs[0].id).toBe('WTX-C-1-CONSUMED');
    expect(await ledgerRows()).toHaveLength(1);
    expect(await storeFor('walletTransactions').get('WTX-C-1-VOID-REVERSAL')).toBeUndefined();
  });

  it('is idempotent: a repeated cancel writes nothing', async () => {
    await transactionService.cancelPrintingContract({ contractId: CONTRACT_ID });
    const version = ((await storeFor('assessmentContracts').get(CONTRACT_ID)) as any).version;
    const keysBefore = (await storeFor('idempotencyKeys').getAll()).length;

    const again: any = await transactionService.cancelPrintingContract({ contractId: CONTRACT_ID });
    expect(again.success).toBe(true);
    expect(again.already).toBe(true);
    expect(again.releasedValue).toBe(0);

    const after: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(after.version).toBe(version);
    expect((await storeFor('idempotencyKeys').getAll()).length).toBe(keysBefore);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(950000);
  });

  it('holds zero protected funds after cancel', async () => {
    await transactionService.cancelPrintingContract({ contractId: CONTRACT_ID });
    const position = customerFundingPosition({
      contracts: (await storeFor('assessmentContracts').getAll()) as any,
      items: (await storeFor('contractAssessments').getAll()) as any,
      customerId: CUSTOMER_ID,
      walletBalance: 950000,
    });
    expect(position.totalActiveReservations).toBe(0);
    expect(position.availableForUnrelatedSpending).toBe(950000);
  });

  it('cannot cancel a voided contract', async () => {
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'Signed in error' });
    await expect(
      transactionService.cancelPrintingContract({ contractId: CONTRACT_ID }),
    ).rejects.toThrow(/voided.*terminal/);
  });
});

// ─── B. Void reverses every consumed assessment ────────────────────────

describe('void: reverses consumed assessments and returns the money', () => {
  beforeEach(() => seedConsumedScenario());

  it('credits the debited 50,000 back, releases 150,000 and zeroes the contract', async () => {
    const res: any = await transactionService.voidPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'Contract signed in error',
      performedBy: 'u-1',
    });

    expect(res.success).toBe(true);
    expect(res.already).toBe(false);
    expect(res.status).toBe('voided');
    expect(res.reversedValue).toBe(50000);
    expect(res.releasedValue).toBe(150000);
    expect(res.newBalance).toBe(1000000);
    expect(res.walletTransactionIds).toEqual(['WTX-C-1-VOID-REVERSAL']);
    expect(res.ledgerEntryIds).toEqual(['LG-WTX-C-1-VOID-REVERSAL']);

    // The wallet is restored to its pre-consumption balance.
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(1000000);

    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('voided');
    expect(contract.prepaid_amount).toBe(0);
    expect(contract.consumed_amount).toBe(0);
    expect(contract.reserved_amount).toBe(0);
    expect(contract.voided_at).toBeTruthy();
    expect(contract.data.void).toMatchObject({
      status: 'voided',
      reason: 'Contract signed in error',
      by: 'u-1',
      prepaidAmountBefore: 200000,
      consumedAmountBefore: 50000,
      reservedAmountBefore: 150000,
      reversedAmount: 50000,
      releasedAmount: 150000,
      reversedItemIds: ['C-1'],
      walletTransactionIds: ['WTX-C-1-VOID-REVERSAL'],
      ledgerEntryIds: ['LG-WTX-C-1-VOID-REVERSAL'],
    });
    expect([...contract.data.void.releasedItemIds].sort()).toEqual(['R-1', 'R-2', 'R-3']);

    // Consumed → voided, with reversal linkage recorded on the item.
    const consumedItem: any = await storeFor('contractAssessments').get('C-1');
    expect(consumedItem.status).toBe('voided');
    expect(consumedItem.voided_at).toBeTruthy();
    expect(consumedItem.void_reason).toBe('Contract signed in error');
    expect(consumedItem.reversal_wallet_transaction_id).toBe('WTX-C-1-VOID-REVERSAL');
    expect(consumedItem.data.void).toMatchObject({
      reason: 'Contract signed in error',
      by: 'u-1',
      amount: 50000,
      originalWalletTransactionId: 'WTX-C-1-CONSUMED',
      originalLedgerEntryId: 'LG-WTX-C-1-CONSUMED',
      reversalWalletTransactionId: 'WTX-C-1-VOID-REVERSAL',
      reversalLedgerEntryId: 'LG-WTX-C-1-VOID-REVERSAL',
    });

    // Reserved items become released; their money never left the wallet, so
    // no credit is fabricated for them.
    for (const id of ['R-1', 'R-2', 'R-3']) {
      const item: any = await storeFor('contractAssessments').get(id);
      expect(item.status).toBe('released');
      expect(item.release_reason).toBe('contract_void');
      expect(item.data.void.releasedByContractVoid).toBe(true);
    }
  });

  it('posts exactly one Credit wallet transaction with full linkage', async () => {
    await transactionService.voidPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'Signed in error',
      performedBy: 'u-1',
    });

    const txs = await walletRows();
    expect(txs).toHaveLength(2);
    const credit = txs.find((tx) => tx.id === 'WTX-C-1-VOID-REVERSAL');
    expect(credit).toBeTruthy();
    expect(credit.type).toBe('Credit');
    expect(credit.amount).toBe(50000);
    expect(credit.customerId).toBe(CUSTOMER_ID);
    expect(credit.data.type).toBe('ASSESSMENT_VOID_REVERSAL');
    expect(credit.data.contract_id).toBe(CONTRACT_ID);
    expect(credit.data.assessment_item_id).toBe('C-1');
    expect(credit.data.amount).toBe(50000);
    expect(credit.data.original_wallet_transaction_id).toBe('WTX-C-1-CONSUMED');
    expect(credit.data.original_ledger_entry_id).toBe('LG-WTX-C-1-CONSUMED');
    expect(credit.data.reason).toBe('Signed in error');
    expect(credit.idempotencyKey).toBe('wallet:contract:PC-1:void:C-1');

    expect(await storeFor('idempotencyKeys').get('wallet:contract:PC-1:void')).toBeTruthy();
  });

  it('posts a reversing ledger entry that swaps the consumption legs', async () => {
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' });

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(2);

    const consumption = ledger.find((e) => e.id === 'LG-WTX-C-1-CONSUMED');
    expect(consumption.debitAccountId).toBe('ACC-21300');
    expect(consumption.creditAccountId).toBe('ACC-41100');
    expect(consumption.amount).toBe(50000);

    const reversal = ledger.find((e) => e.id === 'LG-WTX-C-1-VOID-REVERSAL');
    expect(reversal).toBeTruthy();
    expect(reversal.debitAccountId).toBe('ACC-41100');
    expect(reversal.creditAccountId).toBe('ACC-21300');
    expect(reversal.amount).toBe(50000);
    expect(reversal.referenceId).toBe('C-1');
    expect(reversal.customerId).toBe(CUSTOMER_ID);
    expect(reversal.data.type).toBe('ASSESSMENT_VOID_REVERSAL');
    expect(reversal.data.original_wallet_transaction_id).toBe('WTX-C-1-CONSUMED');
  });

  it('reverses the amount actually debited, not the current item price', async () => {
    // Historical debit may differ from the item's price (e.g. a repriced
    // assessment). The void must return what actually left the wallet.
    const debit: any = await storeFor('walletTransactions').get('WTX-C-1-CONSUMED');
    await storeFor('walletTransactions').put({ ...debit, amount: 45000 });
    const consumption: any = await storeFor('ledger').get('LG-WTX-C-1-CONSUMED');
    await storeFor('ledger').put({ ...consumption, amount: 45000 });

    const res: any = await transactionService.voidPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'x',
    });
    expect(res.reversedValue).toBe(45000);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(995000);
    const credit: any = await storeFor('walletTransactions').get('WTX-C-1-VOID-REVERSAL');
    expect(credit.amount).toBe(45000);
  });

  it('is idempotent: a second void posts no second credit', async () => {
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' });
    const txCountBefore = (await walletRows()).length;
    const ledgerCountBefore = (await ledgerRows()).length;
    const balanceBefore = ((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance;

    const again: any = await transactionService.voidPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'x',
    });
    expect(again.success).toBe(true);
    expect(again.already).toBe(true);
    expect(again.reversedValue).toBe(0);
    expect(again.releasedValue).toBe(0);

    expect((await walletRows()).length).toBe(txCountBefore);
    expect((await ledgerRows()).length).toBe(ledgerCountBefore);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(balanceBefore);
    expect(((await storeFor('assessmentContracts').get(CONTRACT_ID)) as any).status).toBe('voided');
  });

  it('serializes concurrent voids to exactly one credit', async () => {
    const results = await Promise.all([
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ]);
    expect(results.map((r: any) => r.already).sort()).toEqual([false, true]);
    const credits = (await walletRows()).filter((tx) => tx.type === 'Credit');
    expect(credits).toHaveLength(1);
    expect(credits[0].id).toBe('WTX-C-1-VOID-REVERSAL');
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(1000000);
  });
});

// ─── C. Void with nothing consumed ─────────────────────────────────────

describe('void without consumed assessments', () => {
  beforeEach(async () => {
    stores.clear();
    for (const a of ACCOUNTS) await storeFor('accounts').put(a);
    await seedCustomer(1000000);
    await seedContract({ reserved_amount: 150000, consumed_amount: 0, assessment_count: 3, max_assessments: 3 });
    await seedItem('R-1', 50000);
    await seedItem('R-2', 50000);
    await seedItem('R-3', 50000);
  });

  it('releases remaining reservations without fabricating a wallet credit', async () => {
    const res: any = await transactionService.voidPrintingContract({
      contractId: CONTRACT_ID,
      reason: 'Created by mistake',
    });
    expect(res.reversedValue).toBe(0);
    expect(res.releasedValue).toBe(150000);
    expect(res.newBalance).toBe(1000000);
    expect(res.walletTransactionIds).toEqual([]);
    expect(res.ledgerEntryIds).toEqual([]);

    expect(await walletRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(1000000);
    expect(await itemIdsWithStatus('released')).toEqual(['R-1', 'R-2', 'R-3']);
    expect(await itemIdsWithStatus('voided')).toEqual([]);
    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('voided');
    expect(contract.data.void.reversedAmount).toBe(0);
    expect(contract.data.void.releasedAmount).toBe(150000);
  });
});

// ─── D. Fail closed on missing / duplicate evidence ─────────────────────

describe('void fails closed without consumption evidence', () => {
  it('refuses when the consumption wallet transaction is missing', async () => {
    stores.clear();
    for (const a of ACCOUNTS) await storeFor('accounts').put(a);
    await seedCustomer(1000000);
    await seedContract({ reserved_amount: 150000, consumed_amount: 50000 });
    // A "consumed" row with no debit evidence behind it.
    await seedItem('C-1', 50000, { status: 'consumed', consumed_at: new Date().toISOString() });
    await seedItem('R-1', 50000);

    await expect(
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ).rejects.toThrow(/no consumption wallet transaction \(WTX-C-1-CONSUMED\)/);

    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('active');
    expect(contract.consumed_amount).toBe(50000);
    expect(contract.reserved_amount).toBe(150000);
    expect((await storeFor('contractAssessments').get('C-1') as any).status).toBe('consumed');
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(1000000);
    expect(await walletRows()).toHaveLength(0);
    expect(await storeFor('idempotencyKeys').getAll()).toHaveLength(0);
  });

  it('refuses when the consumption ledger entry is missing', async () => {
    await seedConsumedScenario();
    await storeFor('ledger').delete('LG-WTX-C-1-CONSUMED');

    await expect(
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ).rejects.toThrow(/no consumption ledger entry \(LG-WTX-C-1-CONSUMED\)/);

    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('active');
    expect(contract.consumed_amount).toBe(50000);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(950000);
    expect(await storeFor('walletTransactions').get('WTX-C-1-VOID-REVERSAL')).toBeUndefined();
  });

  it('refuses when a reversal credit already exists', async () => {
    await seedConsumedScenario();
    await storeFor('walletTransactions').put({
      id: 'WTX-C-1-VOID-REVERSAL',
      customerId: CUSTOMER_ID,
      type: 'Credit',
      amount: 50000,
      date: new Date().toISOString(),
    });

    await expect(
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ).rejects.toThrow(/already exists.*duplicate credit/i);

    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(950000);
    expect(((await storeFor('assessmentContracts').get(CONTRACT_ID)) as any).status).toBe('active');
    expect(((await storeFor('contractAssessments').get('C-1')) as any).status).toBe('consumed');
  });
});

// ─── E. Closed accounting windows refuse the reversal ──────────────────

describe('void refuses closed accounting windows before writing', () => {
  beforeEach(() => seedConsumedScenario());

  const expectUntouched = async () => {
    const contract: any = await storeFor('assessmentContracts').get(CONTRACT_ID);
    expect(contract.status).toBe('active');
    expect(contract.consumed_amount).toBe(50000);
    expect(contract.reserved_amount).toBe(150000);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(950000);
    expect(await walletRows()).toHaveLength(1);
  };

  it('refuses a closed financial year', async () => {
    await storeFor('financialYears').put({
      id: 'FY-CLOSED',
      name: 'Closed FY',
      start_date: '2000-01-01',
      end_date: '2999-12-31',
      is_closed: true,
    });

    await expect(
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ).rejects.toThrow(/closed financial year 'Closed FY'/);
    await expectUntouched();
  });

  it('refuses a closed period registry entry', async () => {
    await storeFor('settings').put({
      id: 'financial_closed_periods',
      value: [{ id: 'P-1', from: '2000-01-01', to: '2999-12-31', reason: 'Year-end lock' }],
    });

    await expect(
      transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' }),
    ).rejects.toThrow(/closed \(Year-end lock\).*voidPrintingContract is not permitted/);
    await expectUntouched();
  });
});

// ─── F. `voided` is terminal for every other operation ─────────────────

describe('voided contract is terminal', () => {
  beforeEach(async () => {
    await seedConsumedScenario();
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' });
  });

  it('cannot be closed again', async () => {
    await expect(
      transactionService.resolveContractClosure({ contractId: CONTRACT_ID, targetStatus: 'cancelled' }),
    ).rejects.toThrow(/voided.*terminal/);
  });

  it('cannot be refunded (the consumed money was already returned)', async () => {
    await expect(
      transactionService.refundContractBalance({
        contractId: CONTRACT_ID,
        amount: 1000,
        policyReference: 'POL-1',
      }),
    ).rejects.toThrow(/voided.*already returned by the void/);
    expect(((await storeFor('customers').get(CUSTOMER_ID)) as any).walletBalance).toBe(1000000);
  });

  it('cannot be amended', async () => {
    await expect(
      transactionService.applyContractAmendmentDelta({
        contractId: CONTRACT_ID,
        amendmentId: 'AM-1',
        prepaidDelta: 1000,
      }),
    ).rejects.toThrow(/closed \(voided\)/);
  });

  it('cannot be scheduled on', async () => {
    await expect(
      transactionService.reserveContractAssessment({
        contractId: CONTRACT_ID,
        assessmentItemId: 'NEW-1',
        assessment: { assessment_name: 'New assessment', item_price: 1000 },
      }),
    ).rejects.toThrow(/voided.*cannot be scheduled/);
    expect(await storeFor('contractAssessments').get('NEW-1')).toBeUndefined();
  });

  it('cannot consume its remaining assessments', async () => {
    await expect(
      transactionService.consumeContractAssessment({ contractId: CONTRACT_ID, assessmentItemId: 'R-1' }),
    ).rejects.toThrow(/only active contracts can consume/);
  });
});

// ─── G. Derived reports understand the reversal ────────────────────────

describe('reconciliation understands the void reversal', () => {
  it('reports zero consumed, zero reservations and no discrepancies', async () => {
    await seedConsumedScenario();
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' });

    const report = reconcilePrintingContracts({
      contracts: (await storeFor('assessmentContracts').getAll()) as any,
      items: (await storeFor('contractAssessments').getAll()) as any,
      walletTransactions: (await walletRows()) as any,
      ledger: (await ledgerRows()) as any,
      customerId: CUSTOMER_ID,
      walletBalance: 1000000,
    });

    expect(report.totalConsumed).toBe(0);
    expect(report.totalActiveReservations).toBe(0);
    expect(report.availableForUnrelatedSpending).toBe(1000000);
    expect(report.discrepancies).toEqual([]);
    expect(report.contracts).toHaveLength(1);
    expect(report.contracts[0].status).toBe('voided');
    expect(report.contracts[0].discrepancies).toEqual([]);
    expect(report.contracts[0].consumedItemsValue).toBe(0);
    expect(report.contracts[0].reservedItemsValue).toBe(0);
    expect(report.contracts[0].releasedAmount).toBe(200000);
  });

  it('nets consumption debits against void-reversal credits', async () => {
    await seedConsumedScenario();
    await transactionService.voidPrintingContract({ contractId: CONTRACT_ID, reason: 'x' });
    const report = reconcilePrintingContracts({
      contracts: (await storeFor('assessmentContracts').getAll()) as any,
      items: (await storeFor('contractAssessments').getAll()) as any,
      walletTransactions: (await walletRows()) as any,
      ledger: (await ledgerRows()) as any,
      customerId: CUSTOMER_ID,
      walletBalance: 1000000,
    });
    // History is immutable: the debit and its compensating credit both exist,
    // but only the net movement is reconciled against consumed_amount.
    expect(report.contractWalletTransactions).toHaveLength(2);
    expect(report.contractWalletTransactions.filter((tx: any) => tx.type === 'Deduction')).toHaveLength(1);
    expect(report.contractWalletTransactions.filter((tx: any) => tx.type === 'Credit')).toHaveLength(1);
    expect(report.discrepancies.join(' ')).not.toMatch(/net consumption/);
  });
});
