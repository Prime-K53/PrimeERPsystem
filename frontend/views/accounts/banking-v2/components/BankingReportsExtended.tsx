/**
 * Banking Reports — Extended Suite.
 *
 * Reports included:
 *   - Deposit Report
 *   - Withdrawal Report
 *   - Transfer Report
 *   - Bank Charges Report
 *   - Interest Report
 *   - Unreconciled Transactions Report
 *   - Bank Activity by Account
 *   - Cash Flow Projection
 *   - Scheduled Payments Report
 *   - By Cost Centre (gracefully N/A — no cost-centre store exists yet)
 *
 * All reports operate on the passed-in store slices; no extra service
 * dependency; all amounts come from canonical sources.
 */

import React, { useMemo } from 'react';
import { roundFinancial } from '../../../../utils/helpers';

interface Props {
  accounts: any[];
  transactions: any[];
  reconciliations: any[];
  scheduledPayments?: any[];
  currency: string;
  coaBalances: Record<string, number>;
}

const fmt = (n: number, symbol: string) => `${symbol} ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';

const th: React.CSSProperties = { textAlign: 'left', padding: 8, fontWeight: 700, fontSize: 11, color: '#0b3e39' };
const td: React.CSSProperties = { padding: 8, borderTop: `1px solid ${hairline}` };

interface ReportTableProps {
  title: string;
  rows: Array<Record<string, any>>;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center'; render?: (r: any) => React.ReactNode }>;
  empty: string;
  footer?: React.ReactNode;
}

export const ReportTable: React.FC<ReportTableProps> = ({ title, rows, columns, empty, footer }) => (
  <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 16 }}>
    <h3 style={{ margin: '0 0 10px', fontSize: 13, color: ink }}>{title}</h3>
    {rows.length === 0 ? (
      <div style={{ padding: 24, color: inkSoft, fontSize: 12, textAlign: 'center' }}>{empty}</div>
    ) : (
      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#eef7f6' }}>
              {columns.map((c) => (
                <th key={c.key} style={{ ...th, textAlign: c.align || 'left' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${hairline}` }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ ...td, textAlign: c.align || 'left' }}>{c.render ? c.render(r) : r[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {footer && <div style={{ marginTop: 10, fontSize: 11, color: inkSoft }}>{footer}</div>}
      </div>
    )}
  </div>
);

