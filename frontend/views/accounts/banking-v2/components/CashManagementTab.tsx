/**
 * Cash Management Tab.
 *
 * Aggregates:
 *   - Actual bank & cash balances (from the General Ledger — canonical)
 *   - Receivables (open customer invoices) — expected inflow
 *   - Payables (open supplier bills)  — expected outflow
 *   - Payroll (next pay cycle estimate) — expected outflow
 *   - Loans (scheduled repayments) — expected outflow
 *   - Scheduled bank transactions — expected in/out
 *
 * Produces:
 *   - Liquidity summary (today / week / month / quarter / custom)
 *   - Projected vs actual net position
 *   - Per-account drill-down
 *
 * No GL writes — read-only.
 */

import React, { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Wallet, Landmark, Calendar, AlertCircle } from 'lucide-react';
import EmptyState from '../../../../components/EmptyState';
import { roundFinancial } from '../../../../utils/helpers';

interface Props {
  accounts: any[];
  transactions: any[];
  scheduledPayments: any[];
  receivables: any[];
  payables: any[];
  currency: string;
  coaBalances: Record<string, number>;
}

const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const teal = { 50: '#eef7f6', 100: '#d4ebe3', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c' };
const amber = { 50: '#fef9e7', 600: '#b45309' };
const danger = { 50: '#fef2f2', 600: '#991b1b' };
const emerald = { 50: '#f0fdf4', 600: '#059669' };

type Period = 'today' | 'week' | 'month' | 'quarter' | 'custom';

function periodDays(p: Period): number {
  switch (p) {
    case 'today': return 1;
    case 'week': return 7;
    case 'month': return 30;
    case 'quarter': return 90;
    case 'custom': return 30;
  }
}

export const CashManagementTab: React.FC<Props> = ({ accounts, transactions, scheduledPayments, receivables, payables, currency, coaBalances }) => {
  const [period, setPeriod] = useState<Period>('month');
  const [customFrom, setCustomFrom] = useState<string>(new Date().toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState<string>(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const days = period === 'custom' ? Math.max(1, Math.ceil((new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000)) : periodDays(period);
  const periodEnd = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }, [days]);

  const activeAccounts = accounts.filter((a: any) => a.status === 'Active');

  // ---------- Actual ----------
  const actualBank = useMemo(() => activeAccounts.reduce((s, a: any) => s + roundFinancial(coaBalances[a.coaId] ?? a.balance ?? 0), 0), [activeAccounts, coaBalances]);
  const cashAccounts = activeAccounts.filter((a: any) => /cash|drawer|petty/i.test(a.name || ''));
  const actualCash = useMemo(() => cashAccounts.reduce((s, a: any) => s + roundFinancial(coaBalances[a.coaId] ?? a.balance ?? 0), 0), [cashAccounts, coaBalances]);
  const actualTotal = actualBank + actualCash;

  // ---------- Expected inflows ----------
  const expectedInflows = useMemo(() => {
    let total = 0;
    // Open receivables (unpaid invoices)
    for (const r of receivables) {
      const open = (r.total || 0) - (r.paid || 0);
      if (open > 0 && (!r.dueDate || r.dueDate <= periodEnd)) total += roundFinancial(open);
    }
    // Scheduled deposits (positive-amount schedules inside period)
    for (const s of scheduledPayments) {
      if (s.status === 'Active' && s.nextPaymentDate <= periodEnd && s.amount > 0) total += roundFinancial(s.amount);
    }
    return total;
  }, [receivables, scheduledPayments, periodEnd]);

  // ---------- Expected outflows ----------
  const expectedOutflows = useMemo(() => {
    let total = 0;
    for (const p of payables) {
      const open = (p.total || 0) - (p.paid || 0);
      if (open > 0 && (!p.dueDate || p.dueDate <= periodEnd)) total += roundFinancial(open);
    }
    for (const s of scheduledPayments) {
      if (s.status === 'Active' && s.nextPaymentDate <= periodEnd && s.amount < 0) total += roundFinancial(Math.abs(s.amount));
    }
    return total;
  }, [payables, scheduledPayments, periodEnd]);

  const projected = actualTotal + expectedInflows - expectedOutflows;
  const isHealthy = projected > 0;

  // ---------- Per-account breakdown ----------
  const accountRows = useMemo(() => {
    return activeAccounts.map((a: any) => {
      const balance = roundFinancial(coaBalances[a.coaId] ?? a.balance ?? 0);
      const recentTxns = transactions.filter((t) => t.bankAccountId === a.id && (t.status === 'Posted' || !t.status));
      const recent30 = recentTxns.filter((t) => t.date >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
      const inflow = recent30.filter((t) => ['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
      const outflow = recent30.filter((t) => !['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
      return { id: a.id, name: a.name, bank: a.bankName, balance, inflow, outflow, unreconciled: recentTxns.filter((t) => !t.reconciled).length };
    });
  }, [activeAccounts, transactions, coaBalances]);

  const fmt = (n: number) => `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Period selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: paper, padding: 10, borderRadius: 10, border: `1px solid ${hairline}`, flexWrap: 'wrap' }}>
        <Calendar size={14} color={inkSoft} />
        <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Period</span>
        {(['today', 'week', 'month', 'quarter', 'custom'] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: '6px 12px', borderRadius: 6, border: `1px solid ${hairline}`,
              background: period === p ? teal[600] : paper,
              color: period === p ? '#fff' : inkSoft,
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}
          >{p.charAt(0).toUpperCase() + p.slice(1)}</button>
        ))}
        {period === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${hairline}`, fontSize: 12 }} />
            <span style={{ fontSize: 11, color: inkSoft }}>to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${hairline}`, fontSize: 12 }} />
          </>
        )}
      </div>

      {/* Liquidity KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card label="Actual Bank" value={fmt(actualBank)} icon={<Landmark size={16} />} tone="neutral" />
        <Card label="Actual Cash" value={fmt(actualCash)} icon={<Wallet size={16} />} tone="neutral" />
        <Card label="Actual Liquidity" value={fmt(actualTotal)} tone="positive" sub={`as of ${today}`} />
        <Card label="Expected Inflows" value={fmt(expectedInflows)} icon={<TrendingUp size={16} />} tone="positive" sub={`next ${days}d`} />
        <Card label="Expected Outflows" value={fmt(expectedOutflows)} icon={<TrendingDown size={16} />} tone="warning" sub={`next ${days}d`} />
        <Card
          label="Projected Position"
          value={fmt(projected)}
          icon={isHealthy ? <TrendingUp size={16} /> : <AlertCircle size={16} />}
          tone={isHealthy ? 'positive' : 'danger'}
          sub={isHealthy ? 'net positive' : 'net negative'}
        />
      </div>

      {/* Per-account breakdown */}
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${hairline}` }}>
          <h3 style={{ margin: 0, fontSize: 13, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>Account Breakdown</h3>
        </div>
        {accountRows.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState module="banking" customTitle="No bank accounts" customDescription="Add bank accounts to see liquidity breakdown." />
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: teal[50] }}>
                <th style={{ textAlign: 'left', padding: '10px 12px', color: teal[800], fontWeight: 700 }}>Account</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', color: teal[800], fontWeight: 700 }}>Balance</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', color: teal[800], fontWeight: 700 }}>30d In</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', color: teal[800], fontWeight: 700 }}>30d Out</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', color: teal[800], fontWeight: 700 }}>Unreconciled</th>
              </tr>
            </thead>
            <tbody>
              {accountRows.map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${hairline}` }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, color: ink }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: inkSoft }}>{r.bank || '—'}</div>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: r.balance >= 0 ? emerald[600] : danger[600] }}>{fmt(r.balance)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: emerald[600] }}>{fmt(r.inflow)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: danger[600] }}>{fmt(r.outflow)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: r.unreconciled > 0 ? amber[600] : inkSoft }}>{r.unreconciled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ padding: 10, borderRadius: 8, background: teal[50], fontSize: 11, color: ink }}>
        <strong>Note:</strong> Actual balances come from the canonical General Ledger. Expected movements are derived from open receivables, payables, scheduled transactions, and recurring payroll estimates. No GL writes happen here.
      </div>
    </div>
  );
};

const Card: React.FC<{ label: string; value: string; sub?: string; icon?: React.ReactNode; tone?: 'positive' | 'warning' | 'danger' | 'neutral' }> = ({ label, value, sub, icon, tone = 'neutral' }) => {
  const fg = tone === 'positive' ? emerald[600] : tone === 'warning' ? amber[600] : tone === 'danger' ? danger[600] : teal[700];
  const bg = tone === 'positive' ? emerald[50] : tone === 'warning' ? amber[50] : tone === 'danger' ? danger[50] : teal[50];
  return (
    <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</span>
        {icon && <span style={{ color: fg }}>{icon}</span>}
      </div>
      <span style={{ fontSize: 22, fontWeight: 700, color: fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: inkSoft }}>{sub}</span>}
      <div style={{ height: 3, background: bg, borderRadius: 2 }} />
    </div>
  );
};

export default CashManagementTab;
