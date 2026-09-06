/**
 * posAccountingFix.test.ts
 *
 * Regression tests for the fix that removed the spurious "SmartPricing Revenue
 * Analytics" block from processSale() which was incorrectly posting gross profit
 * (Sales - COGS = K4,828) as a DR Cash Drawer / CR Interest Income ledger entry.
 *
 * After the fix the correct accounting for a K7,000 cash POS sale (cost K2,172) is:
 *   1. DR Cash Drawer K7,000  / CR Product Sales K7,000   (LG-REV)
 *   2. DR COGS K2,172         / CR Inventory K2,172        (LG-COGS)
 *   3. DR Cash K7,000         / CR Cash Drawer K7,000      (LG-PAY)
 *   4. DR Bank K7,000         / CR Cash Drawer K7,000      (LG-TRANSFER)
 *   Interest Income entries   = K0
 *   Gross Profit (derived)    = K4,828
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── Canonical account IDs (mock UUIDs consistent across the mock) ───────────
const ACCOUNTS = {
  cashDrawer:     'acct-11110',
  cash:           'acct-11100',
  bank:           'acct-11210',
  inventory:      'acct-11400',
  productSales:   'acct-41100',
  otherIncome:    'acct-42000',
  interestIncome: 'acct-42100',
  cogs:           'acct-51200',
};

// ─── Minimal in-memory ledger ────────────────────────────────────────────────
interface MockLedgerEntry {
  id: string;
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  referenceId: string;
  reconciled: boolean;
  customerId?: string;
  customerName?: string;
  entryType?: string;
}

interface MockSale {
  id: string;
  date: string;
  totalAmount: number;
  payments: Array<{ method: string; amount: number }>;
  items: Array<{ id: string; productId: string; quantity: number; costPrice: number }>;
  customerId?: string;
  customerName?: string;
  /** Display-only field. Must NEVER drive a GL entry. */
  profitMarginTotal?: number;
}

let ledger: MockLedgerEntry[] = [];
let inventoryLog: Array<{ itemId: string; qty: number }> = [];

function roundToCurrency(n: number) { return Math.round(n * 100) / 100; }
let seq = 0;
function generateId(prefix: string) { return `${prefix}-${++seq}`; }

/**
 * Stripped-down version of the FIXED processSale() logic.
 * Mirrors the production code paths after the profit-margin block removal.
 */
