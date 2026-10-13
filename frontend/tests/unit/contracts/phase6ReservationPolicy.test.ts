/**
 * phase6ReservationPolicy.test.ts — §2 reservation-policy consistency.
 *
 * The policy under test:
 *   protected(contract) = min(outstandingClaim, verified eligible funds),
 *   allocated across holding contracts in contract-number order;
 *   available = walletBalance - Σ protected   (never negative);
 *   unfunded = claim - protected             (exposed, never fabricated).
 *
 * Regression focus: an UNDERFUNDED contract must expose its unfunded
 * obligation WITHOUT freezing unrelated funds the customer actually holds.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { customerFundingPosition } from '../../../utils/contractFunds';

const CUST = 'CUST-1';
const put = (s: string, r: any) => storeFor(s).put(r);

async function seedContract(id: string, number: string, status: string, bucket: number, outstanding: number, price = 100000, count = 1) {
  const now = new Date().toISOString();
  await put('assessmentContracts', {
    id, company_id: 'CO-1', customer_id: CUST, school_id: 'SCH-1',
    contract_number: number, title: number, status,
    prepaid_amount: outstanding, consumed_amount: 0, reserved_amount: bucket,
    max_assessments: count, assessment_price: price, assessment_type: 'examination',
    assessment_count: count, created_at: now, updated_at: now, version: 1, data: {},
  });
  for (let i = 0; i < count; i++) {
    await put('contractAssessments', {
      id: `${id}-item-${i}`, contract_id: id, company_id: 'CO-1', customer_id: CUST, school_id: 'SCH-1',
      assessment_type: 'examination', assessment_name: `A${i}`, assessment_date: '2026-03-15',
      status: 'reserved', item_price: price, created_at: now, updated_at: now, version: 1,
    });
  }
}

const loadPosition = async (wallet: number) => customerFundingPosition({
  contracts: await storeFor('assessmentContracts').getAll() as any,
  items: await storeFor('contractAssessments').getAll() as any,
  customerId: CUST,
  walletBalance: wallet,
});

beforeEach(() => { stores.clear(); });

describe('fully funded contract protects outstanding value (§2)', () => {
  it('protects the full outstanding amount and exposes none as unfunded', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 1000000 });
    await seedContract('PC-A', 'PC-0001', 'active', 1000000, 1000000, 100000, 10);
    const p = await loadPosition(1000000);
    expect(p.totalActiveReservations).toBe(1000000);
    expect(p.totalOutstandingReservations).toBe(1000000);
    expect(p.totalUnfundedObligation).toBe(0);
    expect(p.availableForUnrelatedSpending).toBe(0);
  });

  it('suspended contract retains its protected reservation', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 1000000 });
    await seedContract('PC-A', 'PC-0001', 'suspended', 1000000, 1000000, 100000, 10);
    const p = await loadPosition(1000000);
    expect(p.totalActiveReservations).toBe(1000000);
    expect(p.availableForUnrelatedSpending).toBe(0);
  });
});

describe('partially funded contract exposes unfunded without freezing (§2)', () => {
  it('underfunded contract never drives available negative', async () => {
    // Wallet 600k; contract A funded (400k), contract B unfunded (900k).
    await put('customers', { id: CUST, name: 'S', walletBalance: 600000 });
    await seedContract('PC-A', 'PC-0001', 'active', 400000, 400000, 100000, 4);
    await seedContract('PC-B', 'PC-0002', 'active', 900000, 900000, 100000, 9);
    const p = await loadPosition(600000);
    // Protected is capped at verified funds: 400k (A) + 200k (B) = 600k.
    expect(p.totalActiveReservations).toBe(600000);
    expect(p.availableForUnrelatedSpending).toBe(0);
    expect(p.availableForUnrelatedSpending).toBeGreaterThanOrEqual(0);
    // Outstanding claims exceed verified funds; the gap is unfunded, not invented.
    expect(p.totalOutstandingReservations).toBe(1300000);
    expect(p.totalUnfundedObligation).toBe(700000);
    const a = p.contracts.find((c: any) => c.contractNumber === 'PC-0001')!;
    const b = p.contracts.find((c: any) => c.contractNumber === 'PC-0002')!;
    expect(a.unfundedObligation).toBe(0);
    expect(b.unfundedObligation).toBe(700000);
    expect(b.protectedReservation).toBe(200000);
  });

  it('zero wallet with an unfunded contract leaves available at zero (not negative)', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 0 });
    await seedContract('PC-B', 'PC-0002', 'active', 500000, 500000, 100000, 5);
    const p = await loadPosition(0);
    expect(p.totalActiveReservations).toBe(0);
    expect(p.availableForUnrelatedSpending).toBe(0);
    expect(p.totalUnfundedObligation).toBe(500000);
  });

  it('surplus wallet above all claims stays spendable', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 1500000 });
    await seedContract('PC-A', 'PC-0001', 'active', 1000000, 1000000, 100000, 10);
    const p = await loadPosition(1500000);
    expect(p.totalActiveReservations).toBe(1000000);
    expect(p.availableForUnrelatedSpending).toBe(500000);
  });
});

describe('terminal contracts release their outstanding eligible reservation (§2)', () => {
  it.each(['completed', 'cancelled', 'expired'])('%s protects nothing', async (status) => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 1000000 });
    await seedContract('PC-A', 'PC-0001', status as any, 400000, 400000, 100000, 4);
    const p = await loadPosition(1000000);
    expect(p.totalActiveReservations).toBe(0);
    expect(p.availableForUnrelatedSpending).toBe(1000000);
  });
});

describe('guard uses the same allocation as the display (§2 agreement)', () => {
  it('an underfunded contract does not block spending of unrelated held funds', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 600000 });
    await seedContract('PC-A', 'PC-0001', 'active', 400000, 400000, 100000, 4);
    await seedContract('PC-B', 'PC-0002', 'active', 900000, 900000, 100000, 9);
    await put('salesOrders', {
      id: 'SO-1', orderNumber: 'SO-1', customerId: CUST, customerName: 'S',
      totalAmount: 100000, paidAmount: 0, remainingBalance: 100000, status: 'Pending',
      orderDate: new Date().toISOString(), payments: [], items: [],
    });
    // Protected == wallet, so a further unrelated spend must still be refused…
    await expect(
      transactionService.recordOrderPayment('SO-1', {
        id: 'PAY-1', amountPaid: 100000, paymentMethod: 'Wallet', paymentDate: new Date().toISOString(),
      } as any),
    ).rejects.toThrow(/INSUFFICIENT_AVAILABLE_FUNDS/);

    // …and the displayed available figure agrees with that refusal.
    const p = await loadPosition(600000);
    expect(p.availableForUnrelatedSpending).toBe(0);
  });

  it('spending succeeds when verified funds exceed protected reservations', async () => {
    await put('customers', { id: CUST, name: 'S', walletBalance: 1000000 });
    await seedContract('PC-A', 'PC-0001', 'active', 300000, 300000, 100000, 3);
    await put('salesOrders', {
      id: 'SO-2', orderNumber: 'SO-2', customerId: CUST, customerName: 'S',
      totalAmount: 200000, paidAmount: 0, remainingBalance: 200000, status: 'Pending',
      orderDate: new Date().toISOString(), payments: [], items: [],
    });
    const res: any = await transactionService.recordOrderPayment('SO-2', {
      id: 'PAY-2', amountPaid: 200000, paymentMethod: 'Wallet', paymentDate: new Date().toISOString(),
    } as any);
    expect(res.success).toBe(true);
    const p = await loadPosition(800000);
    expect(p.availableForUnrelatedSpending).toBe(500000);
  });
});