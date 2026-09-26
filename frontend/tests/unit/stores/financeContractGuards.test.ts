/**
 * financeContractGuards.test.ts — store-level lifecycle hardening.
 *
 * financeStore.updateContractAssessment is the only store path that mutates
 * assessment items. It must refuse financial edges (reserved→consumed,
 * anything out of consumed) so production callers cannot bypass the
 * canonical wallet-first operation (consumeContractAssessment).
 * Non-financial transitions and status-preserving writes pass through.
 * financeStore.consumeContractAssessment delegates end-to-end (store →
 * api → transactionService) producing exactly one debit.
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
  },
}));

import { useFinanceStore } from '../../../stores/financeStore';

const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
];

const baseItem = (overrides: any = {}) => ({
  id: 'A-1',
  contract_id: 'PC-1',
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  assessment_name: 'Maths',
  status: 'reserved',
  item_price: 50000,
  version: 1,
  ...overrides,
});

const baseContract = (overrides: any = {}) => ({
  id: 'PC-1',
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  contract_number: 'PC-2026-0001',
  title: 'T',
  status: 'active',
  prepaid_amount: 200000,
  consumed_amount: 0,
  reserved_amount: 0,
  version: 1,
  data: {},
  ...overrides,
});

function seedState(items: any[] = [baseItem()], contracts: any[] = [baseContract()]) {
  useFinanceStore.setState({ contractAssessments: items, assessmentContracts: contracts } as any);
}

async function seedDbForConsume(balance = 200000) {
  stores.clear();
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await storeFor('customers').put({ id: 'CUST-1', name: 'Test School', walletBalance: balance });
  await storeFor('assessmentContracts').put(baseContract());
  await storeFor('contractAssessments').put(baseItem());
}

describe('financeStore.updateContractAssessment guards', () => {
  beforeEach(() => {
    stores.clear();
    seedState();
  });

  it('blocks direct reserved → consumed mutation', async () => {
    await expect(
      useFinanceStore.getState().updateContractAssessment({ ...baseItem(), status: 'consumed' } as any)
    ).rejects.toThrow(/canonical wallet-first operation/);
    // Nothing persisted, store state untouched.
    expect(useFinanceStore.getState().contractAssessments[0].status).toBe('reserved');
    expect(await storeFor('contractAssessments').getAll()).toEqual([]);
  });

  it('blocks every edge out of consumed', async () => {
    seedState([baseItem({ status: 'consumed' })]);
    for (const target of ['reserved', 'released', 'cancelled']) {
      await expect(
        useFinanceStore.getState().updateContractAssessment({ ...baseItem(), status: 'consumed', ...( { status: target } as any) })
      ).rejects.toThrow(/compensating reversal/);
    }
    expect(useFinanceStore.getState().contractAssessments[0].status).toBe('consumed');
  });

  it('allows non-financial transitions and status-preserving writes', async () => {
    await useFinanceStore.getState().updateContractAssessment({ ...baseItem(), status: 'released' } as any);
    expect(useFinanceStore.getState().contractAssessments[0].status).toBe('released');
    // Job-link style write on a consumed item keeps its status: allowed.
    seedState([{ ...baseItem(), status: 'consumed' }]);
    await useFinanceStore.getState().updateContractAssessment({
      ...baseItem(), status: 'consumed', job_order_id: 'JO-9',
    } as any);
    expect(useFinanceStore.getState().contractAssessments[0].job_order_id).toBe('JO-9');
  });

  it('still rejects lifecycle-map violations', async () => {
    await expect(
      useFinanceStore.getState().updateContractAssessment({ ...baseItem(), status: 'released' } as any)
    ).resolves.toBeUndefined();
    seedState([{ ...baseItem(), status: 'released' }]);
    await expect(
      useFinanceStore.getState().updateContractAssessment({ ...baseItem(), status: 'released', ...( { status: 'consumed' } as any) })
    ).rejects.toThrow();
  });

  it('blocks birth of non-reserved items', async () => {
    await expect(
      useFinanceStore.getState().addContractAssessment({ ...baseItem(), status: 'consumed' } as any)
    ).rejects.toThrow(/created reserved/);
  });
});

describe('financeStore.consumeContractAssessment end-to-end delegation', () => {
  beforeEach(() => seedDbForConsume());

  it('produces exactly one debit via store → api → service', async () => {
    seedState([baseItem()], [baseContract()]);
    const res: any = await useFinanceStore.getState().consumeContractAssessment({
      contractId: 'PC-1',
      assessmentItemId: 'A-1',
    });
    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(150000);
    const txs = await storeFor('walletTransactions').getAll();
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('Deduction');
    expect(txs[0].amount).toBe(50000);
    const item = await storeFor('contractAssessments').get('A-1');
    expect(item.status).toBe('consumed');
    // Store refreshed from the database (no stale optimistic snapshot).
    expect(useFinanceStore.getState().contractAssessments.find((a: any) => a.id === 'A-1')?.status).toBe('consumed');
  });

  it('surfaces insufficient funds without side effects', async () => {
    await storeFor('customers').put({ id: 'CUST-1', name: 'Test School', walletBalance: 1000 });
    seedState([baseItem()], [baseContract()]);
    await expect(
      useFinanceStore.getState().consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-1' })
    ).rejects.toThrow(/INSUFFICIENT_WALLET_FUNDS/);
    expect(await storeFor('walletTransactions').getAll()).toHaveLength(0);
  });
});
