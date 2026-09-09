/**
 * New / Edit Bank Account Modal.
 *
 * - Validates name, accountNumber, bankName uniqueness (warn if duplicate).
 * - Resolves a canonical COA id via `resolveBankCOAId`.
 * - Allows user to override the COA mapping.
 * - Captures opening balance and opening balance date.
 * - Persists via bankingService.createAccount.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Dialog } from '../../../../components/Dialog';
import { Building2, AlertCircle } from 'lucide-react';
import { getDefaultDate } from '../../../../utils/financialYearUtils';
import { resolveBankCOAId, CANONICAL_COA } from '../../../../services/bankingGLService';

interface Props {
  onClose: () => void;
  onSaved: (account: any) => void | Promise<void>;
  existingAccounts: any[];
  editing?: any | null;
}

const COA_OPTIONS = [
  { id: CANONICAL_COA.BANK_NATIONAL, label: '11210 · National Bank' },
  { id: CANONICAL_COA.BANK_FDH, label: '11220 · FDH Bank' },
  { id: CANONICAL_COA.BANK_NBS, label: '11230 · NBS Bank' },
  { id: CANONICAL_COA.MOBILE_MONEY, label: '11240 · Mobile Money' },
  { id: CANONICAL_COA.CASH_DRAWER, label: '11110 · Cash Drawer' },
  { id: CANONICAL_COA.PETTY_CASH, label: '11120 · Petty Cash' },
];

export const NewAccountModal: React.FC<Props> = ({ onClose, onSaved, existingAccounts, editing }) => {
  const [name, setName] = useState(editing?.name || '');
  const [accountNumber, setAccountNumber] = useState(editing?.accountNumber || '');
  const [bankName, setBankName] = useState(editing?.bankName || '');
  const [branch, setBranch] = useState(editing?.bankAddress || editing?.branch || '');
  const [bankAccountType, setBankAccountType] = useState<'Current' | 'Savings' | 'Business' | 'Cash' | 'PettyCash' | 'MobileMoney' | 'Other'>(editing?.bankAccountType || 'Current');
  const [currency, setCurrency] = useState(editing?.currency || 'MWK');
  const [openingBalance, setOpeningBalance] = useState(editing?.openingBalance !== undefined ? String(editing.openingBalance) : '0');
  const [openingDate, setOpeningDate] = useState(editing?.openingBalanceDate || editing?.openingDate || getDefaultDate());
  const [coaId, setCoaId] = useState<string>(editing?.coaId || '');
  const [notes, setNotes] = useState(editing?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedCOA = useMemo(() => coaId || resolveBankCOAId({ name, bankName, accountNumber }), [coaId, name, bankName, accountNumber]);

  // Auto-suggest COA when name/bank changes and user hasn't overridden
  useEffect(() => {
    if (!coaId && (name || bankName)) {
      const r = resolveBankCOAId({ name, bankName, accountNumber });
      if (r) setCoaId(r);
    }
  }, [name, bankName, accountNumber, coaId]);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError('Account name is required');
    if (!accountNumber.trim()) return setError('Account number is required');
    if (!bankName.trim()) return setError('Bank name is required');
    if (!resolvedCOA) return setError('Could not resolve a Chart of Accounts account for this bank account. Please select one explicitly.');
    const dup = existingAccounts.find((a) => a.id !== editing?.id && a.accountNumber === accountNumber && a.bankName === bankName);
    if (dup) return setError(`An account with the same number at this bank already exists: ${dup.name}`);
    const ob = parseFloat(openingBalance);
    if (isNaN(ob) || ob < 0) return setError('Opening balance must be a non-negative number');

    setSaving(true);
    try {
      await onSaved({
        ...(editing || {}),
        name: name.trim(),
        accountNumber: accountNumber.trim(),
        bankName: bankName.trim(),
        bankAddress: branch || undefined,
        accountType: 'ASSET',
        status: editing?.status || 'Active',
        openingDate: openingDate,
        currency: currency.toUpperCase(),
        openingBalance: ob,
        openingBalanceDate: openingDate,
        coaId: resolvedCOA,
        bankAccountType,
        notes,
        lastReconciledDate: editing?.lastReconciledDate,
        lastReconciliationId: editing?.lastReconciliationId,
      });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={() => onClose()} title={editing ? 'Edit Bank Account' : 'New Bank Account'} ariaLabel={editing ? 'Edit Bank Account' : 'New Bank Account'}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'linear-gradient(155deg, #1f8577, #0f544c)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Building2 size={16} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0b3e39' }}>{editing ? 'Edit Bank Account' : 'Add Bank Account'}</div>
            <div style={{ fontSize: 11, color: '#5c6567' }}>Map to Chart of Accounts and set opening balance</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Account Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. National Bank Operating" /></Field>
          <Field label="Account Number *"><input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="e.g. 1001234567" /></Field>
          <Field label="Bank Name *"><input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. National Bank" /></Field>
          <Field label="Branch"><input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. Lilongwe Branch" /></Field>
          <Field label="Account Type">
            <select value={bankAccountType} onChange={(e) => setBankAccountType(e.target.value as any)}>
              <option value="Current">Current</option>
              <option value="Savings">Savings</option>
              <option value="Business">Business</option>
              <option value="Cash">Cash Drawer</option>
              <option value="PettyCash">Petty Cash</option>
              <option value="MobileMoney">Mobile Money</option>
              <option value="Other">Other</option>
            </select>
          </Field>
          <Field label="Currency">
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Opening Balance"><input type="number" step="0.01" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} /></Field>
          <Field label="Opening Date"><input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} /></Field>
        </div>

        <Field label="Chart of Accounts Account *">
          <select value={coaId} onChange={(e) => setCoaId(e.target.value)}>
            <option value="">Auto-resolve from name/bank</option>
            {COA_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Internal notes…" />
        </Field>

        {resolvedCOA && (
          <div style={{ padding: 10, borderRadius: 8, background: '#eef7f6', color: '#166b5e', fontSize: 11 }}>
            Resolved COA: <strong>{resolvedCOA}</strong>
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 12 }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #e4ddd1', paddingTop: 12, marginTop: 4 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Account'}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#5c6567' }}>{label}</label>
    {React.Children.map(children, (c) => React.isValidElement(c) ? React.cloneElement(c as any, {
      style: { padding: '8px 10px', borderRadius: 7, border: '1px solid #e4ddd1', fontSize: 13, color: '#23282A', background: '#FEFDFB', outline: 'none', fontFamily: 'inherit', width: '100%', ...(c.props.style || {}) },
    }) : c)}
  </div>
);

const btnPrimary: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, border: 'none', background: 'linear-gradient(155deg, #1f8577, #0f544c)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { padding: '9px 18px', borderRadius: 9, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
