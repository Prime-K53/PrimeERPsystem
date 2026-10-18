/**
 * receiptAccountBalanceScope.test.ts
 *
 * A payment receipt's notes end with "Your account balance is …". That number
 * must describe THE ACCOUNT the payment was received for:
 *
 *   * a Main payment prints the Main balance — never a branch's;
 *   * a branch payment prints THAT branch's balance — never the parent's, and
 *     never a sibling branch's, even when both share a display name;
 *   * a legacy payment tagged only by a branch name shared by two branches
 *     cannot be attributed, so it prints NO balance rather than another
 *     account's figure.
 *
 * Reverting to `getCustomerOutstandingBalance(customerId)` (which defaults to
 * Main) makes every branch case fail with the Main figure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const stores: Record<string, any[]> = {
  customers: [],
  invoices: [],
  customerPayments: [],
};

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async (store: string) => stores[store] || []),
    get: vi.fn(async (store: string, id: string) => (stores[store] || []).find((r: any) => String(r.id) === String(id)) || null),
    put: vi.fn(async () => ''),
  },
}));

import { paymentService } from '../../services/paymentService';
import { buildReceiptAcknowledgement } from '../../services/receiptCalculationService';

const ACME = {
  id: 'CUST-ACME',
  name: 'Acme Schools',
  balance: 0,            // no stored opening
  subAccounts: [
    { id: 'SUB-A', name: 'Campus' },
    { id: 'SUB-B', name: 'Campus' },   // identical display name, different id
  ],
};

beforeEach(() => {
  stores.customers = [ACME];
  stores.invoices = [
    { id: 'INV-MAIN', customerId: ACME.id, totalAmount: 1000, paidAmount: 400, status: 'Partially Paid' },
    { id: 'INV-A', customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus', totalAmount: 500, paidAmount: 100, status: 'Partially Paid' },
    { id: 'INV-B', customerId: ACME.id, subAccountId: 'SUB-B', subAccountName: 'Campus', totalAmount: 700, paidAmount: 700, status: 'Paid' },
  ];
  stores.customerPayments = [
    { id: 'PAY-MAIN', customerId: ACME.id, amount: 400, amountApplied: 400, status: 'Cleared' },
    { id: 'PAY-A', customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus', amount: 100, amountApplied: 100, status: 'Cleared' },
    { id: 'PAY-B', customerId: ACME.id, subAccountId: 'SUB-B', subAccountName: 'Campus', amount: 700, amountApplied: 700, status: 'Cleared' },
  ];
});

describe('receipt "account balance" belongs to the account that was paid', () => {
  it('a MAIN payment prints the Main balance only', async () => {
    expect(await paymentService.getOutstandingBalanceForPayment({ customerId: ACME.id })).toBe(600);
  });

  it('a MAIN payment never prints a branch balance', async () => {
    const balance = await paymentService.getOutstandingBalanceForPayment({ customerId: ACME.id });
    expect(balance).not.toBe(400);   // SUB-A outstanding
    expect(balance).not.toBe(0);     // SUB-B outstanding
  });

  it('a BRANCH payment prints that branch balance, not the parent\'s', async () => {
    expect(await paymentService.getOutstandingBalanceForPayment({
      customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus',
    })).toBe(400);
  });

  it('two identically-named branches print their OWN balances', async () => {
    const a = await paymentService.getOutstandingBalanceForPayment({ customerId: ACME.id, subAccountId: 'SUB-A' });
    const b = await paymentService.getOutstandingBalanceForPayment({ customerId: ACME.id, subAccountId: 'SUB-B' });
    expect(a).toBe(400);
    expect(b).toBe(0);
    expect(a).not.toBe(b);
  });

  it('a legacy name-only payment under a SHARED branch name states no balance', async () => {
    // Unattributable: printing either branch's figure would be a leak.
    expect(await paymentService.getOutstandingBalanceForPayment({
      customerId: ACME.id, subAccountName: 'Campus',
    })).toBe(0);
  });

  it('a payment with no customer states no balance', async () => {
    expect(await paymentService.getOutstandingBalanceForPayment({})).toBe(0);
    expect(await paymentService.getOutstandingBalanceForPayment(null)).toBe(0);
  });

  it('a payment for an unknown customer states no balance', async () => {
    expect(await paymentService.getOutstandingBalanceForPayment({ customerId: 'CUST-GONE' })).toBe(0);
  });

  it('the notes sentence carries that balance and nothing else', async () => {
    const main = buildReceiptAcknowledgement({
      amount: 100, customerName: 'Acme Schools', currencySymbol: 'K',
      accountBalance: await paymentService.getOutstandingBalanceForPayment({ customerId: ACME.id }),
    });
    expect(main).toContain('Your account balance is K 600.00');

    const branchA = buildReceiptAcknowledgement({
      amount: 100, customerName: 'Acme Schools', currencySymbol: 'K',
      accountBalance: await paymentService.getOutstandingBalanceForPayment({
        customerId: ACME.id, subAccountId: 'SUB-A', subAccountName: 'Campus',
      }),
    });
    expect(branchA).toContain('Your account balance is K 400.00');
    expect(branchA).not.toContain('600');

    // A branch with nothing outstanding prints no balance sentence at all,
    // rather than falling back to the parent's figure.
    const branchB = buildReceiptAcknowledgement({
      amount: 100, customerName: 'Acme Schools', currencySymbol: 'K',
      accountBalance: await paymentService.getOutstandingBalanceForPayment({
        customerId: ACME.id, subAccountId: 'SUB-B', subAccountName: 'Campus',
      }),
    });
    expect(branchB).not.toMatch(/account balance/i);
  });
});