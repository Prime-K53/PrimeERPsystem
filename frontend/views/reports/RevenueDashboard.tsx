import React, { useEffect, useMemo, useState } from 'react';
import {useData, REFRESH_INTERVAL } from '../../context/DataContext';
import { useAuth } from '../../context/AuthContext';
import { useSales } from '../../context/SalesContext';
import { useFinance } from '../../context/FinanceContext';
import { useOrders } from '../../context/OrdersContext';
import { useExamination } from '../../context/ExaminationContext';
import { useModuleRefresh } from '../../hooks/useModuleRefresh';
import {
  Activity, AlertTriangle, Coins, DollarSign, Layers3, Receipt, TrendingDown, TrendingUp, Users, Wallet, } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis} from 'recharts';
import { ResponsiveContainer } from '@/components/charts/ResponsiveContainer';

import { getRevenueSourceLabel } from '../../services/revenueAnalysisService';
import {
  buildRevenueReportingSnapshot, resolveRevenueWindow,
  type RevenueDateRange,
} from '../../services/revenueReportingService';
import { reconcileRevenueToGl, sumPostedExpenseDebits, sumPostedIncomeCredits } from '../../utils/glReconciliation';
import { invoiceRevenueSign, isRecognizedInvoiceStatus } from '../../utils/revenueRecognition';
import { currencyService } from '../../services/currencyService';

const teal = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a' };
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';

const cardBase: React.CSSProperties = { background: '#FEFDFB', borderRadius: 14, border: `1.4px solid ${hairline}`, boxShadow: '0 1px 3px rgba(0,0,0,.04)' };
const cardPad: React.CSSProperties = { ...cardBase, padding: 24 };

const TREND_TITLES: Record<string, string> = {
  day: 'Daily', week: 'Weekly', month: 'Monthly',
};

