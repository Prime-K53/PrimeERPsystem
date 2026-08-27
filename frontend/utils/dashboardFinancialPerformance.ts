import { isValid, parse, parseISO } from 'date-fns';

export const DASHBOARD_PERIOD_DAYS: Record<string, number> = { Year: 365, Month: 30, Week: 7 };

export interface FinancialPerformanceChartRow {
  day: string;
  income: number;
  expenses: number;
  pos: number;
  paid_inv: number;
  unpaid_inv: number;
  partial_inv: number;
}

interface BuildFinancialPerformanceChartDataOptions {
  activePeriod: string;
  selectedFinYear: string;
  financialYearStartMonth: number;
  financialYearStartDate?: unknown;
  now?: Date;
  sales?: any[];
  invoices?: any[];
  purchases?: any[];
  expenses?: any[];
  inFY?: (raw: unknown) => boolean;
}

const DATE_FORMATS = [
  'yyyy-MM-dd',
  'yyyy/MM/dd',
  'dd/MM/yyyy',
  'd/M/yyyy',
  'MM/dd/yyyy',
  'M/d/yyyy',
  'dd-MM-yyyy',
  'd-M-yyyy',
  'MM-dd-yyyy',
  'M-d-yyyy',
];

const toSafeNumber = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export const parseDashboardDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const iso = parseISO(raw);
  if (isValid(iso)) return iso;

  for (const formatToken of DATE_FORMATS) {
    const parsed = parse(raw, formatToken, new Date(0));
    if (isValid(parsed)) return parsed;
  }

  const nativeParsed = new Date(raw);
  return Number.isNaN(nativeParsed.getTime()) ? null : nativeParsed;
};

const toDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const toMonthKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const firstPresentValue = (record: any, keys: string[]): unknown => {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null && String(record[key]).trim() !== '') {
      return record[key];
    }
  }
  return undefined;
};

const getRecordDate = (record: any, keys: string[]): unknown =>
  firstPresentValue(record, keys);

const getRecordAmount = (record: any, keys: string[]): number =>
  toSafeNumber(firstPresentValue(record, keys));

const isRecognizedInvoice = (invoice: any) => {
  const status = String(invoice?.status || '').trim().toLowerCase();
  return status !== 'draft' && status !== 'cancelled' && status !== 'void' && status !== 'voided';
};

const getInvoiceRevenueAmount = (invoice: any) => {
  if (!isRecognizedInvoice(invoice)) return 0;
  return getRecordAmount(invoice, ['totalAmount', 'total', 'amount', 'total_amount']);
};

const invoiceReferencesSale = (invoice: any, saleIds: Set<string>) => {
  const references = [
    invoice?.reference,
    invoice?.referenceId,
    invoice?.reference_id,
    invoice?.saleId,
    invoice?.sale_id,
    invoice?.sourceId,
    invoice?.source_id,
    invoice?.id,
  ];

  return references.some(reference => {
    const value = String(reference ?? '').trim();
    return value.length > 0 && saleIds.has(value);
  });
};

const createEmptyRow = (day: string): FinancialPerformanceChartRow => ({
  day,
  income: 0,
  expenses: 0,
  pos: 0,
  paid_inv: 0,
  unpaid_inv: 0,
  partial_inv: 0,
});

const hasChartValues = (rows: FinancialPerformanceChartRow[]) =>
  rows.some(row => row.income > 0 || row.expenses > 0);

const normalizeFinancialYearStart = (
  selectedFinYear: string,
  financialYearStartMonth: number,
  financialYearStartDate: unknown,
  now: Date,
) => {
  const parsedStartDate = parseDashboardDate(financialYearStartDate);
  if (parsedStartDate) {
    return {
      startYear: parsedStartDate.getFullYear(),
      startMonth: parsedStartDate.getMonth(),
    };
  }

  const parsedStartYear = Number.parseInt(String(selectedFinYear || '').split('/')[0], 10);
  const safeStartMonth = Number.isInteger(financialYearStartMonth) && financialYearStartMonth >= 0 && financialYearStartMonth <= 11
    ? financialYearStartMonth
    : 0;

  return {
    startYear: Number.isFinite(parsedStartYear) ? parsedStartYear : now.getFullYear(),
    startMonth: safeStartMonth,
  };
};

