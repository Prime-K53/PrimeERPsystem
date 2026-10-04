import { describe, expect, it } from 'vitest';
import { buildBusinessHealthSnapshot } from '../../services/ai/aiService';

const cogsAccounts = [
  { id: 'ACC-41100', code: '41100', account_type: 'INCOME' },
  { id: 'ACC-51200', code: '51200', account_type: 'EXPENSE', account_group: 'COST_OF_SALES' },
  { id: 'ACC-52100', code: '52100', account_type: 'EXPENSE', account_group: 'OPERATING' },
  { id: 'ACC-11110', code: '11110', account_type: 'ASSET' },
];

const finance = (overrides: Record<string, unknown> = {}) => ({
  invoices: [{ id: 'INV-1' }],
  expenses: [],
  income: [],
  accounts: cogsAccounts,
  ledger: [],
  ...overrides,
});

const sales = { customers: [{ id: 'C-1' }] };
const inventory = { inventory: [] };

describe('buildBusinessHealthSnapshot — critical case', () => {
  it('reports posted COGS as expenses when the manual expenses table is empty', () => {
    const snapshot = buildBusinessHealthSnapshot(
      finance({
        ledger: [
          {
            id: 'L1',
            date: '2026-09-10',
            debitAccountId: 'ACC-51200',
            creditAccountId: 'ACC-11410',
            amount: 20000,
            referenceId: 'SALE-1',
          },
        ],
      }),
      sales,
      inventory,
    );
    // The critical assertion: financial expense total > 0 even though
    // financeData.expenses is empty.
    expect(snapshot.summary.totalExpensesAmount).toBe(20000);
    expect(snapshot.summary.totalCOGS).toBe(20000);
    expect(snapshot.summary.totalOperatingExpenses).toBe(0);
    expect(snapshot.summary.manualExpenseRecords).toBe(0);
    // Recent activity comes from posted GL legs, not manual rows.
    expect(snapshot.recentPerformance.last10PostedExpenses).toHaveLength(1);
    expect(snapshot.recentPerformance.last10PostedExpenses[0]).toMatchObject({
      amount: 20000,
      date: '2026-09-10',
    });
  });

  it('splits COGS from operating expenses', () => {
    const snapshot = buildBusinessHealthSnapshot(
      finance({
        expenses: [{ id: 'E-1', date: '2026-09-11', amount: 500, category: 'Rent' }],
        ledger: [
          {
            id: 'L1',
            date: '2026-09-10',
            debitAccountId: 'ACC-51200',
            creditAccountId: 'ACC-11410',
            amount: 20000,
            referenceId: 'SALE-1',
          },
          {
            id: 'L2',
            date: '2026-09-11',
            debitAccountId: 'ACC-52100',
            creditAccountId: 'ACC-11110',
            amount: 500,
            referenceId: 'EXP-1',
          },
        ],
      }),
      sales,
      inventory,
    );
    expect(snapshot.summary.totalExpensesAmount).toBe(20500);
    expect(snapshot.summary.totalCOGS).toBe(20000);
    expect(snapshot.summary.totalOperatingExpenses).toBe(500);
    expect(snapshot.summary.manualExpenseRecords).toBe(1);
  });

  it('manual expense records post to the ledger and are included', () => {
    // A manually entered rent expense, approved and posted: the document row
    // exists AND its ledger leg carries the economics.
    const snapshot = buildBusinessHealthSnapshot(
      finance({
        expenses: [{ id: 'E-9', date: '2026-09-12', amount: 1500, category: 'Rent' }],
        ledger: [
          {
            id: 'L9',
            date: '2026-09-12',
            debitAccountId: 'ACC-52100',
            creditAccountId: 'ACC-11110',
            amount: 1500,
            referenceId: 'E-9',
          },
        ],
      }),
      sales,
      inventory,
    );
    expect(snapshot.summary.manualExpenseRecords).toBe(1);
    expect(snapshot.summary.totalExpensesAmount).toBe(1500);
    expect(snapshot.summary.totalOperatingExpenses).toBe(1500);
    expect(snapshot.summary.totalCOGS).toBe(0);
  });

  it('genuinely empty books report zero without implying missing data', () => {
    const snapshot = buildBusinessHealthSnapshot(finance(), sales, inventory);
    expect(snapshot.summary.totalExpensesAmount).toBe(0);
    expect(snapshot.summary.totalCOGS).toBe(0);
    expect(snapshot.summary.totalOperatingExpenses).toBe(0);
    expect(snapshot.summary.manualExpenseRecords).toBe(0);
    expect(snapshot.recentPerformance.last10PostedExpenses).toEqual([]);
  });

  it('excludes draft and reversal ledger rows from the expense total', () => {
    const snapshot = buildBusinessHealthSnapshot(
      finance({
        ledger: [
          {
            id: 'L1',
            date: '2026-09-10',
            debitAccountId: 'ACC-52100',
            creditAccountId: 'ACC-11110',
            amount: 700,
            referenceId: 'EXP-DRAFT',
            status: 'DRAFT',
          },
          {
            id: 'L2',
            date: '2026-09-10',
            debitAccountId: 'ACC-52100',
            creditAccountId: 'ACC-11110',
            amount: 300,
            referenceId: 'EXP-OK',
          },
        ],
      }),
      sales,
      inventory,
    );
    expect(snapshot.summary.totalExpensesAmount).toBe(300);
  });

  it('keeps invoice/customer/inventory counts intact', () => {
    const snapshot = buildBusinessHealthSnapshot(
      finance({ invoices: [{ id: 'A' }, { id: 'B' }] }),
      { customers: [{ id: 'C-1' }, { id: 'C-2' }, { id: 'C-3' }] },
      { inventory: [{ id: 'I-1', stock: 2, minStockLevel: 5 }] },
    );
    expect(snapshot.summary.totalInvoices).toBe(2);
    expect(snapshot.summary.totalCustomers).toBe(3);
    expect(snapshot.summary.inventoryItems).toBe(1);
    expect(snapshot.inventoryStatus).toHaveLength(1);
  });
});
