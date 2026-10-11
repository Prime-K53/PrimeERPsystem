/**
 * phase1ReservationGuard.test.ts — Phase 1 (§2.1–§2.4) regression coverage.
 * Uses the real transactionService against a shared in-memory boundary
 * (same harness as contractFundReservation.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const stores = new Map<string, Map<string, any>>();
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
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
    getSetting: async (key: string) =>
      key === 'financial_closed_periods' ? closedPeriods : undefined,
    saveSetting: async () => {},
  },
}));

import { transactionService } from '../../../services/transactionService';
import { customerFundingPosition, diagnoseReservationDrift } from '../../../utils/contractFunds';

const ACCOUNTS = [
  { id: 'ACC-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', account_type: 'LIABILITY', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Service Income', account_type: 'INCOME', allow_posting: true, is_active: true, normal_balance: 'CREDIT' },
  { id: 'ACC-CASH', code: '10000', account_number: '10000', name: 'Cash', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
  { id: 'ACC-11200', code: '11200', account_number: '11200', name: 'Bank', account_type: 'ASSET', allow_posting: true, is_active: true, normal_balance: 'DEBIT' },
];

const CUSTOMER_ID = 'CUST-1';

async function seedAll(balance = 1000000) {
  stores.clear();
  closedPeriods = [];
  for (const a of ACCOUNTS) await storeFor('accounts').put(a);
  await storeFor('customers').put({ id: CUSTOMER_ID, name: 'Test School', walletBalance: balance });
}

const contractRow = async (id: string) => storeFor('assessmentContracts').get(id);
const itemsFor = async (cid: string) =>
  ((await storeFor('contractAssessments').getAll()) as any[]).filter((it) => String(it.contract_id) === cid);

describe('bulk atomic creation (§2.1)', () => {
  beforeEach(() => seedAll());

  it('creates contract + items + bucket atomically', async () => {
    const now = new Date().toISOString();
    const res: any = await (transactionService as any).createPrintingContractWithItems({
      contract: {
        id: 'PC-BULK', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
        contract_number: 'PC-2026-0099', title: 'Bulk', status: 'draft',
        prepaid_amount: 300000, consumed_amount: 0, reserved_amount: 0,
        max_assessments: 3, assessment_price: 100000, assessment_type: 'examination',
        assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
      },
      items: [
        { id: 'B-1', assessment_name: 'A1', item_price: 100000 },
        { id: 'B-2', assessment_name: 'A2', item_price: 100000 },
        { id: 'B-3', assessment_name: 'A3', item_price: 100000 },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.reservedAmount).toBe(300000);
    const c: any = await contractRow('PC-BULK');
    expect(c.reserved_amount).toBe(300000);
    expect(c.assessment_count).toBe(3);
    expect((await itemsFor('PC-BULK')).length).toBe(3);
  });

  it('rejects entitlement overflow with nothing written', async () => {
    const now = new Date().toISOString();
    await expect(
      (transactionService as any).createPrintingContractWithItems({
        contract: {
          id: 'PC-OVER', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
          contract_number: 'PC-OVER', title: 'Over', status: 'draft',
          prepaid_amount: 200000, consumed_amount: 0, reserved_amount: 0,
          max_assessments: 1, assessment_price: 100000, assessment_type: 'examination',
          assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
        },
        items: [
          { id: 'O-1', assessment_name: 'A1', item_price: 100000 },
          { id: 'O-2', assessment_name: 'A2', item_price: 100000 },
        ],
      }),
    ).rejects.toThrow(/entitlement exceeded/);
    expect(await contractRow('PC-OVER')).toBeUndefined();
    expect(await itemsFor('PC-OVER')).toHaveLength(0);
  });

  it('rejects duplicate item ids with nothing written', async () => {
    const now = new Date().toISOString();
    await (transactionService as any).createPrintingContractWithItems({
      contract: {
        id: 'PC-D1', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
        contract_number: 'PC-D1', title: 'D', status: 'draft',
        prepaid_amount: 100000, consumed_amount: 0, reserved_amount: 0,
        max_assessments: 5, assessment_price: 100000, assessment_type: 'examination',
        assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
      },
      items: [{ id: 'DUP', assessment_name: 'A1', item_price: 100000 }],
    });
    await expect(
      (transactionService as any).createPrintingContractWithItems({
        contract: {
          id: 'PC-D2', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
          contract_number: 'PC-D2', title: 'D2', status: 'draft',
          prepaid_amount: 100000, consumed_amount: 0, reserved_amount: 0,
          max_assessments: 5, assessment_price: 100000, assessment_type: 'examination',
          assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
        },
        items: [{ id: 'DUP', assessment_name: 'A1', item_price: 100000 }],
      }),
    ).rejects.toThrow(/Duplicate financial request/);
  });
});

describe('unrelated spending guard (§2.3)', () => {
  beforeEach(() => seedAll(1000000));

  async function seedActiveContract() {
    const now = new Date().toISOString();
    await (transactionService as any).createPrintingContractWithItems({
      contract: {
        id: 'PC-1', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
        contract_number: 'PC-2026-0001', title: 'Exam printing', status: 'active',
        prepaid_amount: 1000000, consumed_amount: 0, reserved_amount: 0,
        max_assessments: 10, assessment_price: 100000, assessment_type: 'examination',
        assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
      },
      items: Array.from({ length: 10 }, (_, i) => ({ id: `A-${i + 1}`, assessment_name: `A${i + 1}`, item_price: 100000 })),
    });
  }

  it('blocks order wallet payment that would eat protected funds', async () => {
    await seedActiveContract();
    // Wallet 1,000,000, protected 1,000,000 → available 0. A 500,000 order must fail.
    await storeFor('salesOrders').put({
      id: 'SO-1', orderNumber: 'SO-1', customerId: CUSTOMER_ID, customerName: 'Test School',
      totalAmount: 500000, paidAmount: 0, remainingBalance: 500000, status: 'Pending',
      orderDate: new Date().toISOString(), payments: [], items: [],
    });
    await expect(
      transactionService.recordOrderPayment('SO-1', { id: 'PAY-1', amountPaid: 500000, paymentMethod: 'Wallet', paymentDate: new Date().toISOString() } as any),
    ).rejects.toThrow(/INSUFFICIENT_AVAILABLE_FUNDS/);
    expect((await storeFor('customers').get(CUSTOMER_ID)).walletBalance).toBe(1000000);
  });

  it('allows unrelated spending when funds are sufficient', async () => {
    await seedActiveContract();
    // Top up wallet to 1,500,000 → available 500,000. A 400,000 order passes.
    const cust: any = await storeFor('customers').get(CUSTOMER_ID);
    await storeFor('customers').put({ ...cust, walletBalance: 1500000 });
    await storeFor('salesOrders').put({
      id: 'SO-2', orderNumber: 'SO-2', customerId: CUSTOMER_ID, customerName: 'Test School',
      totalAmount: 400000, paidAmount: 0, remainingBalance: 400000, status: 'Pending',
      orderDate: new Date().toISOString(), payments: [], items: [],
    });
    const res: any = await transactionService.recordOrderPayment('SO-2', { id: 'PAY-2', amountPaid: 400000, paymentMethod: 'Wallet', paymentDate: new Date().toISOString() } as any);
    expect(res.success).toBe(true);
    expect((await storeFor('customers').get(CUSTOMER_ID)).walletBalance).toBe(1100000);
  });

  it('canonical position: available = wallet - protected', async () => {
    await seedActiveContract();
    const pos = customerFundingPosition({
      contracts: (await storeFor('assessmentContracts').getAll()) as any,
      items: (await storeFor('contractAssessments').getAll()) as any,
      customerId: CUSTOMER_ID,
      walletBalance: 1000000,
    });
    expect(pos.totalActiveReservations).toBe(1000000);
    expect(pos.availableForUnrelatedSpending).toBe(0);
  });
});

describe('amendment delta + closure + refund (§2.4)', () => {
  beforeEach(() => seedAll(1000000));

  async function seedActive() {
    const now = new Date().toISOString();
    await (transactionService as any).createPrintingContractWithItems({
      contract: {
        id: 'PC-1', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
        contract_number: 'PC-2026-0001', title: 'Exam', status: 'active',
        prepaid_amount: 1000000, consumed_amount: 0, reserved_amount: 0,
        max_assessments: 10, assessment_price: 100000, assessment_type: 'examination',
        assessment_count: 0, created_at: now, updated_at: now, version: 1, data: {},
      },
      items: Array.from({ length: 10 }, (_, i) => ({ id: `A-${i + 1}`, assessment_name: `A${i + 1}`, item_price: 100000 })),
    });
  }

  it('unfunded increase grows commercial value only (never fabricates)', async () => {
    await seedActive();
    const res: any = await (transactionService as any).applyContractAmendmentDelta({
      contractId: 'PC-1', amendmentId: 'AM-1', prepaidDelta: 500000, countDelta: 0,
    });
    expect(res.success).toBe(true);
    expect(res.funded).toBe(false);
    const c: any = await contractRow('PC-1');
    expect(c.prepaid_amount).toBe(1500000);
    expect(c.reserved_amount).toBe(1000000); // unchanged — unfunded
  });

  it('funded increase with verified wallet grows reservation', async () => {
    await seedActive();
    const cust: any = await storeFor('customers').get(CUSTOMER_ID);
    await storeFor('customers').put({ ...cust, walletBalance: 1500000 });
    const res: any = await (transactionService as any).applyContractAmendmentDelta({
      contractId: 'PC-1', amendmentId: 'AM-2', prepaidDelta: 500000, countDelta: 0,
      fundingReference: 'WTX-TOPUP-1',
    });
    expect(res.funded).toBe(true);
    const c: any = await contractRow('PC-1');
    expect(c.reserved_amount).toBe(1500000);
  });

  it('amendment apply is idempotent', async () => {
    await seedActive();
    await (transactionService as any).applyContractAmendmentDelta({ contractId: 'PC-1', amendmentId: 'AM-X', prepaidDelta: 0, countDelta: 1 });
    await expect(
      (transactionService as any).applyContractAmendmentDelta({ contractId: 'PC-1', amendmentId: 'AM-X', prepaidDelta: 0, countDelta: 1 }),
    ).rejects.toThrow(/Duplicate financial request/);
  });

  it('closure releases reservation without touching consumed', async () => {
    await seedActive();
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-1' });
    const res: any = await (transactionService as any).resolveContractClosure({ contractId: 'PC-1', targetStatus: 'cancelled' });
    expect(res.success).toBe(true);
    expect(res.releasedValue).toBe(900000);
    const c: any = await contractRow('PC-1');
    expect(c.status).toBe('cancelled');
    expect(c.reserved_amount).toBe(0);
    expect(c.consumed_amount).toBe(100000);
  });

  it('refund requires policy reference and cannot exceed prepaid-consumed', async () => {
    await seedActive();
    await transactionService.consumeContractAssessment({ contractId: 'PC-1', assessmentItemId: 'A-1' });
    await (transactionService as any).resolveContractClosure({ contractId: 'PC-1', targetStatus: 'cancelled' });
    await expect(
      (transactionService as any).refundContractBalance({ contractId: 'PC-1', amount: 100000 }),
    ).rejects.toThrow(/policyReference is required/);
    await expect(
      (transactionService as any).refundContractBalance({ contractId: 'PC-1', amount: 999999999, policyReference: 'POL-1' }),
    ).rejects.toThrow(/exceeds refundable/);
    const res: any = await (transactionService as any).refundContractBalance({ contractId: 'PC-1', amount: 50000, policyReference: 'POL-1' });
    expect(res.success).toBe(true);
    await expect(
      (transactionService as any).refundContractBalance({ contractId: 'PC-1', amount: 50000, policyReference: 'POL-1' }),
    ).rejects.toThrow(/Duplicate financial request|already exists/);
  });
});

describe('legacy drift diagnosis is read-only (§2.1)', () => {
  beforeEach(() => seedAll());

  it('flags reserved items with zero bucket without mutating', async () => {
    const now = new Date().toISOString();
    await storeFor('assessmentContracts').put({
      id: 'PC-LEG', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
      contract_number: 'PC-LEG', title: 'Legacy', status: 'active',
      prepaid_amount: 200000, consumed_amount: 0, reserved_amount: 0,
      max_assessments: 2, assessment_price: 100000, assessment_type: 'examination',
      assessment_count: 2, created_at: now, updated_at: now, version: 1, data: {},
    });
    for (const id of ['L-1', 'L-2']) {
      await storeFor('contractAssessments').put({
        id, contract_id: 'PC-LEG', company_id: 'CO-1', customer_id: CUSTOMER_ID, school_id: 'SCH-1',
        assessment_type: 'examination', assessment_name: id, status: 'reserved', item_price: 100000,
        created_at: now, updated_at: now, version: 1,
      });
    }
    const drift = diagnoseReservationDrift({
      contracts: (await storeFor('assessmentContracts').getAll()) as any,
      items: (await storeFor('contractAssessments').getAll()) as any,
    });
    expect(drift.length).toBe(1);
    expect(drift[0].bucketReserved).toBe(0);
    expect(drift[0].itemsReservedValue).toBe(200000);
    // No mutation occurred.
    expect(((await contractRow('PC-LEG')) as any).reserved_amount).toBe(0);
  });
});
