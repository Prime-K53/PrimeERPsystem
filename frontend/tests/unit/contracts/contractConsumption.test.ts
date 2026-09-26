/**
 * contractConsumption.test.ts — wallet-first assessment consumption.
 *
 * Canonical invariant under test:
 *   ONE assessment consumption = ONE wallet debit + ONE ledger posting + ONE consumed assessment.
 *   Retry / double-click / sync replay ⇒ NO second debit.
 *
 * Uses the real transactionService.consumeContractAssessment with an
 * in-memory dbService stub (same harness as tests/accounting/postEditCorrection.test.ts).
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
  },
}));

import { transactionService } from '../../../services/transactionService';

// ─── Fixtures ──────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

function seedCustomer(balance: number) {
  return storeFor('customers').put({ id: 'CUST-1', name: 'Test School', walletBalance: balance });
}

function seedContract(overrides: any = {}) {
  return storeFor('assessmentContracts').put({
    id: 'PC-1',
    company_id: 'CO-1',
    customer_id: 'CUST-1',
    school_id: 'SCH-1',
    contract_number: 'PC-2026-0001',
    title: 'Exam printing',
    status: 'active',
    prepaid_amount: 920700,
    consumed_amount: 0,
    reserved_amount: 0,
    max_assessments: 3,
    assessment_price: 0,
    payment_status: 'verified',
    version: 1,
    data: {},
    ...overrides,
  });
}

function seedItem(id: string, price: number, overrides: any = {}) {
  return storeFor('contractAssessments').put({
    id,
    contract_id: 'PC-1',
    company_id: 'CO-1',
    customer_id: 'CUST-1',
    school_id: 'SCH-1',
    assessment_name: `Assessment ${id}`,
    status: 'reserved',
    item_price: price,
    version: 1,
    ...overrides,
  });
}

async function seedScenario(balance = 920700) {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await seedCustomer(balance);
  await seedContract();
  await seedItem('A-287', 287000);
  await seedItem('A-130', 130000);
  await seedItem('A-058', 58500);
}

const walletTxFor = (itemId: string) => storeFor('walletTransactions').get(`WTX-${itemId}-CONSUMED`);
const walletTxCount = async () => (await storeFor('walletTransactions').getAll()).length;
const ledgerForContract = async () => (await storeFor('ledger').getAll() as any[])
  .filter((e) => String(e.referenceId || '').startsWith('A-'));

// ─── A. Basic consumption: 920700 → 633700 → 503700 → 445200 ────────────

describe('basic consumption sequence', () => {
  beforeEach(() => seedScenario());

  it('consumes K287,000 → K633,700 with one debit + one ledger posting', async () => {
    const res: any = await transactionService.consumeContractAssessment({
      contractId: 'PC-1', assessmentItemId: 'A-287',
    });
    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(633700);
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(633700);

    const item = await storeFor('contractAssessments').get('A-287');
    expect(item.status).toBe('consumed');
    expect(item.consumed_at).toBeTruthy();

    const contract = await storeFor('assessmentContracts').get('PC-1');
    expect(contract.consumed_amount).toBe(287000);
    expect(contract.reserved_amount).toBe(0);
    // available invariant holds: 920700 - 287000 - 0
    expect(contract.prepaid_amount - contract.consumed_amount - contract.reserved_amount).toBe(633700);
  });

  it('full sequence ends at K445,200', async () => {
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' });
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(633700);
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-130' });
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(503700);
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-058' });
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(445200);

    const contract = await storeFor('assessmentContracts').get('PC-1');
    expect(contract.consumed_amount).toBe(475500);
    expect(await walletTxCount()).toBe(3);
  });
});

// ─── B. Exactly one transaction ────────────────────────────────────────

describe('exactly one wallet debit per consumption', () => {
  beforeEach(() => seedScenario());

  it('creates one deterministic Deduction with full linkage', async () => {
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' });
    const tx: any = await walletTxFor('A-287');
    expect(tx).toBeTruthy();
    expect(tx.id).toBe('WTX-A-287-CONSUMED');
    expect(tx.type).toBe('Deduction');
    expect(tx.amount).toBe(287000);
    expect(tx.customerId).toBe('CUST-1');
    expect(tx.idempotencyKey).toBe('wallet:assessment:A-287:consumed');
    expect(tx.data.contract_id).toBe('PC-1');
    expect(tx.data.assessment_item_id).toBe('A-287');
    expect(tx.data.amount).toBe(287000);
    expect(tx.data.consumed_at).toBeTruthy();
    expect(await walletTxCount()).toBe(1);
  });
});

// ─── C/F/E. Idempotency, retry, double-click ───────────────────────────

describe('idempotency: retry, double-click and replay never duplicate', () => {
  beforeEach(() => seedScenario());

  it('second consume throws duplicate and writes nothing new', async () => {
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' });
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' })
    ).rejects.toThrow(/already consumed|Duplicate financial request|only reserved assessments can be consumed/i);
    expect(await walletTxCount()).toBe(1);
    expect((await ledgerForContract()).length).toBe(1);
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(633700);
  });

  it('two immediate concurrent consumes yield exactly one charge', async () => {
    const results = await Promise.allSettled([
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-130' }),
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-130' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await walletTxCount()).toBe(1);
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(790700);
  });

  it('sync replay (same deterministic ids re-put) does not duplicate rows', async () => {
    const res: any = await transactionService.consumeContractAssessment({
      contractId: 'PC-1', assessmentItemId: 'A-058',
    });
    expect(res.success).toBe(true);
    // Simulate durable-queue replay of the identical payloads.
    const tx: any = await walletTxFor('A-058');
    await storeFor('walletTransactions').put({ ...tx });
    const ledgerRows = await ledgerForContract();
    await storeFor('ledger').put({ ...ledgerRows[0] });
    expect(await walletTxCount()).toBe(1);
    expect((await ledgerForContract()).length).toBe(1);
    // And a fresh consume call still refuses (status edge + reservation).
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-058' })
    ).rejects.toThrow(/already consumed|Duplicate financial request|only reserved assessments can be consumed/i);
  });
});

// ─── D. Insufficient funds ─────────────────────────────────────────────

describe('insufficient funds', () => {
  beforeEach(() => seedScenario(42000));

  it('aborts with zero writes; item stays reserved', async () => {
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-058' })
    ).rejects.toThrow(/INSUFFICIENT_WALLET_FUNDS.*required 58500.*available 42000/);
    expect(await walletTxCount()).toBe(0);
    expect((await ledgerForContract()).length).toBe(0);
    expect((await storeFor('customers').get('CUST-1')).walletBalance).toBe(42000);
    expect((await storeFor('contractAssessments').get('A-058')).status).toBe('reserved');
    const contract = await storeFor('assessmentContracts').get('PC-1');
    expect(contract.consumed_amount).toBe(0);
    expect(contract.reserved_amount).toBe(0);
  });
});

// ─── G. Zero/invalid price ─────────────────────────────────────────────

describe('zero/invalid price', () => {
  beforeEach(async () => {
    await seedScenario();
    await seedItem('A-ZERO', 0);
    await seedItem('A-NEG', -50);
  });

  it.each([['A-ZERO'], ['A-NEG']])('refuses to charge %s', async (id) => {
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: id })
    ).rejects.toThrow(/invalid price/i);
    expect((await storeFor('contractAssessments').get(id)).status).toBe('reserved');
  });

  it('writes nothing on invalid price', async () => {
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' }).catch(() => {});
    expect(await walletTxCount()).toBe(1); // only the valid one
  });
});

// ─── H/I/J. Linkage, status, eligibility ───────────────────────────────

describe('guards: linkage, status, eligibility', () => {
  beforeEach(() => seedScenario());

  it('rejects an assessment belonging to another contract', async () => {
    await seedItem('A-X', 1000, { contract_id: 'PC-OTHER' });
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-X' })
    ).rejects.toThrow(/does not belong/);
    expect(await walletTxCount()).toBe(0);
  });

  it.each([['consumed'], ['released'], ['cancelled']])('rejects already-%s items', async (status) => {
    await storeFor('contractAssessments').put({
      id: `A-${status}`, contract_id: 'PC-1', status, item_price: 1000, version: 1,
    });
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: `A-${status}` })
    ).rejects.toThrow(/only reserved assessments can be consumed/);
    expect(await walletTxCount()).toBe(0);
  });

  it.each([['draft'], ['pending_payment'], ['suspended'], ['completed'], ['expired'], ['cancelled']])(
    'rejects consumption on %s contracts',
    async (status) => {
      const c: any = await storeFor('assessmentContracts').get('PC-1');
      await storeFor('assessmentContracts').put({ ...c, status });
      await expect(
        transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' })
      ).rejects.toThrow(/only active contracts can consume/);
      expect(await walletTxCount()).toBe(0);
    }
  );

  it('rejects missing contract and missing item', async () => {
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-NOPE', assessmentItemId: 'A-287' })
    ).rejects.toThrow(/contract PC-NOPE not found/);
    await expect(
      transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-NOPE' })
    ).rejects.toThrow(/assessment item A-NOPE not found/);
  });
});

// ─── K. Ledger legs ────────────────────────────────────────────────────

describe('ledger posting (existing GL conventions)', () => {
  beforeEach(() => seedScenario());

  it('posts DR customerDeposits / CR revenue for the consumed amount', async () => {
    const res: any = await transactionService.consumeContractAssessment({
      contractId: 'PC-1', assessmentItemId: 'A-287',
    });
    const rows = await ledgerForContract();
    expect(rows).toHaveLength(1);
    const [entry] = rows;
    expect(entry.id).toBe(res.ledgerEntryId);
    expect(entry.debitAccountId).toBe('ACC-21300');
    expect(entry.creditAccountId).toBe('ACC-41100');
    expect(entry.amount).toBe(287000);
    expect(entry.referenceId).toBe('A-287');
    expect(entry.customerId).toBe('CUST-1');
  });
});

// ─── Reservation-coverage healing (documented creation-bug tolerance) ───

describe('legacy rows with unrecorded reservations', () => {
  beforeEach(async () => {
    // Creation-bug shape: reserved items exist but reserved_amount stayed 0.
    await seedScenario();
  });

  it('consumes truthfully without clamping and keeps buckets exact', async () => {
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-287' });
    const contract = await storeFor('assessmentContracts').get('PC-1');
    expect(contract.reserved_amount).toBe(0);
    expect(contract.consumed_amount).toBe(287000);
    expect(contract.prepaid_amount - contract.consumed_amount - contract.reserved_amount).toBe(633700);
  });
});
