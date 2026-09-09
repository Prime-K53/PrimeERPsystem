/**
 * Scheduled / Recurring Transactions Tab.
 *
 * Manages the ScheduledPayment entries from the BankingContext. Per the
 * spec:
 *   - Bank fees, rent, loan repayments, subscriptions, salaries, supplier
 *     payments
 *   - Fields: type, account, amount, frequency, start/end, next execution,
 *     description, account mapping, status
 *   - Status: Active / Paused / Completed / Cancelled
 *   - Does NOT auto-post (matches existing ERP automation rules). Manual
 *     "Execute now" creates a draft transaction that the user can post
 *     through the standard flow (with audit trail).
 */

import React, { useState, useMemo } from 'react';
import { Plus, Pause, Play, X, Calendar, Trash2, AlertCircle } from 'lucide-react';
import EmptyState from '../../../../components/EmptyState';
import { Dialog } from '../../../../components/Dialog';
import { getDefaultDate, validateDateInFY } from '../../../../utils/financialYearUtils';
import { roundFinancial } from '../../../../utils/helpers';
import { logger } from '../../../../services/logger';
import { dbService } from '../../../../services/db';

interface Props {
  accounts: any[];
  scheduledPayments: any[];
  currency: string;
  onRefresh: () => void | Promise<void>;
  onCreateTransaction: (tx: any) => void;
}

const FREQUENCIES = ['Daily', 'Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Annually'] as const;
const STATUSES = ['Active', 'Paused', 'Completed', 'Cancelled'] as const;

const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const teal = { 50: '#eef7f6', 100: '#d4ebe3', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c' };
const amber = { 50: '#fef9e7', 600: '#b45309' };
const danger = { 50: '#fef2f2', 600: '#991b1b' };
const emerald = { 50: '#f0fdf4', 600: '#059669' };

function addFrequency(date: string, freq: typeof FREQUENCIES[number]): string {
  const d = new Date(date);
  switch (freq) {
    case 'Daily': d.setDate(d.getDate() + 1); break;
    case 'Weekly': d.setDate(d.getDate() + 7); break;
    case 'Biweekly': d.setDate(d.getDate() + 14); break;
    case 'Monthly': d.setMonth(d.getMonth() + 1); break;
    case 'Quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'Annually': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function statusColor(s: string): { bg: string; fg: string } {
  switch (s) {
    case 'Active': return { bg: emerald[50], fg: emerald[600] };
    case 'Paused': return { bg: amber[50], fg: amber[600] };
    case 'Completed': return { bg: teal[50], fg: teal[700] };
    case 'Cancelled': return { bg: danger[50], fg: danger[600] };
    default: return { bg: teal[50], fg: teal[700] };
  }
}

export const ScheduledTransactionsTab: React.FC<Props> = ({ accounts, scheduledPayments, currency, onRefresh, onCreateTransaction }) => {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const activeAccounts = accounts.filter((a) => a.status === 'Active');

  const due = useMemo(() => {
    const today = getDefaultDate();
    return scheduledPayments.filter((p) => p.status === 'Active' && p.nextPaymentDate <= today);
  }, [scheduledPayments]);

  const list = useMemo(() => {
    if (filter === 'all') return scheduledPayments;
    return scheduledPayments.filter((p) => p.status === filter);
  }, [scheduledPayments, filter]);

  const setStatus = async (p: any, status: string) => {
    try {
      await dbService.put('scheduledPayments', { ...p, status, updatedAt: new Date().toISOString() });
      await onRefresh();
    } catch (err) { logger.error('Failed to update scheduled payment', err); }
  };

  const remove = async (p: any) => {
    if (!confirm(`Delete scheduled payment "${p.name}"?`)) return;
    try {
      await dbService.delete('scheduledPayments', p.id);
      await onRefresh();
    } catch (err) { logger.error('Failed to delete', err); }
  };

  const executeNow = async (p: any) => {
    const fyErr = validateDateInFY(getDefaultDate());
    if (fyErr) { alert(fyErr); return; }
    const acc = accounts.find((a) => a.id === p.bankAccountId);
    if (!acc) { alert('Bank account not found'); return; }
    const tx = {
      id: `TX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: getDefaultDate(),
      amount: roundFinancial(p.amount),
      type: 'Withdrawal' as const,
      description: p.description || p.name,
      reference: `SCHED:${p.id}`,
      bankAccountId: p.bankAccountId,
      status: 'Draft' as const,
      counterparty: p.counterparty,
      reconciled: false,
      sourceModule: 'Manual' as const,
      sourceReference: p.id,
      scheduledPaymentId: p.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await onCreateTransaction(tx);
    // Advance next execution
    const next = addFrequency(p.nextPaymentDate, p.frequency);
    await dbService.put('scheduledPayments', { ...p, nextPaymentDate: next, lastExecutedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await onRefresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, color: ink }}>Scheduled Transactions</h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft }}>Recurring banking operations. Execution is manual — confirm each before posting.</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={14} /> New Schedule
        </button>
      </div>

      {/* Due alert */}
      {due.length > 0 && (
        <div style={{ padding: 12, borderRadius: 10, background: amber[50], border: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={16} color={amber[600]} />
          <span style={{ fontSize: 12, color: ink }}><strong>{due.length}</strong> scheduled transaction{due.length === 1 ? '' : 's'} due. Review and execute manually.</span>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: paper, padding: 10, borderRadius: 10, border: `1px solid ${hairline}` }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Filter</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
          <option value="all">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* List */}
      {list.length === 0 ? (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 20 }}>
          <EmptyState module="banking" customTitle="No scheduled transactions" customDescription="Schedule recurring banking operations like rent, salaries, or loan repayments." actionLabel="New Schedule" onAction={() => setShowForm(true)} />
        </div>
      ) : (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: teal[50], color: teal[800] }}>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Name</th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Account</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Amount</th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Frequency</th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Next Run</th>
                <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 700 }}>Status</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p: any) => {
                const acc = activeAccounts.find((a) => a.id === p.bankAccountId);
                const sc = statusColor(p.status);
                return (
                  <tr key={p.id} style={{ borderTop: `1px solid ${hairline}` }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600, color: ink }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: inkSoft }}>{p.counterparty?.name || '—'}</div>
                    </td>
                    <td style={{ padding: '10px 12px', color: inkSoft }}>{acc?.name || '—'}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: ink }}>{currency} {(p.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td style={{ padding: '10px 12px', color: inkSoft }}>{p.frequency}</td>
                    <td style={{ padding: '10px 12px', color: inkSoft }}>{p.nextPaymentDate}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <span style={{ padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: sc.bg, color: sc.fg }}>{p.status}</span>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {p.status === 'Active' && (
                          <button onClick={() => executeNow(p)} title="Execute now (creates draft)" style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer', fontSize: 11 }}><Calendar size={11} /></button>
                        )}
                        {p.status === 'Active' ? (
                          <button onClick={() => setStatus(p, 'Paused')} title="Pause" style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 11 }}><Pause size={11} /></button>
                        ) : p.status === 'Paused' ? (
                          <button onClick={() => setStatus(p, 'Active')} title="Resume" style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer', fontSize: 11 }}><Play size={11} /></button>
                        ) : null}
                        <button onClick={() => setStatus(p, 'Cancelled')} title="Cancel" style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 11 }}><X size={11} /></button>
                        <button onClick={() => remove(p)} title="Delete" style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${hairline}`, background: paper, color: danger[600], cursor: 'pointer', fontSize: 11 }}><Trash2 size={11} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <ScheduleForm
          onClose={() => setShowForm(false)}
          onSaved={async () => { setShowForm(false); await onRefresh(); }}
          accounts={activeAccounts}
          existing={editing}
        />
      )}
    </div>
  );
};

