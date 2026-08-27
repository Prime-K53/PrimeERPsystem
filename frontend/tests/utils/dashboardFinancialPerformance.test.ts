import { describe, expect, it } from 'vitest';
import {
  buildFinancialPerformanceChartData,
  parseDashboardDate,
} from '../../utils/dashboardFinancialPerformance';

describe('dashboard financial performance chart data', () => {
  it('buckets synced POS sales that use created_at and total aliases', () => {
    const rows = buildFinancialPerformanceChartData({
      activePeriod: 'Month',
      selectedFinYear: '2026/27',
      financialYearStartMonth: 0,
      now: new Date('2026-08-27T12:00:00.000Z'),
      sales: [
        {
          id: 'SALE-1',
          created_at: '2026-08-26T10:00:00.000Z',
          total: '1,250.50',
          status: 'Completed',
        },
      ],
    });

    const row = rows.find(entry => entry.day === 'Aug 26');
    expect(row?.pos).toBe(1250.5);
    expect(row?.income).toBe(1250.5);
  });

  it('normalizes non-ISO dates before matching period buckets', () => {
    const rows = buildFinancialPerformanceChartData({
      activePeriod: 'Month',
      selectedFinYear: '2026/27',
      financialYearStartMonth: 0,
      now: new Date('2026-08-27T12:00:00.000Z'),
      expenses: [
        {
          id: 'EXP-1',
          date: '26/08/2026',
          amount: 40,
        },
      ],
    });

    const row = rows.find(entry => entry.day === 'Aug 26');
    expect(row?.expenses).toBe(40);
  });

  it('keeps recognized invoice revenue outside the paid/unpaid/partial buckets', () => {
    const rows = buildFinancialPerformanceChartData({
      activePeriod: 'Year',
      selectedFinYear: '2026/27',
      financialYearStartMonth: 0,
      now: new Date('2026-08-27T12:00:00.000Z'),
      invoices: [
        {
          id: 'INV-1',
          date: '2026-03-05',
          status: 'Sent',
          totalAmount: 300,
        },
      ],
    });

    const row = rows.find(entry => entry.day === 'Mar');
    expect(row?.income).toBe(300);
  });

  it('does not double count POS sale invoice mirrors', () => {
    const rows = buildFinancialPerformanceChartData({
      activePeriod: 'Year',
      selectedFinYear: '2026/27',
      financialYearStartMonth: 0,
      now: new Date('2026-08-27T12:00:00.000Z'),
      sales: [
        {
          id: 'SALE-1',
          date: '2026-03-05',
          status: 'Completed',
          totalAmount: 100,
        },
      ],
      invoices: [
        {
          id: 'INV-1',
          date: '2026-03-05',
          status: 'Paid',
          totalAmount: 100,
          reference: 'SALE-1',
          notes: 'POS Sale - Source: POS',
        },
      ],
    });

    const row = rows.find(entry => entry.day === 'Mar');
    expect(row?.pos).toBe(100);
    expect(row?.paid_inv).toBe(0);
    expect(row?.income).toBe(100);
  });

  it('returns no chart rows when the selected period has no values', () => {
    const rows = buildFinancialPerformanceChartData({
      activePeriod: 'Week',
      selectedFinYear: '2026/27',
      financialYearStartMonth: 0,
      now: new Date('2026-08-27T12:00:00.000Z'),
      sales: [{ id: 'SALE-1', date: '2026-08-26', totalAmount: 0 }],
    });

    expect(rows).toEqual([]);
  });

  it('parses common local financial dates used by legacy records', () => {
    const parsed = parseDashboardDate('26/08/2026');
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(26);
  });
});
