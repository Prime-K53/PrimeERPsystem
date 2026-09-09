/**
 * Bank Reconciliation Modal.
 *
 * - Selects bank account
 * - Sets statement period + ending balance
 * - Marks each transaction cleared or not
 * - Live difference calc: book balance - statement balance (considering cleared items)
 * - Adds bank charge / interest adjustments (which create proper GL entries)
 * - Blocks completion when |difference| > 0.01
 */

import React, { useState, useMemo } from 'react';
import { Dialog } from '../../../../components/Dialog';
import { CheckCircle2, AlertCircle, Plus, ArrowRightLeft } from 'lucide-react';
import { getDefaultDate, validateDateInFY } from '../../../../utils/financialYearUtils';
import { roundFinancial } from '../../../../utils/helpers';
import { dbService } from '../../../../services/db';
import { CANONICAL_COA, postBalancedJournal } from '../../../../services/bankingGLService';
import { generateId } from '../../../../services/transactions/_internal';
import { logger } from '../../../../services/logger';

interface Props {
  onClose: () => void;
  account: any;
  accounts: any[];
  transactions: any[];
  currency: string;
  onCompleted: () => void | Promise<void>;
}

const TOLERANCE = 0.01;

export const ReconcileModal: React.FC<Props> = ({ onClose, account, accounts, transactions, currency, onCompleted }) => {
  const [statementEndingBalance, setStatementEndingBalance] = useState<string>('');
  const [endDate, setEndDate] = useState<string>(getDefaultDate());
  const [startDate, setStartDate] = useState<string>('');
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [adjustments, setAdjustments] = useState<Array<{ id: string; date: string; type: 'BankCharge' | 'Interest'; amount: string; description: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const accountTxns = useMemo(() => {
    return transactions
      .filter((t) => t.bankAccountId === account?.id && (t.status === 'Posted' || !t.status))
      .filter((t) => !startDate || t.date >= startDate)
      .filter((t) => t.date <= endDate)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, account, startDate, endDate]);

  const { bookBalance, clearedBalance, unclearedBalance, statementBalance, difference } = useMemo(() => {
    const bb = accountTxns.reduce((s, t) => {
      const isIn = ['Deposit', 'Interest'].includes(t.type);
      return s + (isIn ? roundFinancial(t.amount) : -roundFinancial(t.amount));
    }, 0);
    const cb = accountTxns
      .filter((t) => cleared.has(t.id))
      .reduce((s, t) => {
        const isIn = ['Deposit', 'Interest'].includes(t.type);
        return s + (isIn ? roundFinancial(t.amount) : -roundFinancial(t.amount));
      }, 0);
    const sb = parseFloat(statementEndingBalance);
    const stmtBal = isNaN(sb) ? 0 : roundFinancial(sb);
    const adjSum = adjustments.reduce((s, a) => {
      const n = parseFloat(a.amount);
      if (isNaN(n)) return s;
      return s + (a.type === 'Interest' ? n : -n);
    }, 0);
    // Book balance = opening + cleared items (since cleared == confirmed-against-statement)
    // Difference = statement - bookBalance - adjustments
    return {
      bookBalance: bb,
      clearedBalance: cb + adjSum,
      unclearedBalance: bb - cb,
      statementBalance: stmtBal,
      difference: roundFinancial(stmtBal - cb - adjSum),
    };
  }, [accountTxns, cleared, statementEndingBalance, adjustments]);

  const canComplete = Math.abs(difference) < TOLERANCE;

  const toggleCleared = (id: string) => {
    setCleared((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectAll = () => setCleared(new Set(accountTxns.map((t) => t.id)));
  const clearAll = () => setCleared(new Set());

  const addAdjustment = (type: 'BankCharge' | 'Interest') => {
    setAdjustments((a) => [...a, { id: generateId('ADJ'), date: endDate, type, amount: '', description: type === 'BankCharge' ? 'Bank charge' : 'Interest received' }]);
  };

  const removeAdjustment = (id: string) => setAdjustments((a) => a.filter((x) => x.id !== id));

  const complete = async () => {
    setError(null);
    if (!statementEndingBalance || parseFloat(statementEndingBalance) <= 0 && accountTxns.length > 0) {
      // Statement balance can legitimately be 0 if account is empty, but generally required.
    }
    const fyErr = validateDateInFY(endDate);
    if (fyErr) return setError(fyErr);
    if (!canComplete) return setError(`Cannot complete reconciliation. Difference: ${currency} ${difference.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

    setSaving(true);
    try {
      // 1. Mark cleared transactions
      for (const id of cleared) {
        await dbService.put('bankTransactions', { id, reconciled: true, clearedDate: new Date().toISOString() } as any);
      }

      // 2. Post GL adjustments
      for (const a of adjustments) {
        const amt = parseFloat(a.amount);
        if (isNaN(amt) || amt <= 0) continue;
        const idempotencyKey = `RECONADJ:${account.id}:${a.id}`;
        if (a.type === 'BankCharge') {
          await postBalancedJournal({
            date: a.date,
            description: a.description || 'Bank charge',
            reference: `RECONADJ-${a.id}`,
            entryType: 'BANK_CHARGE',
            lines: [{ debitAccountId: CANONICAL_COA.BANK_CHARGES, creditAccountId: account.coaId || CANONICAL_COA.BANK_NATIONAL, amount: amt }],
            idempotencyKey,
          });
        } else {
          await postBalancedJournal({
            date: a.date,
            description: a.description || 'Bank interest',
            reference: `RECONADJ-${a.id}`,
            entryType: 'BANK_INTEREST',
            lines: [{ debitAccountId: account.coaId || CANONICAL_COA.BANK_NATIONAL, creditAccountId: CANONICAL_COA.INTEREST_INCOME, amount: amt }],
            idempotencyKey,
          });
        }
      }

      // 3. Create reconciliation record
      const reconciliation = {
        id: generateId('REC'),
        bankAccountId: account.id,
        startDate: startDate || (accountTxns[accountTxns.length - 1]?.date || endDate),
        endDate,
        statementEndingBalance,
        bookBalance,
        clearedBalance,
        unclearedBalance,
        difference,
        status: 'Completed' as const,
        clearedTransactionIds: Array.from(cleared),
        adjustments: adjustments.map((a) => ({ id: a.id, date: a.date, amount: parseFloat(a.amount) || 0, type: a.type, description: a.description })),
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await dbService.put('bankReconciliations', reconciliation as any);

      // 4. Update account.lastReconciliation
      await dbService.put('bankAccounts', { ...account, lastReconciliationId: reconciliation.id, lastReconciliationDate: endDate, lastReconciledDate: endDate } as any);

      await onCompleted();
    } catch (e) {
      logger.error('Reconciliation failed', e);
      setError((e as Error).message);
      setSaving(false);
    }
  };

  if (!account) {
    return (
      <Dialog open={true} onOpenChange={() => onClose()} title="Reconcile">
        <div style={{ padding: 20 }}>Select a bank account first.</div>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={() => onClose()} title={`Reconcile: ${account.name}`} ariaLabel="Bank Reconciliation">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760, maxHeight: '80vh', overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label="Start Date"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="Statement End Date *"><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
          <Field label="Statement Ending Balance *"><input type="number" step="0.01" value={statementEndingBalance} onChange={(e) => setStatementEndingBalance(e.target.value)} placeholder="0.00" /></Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Stat label="Book Balance" value={bookBalance} currency={currency} />
          <Stat label="Cleared" value={clearedBalance} currency={currency} tone={Math.abs(clearedBalance - statementBalance) < TOLERANCE ? 'positive' : 'neutral'} />
          <Stat label="Uncleared" value={unclearedBalance} currency={currency} />
          <Stat label="Difference" value={difference} currency={currency} tone={canComplete ? 'positive' : 'danger'} />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={selectAll} style={btnSm}>Select All</button>
          <button onClick={clearAll} style={btnSm}>Clear All</button>
          <span style={{ flex: 1 }} />
          <button onClick={() => addAdjustment('BankCharge')} style={btnSm}><Plus size={12} /> Bank Charge</button>
          <button onClick={() => addAdjustment('Interest')} style={btnSm}><Plus size={12} /> Interest</button>
        </div>

        {adjustments.length > 0 && (
          <div style={{ background: '#fef9e7', padding: 10, borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginBottom: 6 }}>Reconciliation Adjustments</div>
            {adjustments.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#92400e', minWidth: 90 }}>{a.type}</span>
                <input type="date" value={a.date} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, date: e.target.value } : x))} style={inp} />
                <input type="number" step="0.01" value={a.amount} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, amount: e.target.value } : x))} placeholder="Amount" style={inp} />
                <input value={a.description} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, description: e.target.value } : x))} placeholder="Description" style={{ ...inp, flex: 1 }} />
                <button onClick={() => removeAdjustment(a.id)} style={btnSm}>×</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: '#fff', border: '1px solid #e4ddd1', borderRadius: 8, maxHeight: 280, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#eef7f6' }}>
              <tr>
                <th style={th}>✓</th>
                <th style={th}>Date</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                <th style={th}>Type</th>
              </tr>
            </thead>
            <tbody>
              {accountTxns.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 14, textAlign: 'center', color: '#5c6567' }}>No transactions in this period.</td></tr>
              ) : accountTxns.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid #e4ddd1', background: cleared.has(t.id) ? '#f0fdf4' : 'transparent' }}>
                  <td style={td}><input type="checkbox" checked={cleared.has(t.id)} onChange={() => toggleCleared(t.id)} /></td>
                  <td style={td}>{t.date}</td>
                  <td style={td}>{t.description}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td style={td}>{t.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 12 }}><AlertCircle size={14} /> {error}</div>}

        {!canComplete && Math.abs(difference) >= TOLERANCE && (
          <div style={{ padding: 10, borderRadius: 8, background: '#fef9e7', color: '#b45309', fontSize: 12 }}>
            Cannot complete reconciliation. Difference: {currency} {difference.toLocaleString(undefined, { minimumFractionDigits: 2 })}.
            Review unmatched transactions, add a bank charge, add interest, or add an adjustment.
          </div>
        )}
        {canComplete && (
          <div style={{ padding: 10, borderRadius: 8, background: '#f0fdf4', color: '#059669', fontSize: 12 }}>
            <CheckCircle2 size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            Statement balance equals cleared book balance. Ready to complete.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #e4ddd1', paddingTop: 12 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={complete} disabled={saving || !canComplete} style={{ ...btnPrimary, opacity: (saving || !canComplete) ? 0.6 : 1 }}>
            {saving ? 'Completing…' : 'Complete Reconciliation'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#5c6567' }}>{label}</label>
    {React.Children.map(children, (c) => React.isValidElement(c) ? React.cloneElement(c as any, { style: { padding: '8px 10px', borderRadius: 7, border: '1px solid #e4ddd1', fontSize: 13, background: '#FEFDFB', outline: 'none', width: '100%', ...(c.props.style || {}) } }) : c)}
  </div>
);

const Stat: React.FC<{ label: string; value: number; currency: string; tone?: 'positive' | 'danger' | 'neutral' }> = ({ label, value, currency, tone = 'neutral' }) => (
  <div style={{ padding: 10, borderRadius: 8, background: tone === 'positive' ? '#f0fdf4' : tone === 'danger' ? '#fef2f2' : '#eef7f6', border: '1px solid #e4ddd1' }}>
    <div style={{ fontSize: 9, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: tone === 'positive' ? '#059669' : tone === 'danger' ? '#991b1b' : '#0b3e39', marginTop: 2 }}>{currency} {value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
  </div>
);

const th: React.CSSProperties = { textAlign: 'left', padding: 8, fontWeight: 700, fontSize: 11, color: '#0b3e39' };
const td: React.CSSProperties = { padding: 8, borderTop: '1px solid #e4ddd1' };
const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #e4ddd1', fontSize: 12, background: '#FEFDFB', outline: 'none' };
const btnSm: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 };
const btnPrimary: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, border: 'none', background: 'linear-gradient(155deg, #1f8577, #0f544c)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
