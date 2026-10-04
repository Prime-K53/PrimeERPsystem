import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, Coins, Download, PiggyBank,
  Scale, TrendingUp, Wallet,
} from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/charts/ResponsiveContainer';
import { format as formatDate } from 'date-fns';

import { transportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../../types/transportBudget';
import {
  bucketTransportBudgetByPeriod,
  sumTransportBudgetEvents,
  summarizeTransportBudgetByKind,
  type TransportBudgetPeriodGranularity,
} from '../../services/transportBudgetKpis';
import {
  resolveRevenueWindow,
  type RevenueDateRange,
} from '../../services/revenueReportingService';
import { reportExportService } from '../../services/reportExportService';
import type { ReportResult } from '../../types/reports';
import { currencyService } from '../../services/currencyService';

const teal = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a' };
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';

const cardPad: React.CSSProperties = { background: '#FEFDFB', borderRadius: 14, border: `1.4px solid ${hairline}`, boxShadow: '0 1px 3px rgba(0,0,0,.04)', padding: 24 };

const GRANULARITY_FOR_RANGE: Record<RevenueDateRange, TransportBudgetPeriodGranularity> = {
  week: 'week',
  month: 'week',
  quarter: 'month',
  year: 'month',
  all: 'year',
};

const toWindowBounds = (dateRange: RevenueDateRange): { from?: string; to?: string } => {
  const { start, end } = resolveRevenueWindow(dateRange);
  const bounds: { from?: string; to?: string } = {};
  if (start) bounds.from = formatDate(start, 'yyyy-MM-dd');
  if (end) bounds.to = formatDate(end, 'yyyy-MM-dd');
  return bounds;
};

const TransportBudgetDashboard: React.FC = () => {
  const { companyConfig } = useAuth();
  const [events, setEvents] = useState<TransportBudgetEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [dateRange, setDateRange] = useState<RevenueDateRange>('month');
  const [error, setError] = useState<string | null>(null);

  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { from, to } = toWindowBounds(dateRange);
        const rows = await transportBudgetRepository.listTransportBudgetEvents({
          ...(from ? { fromBusinessDate: from } : {}),
          ...(to ? { toBusinessDate: to } : {}),
        });
        if (!cancelled) setEvents(rows || []);
      } catch (err) {
        if (!cancelled) {
          setEvents([]);
          setError('Failed to load transport budget data. Please try again.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dateRange]);

  const totals = useMemo(() => sumTransportBudgetEvents(events), [events]);
  const byKind = useMemo(() => summarizeTransportBudgetByKind(events), [events]);
  const granularity = GRANULARITY_FOR_RANGE[dateRange];
  const buckets = useMemo(
    () => bucketTransportBudgetByPeriod(events, granularity),
    [events, granularity],
  );

  // Validate chart data
  const chartData = buckets.length > 0 ? buckets : [];
  const hasValidChartData = chartData.some(bucket => 
    bucket.accumulated !== 0 || bucket.used !== 0 || bucket.net !== 0
  );

  const { start } = resolveRevenueWindow(dateRange);
  const windowLabel = start
    ? `${formatDate(start, 'd MMM yyyy')} → ${formatDate(new Date(), 'd MMM yyyy')}`
    : 'All time';

  const formatCurrency = (value: number) =>
    `${currency}${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const kpis = [
    {
      label: 'Accumulated',
      value: isLoading ? '…' : formatCurrency(totals.accumulated),
      subtext: 'Net allocation after sales reversals',
      icon: PiggyBank, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    },
    {
      label: 'Used',
      value: isLoading ? '…' : formatCurrency(totals.used),
      subtext: 'Net transport consumption in window',
      icon: TrendingUp, border: inkSoft, iconBg: teal[50], iconColor: inkSoft, textColor: ink,
    },
    {
      label: 'Remaining',
      value: isLoading ? '…' : formatCurrency(totals.remaining),
      subtext: `${totals.eventCount} event(s) · ${windowLabel}`,
      icon: Scale,
      border: totals.remaining >= 0 ? teal[600] : '#b5493f',
      iconBg: totals.remaining >= 0 ? teal[50] : '#fef0ee',
      iconColor: totals.remaining >= 0 ? teal[600] : '#b5493f',
      textColor: totals.remaining >= 0 ? teal[700] : '#b5493f',
    },
    {
      label: 'Inbound Used',
      value: isLoading ? '…' : formatCurrency(totals.inboundUsed),
      subtext: 'Inbound consumption net of corrections',
      icon: ArrowDownToLine, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    },
    {
      label: 'Outbound Used',
      value: isLoading ? '…' : formatCurrency(totals.outboundUsed),
      subtext: 'Outbound consumption net of reversals',
      icon: ArrowUpFromLine, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    },
    {
      label: 'Corrections',
      value: isLoading ? '…' : `${totals.corrections >= 0 ? '+' : ''}${formatCurrency(totals.corrections)}`,
      subtext: 'Consumption corrections restoring budget',
      icon: Coins, border: teal[600], iconBg: teal[50], iconColor: teal[600], textColor: teal[700],
    },
    {
      label: 'Reversals',
      value: isLoading ? '…' : formatCurrency(totals.reversals),
      subtext: 'Sales + consumption reversals',
      icon: Wallet, border: '#d99a3f', iconBg: '#fbead0', iconColor: '#d99a3f', textColor: '#d99a3f',
    },
  ];

  const handleExport = async () => {
    if (isLoading || events.length === 0) return;
    
    setIsExporting(true);
    try {
      const startedAt = Date.now();
      const result: ReportResult = {
        id: `transport-budget-${dateRange}-${startedAt}`,
        reportDefinitionId: 'transport-budget',
        reportName: `Transport Budget (${windowLabel})`,
        generatedAt: new Date(),
        generatedBy: 'transport-budget-dashboard',
        executionTimeMs: Date.now() - startedAt,
        totalRows: buckets.length,
        page: 1,
        pageSize: Math.max(buckets.length, 1),
        totalPages: 1,
        columns: [
          { id: 'period', field: 'period', label: 'Period', type: 'string' },
          { id: 'accumulated', field: 'accumulated', label: 'Accumulated', type: 'currency', alignment: 'right' },
          { id: 'used', field: 'used', label: 'Used', type: 'currency', alignment: 'right' },
          { id: 'net', field: 'net', label: 'Net', type: 'currency', alignment: 'right' },
          { id: 'events', field: 'events', label: 'Events', type: 'number', alignment: 'right' },
        ],
        rows: buckets.map((bucket) => ({
          period: bucket.label,
          accumulated: bucket.accumulated,
          used: bucket.used,
          net: bucket.net,
          events: bucket.count,
        })),
        summary: {
          accumulated: totals.accumulated,
          used: totals.used,
          remaining: totals.remaining,
          inboundUsed: totals.inboundUsed,
          outboundUsed: totals.outboundUsed,
          corrections: totals.corrections,
          reversals: totals.reversals,
          eventCount: totals.eventCount,
          window: windowLabel,
        },
      };
      await reportExportService.exportReport(result, {
        format: 'csv',
        fileName: `transport-budget-${dateRange}`,
      });
    } catch (err) {
      console.error('Export failed:', err);
      // You could add a toast notification here if you have a toast system
    } finally {
      setIsExporting(false);
    }
  };

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '16px 24px', maxWidth: 1600, margin: '0 auto', fontFamily: "'Inter',sans-serif", fontSize: 13, color: ink }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700, color: ink, margin: 0, letterSpacing: -0.02 }}>Transport Budget</h2>
              <p style={{ fontSize: 13, color: inkSoft, fontWeight: 500, margin: '2px 0 0' }}>
                Internal management ledger — accumulated, used, and remaining budget. Never customer-visible.
              </p>
            </div>
          </div>
          <div style={{ background: '#fef0ee', border: `1.4px solid #b5493f`, borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 24, height: 24, borderRadius: 50, background: '#fef0ee', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b5493f" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#b5493f', margin: 0 }}>Error Loading Data</p>
                <p style={{ fontSize: 13, color: inkSoft, margin: '4px 0 0' }}>{error}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '16px 24px', maxWidth: 1600, margin: '0 auto', fontFamily: "'Inter',sans-serif", fontSize: 13, color: ink }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: ink, margin: 0, letterSpacing: -0.02 }}>Transport Budget</h2>
            <p style={{ fontSize: 13, color: inkSoft, fontWeight: 500, margin: '2px 0 0' }}>
              Internal management ledger — accumulated, used, and remaining budget. Never customer-visible.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={handleExport}
              disabled={isExporting || isLoading || events.length === 0}
              style={{
                padding: '6px 12px', borderRadius: 9, fontSize: 12, fontWeight: 600,
                border: `1.4px solid ${hairline}`, cursor: isExporting ? 'not-allowed' : 'pointer',
                background: '#FEFDFB', color: inkSoft, display: 'flex', alignItems: 'center', gap: 6,
                opacity: (isExporting || isLoading || events.length === 0) ? 0.6 : 1,
              }}
            >
              <Download size={13} /> {isExporting ? 'Exporting…' : events.length === 0 ? 'No Data' : 'Export CSV'}
            </button>
            <div style={{ display: 'flex', gap: 2, background: '#FEFDFB', padding: 3, borderRadius: 12, border: `1.4px solid ${hairline}`, boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
              {(['week', 'month', 'quarter', 'year', 'all'] as const).map((range) => (
                <button key={range} onClick={() => setDateRange(range)}
                  style={{ padding: '6px 12px', borderRadius: 9, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', background: dateRange === range ? `linear-gradient(155deg, ${teal[500]}, ${teal[700]})` : 'transparent', color: dateRange === range ? '#fff' : inkSoft, boxShadow: dateRange === range ? `0 4px 10px -4px rgba(15,84,76,.4)` : 'none' }}>
                  {range.charAt(0).toUpperCase() + range.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {kpis.map((kpi) => {
            const Icon = kpi.icon;
            return (
              <div key={kpi.label} style={{ background: '#FEFDFB', padding: '12px 16px', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.04)', border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${kpi.border}`, display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ padding: 10, borderRadius: 9, background: kpi.iconBg, color: kpi.iconColor, flexShrink: 0 }}>
                  <Icon size={20} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: -0.01, margin: '0 0 4px' }}>{kpi.label}</p>
                  <p style={{ fontSize: 18, fontWeight: 600, color: kpi.textColor, margin: 0, fontVariantNumeric: 'tabular-nums' }}>{isLoading ? '…' : kpi.value}</p>
                  <p style={{ fontSize: 10, color: inkSoft, margin: '2px 0 0' }}>{kpi.subtext}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={18} style={{ color: teal[500] }} /> Budget Net per {granularity === 'year' ? 'Year' : granularity === 'month' ? 'Month' : 'Week'} ({windowLabel})
          </h3>
          <div style={{ width: '100%', height: 280, minHeight: 180 }}>
            {hasValidChartData ? (
              <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={0}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="trendBudgetNet" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={teal[500]} stopOpacity={0.28} /><stop offset="95%" stopColor={teal[500]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={teal[50]} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: inkSoft }} axisLine={false} tickLine={false} tickFormatter={(value: number) => `${currency}${value >= 1000 || value <= -1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                  <Tooltip formatter={(value: number) => [formatCurrency(value), '']} contentStyle={{ borderRadius: 12, border: `1.4px solid ${hairline}`, fontSize: 12 }} />
                  <Area type="monotone" dataKey="net" name="Net" stroke={teal[500]} strokeWidth={2} fill="url(#trendBudgetNet)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 180, background: '#FEFDFB', border: `1.4px solid ${hairline}`, borderRadius: 12 }}>
                <div style={{ width: 48, height: 48, borderRadius: 50, background: teal[50], display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                  <Activity size={24} style={{ color: teal[500] }} />
                </div>
                <p style={{ textAlign: 'center', color: inkSoft, fontSize: 13, margin: 0 }}>
                  {isLoading ? 'Loading budget data...' : 'No budget activity to display'}
                </p>
                {!isLoading && (
                  <p style={{ textAlign: 'center', color: inkSoft, fontSize: 11, margin: '4px 0 0' }}>
                    Transport budget events will appear here once recorded
                  </p>
                )}
              </div>
            )}
          </div>
          {buckets.length === 0 && !isLoading && (
            <div style={{ textAlign: 'center', color: inkSoft, padding: 24, fontSize: 13 }}>
              No transport budget events in this range.
            </div>
          )}
        </div>
        <div style={cardPad}>
          <h3 style={{ fontWeight: 700, color: ink, fontSize: 13, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wallet size={18} style={{ color: teal[500] }} /> By Event Kind
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {byKind.map((row) => (
              <div key={row.kind} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, background: teal[50], borderRadius: 12 }}>
                <div>
                  <p style={{ fontWeight: 600, color: ink, fontSize: 12, margin: 0 }}>{row.kind}</p>
                  <p style={{ fontSize: 11, color: inkSoft, margin: 0 }}>{row.count} event(s)</p>
                </div>
                <p style={{ fontWeight: 700, color: row.total < 0 ? '#b5493f' : ink, margin: 0, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                  {row.total < 0 ? '−' : ''}{formatCurrency(Math.abs(row.total))}
                </p>
              </div>
            ))}
            {byKind.every((row) => row.count === 0) && !isLoading && (
              <div style={{ textAlign: 'center', color: inkSoft, padding: 24, fontSize: 13 }}>
                <div style={{ width: 48, height: 48, borderRadius: 50, background: teal[50], display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                  <Wallet size={24} style={{ color: teal[500] }} />
                </div>
                No events recorded yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TransportBudgetDashboard;