const ScheduleForm: React.FC<{
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  accounts: any[];
  existing: any | null;
}> = ({ onClose, onSaved, accounts, existing }) => {
  const [name, setName] = useState(existing?.name || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [bankAccountId, setBankAccountId] = useState(existing?.bankAccountId || accounts[0]?.id || '');
  const [amount, setAmount] = useState<string>(existing ? String(existing.amount) : '');
  const [frequency, setFrequency] = useState<string>(existing?.frequency || 'Monthly');
  const [startDate, setStartDate] = useState(existing?.startDate || getDefaultDate());
  const [endDate, setEndDate] = useState(existing?.endDate || '');
  const [nextPaymentDate, setNextPaymentDate] = useState(existing?.nextPaymentDate || getDefaultDate());
  const [counterpartyName, setCounterpartyName] = useState(existing?.counterparty?.name || '');
  const [paymentMethod, setPaymentMethod] = useState(existing?.paymentMethod || 'Bank Transfer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required'); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError('Amount must be positive'); return; }
    if (!bankAccountId) { setError('Bank account is required'); return; }
    setSaving(true);
    try {
      const id = existing?.id || `SCHED-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const payload = {
        id,
        name: name.trim(),
        description: description.trim(),
        bankAccountId,
        amount: roundFinancial(amt),
        frequency,
        startDate,
        endDate: endDate || undefined,
        nextPaymentDate,
        status: existing?.status || 'Active',
        paymentMethod,
        counterparty: { name: counterpartyName.trim() },
        updatedAt: new Date().toISOString(),
        ...(existing ? {} : { createdAt: new Date().toISOString() }),
      };
      await dbService.put('scheduledPayments', payload);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={existing ? 'Edit Schedule' : 'New Scheduled Transaction'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office rent" /></Field>
          <Field label="Bank Account *">
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Amount *"><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Frequency *">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label="Start Date"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="Next Run Date"><input type="date" value={nextPaymentDate} onChange={(e) => setNextPaymentDate(e.target.value)} /></Field>
          <Field label="End Date (optional)"><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
          <Field label="Payment Method">
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="Bank Transfer">Bank Transfer</option>
              <option value="Wire Transfer">Wire Transfer</option>
              <option value="ACH">ACH</option>
              <option value="Check">Check</option>
            </select>
          </Field>
          <Field label="Counterparty / Payee"><input value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder="Payee name" /></Field>
          <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes" /></Field>
        </div>
        {error && <div style={{ padding: 8, borderRadius: 6, background: '#fef2f2', color: danger[600], fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: `1px solid ${hairline}`, paddingTop: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Dialog>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: inkSoft }}>{label}</label>
    {React.Children.map(children, (c) => React.isValidElement(c) ? React.cloneElement(c as any, { style: { padding: '8px 10px', borderRadius: 7, border: `1px solid ${hairline}`, fontSize: 12, background: paper, outline: 'none', width: '100%', ...(c.props.style || {}) } }) : c)}
  </div>
);

export default ScheduledTransactionsTab;