export const DepositReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'Deposit' && (t.status !== 'Draft' && t.status !== 'Reversed'))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => ({
        date: t.date,
        account: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
        counterparty: t.counterparty?.name || '—',
        reference: t.reference || t.id,
        description: t.description,
        amount: roundFinancial(t.amount),
        source: t.sourceModule || 'Manual',
      }));
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Deposit Report — Total ${fmt(total, currency)}`}
      rows={rows}
      empty="No deposits recorded."
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'account', label: 'Account' },
        { key: 'counterparty', label: 'Payer' },
        { key: 'reference', label: 'Reference' },
        { key: 'description', label: 'Description' },
        { key: 'source', label: 'Source' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ color: '#059669', fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const WithdrawalReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => (t.type === 'Withdrawal' || t.type === 'Payment') && (t.status !== 'Draft' && t.status !== 'Reversed'))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => ({
        date: t.date,
        account: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
        counterparty: t.counterparty?.name || '—',
        reference: t.reference || t.id,
        description: t.description,
        amount: roundFinancial(t.amount),
        source: t.sourceModule || 'Manual',
      }));
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Withdrawal Report — Total ${fmt(total, currency)}`}
      rows={rows}
      empty="No withdrawals recorded."
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'account', label: 'Account' },
        { key: 'counterparty', label: 'Payee' },
        { key: 'reference', label: 'Reference' },
        { key: 'description', label: 'Description' },
        { key: 'source', label: 'Source' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ color: '#991b1b', fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const TransferReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'Transfer' && (t.status !== 'Draft' && t.status !== 'Reversed'))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => ({
        date: t.date,
        fromAccount: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
        toCoa: t.counterpartyCOAId || '—',
        reference: t.reference || t.id,
        amount: roundFinancial(t.amount),
      }));
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Transfer Report — Total ${fmt(total, currency)}`}
      rows={rows}
      empty="No transfers recorded through Banking."
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'fromAccount', label: 'From Account' },
        { key: 'toCoa', label: 'To COA Account' },
        { key: 'reference', label: 'Reference' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const BankChargesReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'Fee' && (t.status !== 'Draft' && t.status !== 'Reversed'))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => ({
        date: t.date,
        account: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
        description: t.description,
        reference: t.reference || t.id,
        amount: roundFinancial(t.amount),
      }));
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Bank Charges Report — Total ${fmt(total, currency)}`}
      rows={rows}
      empty="No bank charges recorded."
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'account', label: 'Account' },
        { key: 'description', label: 'Description' },
        { key: 'reference', label: 'Reference' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ color: '#991b1b', fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const InterestReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'Interest' && (t.status !== 'Draft' && t.status !== 'Reversed'))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => ({
        date: t.date,
        account: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
        description: t.description,
        reference: t.reference || t.id,
        amount: roundFinancial(t.amount),
      }));
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Interest Report — Total ${fmt(total, currency)}`}
      rows={rows}
      empty="No interest recorded."
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'account', label: 'Account' },
        { key: 'description', label: 'Description' },
        { key: 'reference', label: 'Reference' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ color: '#059669', fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const UnreconciledReport: React.FC<Props> = ({ transactions, accounts, currency }) => {
  const rows = useMemo(() => {
    return transactions
      .filter((t) => !t.reconciled && t.status !== 'Draft' && t.status !== 'Reversed')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map((t) => {
        const days = Math.max(0, Math.round((Date.now() - new Date(t.date).getTime()) / 86400000));
        return {
          date: t.date,
          account: accounts.find((a) => a.id === t.bankAccountId)?.name || '—',
          reference: t.reference || t.id,
          description: t.description,
          age: `${days}d`,
          amount: roundFinancial(t.amount),
        };
      });
  }, [transactions, accounts]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Unreconciled Transactions — ${rows.length} pending · ${fmt(total, currency)}`}
      rows={rows}
      empty="All transactions are reconciled. 🎉"
      columns={[
        { key: 'date', label: 'Date' },
        { key: 'account', label: 'Account' },
        { key: 'reference', label: 'Reference' },
        { key: 'description', label: 'Description' },
        { key: 'age', label: 'Age', align: 'center' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
      ]}
    />
  );
};

