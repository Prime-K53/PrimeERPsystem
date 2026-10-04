import {
  buildRevenueAnalysisDataset,
  buildRevenueAnalysisDatasetFromLines,
  emptyRevenueCoverage,
  type RevenueAnalysisDataset,
  type RevenueAnalysisLine,
  type RevenueAnalysisTransaction,
  type RevenueCoverage,
  type RevenueItemPerformanceRow,
  type RevenueAdjustmentLedgerRow,
  type RevenueSourceSummary,
} from './revenueAnalysisService';
import { format, isWithinInterval, startOfMonth, startOfWeek, startOfYear, subDays, subMonths, subWeeks, endOfDay } from 'date-fns';

export type RevenueDateRange = 'week' | 'month' | 'quarter' | 'year' | 'all';

/** Bucket granularity used to plot the revenue trend for a given range. */
export type RevenueTrendBucket = 'day' | 'week' | 'month';

export interface RevenueTrendPoint {
  date: string;
  revenue: number;
  materialCost: number;
  adjustmentTotal: number;
  profitMargin: number;
  roundingTotal: number;
}

export interface RevenueCustomerSummary {
  customerName: string;
  transactionCount: number;
  revenue: number;
  adjustmentTotal: number;
  profitMargin: number;
  roundingTotal: number;
}

export interface RevenueReportingSnapshot {
  dataset: RevenueAnalysisDataset;
  totals: RevenueSourceSummary;
  sources: RevenueSourceSummary[];
  trend: RevenueTrendPoint[];
  trendBucket: RevenueTrendBucket;
  customers: RevenueCustomerSummary[];
  topItems: RevenueItemPerformanceRow[];
  topAdjustments: RevenueAdjustmentLedgerRow[];
  transactions: RevenueAnalysisTransaction[];
  lines: RevenueAnalysisLine[];
  /** Why the recognised total may differ from the documents on file. */
  coverage: RevenueCoverage;
  /** Human-readable bounds of the selected window (null for 'all'). */
  windowStart: string | null;
  windowEnd: string | null;
}

const roundMoney = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

const normalizeDate = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

const zeroSummary: RevenueSourceSummary = {
  source: 'ALL',
  transactionCount: 0,
  lineCount: 0,
  quantity: 0,
  revenue: 0,
  materialCost: 0,
  adjustmentTotal: 0,
  profitMargin: 0,
  roundingTotal: 0,
  manualOverrideAmount: 0,
  grossGain: 0,
  reconciliationDelta: 0,
};

export const matchesRevenueDateRange = (
  dateValue: unknown,
  dateRange: RevenueDateRange,
  referenceDate: Date = new Date()
) => {
  if (dateRange === 'all') return true;

  const date = normalizeDate(dateValue);
  if (!date) return false;

  const intervalEnd = endOfDay(referenceDate);
  switch (dateRange) {
    case 'week':
      return isWithinInterval(date, { start: startOfWeek(referenceDate, { weekStartsOn: 1 }), end: intervalEnd });
    case 'month':
      return isWithinInterval(date, { start: startOfMonth(referenceDate), end: intervalEnd });
    case 'quarter': {
      const quarterStart = new Date(referenceDate.getFullYear(), Math.floor(referenceDate.getMonth() / 3) * 3, 1);
      return isWithinInterval(date, { start: quarterStart, end: intervalEnd });
    }
    case 'year':
      return isWithinInterval(date, { start: startOfYear(referenceDate), end: intervalEnd });
    default:
      return true;
  }
};

/** Inclusive bounds of the selected window, for display and for GL parity. */
export const resolveRevenueWindow = (
  dateRange: RevenueDateRange,
  referenceDate: Date = new Date()
): { start: Date | null; end: Date } => {
  const end = endOfDay(referenceDate);
  if (dateRange === 'all') return { start: null, end };
  if (dateRange === 'week') return { start: startOfWeek(referenceDate, { weekStartsOn: 1 }), end };
  if (dateRange === 'month') return { start: startOfMonth(referenceDate), end };
  if (dateRange === 'quarter') {
    return { start: new Date(referenceDate.getFullYear(), Math.floor(referenceDate.getMonth() / 3) * 3, 1), end };
  }
  if (dateRange === 'year') return { start: startOfYear(referenceDate), end };
  return { start: null, end };
};