const RevenueDashboard: React.FC = () => {
  const { companyConfig } = useAuth();
  const { sales = [], isLoading } = useSales();
  const { invoices = [], expenses = [], ledger = [], accounts = [] } = useFinance();
  const { orders = [] } = useOrders();
  const { batches: examinationBatches = [] } = useExamination();
  const { refreshAllData } = useData();

  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const loadData = async () => { setIsRefreshing(true); await refreshAllData?.(); setIsRefreshing(false); };
    loadData();
  }, []);

  useModuleRefresh(refreshAllData, { interval: REFRESH_INTERVAL });

  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
  const [dateRange, setDateRange] = useState<RevenueDateRange>('month');

  const formatCurrency = (value: number) =>
    `${currency}${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const report = useMemo(() =>
    buildRevenueReportingSnapshot({ sales, invoices, orders, batches: examinationBatches, dateRange, trendDays: 7 }),
    [sales, invoices, orders, examinationBatches, dateRange]);

  const inWindow = useMemo(
    () => (date: unknown) => {
      const { start, end } = resolveRevenueWindow(dateRange);
      if (!start) return true;
      const parsed = new Date(String(date || ''));
      if (!Number.isFinite(parsed.getTime())) return false;
      return parsed >= start && parsed <= end;
    },
    [dateRange]
  );

  /**
   * Operating expenses come from the POSTED LEDGER, not the `expenses` table.
   * The table both misses everything posted by other paths (payroll, wages,
   * supplier payments) and includes rows still awaiting approval that never
   * reached the GL — which is how "Operating Expenses K0.00" sat under a real
   * ledger while "Net Contribution" quietly reported gross profit.
   */
  const ledgerExpenses = useMemo(() =>
    sumPostedExpenseDebits(ledger as any[], accounts as any[], inWindow),
    [ledger, accounts, inWindow]);

  const unpostedExpenseDocs = useMemo(() =>
    (expenses || []).filter((expense: any) => inWindow(expense?.date)).length,
    [expenses, inWindow]);

  /**
   * AR is a point-in-time balance, not a period flow: an invoice raised six
   * months ago and still unpaid is exposure today. Filtering it by the selected
   * window hid most of the book and made "Outstanding AR" look reconciled when
   * it was not. Credit notes are excluded — they reduce AR and would otherwise
   * be counted as new receivables.
   */
  const outstandingReceivables = useMemo(() => {
    let amount = 0;
    let count = 0;
    (invoices || []).forEach((invoice: any) => {
      if (!isRecognizedInvoiceStatus(invoice?.status)) return;
      if (invoiceRevenueSign(invoice) !== 1) return;
      const total = Number(invoice?.totalAmount ?? invoice?.total ?? 0);
      const paid = Number(invoice?.paidAmount ?? 0);
      const open = Math.max(0, total - paid);
      if (open <= 0.0001) return;
      amount += open;
      count += 1;
    });
    return { amount, count };
  }, [invoices]);

  // Phase 5 / C1: GL reconciliation — posted income credits vs recognized
  // document revenue (same PL-01 identity as run_reporting_reconciliation).
  const glReconciliation = useMemo(() => {
    const gl = sumPostedIncomeCredits(ledger as any[], accounts as any[], inWindow);
    return { ...reconcileRevenueToGl(report.totals.revenue, gl.glRevenue), ...gl };
  }, [ledger, accounts, report.totals.revenue, inWindow]);

  const operatingExpenses = ledgerExpenses.glExpenses;
  const grossProfit = report.totals.profitMargin;
  const netContribution = grossProfit - operatingExpenses;

  const coverage = report.coverage;
  const windowLabel = report.windowStart ? `${report.windowStart} → ${report.windowEnd}` : `All time → ${report.windowEnd}`;

  /**
   * Only MATERIAL omissions belong in the alert banner. Draft/cancelled/void
   * exclusions are correct accounting, not a defect — putting them here taught
   * the reader to ignore the banner that actually matters.
   */
  const coverageWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (coverage.documentsExcludedAsDuplicate > 0) {
      warnings.push(`${coverage.documentsExcludedAsDuplicate} POS mirror invoice(s) suppressed — the POS sale already carries that revenue.`);
    }
    if (coverage.undatedDocuments > 0 && dateRange !== 'all') {
      warnings.push(`${coverage.undatedDocuments} document(s) worth ${formatCurrency(coverage.undatedRevenue)} have no usable date and sit outside this window — fix their dates in Sales.`);
    }
    if (!glReconciliation.withinTolerance) {
      warnings.push(`The ledger holds ${formatCurrency(glReconciliation.glRevenue)} of income against ${formatCurrency(report.totals.revenue)} of documents. That ${formatCurrency(glReconciliation.delta)} gap is revenue the ledger recorded and this view did not — reconcile it before trusting any figure below.`);
    }
    if (operatingExpenses === 0 && unpostedExpenseDocs > 0) {
      warnings.push(`${unpostedExpenseDocs} expense record(s) in this window were never posted to the ledger, so they are excluded here.`);
    }
    return warnings;
  }, [coverage, dateRange, glReconciliation, operatingExpenses, unpostedExpenseDocs, report.totals.revenue]);

  const kpis = [
    {
      label: 'Recognized Revenue',
      value: formatCurrency(report.totals.revenue),
      subtext: `${report.totals.transactionCount} document(s) · ${windowLabel} · ${coverage.documentsExcludedByStatus} draft/void excluded`,
      icon: TrendingUp, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    },
    {
      label: 'Material Cost',
      value: formatCurrency(report.totals.materialCost),
      subtext: report.totals.revenue > 0
        ? `${((report.totals.materialCost / report.totals.revenue) * 100).toFixed(1)}% of revenue`
        : 'No revenue in range',
      icon: Layers3, border: inkSoft, iconBg: teal[50], iconColor: inkSoft, textColor: ink,
    },
    {
      label: 'Gross Profit',
      value: formatCurrency(grossProfit),
      subtext: report.totals.revenue > 0
        ? `${((grossProfit / report.totals.revenue) * 100).toFixed(1)}% gross margin — revenue less material cost`
        : 'No revenue in range',
      icon: DollarSign,
      border: grossProfit >= 0 ? teal[600] : '#b5493f',
      iconBg: teal[50], iconColor: teal[600], textColor: teal[700],
    },
    {
      label: 'Outstanding AR',
      value: formatCurrency(outstandingReceivables.amount),
      subtext: `${outstandingReceivables.count} open invoice(s) — all time, not this window`,
      icon: Wallet, border: '#d99a3f', iconBg: '#fbead0', iconColor: '#d99a3f', textColor: '#d99a3f',
    },
    {
      label: 'GL Reconciliation',
      value: `${glReconciliation.delta >= 0 ? '+' : ''}${formatCurrency(glReconciliation.delta)}`,
      subtext: glReconciliation.withinTolerance
        ? `GL agrees within ${formatCurrency(glReconciliation.tolerance)} (${glReconciliation.entryCount} income credits)`
        : `Ledger ${formatCurrency(glReconciliation.glRevenue)} vs documents ${formatCurrency(glReconciliation.documentRevenue)} — tolerance ${formatCurrency(glReconciliation.tolerance)}`,
      icon: Receipt,
      border: glReconciliation.withinTolerance ? teal[600] : '#b5493f',
      iconBg: glReconciliation.withinTolerance ? teal[50] : '#fef0ee',
      iconColor: glReconciliation.withinTolerance ? teal[600] : '#b5493f',
      textColor: glReconciliation.withinTolerance ? teal[700] : '#b5493f',
    },
  ];

  /**
   * Adjustment and rounding tiles carried no information at K0.00 — two of nine
   * KPI slots spent restating "nothing happened". They now only appear when there
   * is something to say.
   */
  const conditionalKpis = [
    ...(report.totals.adjustmentTotal !== 0 ? [{
      label: 'Market Adjustments',
      value: formatCurrency(report.totals.adjustmentTotal),
      subtext: `${report.topAdjustments.length} adjustment type(s) applied`,
      icon: Coins, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    }] : []),
    ...(report.totals.roundingTotal !== 0 ? [{
      label: 'Round Up / Down',
      value: `${report.totals.roundingTotal >= 0 ? '+' : ''}${formatCurrency(report.totals.roundingTotal)}`,
      subtext: 'Net rounding effect',
      icon: Activity, border: teal[600], iconBg: teal[50], iconColor: teal[600], textColor: teal[700],
    }] : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '16px 24px', maxWidth: 1600, margin: '0 auto', fontFamily: "'Inter',sans-serif", fontSize: 13, color: ink }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: ink, margin: 0, letterSpacing: -0.02 }}>Revenue Analysis</h2>
            <p style={{ fontSize: 13, color: inkSoft, fontWeight: 500, margin: '2px 0 0' }}>Unified tracking for sales, order-form invoices, and examination billing.</p>
          </div>
          <div style={{ display: 'flex', gap: 2, background: '#FEFDFB', padding: 3, borderRadius: 12, border: `1.4px solid ${hairline}`, boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
            {(['week', 'month', 'quarter', 'year', 'all'] as const).map((range) => (
              <button key={range} onClick={() => setDateRange(range)}
                style={{ padding: '6px 12px', borderRadius: 9, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', background: dateRange === range ? `linear-gradient(155deg, ${teal[500]}, ${teal[700]})` : 'transparent', color: dateRange === range ? '#fff' : inkSoft, boxShadow: dateRange === range ? `0 4px 10px -4px rgba(15,84,76,.4)` : 'none' }}>
                {range.charAt(0).toUpperCase() + range.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {[...kpis, ...conditionalKpis].map((kpi) => {
            const Icon = kpi.icon;
            return (
              <div key={kpi.label} style={{ background: '#FEFDFB', padding: '12px 16px', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.04)', border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${kpi.border}`, display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ padding: 10, borderRadius: 9, background: kpi.iconBg, color: kpi.iconColor, flexShrink: 0 }}>
                  <Icon size={20} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: -0.01, margin: '0 0 4px' }}>{kpi.label}</p>
                  <p style={{ fontSize: 18, fontWeight: 600, color: kpi.textColor, margin: 0 }}>{kpi.value}</p>
                  <p style={{ fontSize: 10, color: inkSoft, margin: '2px 0 0' }}>{kpi.subtext}</p>
                </div>
              </div>
            );
          })}
        </div>

        {(isLoading || isRefreshing || coverageWarnings.length > 0) && (
          <div style={{ background: '#FEFDFB', border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${coverageWarnings.length > 0 ? '#d99a3f' : teal[500]}`, borderRadius: 12, padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {coverageWarnings.length > 0 && (
              <div style={{ color: '#d99a3f', flexShrink: 0, marginTop: 1 }}><AlertTriangle size={18} /></div>
            )}
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: ink, margin: '0 0 4px' }}>
                {coverageWarnings.length > 0 ? 'These figures are incomplete — read before acting on them' : 'Loading revenue records…'}
              </p>
              {coverageWarnings.map((warning) => (
                <p key={warning} style={{ fontSize: 11.5, color: inkSoft, margin: '2px 0 0' }}>• {warning}</p>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ background: `linear-gradient(135deg, ${teal[800]}, ${teal[900]})`, padding: 20, borderRadius: 14, boxShadow: `0 8px 24px -8px rgba(11,62,57,.4)`, color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: teal[100], letterSpacing: 0.06, textTransform: 'uppercase', margin: 0 }}>Operating Expenses</p>
              <h3 style={{ fontSize: 24, fontWeight: 900, margin: '4px 0 0' }}>{formatCurrency(operatingExpenses)}</h3>
              <p style={{ fontSize: 11, color: teal[100], fontWeight: 500, margin: '4px 0 0' }}>
                Posted to the ledger in this window · {ledgerExpenses.entryCount} entr{(ledgerExpenses.entryCount === 1 ? 'y' : 'ies')}
              </p>
            </div>
            <div style={{ padding: 12, background: 'rgba(255,255,255,.1)', borderRadius: 12 }}>
              <TrendingDown size={22} />
            </div>
          </div>
        </div>
        <div style={{ background: `linear-gradient(135deg, ${teal[600]}, ${teal[800]})`, padding: 20, borderRadius: 14, boxShadow: `0 8px 24px -8px rgba(11,62,57,.4)`, color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: teal[100], letterSpacing: 0.06, textTransform: 'uppercase', margin: 0 }}>Net Contribution</p>
              <h3 style={{ fontSize: 24, fontWeight: 900, margin: '4px 0 0' }}>{formatCurrency(netContribution)}</h3>
              <p style={{ fontSize: 11, color: teal[100], fontWeight: 500, margin: '4px 0 0' }}>
                {formatCurrency(grossProfit)} gross profit less {formatCurrency(operatingExpenses)} posted operating expenses
              </p>
            </div>
            <div style={{ padding: 12, background: 'rgba(255,255,255,.15)', borderRadius: 12 }}>
              <Receipt size={22} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp size={18} style={{ color: teal[500] }} /> {TREND_TITLES[report.trendBucket]} Revenue vs Gross Profit ({windowLabel})
          </h3>
          <div style={{ width: '100%', height: 280, minHeight: 180 }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={0}>
              <AreaChart data={report.trend}>
                <defs>
                  <linearGradient id="trendRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={teal[500]} stopOpacity={0.28} /><stop offset="95%" stopColor={teal[500]} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="trendMargin" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={teal[200]} stopOpacity={0.24} /><stop offset="95%" stopColor={teal[200]} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={teal[50]} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} tickFormatter={(value) => `${currency}${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                <Tooltip formatter={(value: number) => [formatCurrency(value), '']} contentStyle={{ borderRadius: 12, border: `1.4px solid ${hairline}`, fontSize: 12 }} />
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke={teal[500]} strokeWidth={2} fill="url(#trendRevenue)" />
                <Area type="monotone" dataKey="profitMargin" name="Gross Profit" stroke={teal[200]} strokeWidth={2} fill="url(#trendMargin)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Users size={18} style={{ color: teal[500] }} /> Top Customers
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {report.customers.slice(0, 6).map((customer, index) => (
              <div key={`${customer.customerName}-${index}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, background: teal[50], borderRadius: 12 }}>
                <div>
                  <p style={{ fontWeight: 600, color: ink, fontSize: 13, margin: 0 }}>{customer.customerName}</p>
                  <p style={{ fontSize: 11, color: inkSoft, margin: 0 }}>{customer.transactionCount} transaction(s)</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontWeight: 700, color: ink, margin: 0, fontSize: 13 }}>{formatCurrency(customer.revenue)}</p>
                  <p style={{ fontSize: 11, color: teal[600], fontWeight: 500, margin: 0 }}>{formatCurrency(customer.profitMargin)} gross profit</p>
                </div>
              </div>
            ))}
            {report.customers.length === 0 && (<div style={{ textAlign: 'center', color: inkSoft, padding: 40, fontSize: 13 }}>No revenue records available for this range.</div>)}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={18} style={{ color: teal[500] }} /> Revenue by Source
          </h3>
          <div style={{ width: '100%', height: 250, minHeight: 180 }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={0}>
              <BarChart data={report.sources.map((source) => ({ ...source, label: getRevenueSourceLabel(source.source) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke={teal[50]} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} tickFormatter={(value) => `${currency}${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                <Tooltip formatter={(value: number) => [formatCurrency(value), '']} contentStyle={{ borderRadius: 12, border: `1.4px solid ${hairline}`, fontSize: 12 }} />
                <Bar dataKey="revenue" name="Revenue" fill={teal[500]} radius={[6, 6, 0, 0]} />
                <Bar dataKey="profitMargin" name="Gross Profit" fill={teal[200]} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Coins size={18} style={{ color: teal[500] }} /> Adjustment Ledger
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {report.topAdjustments.slice(0, 6).map((adjustment) => (
              <div key={`${adjustment.source}-${adjustment.adjustmentName}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, background: teal[50], borderRadius: 12, border: `1.4px solid ${teal[100]}` }}>
                <div>
                  <p style={{ fontWeight: 600, color: ink, fontSize: 13, margin: 0 }}>{adjustment.adjustmentName}</p>
                  <p style={{ fontSize: 11, color: inkSoft, margin: 0 }}>{getRevenueSourceLabel(adjustment.source)} · {adjustment.transactionCount} transaction(s)</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontWeight: 700, color: teal[700], margin: 0, fontSize: 13 }}>{formatCurrency(adjustment.totalAmount)}</p>
                  <p style={{ fontSize: 11, color: inkSoft, margin: 0 }}>{adjustment.applicationCount} application(s)</p>
                </div>
              </div>
            ))}
            {report.topAdjustments.length === 0 && (<div style={{ textAlign: 'center', color: inkSoft, padding: 40, fontSize: 13 }}>No adjustment entries captured in this range.</div>)}
          </div>
        </div>
      </div>

      <div style={{ ...cardBase, overflow: 'hidden' }}>
        <div style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Receipt size={18} style={{ color: inkSoft }} /> Source Summary
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: `1.4px solid ${teal[100]}`, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                  <th style={{ padding: '12px 16px' }}>Source</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Transactions</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Revenue</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Adjustments</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Gross Profit</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Manual Override</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Rounding</th>
                </tr>
              </thead>
              <tbody>
                {report.sources.map((source) => (
                  <tr key={source.source} style={{ borderBottom: `1.4px solid ${teal[50]}` }}
                    onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: ink }}>{getRevenueSourceLabel(source.source)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: inkSoft }}>{source.transactionCount}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: ink }}>{formatCurrency(source.revenue)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: teal[700] }}>{formatCurrency(source.adjustmentTotal)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: teal[600] }}>{formatCurrency(source.profitMargin)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: source.manualOverrideAmount >= 0 ? '#d99a3f' : '#b5493f' }}>
                      {source.manualOverrideAmount >= 0 ? '+' : ''}{formatCurrency(source.manualOverrideAmount)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: source.roundingTotal >= 0 ? teal[600] : '#b5493f' }}>
                      {source.roundingTotal >= 0 ? '+' : ''}{formatCurrency(source.roundingTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ ...cardBase, overflow: 'hidden' }}>
        <div style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Receipt size={18} style={{ color: inkSoft }} /> Recent Revenue Transactions
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: `1.4px solid ${teal[100]}`, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                  <th style={{ padding: '12px 16px' }}>Document</th>
                  <th style={{ padding: '12px 16px' }}>Source</th>
                  <th style={{ padding: '12px 16px' }}>Customer</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Revenue</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Adjustments</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Gross Profit</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Manual Override</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Rounding</th>
                </tr>
              </thead>
              <tbody>
                {report.transactions.slice(0, 8).map((transaction) => (
                  <tr key={transaction.key} style={{ borderBottom: `1.4px solid ${teal[50]}` }}
                    onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600, color: ink }}>{transaction.transactionNumber}</div>
                      <div style={{ fontSize: 11, color: inkSoft }}>
                        {new Date(transaction.date).toLocaleDateString()}{transaction.subAccountName ? ` · ${transaction.subAccountName}` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', color: inkSoft }}>{getRevenueSourceLabel(transaction.source)}</td>
                    <td style={{ padding: '12px 16px', color: ink }}>{transaction.customerName}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: ink }}>{formatCurrency(transaction.revenue)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: teal[700] }}>{formatCurrency(transaction.adjustmentTotal)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: teal[600] }}>{formatCurrency(transaction.profitMargin)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: transaction.manualOverrideAmount >= 0 ? '#d99a3f' : '#b5493f' }}>
                      {transaction.manualOverrideAmount >= 0 ? '+' : ''}{formatCurrency(transaction.manualOverrideAmount)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: transaction.roundingTotal >= 0 ? teal[600] : '#b5493f' }}>
                      {transaction.roundingTotal >= 0 ? '+' : ''}{formatCurrency(transaction.roundingTotal)}
                    </td>
                  </tr>
                ))}
                {report.transactions.length === 0 && (<tr><td colSpan={8} style={{ padding: 48, textAlign: 'center', color: inkSoft }}>No revenue transactions found for the selected range.</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RevenueDashboard;