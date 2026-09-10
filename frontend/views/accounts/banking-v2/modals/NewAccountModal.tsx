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
import { Building2, AlertCircle } from 'lucide-react';
import { getDefaultDate } from '../../../../utils/financialYearUtils';
import { resolveBankCOAId, CANONICAL_COA } from '../../../../services/bankingGLService';
import { useAuth } from '../../../../context/AuthContext';
import { currencyService } from '../../../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
} from '../../components/financeChrome';

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
  const { companyConfig } = useAuth();
  const defaultCurrency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || 'MWK';
  const [name, setName] = useState(editing?.name || '');
  const [accountNumber, setAccountNumber] = useState(editing?.accountNumber || '');
  const [bankName, setBankName] = useState(editing?.bankName || '');
  const [branch, setBranch] = useState(editing?.bankAddress || editing?.branch || '');
  const [bankAccountType, setBankAccountType] = useState<'Current' | 'Savings' | 'Business' | 'Cash' | 'PettyCash' | 'MobileMoney' | 'Other'>(editing?.bankAccountType || 'Current');
  const [currency, setCurrency] = useState(editing?.currency || defaultCurrency);
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
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(600)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<Building2 size={19} color="#fff" />}
          title={editing ? 'Edit Bank Account' : 'New Bank Account'}
          subtitle="Map to Chart of Accounts & set opening balance"
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Account Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. National Bank Operating" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Account Number <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="e.g. 1001234567" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            </div>
            <div>
              <label style={labelStyle}>Bank Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. National Bank" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Branch
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. Lilongwe Branch" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Account Type</label>
              <select value={bankAccountType} onChange={(e) => setBankAccountType(e.target.value as any)} style={selectStyle}>
                <option value="Current">Current</option>
                <option value="Savings">Savings</option>
                <option value="Business">Business</option>
                <option value="Cash">Cash Drawer</option>
                <option value="PettyCash">Petty Cash</option>
                <option value="MobileMoney">Mobile Money</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Currency</label>
              <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            </div>
            <div>
              <label style={labelStyle}>Opening Balance</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                <input type="number" step="0.01" min="0" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Opening Date</label>
              <input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div style={sectionLabelStyle}><span>GL Mapping & Notes</span></div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Chart of Accounts Account <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
            <select value={coaId} onChange={(e) => setCoaId(e.target.value)} style={selectStyle}>
              <option value="">Auto-resolve from name/bank</option>
              {COA_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Notes
              <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Internal notes…" style={textareaStyle} />
          </div>

          {resolvedCOA && (
            <div style={{ padding: '10px 14px', borderRadius: 9, background: teal[50], border: `1px solid ${teal[100]}`, color: teal[700], fontSize: 12, marginBottom: 16 }}>
              Resolved COA: <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{resolvedCOA}</strong>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 9, background: '#fdeeee', border: `1px solid ${danger}`, color: danger, fontSize: 12.5, marginBottom: 16 }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}
        </div>
        <ModalFooter
          stepLabel={editing ? 'Edit · bank account' : 'New · bank account'}
          onCancel={onClose}
          submitLabel={saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Account'}
          onSubmit={submit}
        />
      </div>
    </div>
  );
};
