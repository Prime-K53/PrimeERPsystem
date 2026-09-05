import { describe, expect, it } from 'vitest';
import { financialIntegrityService } from '../../services/financialIntegrityService';

describe('financialIntegrityService', () => {
  it('builds dashboard metrics from verified ledger and persisted balances only', () => {
    const metrics = financialIntegrityService.buildVerifiedDashboardMetrics(
      {
         accounts: [
           { id: '11110', code: '11110', name: 'Cash Drawer', type: 'Asset' },
           { id: '11310', code: '11310', name: 'Trade Debtors', type: 'Asset' },
           { id: '21110', code: '21110', name: 'Trade Creditors', type: 'Liability' },
           { id: '41100', code: '41100', name: 'Product Sales', type: 'Revenue' },
           { id: '51200', code: '51200', name: 'Cost of Goods Sold', type: 'Expense' }
         ],
         ledger: [
           { id: 'LED-1', date: '2026-03-10T09:00:00.000Z', debitAccountId: '11110', creditAccountId: '41100', amount: 100, referenceId: 'INV-1' },
           { id: 'LED-2', date: '2026-03-12T09:00:00.000Z', debitAccountId: '51200', creditAccountId: '11400', amount: 40, referenceId: 'INV-1' },
           { id: 'LED-3', date: '2026-02-08T09:00:00.000Z', debitAccountId: '11110', creditAccountId: '41100', amount: 50, referenceId: 'INV-OLD' }
         ],
        invoices: [
          { id: 'INV-1', status: 'Partial', totalAmount: 100, paidAmount: 75 },
          { id: 'INV-2', status: 'Unpaid', totalAmount: 25, paidAmount: 0 }
        ],
        customerPayments: [
          { id: 'RCP-1', date: '2026-03-27T10:00:00.000Z', amountRetained: 100, status: 'Cleared' }
        ],
        purchases: [
          { id: 'PO-1', status: 'Approved', totalAmount: 10, paidAmount: 0 }
        ]
      },
      new Date('2026-03-27T12:00:00.000Z')
    );

    expect(metrics.currentMonth.revenue).toBe(100);
    expect(metrics.currentMonth.expenses).toBe(40);
    expect(metrics.currentMonth.netProfit).toBe(60);
    expect(metrics.previousMonth.revenue).toBe(50);
    expect(metrics.todayCollection).toBe(100);
    expect(metrics.receivables).toBe(50);
    expect(metrics.payables).toBe(10);
    expect(metrics.cashPosition).toBe(150);
    expect(metrics.cashForecast).toBe(190);
  });

  it('flags invoice allocation mismatches and missing ledger postings', () => {
    const audit = financialIntegrityService.runAuditFromDataset({
      invoices: [
        { id: 'INV-1', status: 'Partial', totalAmount: 100, paidAmount: 60 }
      ],
      customerPayments: [
        {
          id: 'RCP-1',
          date: '2026-03-20T10:00:00.000Z',
          status: 'Cleared',
          amountRetained: 40,
          allocations: [{ invoiceId: 'INV-1', amount: 40 }]
        }
      ],
      ledger: []
    });

    expect(audit.healthy).toBe(false);
    expect(audit.issues.some(issue => issue.type === 'invoice_payment_mismatch' && issue.entityId === 'INV-1')).toBe(true);
    expect(audit.issues.some(issue => issue.type === 'missing_ledger_posting' && issue.entityType === 'invoice')).toBe(true);
    expect(audit.issues.some(issue => issue.type === 'missing_ledger_posting' && issue.entityType === 'customer_payment')).toBe(true);
  });

  it('flags missing bank mirrors and broken examination links', () => {
    const audit = financialIntegrityService.runAuditFromDataset({
         ledger: [
           { id: 'LED-EXP', date: '2026-03-10T09:00:00.000Z', debitAccountId: '52000', creditAccountId: '11210', amount: 75, referenceId: 'EXP-1' },
           { id: 'LED-SPAY', date: '2026-03-11T09:00:00.000Z', debitAccountId: '21110', creditAccountId: '11210', amount: 40, referenceId: 'SPAY-1' }
         ],
         expenses: [
           { id: 'EXP-1', status: 'Approved', amount: 75, accountId: '11210', description: 'Paper purchase' }
         ],
      supplierPayments: [
        { id: 'SPAY-1', status: 'Posted', amount: 40, supplierId: 'SUP-1' }
      ],
      examinationBatches: [
        { id: 'BATCH-1', status: 'Approved', invoiceId: 'INV-MISSING' }
      ],
      bankTransactions: []
    });

    expect(audit.issues.some(issue => issue.type === 'missing_bank_mirror' && issue.entityType === 'expense')).toBe(true);
    expect(audit.issues.some(issue => issue.type === 'missing_bank_mirror' && issue.entityType === 'supplier_payment')).toBe(true);
    expect(audit.issues.some(issue => issue.type === 'broken_examination_link' && issue.entityId === 'BATCH-1')).toBe(true);
  });

  it('uses live sales and expense records when ledger postings have not refreshed yet', () => {
    const metrics = financialIntegrityService.buildVerifiedDashboardMetrics(
      {
         accounts: [
           { id: '11110', code: '11110', name: 'Cash Drawer', type: 'Asset' },
           { id: '41100', code: '41100', name: 'Product Sales', type: 'Revenue' },
           { id: '52000', code: '52000', name: 'Operating Expenses', type: 'Expense' }
         ],
         ledger: [
           { id: 'LED-SALE-1', date: '2026-03-08T09:00:00.000Z', debitAccountId: '11110', creditAccountId: '41100', amount: 120, referenceId: 'SALE-1' },
           { id: 'LED-EXP-OLD', date: '2026-02-08T09:00:00.000Z', debitAccountId: '52000', creditAccountId: '11110', amount: 10, referenceId: 'EXP-OLD' }
         ],
        sales: [
          { id: 'SALE-1', date: '2026-03-08T09:00:00.000Z', totalAmount: 120, status: 'Completed' },
          { id: 'SALE-2', date: '2026-03-12T09:00:00.000Z', totalAmount: 80, status: 'Completed' },
          { id: 'SALE-OLD', date: '2026-02-12T09:00:00.000Z', totalAmount: 60, status: 'Completed' }
        ],
        expenses: [
          { id: 'EXP-NEW', date: '2026-03-18T09:00:00.000Z', status: 'Approved', amount: 30 },
          { id: 'EXP-OLD', date: '2026-02-10T09:00:00.000Z', status: 'Approved', amount: 10 }
        ]
      },
      new Date('2026-03-27T12:00:00.000Z')
    );

    expect(metrics.currentMonth.revenue).toBe(200);
    expect(metrics.currentMonth.expenses).toBe(30);
    expect(metrics.currentMonth.netProfit).toBe(170);
    expect(metrics.previousMonth.revenue).toBe(60);
    expect(metrics.previousMonth.expenses).toBe(10);
  });
});