export const filterRevenueDatasetByDateRange = (
  dataset: RevenueAnalysisDataset,
  dateRange: RevenueDateRange,
  referenceDate: Date = new Date()
) => {
  if (dateRange === 'all') return dataset;
  return buildRevenueAnalysisDatasetFromLines(
    (dataset?.lines || []).filter((line) => matchesRevenueDateRange(line.date, dateRange, referenceDate))
  );
};

export interface RevenueTrendWindow {
  bucket: RevenueTrendBucket;
  count: number;
  labelFormat: string;
}

/**
 * The trend must describe the SAME window the KPIs describe. A fixed 7-day
 * chart under a Quarter/Year selection silently answered a different question
 * than the numbers above it, so the bucket size now follows the range.
 */
export const resolveRevenueTrendWindow = (
  dateRange: RevenueDateRange,
  fallbackDays = 7
): RevenueTrendWindow => {
  switch (dateRange) {
    case 'week':
      return { bucket: 'day', count: 7, labelFormat: 'EEE' };
    case 'month':
      return { bucket: 'day', count: 31, labelFormat: 'd MMM' };
    case 'quarter':
      return { bucket: 'week', count: 14, labelFormat: 'd MMM' };
    case 'year':
      return { bucket: 'month', count: 12, labelFormat: 'MMM' };
    case 'all':
    default:
      return { bucket: 'day', count: Math.max(1, Math.floor(fallbackDays)), labelFormat: 'd MMM' };
  }
};

const bucketKey = (date: Date, bucket: RevenueTrendBucket): string => {
  if (bucket === 'month') return format(date, 'yyyy-MM');
  if (bucket === 'week') return format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  return format(date, 'yyyy-MM-dd');
};

export const buildRevenueTrend = (
  lines: RevenueAnalysisLine[] = [],
  windowDays = 7,
  referenceDate: Date = new Date(),
  window?: RevenueTrendWindow
): RevenueTrendPoint[] => {
  const { bucket, count, labelFormat } = window || resolveRevenueTrendWindow('all', windowDays);
  const safeCount = Math.max(1, Math.floor(count));
  const normalizedLines = Array.isArray(lines) ? lines : [];

  const step = (date: Date, times: number) => {
    if (bucket === 'month') return subMonths(date, times);
    if (bucket === 'week') return subWeeks(date, times);
    return subDays(date, times);
  };

  const axisDates = Array.from({ length: safeCount }, (_, index) =>
    step(referenceDate, safeCount - index - 1)
  );
  const keys = axisDates.map((date) => bucketKey(date, bucket));

  const totalsByKey = new Map<string, RevenueTrendPoint>(
    keys.map((key, index) => [key, {
      date: format(axisDates[index], labelFormat),
      revenue: 0,
      materialCost: 0,
      adjustmentTotal: 0,
      profitMargin: 0,
      roundingTotal: 0,
    }])
  );

  normalizedLines.forEach((line) => {
    const lineDate = normalizeDate(line.date);
    if (!lineDate) return; // undated documents belong to no bucket
    const bucketForLine = totalsByKey.get(bucketKey(lineDate, bucket));
    if (!bucketForLine) return;
    bucketForLine.revenue += line.revenue;
    bucketForLine.materialCost += line.materialCost;
    bucketForLine.adjustmentTotal += line.adjustmentTotal;
    bucketForLine.profitMargin += line.profitMargin;
    bucketForLine.roundingTotal += line.roundingTotal;
  });

  return Array.from(totalsByKey.values()).map((point) => ({
    date: point.date,
    revenue: roundMoney(point.revenue),
    materialCost: roundMoney(point.materialCost),
    adjustmentTotal: roundMoney(point.adjustmentTotal),
    profitMargin: roundMoney(point.profitMargin),
    roundingTotal: roundMoney(point.roundingTotal),
  }));
};