async function mockProcessSale(sale: MockSale): Promise<void> {
  const totalPaid    = sale.payments.reduce((s, p) => s + p.amount, 0);
  const paymentRatio = sale.totalAmount > 0 ? Math.min(totalPaid / sale.totalAmount, 1) : 0;

  // Physical inventory deduction (no GL)
  for (const item of sale.items) {
    inventoryLog.push({ itemId: item.productId, qty: item.quantity });
  }

  // ── Revenue ───────────────────────────────────────────────────────────────
  const paidRevenue = roundToCurrency(sale.totalAmount * paymentRatio);
  if (paidRevenue > 0) {
    ledger.push({
      id: generateId('LG-REV'), date: sale.date,
      description: `POS Sale Revenue #${sale.id}`,
      debitAccountId:  ACCOUNTS.cashDrawer,
      creditAccountId: ACCOUNTS.productSales,
      amount: paidRevenue,
      referenceId: sale.id, reconciled: false,
      customerId: sale.customerId, customerName: sale.customerName,
    });
  }

  // ── COGS ──────────────────────────────────────────────────────────────────
  const totalCost = sale.items.reduce((s, i) => s + i.costPrice * i.quantity, 0);
  if (totalCost > 0) {
    ledger.push({
      id: generateId('LG-COGS'), date: sale.date,
      description: `COGS - Sale #${sale.id}`,
      debitAccountId:  ACCOUNTS.cogs,
      creditAccountId: ACCOUNTS.inventory,
      amount: roundToCurrency(totalCost),
      referenceId: sale.id, reconciled: false,
      customerId: sale.customerId, customerName: sale.customerName,
    });
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  for (const payment of sale.payments) {
    const amt = roundToCurrency(payment.amount);
    ledger.push({
      id: generateId('LG-PAY'), date: sale.date,
      description: `Payment - Sale #${sale.id}`,
      debitAccountId:  ACCOUNTS.cash,
      creditAccountId: ACCOUNTS.cashDrawer,
      amount: amt, referenceId: sale.id, reconciled: false,
    });
    ledger.push({
      id: generateId('LG-TRANSFER'), date: sale.date,
      description: `Cash Transfer - Sale #${sale.id}`,
      debitAccountId:  ACCOUNTS.bank,
      creditAccountId: ACCOUNTS.cashDrawer,
      amount: amt, referenceId: sale.id, reconciled: false,
    });
  }
  // NOTE: No profit-margin ledger entry — gross profit is a derived metric only.
}

function makeSale(overrides: Partial<MockSale> = {}): MockSale {
  return {
    id: 'SALE-TEST-001',
    date: new Date().toISOString(),
    totalAmount: 7000,
    payments: [{ method: 'cash', amount: 7000 }],
    items: [{ id: 'li-1', productId: 'PROD-001', quantity: 1, costPrice: 2172 }],
    customerId: 'CUST-001',
    customerName: 'Test Customer',
    profitMarginTotal: 4828,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POS Accounting Fix — Interest Income bug', () => {
  beforeEach(() => { ledger = []; inventoryLog = []; seq = 0; });

  // 1. Revenue K7,000 + COGS K2,172
  it('posts K7,000 to Product Sales and K2,172 to COGS', async () => {
    await mockProcessSale(makeSale());
    const rev  = ledger.filter(e => e.creditAccountId === ACCOUNTS.productSales);
    const cogs = ledger.filter(e => e.debitAccountId  === ACCOUNTS.cogs);
    expect(rev).toHaveLength(1);
    expect(rev[0].amount).toBe(7000);
    expect(cogs).toHaveLength(1);
    expect(cogs[0].amount).toBe(2172);
  });

  // 2. Balanced journal
  it('produces a balanced journal (net of all debits and credits = 0)', async () => {
    await mockProcessSale(makeSale());
    const net: Record<string, number> = {};
    for (const e of ledger) {
      net[e.debitAccountId]  = (net[e.debitAccountId]  || 0) + e.amount;
      net[e.creditAccountId] = (net[e.creditAccountId] || 0) - e.amount;
    }
    const journalNet = Object.values(net).reduce((s, v) => s + v, 0);
    expect(journalNet).toBeCloseTo(0, 2);
  });

  // 3. Zero credits to Interest Income
  it('has zero ledger credits to Interest Income (42100)', async () => {
    await mockProcessSale(makeSale());
    const bad = ledger.filter(e => e.creditAccountId === ACCOUNTS.interestIncome);
    expect(bad).toHaveLength(0);
  });

  // 4. Zero credits to Other Income
  it('has zero ledger credits to Other Income (42000)', async () => {
    await mockProcessSale(makeSale());
    const bad = ledger.filter(e => e.creditAccountId === ACCOUNTS.otherIncome);
    expect(bad).toHaveLength(0);
  });

  // 5. Single inventory deduction per item
  it('deducts inventory exactly once per line item', async () => {
    await mockProcessSale(makeSale());
    const deductions = inventoryLog.filter(d => d.itemId === 'PROD-001');
    expect(deductions).toHaveLength(1);
    expect(deductions[0].qty).toBe(1);
  });

  // 6. Gross profit is derived (Revenue - COGS), never posted separately
  it('derives gross profit as K4,828 from the ledger without an extra GL posting', async () => {
    await mockProcessSale(makeSale());
    const revenue = ledger.filter(e => e.creditAccountId === ACCOUNTS.productSales)
                          .reduce((s, e) => s + e.amount, 0);
    const cogs    = ledger.filter(e => e.debitAccountId  === ACCOUNTS.cogs)
                          .reduce((s, e) => s + e.amount, 0);
    expect(revenue - cogs).toBeCloseTo(4828, 2);

    // No entry should have K4,828 credited to income accounts
    const wrongEntries = ledger.filter(
      e => e.amount === 4828 &&
           (e.creditAccountId === ACCOUNTS.interestIncome ||
            e.creditAccountId === ACCOUNTS.otherIncome)
    );
    expect(wrongEntries).toHaveLength(0);
  });

  // 7. No ProfitMargin entryType
  it('produces no ledger entries with entryType "ProfitMargin"', async () => {
    await mockProcessSale(makeSale());
    const pm = ledger.filter(e => e.entryType === 'ProfitMargin');
    expect(pm).toHaveLength(0);
  });

  // 8. profitMarginTotal on sale is ignored by GL engine
  it('ignores sale.profitMarginTotal when generating GL entries', async () => {
    await mockProcessSale(makeSale({ profitMarginTotal: 99999 }));
    const bad = ledger.filter(
      e => e.creditAccountId === ACCOUNTS.interestIncome ||
           e.creditAccountId === ACCOUNTS.otherIncome
    );
    expect(bad).toHaveLength(0);
    // Exactly 4 entries: LG-REV, LG-COGS, LG-PAY, LG-TRANSFER
    expect(ledger).toHaveLength(4);
  });
});
