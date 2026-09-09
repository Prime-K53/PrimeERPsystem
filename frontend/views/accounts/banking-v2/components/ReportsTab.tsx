/**
 * Banking Reports Tab.
 *
 * Provides:
 *   1. Bank Activity Report
 *   2. Reconciliation Report (history)
 *   3. Cash & Bank Summary
 *   4. Deposit Report
 *   5. Withdrawal Report
 *   6. Transfer Report
 *   7. Bank Charges Report
 *   8. Interest Report
 *   9. Unreconciled Transactions
 *  10. Activity by Account
 *  11. Cash Flow Projection
 *  12. Scheduled Payments
 *  13. By Cost Centre
 *
 * Uses inline computation over passed-in store slices; no extra service
 * dependency. All amounts come from the canonical sources (transactions
 * store + financialReportingService COA balances).
 */

import React, { useMemo, useState } from 'react';
import { FileText, Download, Printer } from 'lucide-react';
import EmptyState from '../../../../components/EmptyState';
import { roundFinancial } from '../../../../utils/helpers';
import {
  DepositReport, WithdrawalReport, TransferReport, BankChargesReport,
  InterestReport, UnreconciledReport, ActivityByAccountReport,
  CashFlowProjectionReport, ScheduledPaymentsReport, ByCostCentreReport,
} from './BankingReportsExtended';

interface Props {
  accounts: any[];
  transactions: any[];
  reconciliations: any[];
  scheduledPayments?: any[];
  currency: string;
  coaBalances: Record<string, number>;
}

