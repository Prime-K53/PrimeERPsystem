import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Calendar, Filter, Printer, Download, Eye, TrendingUp, Scale, Activity, Target, CheckCircle2, History, Coins, DollarSign, BarChart3, FileText, FileCheck, FileBarChart,
  ChevronRight, AlertCircle
} from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useProcurement } from '../../context/ProcurementContext';
import { useAuth } from '../../context/AuthContext';
import { useDocumentStore } from '../../stores/documentStore';
import { calculateAccountBalances, getAgedData } from '../../services/reportService';
import { computeTrialBalance, getCanonicalAccountType } from '../../services/accountingEngine';
import { format, parseISO, startOfYear, endOfYear, startOfMonth, endOfMonth, subMonths, startOfQuarter } from 'date-fns';
import { currencyService } from '../../services/currencyService';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area
} from 'recharts';

type ReportType = 'IncomeStatement' | 'BalanceSheet' | 'CashFlow' | 'EquityStatement' | 'TrialBalance' | 'Budget' | 'AgedAR' | 'AgedAP';

interface Props {
  reportType: ReportType;
  reportLabel: string;
  onBack: () => void;
}

const CHART_COLORS = ['#1f8577', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const quickRanges = () => {
  const now = new Date();
  return [
    { label: 'Today', start: now, end: now },
    { label: 'This Month', start: startOfMonth(now), end: endOfMonth(now) },
    { label: 'Last Month', start: startOfMonth(subMonths(now, 1)), end: endOfMonth(subMonths(now, 1)) },
    { label: 'QTD', start: startOfQuarter(now), end: now },
    { label: 'YTD', start: startOfYear(now), end: now },
  ];
};

const FiscalReportWorkspace: React.FC<Props> = ({ reportType, reportLabel, onBack }) => {
  const { accounts, ledger, budgets, invoices } = useFinance();
  const { purchases } = useProcurement();
  const { companyConfig, notify } = useAuth();
  const { safeOpenPreview } = useDocumentStore();
  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
  const navigate = useNavigate();

  const [dateRange, setDateRange] = useState({
    start: startOfYear(new Date()).toISOString().split('T')[0],
    end: endOfYear(new Date()).toISOString().split('T')[0]
  });
  const [compareWithPrevious, setCompareWithPrevious] = useState(false);
  const [activeQuick, setActiveQuick] = useState<string>('YTD');

  const applyQuick = (label: string, start: Date, end: Date) => {
    setActiveQuick(label);
    setDateRange({ start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] });
  };

  const displayTypeOf = (a: any): string => {
    const legacy = String(a?.type || '').trim();
    if (['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(legacy)) return legacy;
    const canonical = getCanonicalAccountType(a);
    if (canonical === 'ASSET') return 'Asset';
    if (canonical === 'LIABILITY') return 'Liability';
    if (canonical === 'EQUITY') return 'Equity';
    if (canonical === 'INCOME') return 'Revenue';
    return 'Expense';
  };

  const balances = useMemo(() => calculateAccountBalances(accounts, ledger, dateRange as any, compareWithPrevious), [accounts, ledger, dateRange, compareWithPrevious]);

  const getAccountRows = (types: string[]) => (accounts || [])
    .filter((a: any) => types.includes(displayTypeOf(a)))
    .map((a: any) => ({
      label: a.name,
      subText: a.code,
      amount: balances.current[a.id] || 0,
      prevAmount: balances.previous[a.id] || 0
    }))
    .filter((a: any) => Math.abs(a.amount) > 0.001 || Math.abs(a.prevAmount) > 0.001)
    .sort((a: any, b: any) => a.subText.localeCompare(b.subText));

  // ---------- Report data ----------
  const revenue = getAccountRows(['Revenue']);
  const expenses = getAccountRows(['Expense']);
  const assets = getAccountRows(['Asset']);
  const liabilities = getAccountRows(['Liability']);
  const equity = getAccountRows(['Equity']);

  const totalRev = revenue.reduce((s: number, a: any) => s + a.amount, 0);
  const totalExp = expenses.reduce((s: number, a: any) => s + a.amount, 0);
  const netIncome = totalRev - totalExp;
  const totalAssets = assets.reduce((s: number, a: any) => s + a.amount, 0);
  const totalLiab = liabilities.reduce((s: number, a: any) => s + a.amount, 0);
  const totalEquity = equity.reduce((s: number, a: any) => s + a.amount, 0);
  const currentAssets = assets.filter((a: any) => /current|cash|receivable|inventory/i.test(a.label)).reduce((s: number, a: any) => s + a.amount, 0);
  const currentLiab = liabilities.filter((a: any) => /current|payable/i.test(a.label)).reduce((s: number, a: any) => s + a.amount, 0);

  const aged = (reportType === 'AgedAR' || reportType === 'AgedAP') ? getAgedData(invoices, purchases) : null;
  const agedData = reportType === 'AgedAR' ? aged?.ar : aged?.ap;

  const trial = reportType === 'TrialBalance' ? computeTrialBalance((accounts || []) as any[], (ledger || []) as any[], { asOfDate: dateRange.end }) : null;

  // KPIs per report
  const kpis = useMemo(() => {
    switch (reportType) {
      case 'IncomeStatement': {
        const cogs = expenses.filter((e: any) => /cost of sales|cogs|cost of goods/i.test(e.label)).reduce((s: number, a: any) => s + a.amount, 0);
        const grossProfit = totalRev - cogs;
        const opExp = totalExp - cogs;
        return [
          { label: 'Revenue', value: totalRev, fmt: 'money' },
          { label: 'Cost of Sales', value: cogs, fmt: 'money' },
          { label: 'Gross Profit', value: grossProfit, fmt: 'money' },
          { label: 'Operating Expenses', value: opExp, fmt: 'money' },
          { label: 'Net Profit', value: netIncome, fmt: 'money' },
          { label: 'Net Margin %', value: totalRev ? (netIncome / totalRev) * 100 : 0, fmt: 'pct' },
        ];
      }
      case 'BalanceSheet':
        return [
          { label: 'Total Assets', value: totalAssets, fmt: 'money' },
          { label: 'Current Assets', value: currentAssets, fmt: 'money' },
          { label: 'Total Liabilities', value: totalLiab, fmt: 'money' },
          { label: 'Current Liabilities', value: currentLiab, fmt: 'money' },
          { label: 'Equity', value: totalEquity, fmt: 'money' },
          { label: 'Current Ratio', value: currentLiab ? currentAssets / currentLiab : 0, fmt: 'ratio' },
        ];
      case 'CashFlow': {
        const inflows = totalRev;
        const outflows = totalExp;
        return [
          { label: 'Cash Inflows', value: inflows, fmt: 'money' },
          { label: 'Cash Outflows', value: outflows, fmt: 'money' },
          { label: 'Net Cash Flow', value: inflows - outflows, fmt: 'money' },
          { label: 'Operating CF', value: netIncome, fmt: 'money' },
          { label: 'Investing CF', value: 0, fmt: 'money' },
          { label: 'Financing CF', value: 0, fmt: 'money' },
        ];
      }
      case 'TrialBalance':
        return [
          { label: 'Total Debit', value: trial?.totalDebits || 0, fmt: 'money' },
          { label: 'Total Credit', value: trial?.totalCredits || 0, fmt: 'money' },
          { label: 'Difference', value: (trial?.totalDebits || 0) - (trial?.totalCredits || 0), fmt: 'money' },
          { label: 'Accounts', value: trial?.lines?.length || 0, fmt: 'num' },
          { label: 'Unbalanced', value: trial?.isBalanced ? 0 : 1, fmt: 'num' },
        ];
      case 'EquityStatement': {
        const opening = totalEquity - netIncome;
        return [
          { label: 'Opening Equity', value: opening, fmt: 'money' },
          { label: 'Contributions', value: 0, fmt: 'money' },
          { label: 'Retained Earnings', value: netIncome, fmt: 'money' },
          { label: 'Current Year Profit', value: netIncome, fmt: 'money' },
          { label: 'Closing Equity', value: totalEquity, fmt: 'money' },
        ];
      }
      case 'Budget': {
        const activeBudgets = (budgets || []).filter((b: any) => {
          const bDate = new Date(`${b.month}-01`);
          const start = new Date(dateRange.start);
          const end = new Date(dateRange.end);
          return bDate >= start && bDate <= end;
        });
        const budgetTotal = activeBudgets.reduce((s: number, b: any) => s + (b.amount || 0), 0);
        const variance = budgetTotal - totalExp;
        return [
          { label: 'Budget', value: budgetTotal, fmt: 'money' },
          { label: 'Actual', value: totalExp, fmt: 'money' },
          { label: 'Variance', value: variance, fmt: 'money' },
          { label: 'Variance %', value: budgetTotal ? (variance / budgetTotal) * 100 : 0, fmt: 'pct' },
          { label: 'Forecast', value: totalExp, fmt: 'money' },
          { label: 'Utilisation %', value: budgetTotal ? (totalExp / budgetTotal) * 100 : 0, fmt: 'pct' },
        ];
      }
      case 'AgedAR':
      case 'AgedAP': {
        const buckets = agedData?.buckets || {};
        const total = Object.values(buckets).reduce((s: number, v: any) => s + (v || 0), 0);
        return [
          { label: 'Total', value: total, fmt: 'money' },
          { label: 'Current', value: buckets['0-30'] || 0, fmt: 'money' },
          { label: '30 Days', value: buckets['31-60'] || 0, fmt: 'money' },
          { label: '60 Days', value: buckets['61-90'] || 0, fmt: 'money' },
          { label: '90 Days', value: buckets['91-120'] || 0, fmt: 'money' },
          { label: '120+ Days', value: buckets['120+'] || 0, fmt: 'money' },
        ];
      }
      default:
        return [];
    }
  }, [reportType, totalRev, totalExp, netIncome, totalAssets, totalLiab, totalEquity, currentAssets, currentLiab, trial, agedData, budgets, dateRange]);

  const fmtValue = (v: number, fmt: string) => {
    if (fmt === 'pct') return `${v.toFixed(1)}%`;
    if (fmt === 'ratio') return v.toFixed(2);
    if (fmt === 'num') return v.toLocaleString();
    return `${currency} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handlePreview = () => {
    const balances2 = calculateAccountBalances(accounts, ledger, dateRange as any, compareWithPrevious);
    const getRows = (types: string[]) => (accounts || [])
      .filter((a: any) => types.includes(displayTypeOf(a)))
      .map((a: any) => ({ label: a.name, subText: a.code, amount: balances2.current[a.id] || 0, prevAmount: balances2.previous[a.id] || 0 }))
      .filter((a: any) => Math.abs(a.amount) > 0.001 || Math.abs(a.prevAmount) > 0.001)
      .sort((a: any, b: any) => a.subText.localeCompare(b.subText));

    let reportData: any = { reportName: reportLabel, period: `${format(parseISO(dateRange.start), 'MMM d, yyyy')} - ${format(parseISO(dateRange.end), 'MMM d, yyyy')}`, currency, sections: [] };

    if (reportType === 'IncomeStatement') {
      const rev = getRows(['Revenue']); const exp = getRows(['Expense']);
      const tr = rev.reduce((s: number, a: any) => s + a.amount, 0); const te = exp.reduce((s: number, a: any) => s + a.amount, 0);
      reportData.sections = [
        { title: 'Operating Revenue', rows: [...rev, { label: 'Total Revenue', amount: tr, prevAmount: rev.reduce((s: number, a: any) => s + (a.prevAmount || 0), 0), isTotal: true }] },
        { title: 'Operating Expenses', rows: [...exp, { label: 'Total Expenses', amount: te, prevAmount: exp.reduce((s: number, a: any) => s + (a.prevAmount || 0), 0), isTotal: true }] }
      ];
      reportData.netPerformance = { label: 'Net Profit / (Loss)', amount: tr - te, prevAmount: 0 };
    } else if (reportType === 'BalanceSheet') {
      const a = getRows(['Asset']); const l = getRows(['Liability']); const e = getRows(['Equity']);
      const ta = a.reduce((s: number, x: any) => s + x.amount, 0);
      const rev = getRows(['Revenue']); const exp = getRows(['Expense']);
      const ni = rev.reduce((s: number, x: any) => s + x.amount, 0) - exp.reduce((s: number, x: any) => s + x.amount, 0);
      reportData.sections = [
        { title: 'Assets', rows: [...a, { label: 'Total Assets', amount: ta, isTotal: true }] },
        { title: 'Liabilities & Equity', rows: [...l, ...e, { label: 'Net Profit / (Loss) for Period', amount: ni }, { label: 'Total Liabilities & Equity', amount: l.reduce((s: number, x: any) => s + x.amount, 0) + e.reduce((s: number, x: any) => s + x.amount, 0) + ni, isTotal: true }] }
      ];
    } else if (reportType === 'TrialBalance') {
      const tb = computeTrialBalance((accounts || []) as any[], (ledger || []) as any[], { asOfDate: dateRange.end });
      reportData.sections = [
        { title: 'Debit Balances', rows: tb.lines.filter((l: any) => l.totalDebit > 0).map((l: any) => ({ label: l.accountName, subText: l.accountCode, amount: l.totalDebit })) },
        { title: 'Credit Balances', rows: tb.lines.filter((l: any) => l.totalCredit > 0).map((l: any) => ({ label: l.accountName, subText: l.accountCode, amount: l.totalCredit })) }
      ];
      reportData.netPerformance = { label: tb.isBalanced ? 'BALANCED' : 'OUT OF BALANCE', amount: tb.totalDebits, prevAmount: tb.totalCredits };
    } else if (reportType === 'AgedAR' || reportType === 'AgedAP') {
      const aged2 = getAgedData(invoices, purchases);
      const d = reportType === 'AgedAR' ? aged2.ar : aged2.ap;
      reportData.sections = [
        { title: 'Aging Summary', rows: Object.entries(d.buckets).map(([b, amt]) => ({ label: `${b} Days`, amount: amt as number })) },
        { title: 'Top Outstanding Items', rows: d.items.sort((a: any, b: any) => b.balance - a.balance).slice(0, 20).map((i: any) => ({ label: i.customerName || i.supplierId || 'Unknown', subText: `Due: ${format(parseISO(i.date), 'MMM d, yyyy')}`, amount: i.balance })) }
      ];
    } else if (reportType === 'Budget') {
      const activeBudgets = (budgets || []).filter((b: any) => {
        const bDate = new Date(`${b.month}-01`); const start = new Date(dateRange.start); const end = new Date(dateRange.end);
        return bDate >= start && bDate <= end;
      });
      const items = (accounts || []).filter((a: any) => displayTypeOf(a) === 'Revenue' || displayTypeOf(a) === 'Expense').map((acc: any) => {
        const actual = balances2.current[acc.id] || 0;
        const budgetAmount = activeBudgets.filter((b: any) => b.accountId === acc.id).reduce((s: number, b: any) => s + b.amount, 0);
        return { label: acc.name, subText: acc.code, amount: actual, prevAmount: budgetAmount };
      }).filter((i: any) => Math.abs(i.amount) > 0 || Math.abs(i.prevAmount) > 0);
      reportData.sections = [{ title: 'Budget vs Actual Performance', rows: items }];
    } else if (reportType === 'CashFlow') {
      const rev = getRows(['Revenue']); const exp = getRows(['Expense']);
      const tr = rev.reduce((s: number, a: any) => s + a.amount, 0); const te = exp.reduce((s: number, a: any) => s + a.amount, 0);
      reportData.sections = [
        { title: 'Operating Activities (Inflow)', rows: rev },
        { title: 'Operating Activities (Outflow)', rows: exp.map((e: any) => ({ ...e, amount: -e.amount })) }
      ];
      reportData.netPerformance = { label: 'Net Cash Flow from Operations', amount: tr - te };
    } else if (reportType === 'EquityStatement') {
      const eq = getRows(['Equity']);
      const rev = getRows(['Revenue']); const exp = getRows(['Expense']);
      const ni = rev.reduce((s: number, a: any) => s + a.amount, 0) - exp.reduce((s: number, a: any) => s + a.amount, 0);
      const opening = eq.reduce((s: number, a: any) => s + (a.prevAmount || 0), 0);
      const closing = eq.reduce((s: number, a: any) => s + a.amount, 0);
      reportData.sections = [{ title: 'Equity Reconciliation', rows: [
        { label: 'Opening Equity', amount: opening },
        { label: 'Net Profit / (Loss) for Period', amount: ni },
        { label: 'Contributions / (Withdrawals)', amount: closing - opening - ni },
        { label: 'Closing Equity', amount: closing, isTotal: true }
      ]}];
      reportData.netPerformance = { label: 'Closing Equity', amount: closing };
    }

    const result = safeOpenPreview('FISCAL_REPORT', reportData);
    if (result.success) onBack();
    else notify(result.error || 'Failed to generate preview', 'error');
  };

  const exportCSV = () => {
    // Build a simple CSV from KPIs
    const rows = [['Metric', 'Value']];
    kpis.forEach((k) => rows.push([k.label, String(k.value)]));
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${reportLabel}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => window.print();

  // charts data
  const revenueVsExpenseData = [{ name: 'Revenue', value: totalRev }, { name: 'Expenses', value: totalExp }];
  const expenseBreakdown = expenses.slice(0, 8).map((e: any) => ({ name: e.label, value: Math.abs(e.amount) }));
  const cashMovement = [{ name: 'Inflows', value: totalRev }, { name: 'Outflows', value: totalExp }];
  const agingBuckets = agedData ? Object.entries(agedData.buckets).map(([k, v]) => ({ name: `${k}d`, value: v as number })) : [];

  return (
    <div style={{ minHeight: '100vh', background: '#FEFDFB', padding: '24px 20px', fontFamily: "'Inter','DM Sans',sans-serif" }}>
      {/* Header */}
      <div style={{ maxWidth: 1280, margin: '0 auto', position: 'relative', paddingTop: 14 }}>
        <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 120, height: 4, borderRadius: 999, background: 'linear-gradient(90deg, #146b60, #3fa294 40%, #d99a3f 100%)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4ddd1', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#5c6567' }}>
            <ArrowLeft size={16} /> Back
          </button>
          <div>
            <h1 style={{ margin: 0, fontFamily: "'DM Serif Display', 'Georgia', serif", fontSize: 28, fontWeight: 400, color: '#0f544c' }}>{reportLabel}</h1>
            <p style={{ margin: 0, fontSize: 12, color: '#5c6567' }}>Professional reporting workspace</p>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={exportCSV} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4ddd1', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#5c6567' }}>
              <Download size={14} /> Excel
            </button>
            <button onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4ddd1', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#5c6567' }}>
              <Printer size={14} /> Print
            </button>
            <button onClick={handlePreview} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: '#1f8577', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#fff' }}>
              <Eye size={14} /> Generate PDF
            </button>
          </div>
        </div>

        {/* Quick filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {quickRanges().map((q) => (
            <button key={q.label} onClick={() => applyQuick(q.label, q.start, q.end)}
              style={{ padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, border: `1.4px solid ${activeQuick === q.label ? '#1f8577' : '#e4ddd1'}`, background: activeQuick === q.label ? '#eef7f6' : '#fff', color: activeQuick === q.label ? '#1f8577' : '#5c6567', cursor: 'pointer' }}>
              {q.label}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <input type="date" value={dateRange.start} onChange={(e) => setDateRange((p) => ({ ...p, start: e.target.value }))} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e4ddd1', fontSize: 11 }} />
            <input type="date" value={dateRange.end} onChange={(e) => setDateRange((p) => ({ ...p, end: e.target.value }))} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e4ddd1', fontSize: 11 }} />
          </div>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
          {kpis.map((k, i) => (
            <div key={i} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k.label}</p>
              <p style={{ margin: '6px 0 0', fontSize: 18, fontWeight: 700, color: '#23282A' }}>{fmtValue(k.value, k.fmt)}</p>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 20 }}>
          {(reportType === 'IncomeStatement' || reportType === 'CashFlow') && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Revenue vs Expenses</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={revenueVsExpenseData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#1f8577" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {reportType === 'IncomeStatement' && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Expense Breakdown</h3>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={expenseBreakdown} dataKey="value" nameKey="name" outerRadius={80} label>
                    {expenseBreakdown.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          {(reportType === 'AgedAR' || reportType === 'AgedAP') && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Aging Distribution</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={agingBuckets}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {reportType === 'BalanceSheet' && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Assets vs Liabilities</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={[{ name: 'Assets', value: totalAssets }, { name: 'Liabilities', value: totalLiab }, { name: 'Equity', value: totalEquity }]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#10b981" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {reportType === 'Budget' && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Actual vs Budget</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={[{ name: 'Actual', value: totalExp }, { name: 'Budget', value: kpis[0]?.value || 0 }]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Preview grid */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e4ddd1', padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#23282A' }}>Preview</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#5c6567' }}>Click "Generate PDF" to open the full report preview. Use Excel/Print for export.</p>
          {reportType === 'TrialBalance' && trial && (
            <div style={{ marginTop: 12, maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: '#f4f1ea' }}><th style={{ textAlign: 'left', padding: 6 }}>Account</th><th style={{ textAlign: 'right', padding: 6 }}>Debit</th><th style={{ textAlign: 'right', padding: 6 }}>Credit</th></tr></thead>
                <tbody>
                  {trial.lines.slice(0, 30).map((l: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f4f1ea' }}>
                      <td style={{ padding: 6 }}>{l.accountName}</td>
                      <td style={{ textAlign: 'right', padding: 6 }}>{l.totalDebit > 0 ? l.totalDebit.toFixed(2) : '-'}</td>
                      <td style={{ textAlign: 'right', padding: 6 }}>{l.totalCredit > 0 ? l.totalCredit.toFixed(2) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(reportType === 'AgedAR' || reportType === 'AgedAP') && agedData && (
            <div style={{ marginTop: 12, maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: '#f4f1ea' }}><th style={{ textAlign: 'left', padding: 6 }}>Name</th><th style={{ textAlign: 'right', padding: 6 }}>Balance</th></tr></thead>
                <tbody>
                  {agedData.items.sort((a: any, b: any) => b.balance - a.balance).slice(0, 20).map((i: any, idx: number) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #f4f1ea' }}>
                      <td style={{ padding: 6 }}>{i.customerName || i.supplierId || 'Unknown'}</td>
                      <td style={{ textAlign: 'right', padding: 6 }}>{(i.balance || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FiscalReportWorkspace;
export { ReportType };