export const buildFinancialPerformanceChartData = ({
  activePeriod,
  selectedFinYear,
  financialYearStartMonth,
  financialYearStartDate,
  now = new Date(),
  sales = [],
  invoices = [],
  purchases = [],
  expenses = [],
  inFY = () => true,
}: BuildFinancialPerformanceChartDataOptions): FinancialPerformanceChartRow[] => {
  const cData: Record<string, FinancialPerformanceChartRow> = {};
  const { startYear, startMonth } = normalizeFinancialYearStart(
    selectedFinYear,
    financialYearStartMonth,
    financialYearStartDate,
    now,
  );

  if (activePeriod === 'Year') {
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(startYear, startMonth + i, 1);
      const key = toMonthKey(d);
      cData[key] = createEmptyRow(d.toLocaleDateString('en-US', { month: 'short' }));
    }
  } else {
    const days = DASHBOARD_PERIOD_DAYS[activePeriod] ?? 30;
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = toDateKey(d);
      const label = activePeriod === 'Week'
        ? d.toLocaleDateString('en-US', { weekday: 'short' })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      cData[key] = createEmptyRow(label);
    }
  }

  const getChartKey = (rawDate: unknown) => {
    const parsedDate = parseDashboardDate(rawDate);
    if (!parsedDate) return null;
    return activePeriod === 'Year' ? toMonthKey(parsedDate) : toDateKey(parsedDate);
  };
  const countedSaleIds = new Set<string>();

  sales.forEach((sale: any) => {
    const rawDate = getRecordDate(sale, ['date', 'transactionDate', 'transaction_date', 'createdAt', 'created_at']);
    if (!inFY(rawDate)) return;
    const key = getChartKey(rawDate);
    if (key && cData[key]) {
      const total = getRecordAmount(sale, ['totalAmount', 'total', 'amount', 'total_amount']);
      if (total > 0) {
        cData[key].pos += total;
        const saleId = String(sale?.id ?? '').trim();
        if (saleId) countedSaleIds.add(saleId);
      }
      cData[key].expenses += getRecordAmount(sale, ['cost', 'expense', 'costAmount', 'cost_amount']);
    }
  });

  invoices.forEach((invoice: any) => {
    if (invoiceReferencesSale(invoice, countedSaleIds)) return;
    const rawDate = getRecordDate(invoice, ['date', 'invoiceDate', 'invoice_date', 'createdAt', 'created_at']);
    if (!inFY(rawDate)) return;
    const key = getChartKey(rawDate);
    if (key && cData[key]) {
      const total = getInvoiceRevenueAmount(invoice);
      const status = String(invoice.status || '').toLowerCase();
      if (status === 'paid' || status === 'completed') cData[key].paid_inv += total;
      else if (status === 'partial' || status === 'partially paid' || status === 'overdue') cData[key].partial_inv += total;
      else if (status === 'unpaid' || status === 'due' || status === 'pending') cData[key].unpaid_inv += total;
      else cData[key].income += total;
    }
  });

  purchases.forEach((purchase: any) => {
    const rawDate = getRecordDate(purchase, ['date', 'orderDate', 'order_date', 'createdAt', 'created_at']);
    if (!inFY(rawDate)) return;
    const isPaid =
      purchase.status === 'Paid' ||
      purchase.paymentStatus === 'Paid' ||
      purchase.payment_status === 'Paid' ||
      toSafeNumber(purchase.paidAmount ?? purchase.paid_amount) > 0 ||
      purchase.paymentStatus === 'Partial' ||
      purchase.payment_status === 'Partial';
    if (!isPaid) return;
    const key = getChartKey(rawDate);
    if (key && cData[key]) {
      cData[key].expenses += getRecordAmount(purchase, ['paidAmount', 'paid_amount', 'totalAmount', 'total', 'amount', 'total_amount']);
    }
  });

  expenses.forEach((expense: any) => {
    const rawDate = getRecordDate(expense, ['date', 'expenseDate', 'expense_date', 'createdAt', 'created_at']);
    if (!inFY(rawDate)) return;
    const key = getChartKey(rawDate);
    if (key && cData[key]) {
      cData[key].expenses += getRecordAmount(expense, ['amount', 'totalAmount', 'total', 'total_amount']);
    }
  });

  const rows = Object.values(cData);
  rows.forEach(entry => {
    entry.income += entry.pos + entry.paid_inv + entry.unpaid_inv + entry.partial_inv;
  });

  return hasChartValues(rows) ? rows : [];
};
