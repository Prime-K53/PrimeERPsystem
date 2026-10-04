import { describe, expect, it } from 'vitest';
import { buildRevenueAnalysisDataset } from '../../services/revenueAnalysisService';
import { buildRevenueReportingSnapshot } from '../../services/revenueReportingService';

describe('revenueAnalysisService', () => {
  const saleItems = [
    {
      id: 'ITEM-1',
      productId: 'ITEM-1',
      productName: 'Flyers',
      quantity: 1,
      price: 120,
      subtotal: 120,
      cost: 60,
      adjustmentSnapshots: [
        { name: 'Paper uplift', type: 'FIXED', value: 10, calculatedAmount: 10 },
        { name: 'Profit Margin', type: 'FIXED', value: 50, calculatedAmount: 50 },
      ],
      adjustmentTotal: 10,
      profitMarginAmount: 50,
      roundingDifference: 0,
    },
  ];

  it('suppresses a POS mirror invoice instead of counting the sale twice', () => {
    const dataset = buildRevenueAnalysisDataset({
      sales: [
        {
          id: 'POS-001',
          date: '2026-04-20T10:00:00.000Z',
          status: 'Paid',
          customerName: 'Walk-in',
          items: saleItems,
        },
      ],
      invoices: [
        {
          id: 'INV-001',
          date: '2026-04-20T10:00:00.000Z',
          status: 'Paid',
          customerName: 'Walk-in',
          reference: 'POS-001',
          notes: 'POS Sale - Source: POS',
          items: saleItems,
        },
      ],
    });

    // The sale is the authoritative POS document. Counting its mirror invoice as
    // well reported the same money twice.
    expect(dataset.transactions).toHaveLength(1);
    expect(dataset.transactions[0].source).toBe('POS');
    expect(dataset.sourceSummaries.find((s) => s.source === 'ALL')?.revenue).toBe(120);
    expect(dataset.coverage.documentsExcludedAsDuplicate).toBe(1);
    expect(dataset.adjustmentLedger).toHaveLength(1);
    expect(dataset.adjustmentLedger[0].adjustmentName).toBe('Paper uplift');
  });

  it('keeps a POS-labelled invoice when no sale row backs it', () => {
    const dataset = buildRevenueAnalysisDataset({
      sales: [],
      invoices: [
        {
          id: 'INV-ORPHAN',
          date: '2026-04-20T10:00:00.000Z',
          status: 'Paid',
          customerName: 'Walk-in',
          notes: 'POS Sale - Source: POS',
          items: saleItems,
        },
      ],
    });

    expect(dataset.transactions).toHaveLength(1);
    expect(dataset.sourceSummaries.find((s) => s.source === 'ALL')?.revenue).toBe(120);
    expect(dataset.coverage.documentsExcludedAsDuplicate).toBe(0);
  });

  it('reports every revenue document it refused to recognise', () => {
    const dataset = buildRevenueAnalysisDataset({
      sales: [
        { id: 'POS-OK', date: '2026-04-20T10:00:00.000Z', status: 'Paid', items: saleItems },
        { id: 'POS-DRAFT', date: '2026-04-20T10:00:00.000Z', status: 'Draft', items: saleItems },
      ],
      invoices: [
        { id: 'INV-VOID', date: '2026-04-20T10:00:00.000Z', status: 'Voided', items: saleItems },
      ],
    });

    expect(dataset.coverage.documentsScanned).toBe(3);
    expect(dataset.coverage.documentsRecognized).toBe(1);
    expect(dataset.coverage.documentsExcludedByStatus).toBe(2);
    expect(dataset.coverage.undatedDocuments).toBe(0);
  });

  it('never books an undated document as today and keeps it out of date windows', () => {
    const undated = {
      id: 'INV-NODATE',
      status: 'Paid',
      customerName: 'Acme',
      items: saleItems,
    };

    const all = buildRevenueReportingSnapshot({ invoices: [undated], dateRange: 'all' });
    expect(all.totals.revenue).toBe(120);
    expect(all.coverage.undatedDocuments).toBe(1);
    expect(all.coverage.undatedRevenue).toBe(120);

    const month = buildRevenueReportingSnapshot({
      invoices: [undated],
      dateRange: 'month',
      referenceDate: new Date('2026-04-30T12:00:00.000Z'),
    });
    expect(month.totals.revenue).toBe(0);
    expect(month.coverage.undatedRevenue).toBe(120);
  });

  it('scales the trend to the selected window instead of always plotting 7 days', () => {
    const week = buildRevenueReportingSnapshot({ dateRange: 'week', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(week.trendBucket).toBe('day');
    expect(week.trend).toHaveLength(7);

    const month = buildRevenueReportingSnapshot({ dateRange: 'month', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(month.trend).toHaveLength(31);

    const quarter = buildRevenueReportingSnapshot({ dateRange: 'quarter', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(quarter.trendBucket).toBe('week');
    expect(quarter.trend).toHaveLength(14);

    const year = buildRevenueReportingSnapshot({ dateRange: 'year', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(year.trendBucket).toBe('month');
    expect(year.trend).toHaveLength(12);
  });

  it('reports the window bounds behind the headline number', () => {
    const month = buildRevenueReportingSnapshot({ dateRange: 'month', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(month.windowStart).toBe('2026-04-01');
    expect(month.windowEnd).toBe('2026-04-30');

    const all = buildRevenueReportingSnapshot({ dateRange: 'all', referenceDate: new Date('2026-04-30T12:00:00.000Z') });
    expect(all.windowStart).toBeNull();
  });

  it('captures examination adjustments, rounding, margin, and sub-account tagging from batches', () => {
    const report = buildRevenueReportingSnapshot({
      invoices: [
        {
          id: 'EXM-INV-001',
          date: '2026-04-21T09:30:00.000Z',
          status: 'Unpaid',
          originModule: 'examination',
          batchId: 'BATCH-001',
          customerName: 'Northview Academy',
          totalAmount: 105,
          items: [
            { id: 'EXAM-LINE-1', name: 'Examination Service', quantity: 1, price: 105, total: 105 },
          ],
        },
      ],
      batches: [
        {
          id: 'BATCH-001',
          school_name: 'Northview Academy',
          sub_account_name: 'Campus A',
          rounding_adjustment_total: 5,
          classes: [
            {
              id: 'CLS-1',
              class_name: 'Form 4',
              number_of_learners: 10,
              live_total_preview: 100,
              material_total_cost: 60,
              adjustment_total_cost: 10,
              rounding_adjustment: 5,
            },
          ],
        },
      ],
    });

    expect(report.totals.revenue).toBe(100);
    expect(report.totals.adjustmentTotal).toBe(10);
    expect(report.totals.roundingTotal).toBe(5);
    expect(report.totals.profitMargin).toBe(25);
    expect(report.transactions).toHaveLength(1);
    expect(report.transactions[0].source).toBe('EXAMINATION');
    expect(report.transactions[0].subAccountName).toBe('Campus A');
  });

  it('uses batch class pricing when invoice adjustment totals already include rounding', () => {
    const report = buildRevenueReportingSnapshot({
      invoices: [
        {
          id: 'EXM-INV-002',
          date: '2026-05-23T09:30:00.000Z',
          status: 'Unpaid',
          originModule: 'examination',
          batchId: 'BATCH-002',
          customerName: 'Mankhamba LEA School',
          totalAmount: 5000,
          materialTotal: 2511,
          adjustmentTotal: 1178.7,
          profitMarginTotal: 1310.3,
          roundingTotal: 0,
          adjustmentSnapshots: [
            { name: 'Transport/Logistics', type: 'FIXED', value: 1049.6, calculatedAmount: 1049.6 },
            { name: 'Rounding', type: 'FIXED', value: 129.1, calculatedAmount: 129.1 },
          ],
          items: [
            { id: 'EXAM-LINE-1', name: 'Examination Service', quantity: 1, price: 5000, total: 5000 },
          ],
        },
      ],
      batches: [
        {
          id: 'BATCH-002',
          school_name: 'Mankhamba LEA School',
          sub_account_name: 'Main Campus',
          classes: [
            {
              id: 'CLS-1',
              class_name: 'Form 4',
              number_of_learners: 1,
              live_total_preview: 5000,
              material_total_cost: 2511,
              market_adjustment_total: 1049.6,
              adjustment_total_cost: 1178.7,
              rounding_adjustment: 129.1,
              margin_amount: 1310.3,
            },
          ],
          adjustmentSnapshots: [
            { id: 'transport', name: 'Transport/Logistics', type: 'FIXED', total_amount: 1049.6, calculatedAmount: 1049.6 },
            { id: 'auto-rounding', name: 'Rounding', type: 'FIXED', total_amount: 129.1, calculatedAmount: 129.1, is_rounding: true },
          ],
        },
      ],
    });

    expect(report.totals.revenue).toBe(5000);
    expect(report.totals.materialCost).toBe(2511);
    expect(report.totals.adjustmentTotal).toBe(1049.6);
    expect(report.totals.profitMargin).toBe(1310.3);
    expect(report.totals.roundingTotal).toBe(129.1);
    expect(report.transactions).toHaveLength(1);
    expect(report.transactions[0].adjustmentTotal).toBe(1049.6);
    expect(report.transactions[0].roundingTotal).toBe(129.1);
    expect(report.transactions[0].subAccountName).toBe('Main Campus');
  });
});