export const ActivityByAccountReport: React.FC<Props> = ({ accounts, transactions, currency }) => {
  const rows = useMemo(() => {
    const filtered = transactions.filter((t) => t.status !== 'Draft' && t.status !== 'Reversed');
    return accounts.filter((a) => a.status === 'Active').map((a) => {
      const acctTxns = filtered.filter((t) => t.bankAccountId === a.id);
      const inflow = acctTxns.filter((t) => ['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
      const outflow = acctTxns.filter((t) => !['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
      return {
        name: a.name,
        bank: a.bankName,
        coa: a.coaId || '—',
        balance: roundFinancial(a.balance || 0),
        inflow,
        outflow,
        net: inflow - outflow,
        count: acctTxns.length,
      };
    });
  }, [accounts, transactions]);
  const totalIn = rows.reduce((s, r) => s + r.inflow, 0);
  const totalOut = rows.reduce((s, r) => s + r.outflow, 0);
  return (
    <ReportTable
      title={`Activity by Account — Net ${fmt(totalIn - totalOut, currency)}`}
      rows={rows}
      empty="No active accounts."
      footer={<span>In: {fmt(totalIn, currency)} · Out: {fmt(totalOut, currency)}</span>}
      columns={[
        { key: 'name', label: 'Account' },
        { key: 'bank', label: 'Bank' },
        { key: 'coa', label: 'COA' },
        { key: 'balance', label: 'Current Balance', align: 'right', render: (r) => <span style={{ fontWeight: 700, color: r.balance >= 0 ? '#059669' : '#991b1b' }}>{fmt(r.balance, currency)}</span> },
        { key: 'inflow', label: 'Total In', align: 'right', render: (r) => <span style={{ color: '#059669' }}>{fmt(r.inflow, currency)}</span> },
        { key: 'outflow', label: 'Total Out', align: 'right', render: (r) => <span style={{ color: '#991b1b' }}>{fmt(r.outflow, currency)}</span> },
        { key: 'net', label: 'Net', align: 'right', render: (r) => <span style={{ fontWeight: 700, color: r.net >= 0 ? '#059669' : '#991b1b' }}>{fmt(r.net, currency)}</span> },
        { key: 'count', label: 'Txns', align: 'center' },
      ]}
    />
  );
};

export const CashFlowProjectionReport: React.FC<Props> = ({ scheduledPayments, currency }) => {
  const rows = useMemo(() => {
    if (!scheduledPayments) return [];
    return scheduledPayments
      .filter((s) => s.status === 'Active')
      .sort((a, b) => (a.nextPaymentDate || '').localeCompare(b.nextPaymentDate || ''))
      .map((s) => ({
        date: s.nextPaymentDate,
        name: s.name,
        payee: s.counterparty?.name || '—',
        amount: roundFinancial(s.amount),
        frequency: s.frequency,
      }));
  }, [scheduledPayments]);
  const outflows = rows.filter((r) => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);
  const inflows = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  return (
    <ReportTable
      title={`Cash Flow Projection — ${rows.length} scheduled`}
      rows={rows}
      empty="No scheduled payments to project."
      footer={<span>Expected In: {fmt(inflows, currency)} · Expected Out: {fmt(outflows, currency)} · Net: {fmt(inflows - outflows, currency)}</span>}
      columns={[
        { key: 'date', label: 'Next Run' },
        { key: 'name', label: 'Name' },
        { key: 'payee', label: 'Counterparty' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ color: r.amount >= 0 ? '#059669' : '#991b1b', fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
        { key: 'frequency', label: 'Frequency', align: 'center' },
      ]}
    />
  );
};

export const ScheduledPaymentsReport: React.FC<Props> = ({ scheduledPayments, currency }) => {
  const rows = useMemo(() => {
    if (!scheduledPayments) return [];
    return scheduledPayments.map((s) => ({
      name: s.name,
      payee: s.counterparty?.name || '—',
      amount: roundFinancial(s.amount),
      frequency: s.frequency,
      nextRun: s.nextPaymentDate,
      status: s.status,
    }));
  }, [scheduledPayments]);
  return (
    <ReportTable
      title={`Scheduled Payments — ${rows.length}`}
      rows={rows}
      empty="No scheduled payments."
      columns={[
        { key: 'name', label: 'Name' },
        { key: 'payee', label: 'Counterparty' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.amount, currency)}</span> },
        { key: 'frequency', label: 'Frequency', align: 'center' },
        { key: 'nextRun', label: 'Next Run' },
        { key: 'status', label: 'Status', align: 'center', render: (r) => <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: r.status === 'Active' ? '#f0fdf4' : r.status === 'Paused' ? '#fef9e7' : '#fef2f2', color: r.status === 'Active' ? '#059669' : r.status === 'Paused' ? '#b45309' : '#991b1b' }}>{r.status}</span> },
      ]}
    />
  );
};

export const ByCostCentreReport: React.FC<Props> = ({ transactions, currency }) => {
  // No cost-centre store exists yet; we surface this gracefully by grouping
  // whatever `costCentreId` / `costCenter` fields exist on transactions.
  const rows = useMemo(() => {
    const groups = new Map<string, { cc: string; count: number; total: number }>();
    for (const t of transactions) {
      if (t.status === 'Draft' || t.status === 'Reversed') continue;
      const cc = t.costCentreId || t.costCenter || t.costCentre || 'Unassigned';
      const existing = groups.get(cc) || { cc, count: 0, total: 0 };
      existing.count++;
      existing.total += roundFinancial(t.amount || 0);
      groups.set(cc, existing);
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [transactions]);
  return (
    <ReportTable
      title="Banking Activity by Cost Centre"
      rows={rows}
      empty="No transactions with cost-centre attribution."
      footer="Cost-centre attribution is read from transaction.costCentreId / costCenter. The dedicated cost-centre store is not yet wired — values default to 'Unassigned'."
      columns={[
        { key: 'cc', label: 'Cost Centre' },
        { key: 'count', label: 'Transactions', align: 'center' },
        { key: 'total', label: 'Total Value', align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{fmt(r.total, currency)}</span> },
      ]}
    />
  );
};