const fmt = (n: number, symbol: string) => `${symbol} ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ReportsTab: React.FC<Props> = ({ accounts, transactions, reconciliations, scheduledPayments = [], currency, coaBalances }) => {
  const [selectedReport, setSelectedReport] = useState<string>('activity');
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?.id || '');

  const activityRows = useMemo(() => {
    const filtered = selectedAccountId ? transactions.filter((t) => t.bankAccountId === selectedAccountId) : transactions;
    const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    return sorted.map((t) => {
      const isIn = ['Deposit', 'Interest'].includes(t.type);
      running += isIn ? roundFinancial(t.amount) : -roundFinancial(t.amount);
      return {
        date: t.date,
        reference: t.reference || t.id,
        description: t.description,
        in: isIn ? roundFinancial(t.amount) : 0,
        out: !isIn ? roundFinancial(t.amount) : 0,
        balance: running,
        status: t.status || 'Posted',
      };
    });
  }, [transactions, selectedAccountId]);

  const cashSummary = useMemo(() => {
    return accounts.filter((a) => a.status === 'Active').map((a) => ({
      id: a.id,
      name: a.name,
      bank: a.bankName,
      coaId: a.coaId,
      bookBalance: coaBalances[a.coaId] ?? a.balance ?? 0,
    }));
  }, [accounts, coaBalances]);

  const exportCSV = (rows: Array<Record<string, any>>, name: string) => {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#FEFDFB', padding: 10, borderRadius: 12, border: '1px solid #e4ddd1' }}>
        <FileText size={16} color="#1f8577" />
        <select value={selectedReport} onChange={(e) => setSelectedReport(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e4ddd1', fontSize: 12 }}>
          <option value="activity">Bank Activity Report</option>
          <option value="reconciliation">Reconciliation Report</option>
          <option value="summary">Cash & Bank Summary</option>
          <option value="deposits">Deposit Report</option>
          <option value="withdrawals">Withdrawal Report</option>
          <option value="transfers">Transfer Report</option>
          <option value="charges">Bank Charges Report</option>
          <option value="interest">Interest Report</option>
          <option value="unreconciled">Unreconciled Transactions</option>
          <option value="byAccount">Activity by Account</option>
          <option value="projection">Cash Flow Projection</option>
          <option value="scheduled">Scheduled Payments</option>
          <option value="costCentre">By Cost Centre</option>
        </select>
        {selectedReport === 'activity' && (
          <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e4ddd1', fontSize: 12 }}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => {
          if (selectedReport === 'activity') exportCSV(activityRows as any, 'bank-activity.csv');
        }} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      <div style={{ background: '#FEFDFB', border: '1px solid #e4ddd1', borderRadius: 12, padding: 16 }}>
        {selectedReport === 'activity' && (
          <>
            <h3 style={{ margin: '0 0 10px', fontSize: 13, color: '#0b3e39' }}>Bank Activity</h3>
            {activityRows.length === 0 ? (
              <EmptyState module="banking" customTitle="No transactions to report" />
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#eef7f6' }}>
                      <th style={th}>Date</th>
                      <th style={th}>Reference</th>
                      <th style={th}>Description</th>
                      <th style={{ ...th, textAlign: 'right' }}>In</th>
                      <th style={{ ...th, textAlign: 'right' }}>Out</th>
                      <th style={{ ...th, textAlign: 'right' }}>Balance</th>
                      <th style={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityRows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #e4ddd1' }}>
                        <td style={td}>{r.date}</td>
                        <td style={{ ...td, color: '#5c6567' }}>{r.reference}</td>
                        <td style={td}>{r.description}</td>
                        <td style={{ ...td, textAlign: 'right', color: r.in > 0 ? '#059669' : '#5c6567' }}>{r.in > 0 ? fmt(r.in, currency) : ''}</td>
                        <td style={{ ...td, textAlign: 'right', color: r.out > 0 ? '#991b1b' : '#5c6567' }}>{r.out > 0 ? fmt(r.out, currency) : ''}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmt(r.balance, currency)}</td>
                        <td style={td}>{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {selectedReport === 'reconciliation' && (
          <>
            <h3 style={{ margin: '0 0 10px', fontSize: 13, color: '#0b3e39' }}>Reconciliation History</h3>
            {reconciliations.length === 0 ? (
              <EmptyState module="banking" customTitle="No reconciliations on record" />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#eef7f6' }}>
                    <th style={th}>Date</th>
                    <th style={th}>Account</th>
                    <th style={{ ...th, textAlign: 'right' }}>Statement</th>
                    <th style={{ ...th, textAlign: 'right' }}>Book</th>
                    <th style={{ ...th, textAlign: 'right' }}>Difference</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliations.map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid #e4ddd1' }}>
                      <td style={td}>{r.endDate}</td>
                      <td style={td}>{accounts.find((a) => a.id === r.bankAccountId)?.name || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmt(r.endingBalance, currency)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmt(r.bookBalance, currency)}</td>
                      <td style={{ ...td, textAlign: 'right', color: Math.abs(r.difference) < 0.01 ? '#059669' : '#991b1b', fontWeight: 700 }}>{fmt(r.difference, currency)}</td>
                      <td style={td}>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {selectedReport === 'summary' && (
          <>
            <h3 style={{ margin: '0 0 10px', fontSize: 13, color: '#0b3e39' }}>Cash & Bank Summary</h3>
            {cashSummary.length === 0 ? (
              <EmptyState module="banking" customTitle="No active accounts" />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#eef7f6' }}>
                    <th style={th}>Account</th>
                    <th style={th}>Bank</th>
                    <th style={th}>COA</th>
                    <th style={{ ...th, textAlign: 'right' }}>Book Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {cashSummary.map((a) => (
                    <tr key={a.id} style={{ borderTop: '1px solid #e4ddd1' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{a.name}</td>
                      <td style={td}>{a.bank || '—'}</td>
                      <td style={{ ...td, color: '#5c6567' }}>{a.coaId || '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: a.bookBalance >= 0 ? '#059669' : '#991b1b' }}>{fmt(a.bookBalance, currency)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid #0b3e39', background: '#eef7f6' }}>
                    <td colSpan={3} style={{ ...td, fontWeight: 700 }}>Total</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmt(cashSummary.reduce((s, a) => s + a.bookBalance, 0), currency)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        )}
        {selectedReport === 'deposits' && <DepositReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'withdrawals' && <WithdrawalReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'transfers' && <TransferReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'charges' && <BankChargesReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'interest' && <InterestReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'unreconciled' && <UnreconciledReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'byAccount' && <ActivityByAccountReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'projection' && <CashFlowProjectionReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'scheduled' && <ScheduledPaymentsReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
        {selectedReport === 'costCentre' && <ByCostCentreReport accounts={accounts} transactions={transactions} reconciliations={reconciliations} scheduledPayments={scheduledPayments} currency={currency} coaBalances={coaBalances} />}
      </div>
    </div>
  );
};

const th: React.CSSProperties = { textAlign: 'left', padding: 8, fontWeight: 700, fontSize: 11, color: '#0b3e39' };
const td: React.CSSProperties = { padding: 8, borderTop: '1px solid #e4ddd1' };
