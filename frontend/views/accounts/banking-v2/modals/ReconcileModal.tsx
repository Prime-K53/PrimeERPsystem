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
import { CheckCircle2, AlertCircle, Plus, ArrowRightLeft } from 'lucide-react';
import { getDefaultDate, validateDateInFY } from '../../../../utils/financialYearUtils';
import { roundFinancial } from '../../../../utils/helpers';
import { dbService } from '../../../../services/db';
import { CANONICAL_COA, postBalancedJournal } from '../../../../services/bankingGLService';
import { generateId } from '../../../../services/transactions/_internal';
import { logger } from '../../../../services/logger';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, selectStyle,
    btnGhostStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    tableHeadRow, EmptyState,
} from '../../components/financeChrome';

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
      <div style={modalOverlayStyle} onClick={onClose}>
        <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
          <AccentStripe />
          <ModalHeader icon={<ArrowRightLeft size={19} color="#fff" />} title="Reconcile" subtitle="Select a bank account first" onClose={onClose} />
          <div style={{ padding: '24px 28px' }}>
            <EmptyState icon={<ArrowRightLeft size={32} />} title="No account selected" hint="Select a bank account first." />
          </div>
          <ModalFooter stepLabel="Reconcile · no account" onCancel={onClose} submitLabel="Close" onSubmit={onClose} />
        </div>
      </div>
    );
  }

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(800)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<CheckCircle2 size={19} color="#fff" />}
          title={`Reconcile — ${account.name}`}
          subtitle="Match book transactions to the bank statement"
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Start Date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Statement End Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Statement Ending Balance <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                <input type="number" step="0.01" required value={statementEndingBalance} onChange={(e) => setStatementEndingBalance(e.target.value)} placeholder="0.00" style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
            <Stat label="Book Balance" value={bookBalance} currency={currency} />
            <Stat label="Cleared" value={clearedBalance} currency={currency} tone={Math.abs(clearedBalance - statementBalance) < TOLERANCE ? 'positive' : 'neutral'} />
            <Stat label="Uncleared" value={unclearedBalance} currency={currency} />
            <Stat label="Difference" value={difference} currency={currency} tone={canComplete ? 'positive' : 'danger'} />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
            <button onClick={selectAll} style={btnGhostStyle}>Select All</button>
            <button onClick={clearAll} style={btnGhostStyle}>Clear All</button>
            <span style={{ flex: 1 }} />
            <button onClick={() => addAdjustment('BankCharge')} style={btnGhostStyle}><Plus size={14} /> Bank Charge</button>
            <button onClick={() => addAdjustment('Interest')} style={btnGhostStyle}><Plus size={14} /> Interest</button>
          </div>

          {adjustments.length > 0 && (
            <div style={{ background: amber[100], border: `1px solid ${amber[300]}`, padding: 14, borderRadius: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: amber[600], textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 8 }}>Reconciliation Adjustments</div>
              {adjustments.map((a) => (
                <div key={a.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: amber[600], minWidth: 90 }}>{a.type}</span>
                  <input type="date" value={a.date} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, date: e.target.value } : x))} style={{ ...inputStyle, width: 150 }} />
                  <input type="number" step="0.01" min="0" value={a.amount} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, amount: e.target.value } : x))} placeholder="Amount" style={{ ...inputStyle, width: 130, fontFamily: "'JetBrains Mono', monospace" }} />
                  <input value={a.description} onChange={(e) => setAdjustments((arr) => arr.map((x) => x.id === a.id ? { ...x, description: e.target.value } : x))} placeholder="Description" style={{ ...inputStyle, flex: '1 1 160px' }} />
                  <button onClick={() => removeAdjustment(a.id)} style={btnGhostStyle}>×</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ maxHeight: 280, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr style={tableHeadRow}>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>✓</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Date</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Description</th>
                    <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700 }}>Amount</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {accountTxns.length === 0 ? (
                    <tr><td colSpan={5} style={{ padding: 20 }}>
                      <EmptyState icon={<ArrowRightLeft size={32} />} title="No transactions in this period" hint="Adjust the statement dates." />
                    </td></tr>
                  ) : accountTxns.map((t) => (
                    <tr key={t.id}
                      style={{ borderTop: `1px solid ${hairline}`, background: cleared.has(t.id) ? teal[50] : 'transparent', transition: 'background .12s' }}
                      onMouseEnter={e => { if (!cleared.has(t.id)) e.currentTarget.style.background = teal[50]; }}
                      onMouseLeave={e => { e.currentTarget.style.background = cleared.has(t.id) ? teal[50] : 'transparent'; }}
                    >
                      <td style={{ padding: '10px 14px' }}><input type="checkbox" checked={cleared.has(t.id)} onChange={() => toggleCleared(t.id)} /></td>
                      <td style={{ padding: '10px 14px', color: ink, whiteSpace: 'nowrap' }}>{t.date}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: ink }}>{t.description}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td style={{ padding: '10px 14px', color: inkSoft }}>{t.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {error && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 9, background: '#fdeeee', border: `1px solid ${danger}`, color: danger, fontSize: 12.5, marginBottom: 14 }}><AlertCircle size={14} /> {error}</div>}

          {!canComplete && Math.abs(difference) >= TOLERANCE && (
            <div style={{ padding: '10px 14px', borderRadius: 9, background: amber[100], border: `1px solid ${amber[300]}`, color: amber[600], fontSize: 12.5, marginBottom: 14 }}>
              Cannot complete reconciliation. Difference: {currency} {difference.toLocaleString(undefined, { minimumFractionDigits: 2 })}.
              Review unmatched transactions, add a bank charge, add interest, or add an adjustment.
            </div>
          )}
          {canComplete && (
            <div style={{ padding: '10px 14px', borderRadius: 9, background: teal[50], border: `1px solid ${teal[100]}`, color: teal[700], fontSize: 12.5, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={14} />
              Statement balance equals cleared book balance. Ready to complete.
            </div>
          )}
        </div>
        <ModalFooter
          stepLabel={`Reconcile · ${cleared.size} cleared`}
          onCancel={onClose}
          submitLabel={saving ? 'Completing…' : 'Complete Reconciliation'}
          onSubmit={complete}
        />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; currency: string; tone?: 'positive' | 'danger' | 'neutral' }> = ({ label, value, currency, tone = 'neutral' }) => (
  <div style={{ padding: '12px 14px', borderRadius: 10, background: tone === 'positive' ? teal[50] : tone === 'danger' ? '#fdeeee' : paper, border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${tone === 'positive' ? teal[500] : tone === 'danger' ? danger : hairline}` }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: tone === 'positive' ? teal[700] : tone === 'danger' ? danger : ink, marginTop: 4, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{currency} {value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
  </div>
);