export const buildRevenueCustomerSummaries = (
  transactions: RevenueAnalysisTransaction[] = []
): RevenueCustomerSummary[] => {
  const map = new Map<string, RevenueCustomerSummary>();

  (Array.isArray(transactions) ? transactions : []).forEach((transaction) => {
    const key = String(transaction.customerName || 'Walk-in').trim() || 'Walk-in';
    const existing = map.get(key);

    if (existing) {
      existing.transactionCount += 1;
      existing.revenue = roundMoney(existing.revenue + transaction.revenue);
      existing.adjustmentTotal = roundMoney(existing.adjustmentTotal + transaction.adjustmentTotal);
      existing.profitMargin = roundMoney(existing.profitMargin + transaction.profitMargin);
      existing.roundingTotal = roundMoney(existing.roundingTotal + transaction.roundingTotal);
      return;
    }

    map.set(key, {
      customerName: key,
      transactionCount: 1,
      revenue: roundMoney(transaction.revenue),
      adjustmentTotal: roundMoney(transaction.adjustmentTotal),
      profitMargin: roundMoney(transaction.profitMargin),
      roundingTotal: roundMoney(transaction.roundingTotal),
    });
  });

  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
};

export const buildRevenueReportingSnapshotFromLines = ({
  lines = [],
  dateRange = 'all',
  trendDays = 7,
  referenceDate = new Date(),
  sourceCoverage,
}: {
  lines?: RevenueAnalysisLine[];
  dateRange?: RevenueDateRange;
  trendDays?: number;
  referenceDate?: Date;
  /** Coverage measured before date-window filtering, so exclusions stay visible. */
  sourceCoverage?: RevenueCoverage;
} = {}): RevenueReportingSnapshot => {
  const baseDataset = buildRevenueAnalysisDatasetFromLines(lines);
  const dataset = filterRevenueDatasetByDateRange(baseDataset, dateRange, referenceDate);
  const totals = dataset.sourceSummaries.find((summary) => summary.source === 'ALL') || zeroSummary;
  const trendWindow = resolveRevenueTrendWindow(dateRange, trendDays);
  const window = resolveRevenueWindow(dateRange, referenceDate);

  // Reporting counts are the window's own; the exclusion ledger is the full scan's,
  // otherwise a filtered view would hide exactly the omissions it must explain.
  const coverage: RevenueCoverage = {
    ...emptyRevenueCoverage(),
    ...(sourceCoverage || baseDataset.coverage),
    documentsRecognized: totals.transactionCount,
    undatedDocuments: sourceCoverage?.undatedDocuments ?? baseDataset.coverage.undatedDocuments,
    undatedRevenue: sourceCoverage?.undatedRevenue ?? baseDataset.coverage.undatedRevenue,
  };

  return {
    dataset,
    totals,
    sources: dataset.sourceSummaries.filter((summary) => summary.source !== 'ALL'),
    trend: buildRevenueTrend(dataset.lines, trendDays, referenceDate, trendWindow),
    trendBucket: trendWindow.bucket,
    customers: buildRevenueCustomerSummaries(dataset.transactions),
    topItems: dataset.itemPerformance,
    topAdjustments: dataset.adjustmentLedger,
    transactions: dataset.transactions,
    lines: dataset.lines,
    coverage,
    windowStart: window.start ? format(window.start, 'yyyy-MM-dd') : null,
    windowEnd: format(window.end, 'yyyy-MM-dd'),
  };
};

export const buildRevenueReportingSnapshot = ({
  sales = [],
  invoices = [],
  orders = [],
  batches = [],
  dateRange = 'all',
  trendDays = 7,
  referenceDate = new Date(),
}: {
  sales?: any[];
  invoices?: any[];
  orders?: any[];
  batches?: any[];
  dateRange?: RevenueDateRange;
  trendDays?: number;
  referenceDate?: Date;
} = {}): RevenueReportingSnapshot => {
  const dataset = buildRevenueAnalysisDataset({ sales, invoices, orders, batches });
  return buildRevenueReportingSnapshotFromLines({
    lines: dataset.lines,
    sourceCoverage: dataset.coverage,
    dateRange,
    trendDays,
    referenceDate,
  });
};
