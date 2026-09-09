/**
 * New Transaction Modal — production version.
 *
 * Supports:
 *   - Transaction type (Deposit / Withdrawal / Transfer / Fee / Interest / Payment)
 *   - Bank account selection (active accounts only)
 *   - Transaction date, amount, reference, description
 *   - Counterparty info (payee/payer)
 *   - Account mapping (expense/income accounts from COA)
 *   - Cheque fields (when supported)
 *   - Source linking (Sales/Purchases/etc.)
 *   - GL impact preview before posting
 *   - FY validation
 *   - Debit = Credit validation
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Dialog } from '../../../../components/Dialog';
import { ArrowRightLeft, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import { BankTransactionV2 } from '../../../../types/bankingV2';
import { getDefaultDate, validateDateInFY } from '../../../../utils/financialYearUtils';
import { roundFinancial } from '../../../../utils/helpers';
import { CANONICAL_COA, resolveBankCOAId } from '../../../../services/bankingGLService';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';

interface Props {
  onClose: () => void;
  onPost: (tx: BankTransactionV2) => Promise<void>;
  accounts: any[];
  preset?: Partial<BankTransactionV2>;
}

const EXPENSE_ACCOUNTS = [
  { id: CANONICAL_COA.BANK_CHARGES, label: '52900 · Bank Charges' },
  { id: CANONICAL_COA.INTEREST_EXPENSE, label: '54100 · Interest Expense' },
  { id: CANONICAL_COA.SALARIES, label: '52100 · Salaries & Wages' },
];
const INCOME_ACCOUNTS = [
  { id: CANONICAL_COA.INTEREST_INCOME, label: '42100 · Interest Income' },
  { id: CANONICAL_COA.OTHER_INCOME, label: '42000 · Other Income' },
  { id: CANONICAL_COA.SALES, label: '41000 · Sales' },
];
const AR_AP = [
  { id: CANONICAL_COA.AR, label: '11310 · Accounts Receivable' },
  { id: CANONICAL_COA.AP, label: '21110 · Accounts Payable' },
];
const EQUITY_ACCOUNTS = [
  { id: CANONICAL_COA.OWNER_CAPITAL, label: '31000 · Owner Capital' },
  { id: CANONICAL_COA.DRAWINGS, label: '34000 · Drawings' },
];
const LOAN_ACCOUNTS = [
  { id: CANONICAL_COA.BANK_LOANS, label: '22100 · Bank Loans' },
  { id: CANONICAL_COA.OTHER_LOANS, label: '22200 · Other Loans' },
];

export const NewTransactionModal: React.FC<Props> = ({ onClose, onPost, accounts, preset }) => {
  const [type, setType] = useState<BankTransactionV2['type']>(preset?.type || 'Deposit');
  const [bankAccountId, setBankAccountId] = useState(preset?.bankAccountId || '');
  const [date, setDate] = useState(preset?.date || getDefaultDate());
  const [amount, setAmount] = useState<string>(preset?.amount ? String(preset.amount) : '');
  const [description, setDescription] = useState(preset?.description || '');
  const [reference, setReference] = useState(preset?.reference || '');
  const [payee, setPayee] = useState(preset?.counterparty?.name || '');
  const [counterpartyAccountId, setCounterpartyAccountId] = useState(preset?.counterpartyCOAId || '');
  const [expenseAccountId, setExpenseAccountId] = useState(preset?.expenseAccountId || '');
  const [incomeAccountId, setIncomeAccountId] = useState(preset?.incomeAccountId || '');
  const [sourceModule, setSourceModule] = useState<BankTransactionV2['sourceModule']>(preset?.sourceModule || 'Manual');
  const [sourceReference, setSourceReference] = useState(preset?.sourceReference || '');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceOptions, setSourceOptions] = useState<Array<{ id: string; label: string; sub: string }>>([]);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [chequeNumber, setChequeNumber] = useState('');
  const [postAsDraft, setPostAsDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const activeAccounts = accounts.filter((a) => a.status === 'Active');
  const account = activeAccounts.find((a) => a.id === bankAccountId);
  const bankCOA = account ? (account.coaId || resolveBankCOAId(account)) : null;

  // Source-module auto-link: search across the active module for matching
  // records. Filters by reference text and returns the top matches.
  useEffect(() => {
    if (sourceModule === 'Manual' || !sourceModule) {
      setSourceOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const q = (sourceSearch || sourceReference || '').toLowerCase().trim();
        const store = sourceModuleStore(sourceModule);
        if (!store) { setSourceOptions([]); return; }
        const all: any[] = await dbService.getAll<any>(store as any);
        const matches = all
          .filter((r) => {
            if (!q) return true;
            const hay = `${r.id || ''} ${r.invoiceNumber || r.purchaseNumber || r.chequeNumber || r.reference || ''} ${r.customerName || r.supplierName || r.payeeName || r.name || ''}`.toLowerCase();
            return hay.includes(q);
          })
          .slice(0, 12)
          .map((r) => ({
            id: r.id,
            label: r.invoiceNumber || r.purchaseNumber || r.chequeNumber || r.reference || r.id,
            sub: r.customerName || r.supplierName || r.payeeName || r.name || r.description || '',
          }));
        if (!cancelled) setSourceOptions(matches);
      } catch (err) {
        logger.error('[NewTransactionModal] source search failed', err);
        if (!cancelled) setSourceOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceModule, sourceSearch, sourceReference]);

  const amountNum = useMemo(() => {
    const n = parseFloat(amount);
    return isNaN(n) ? 0 : roundFinancial(n);
  }, [amount]);

  // Compute GL impact preview
  const preview = useMemo(() => {
    if (!bankCOA || amountNum <= 0) return null;
    const lines: Array<{ dr: string; cr: string; amount: number; label: string }> = [];
    const label = (id: string | undefined, fallback: string) => id ? id : fallback;
    switch (type) {
      case 'Deposit':
        lines.push({ dr: bankCOA, cr: label(incomeAccountId || counterpartyAccountId, CANONICAL_COA.SALES), amount: amountNum, label: 'Money In' });
        break;
      case 'Withdrawal':
        lines.push({ dr: label(expenseAccountId || counterpartyAccountId, CANONICAL_COA.BANK_CHARGES), cr: bankCOA, amount: amountNum, label: 'Money Out' });
        break;
      case 'Fee':
        lines.push({ dr: CANONICAL_COA.BANK_CHARGES, cr: bankCOA, amount: amountNum, label: 'Bank Charge' });
        break;
      case 'Interest':
        lines.push({ dr: bankCOA, cr: CANONICAL_COA.INTEREST_INCOME, amount: amountNum, label: 'Bank Interest' });
        break;
      case 'Transfer':
        if (counterpartyAccountId) lines.push({ dr: counterpartyAccountId, cr: bankCOA, amount: amountNum, label: 'Transfer Out' });
        break;
      case 'Payment':
        lines.push({ dr: label(expenseAccountId, CANONICAL_COA.BANK_CHARGES), cr: bankCOA, amount: amountNum, label: 'Payment' });
        break;
    }
    return lines;
  }, [type, bankCOA, counterpartyAccountId, expenseAccountId, incomeAccountId, amountNum]);

  const validate = (): string | null => {
    if (!bankAccountId) return 'Select a bank account';
    if (!account) return 'Bank account not found';
    if (!date) return 'Date is required';
    const fyErr = validateDateInFY(date);
    if (fyErr) return fyErr;
    if (!amount || amountNum <= 0) return 'Amount must be greater than zero';
    if (!description.trim()) return 'Description is required';
    if (!bankCOA) return 'Could not resolve COA for the selected bank account. Edit the bank account to set its COA mapping.';
    if ((type === 'Deposit' || type === 'Interest') && !incomeAccountId && !counterpartyAccountId) return 'Provide an income account or counterparty account.';
    if ((type === 'Withdrawal' || type === 'Fee' || type === 'Payment') && !expenseAccountId && !counterpartyAccountId) return 'Provide an expense account or counterparty account.';
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const tx: BankTransactionV2 = {
        id: '', // generated by service
        date,
        amount: amountNum,
        type,
        description: description.trim(),
        reference: reference.trim(),
        bankAccountId,
        counterparty: payee.trim() ? { name: payee.trim() } : undefined,
        counterpartyCOAId: counterpartyAccountId || undefined,
        expenseAccountId: expenseAccountId || undefined,
        incomeAccountId: incomeAccountId || undefined,
        bankCOAId: bankCOA || undefined,
        sourceModule,
        sourceReference: sourceReference.trim() || undefined,
        sourceId: sourceReference.trim() || undefined,
        reconciled: false,
        status: postAsDraft ? 'Draft' : 'Posted',
        createdAt: '',
        updatedAt: '',
        cheque: chequeNumber ? { number: chequeNumber, status: 'Draft' } : undefined,
      } as any;

      // Persist locally first to get an ID
      const stored = await dbService.put('bankTransactions', tx);
      // Re-fetch to get the generated ID
      const all = await dbService.getAll<any>('bankTransactions');
      const persisted = all.find((x) => x.date === tx.date && x.amount === tx.amount && x.bankAccountId === tx.bankAccountId && x.description === tx.description);
      const withId = persisted ? { ...tx, id: persisted.id, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt } : tx;

      if (!postAsDraft) {
        await onPost(withId);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={() => onClose()} title="New Transaction" ariaLabel="New Bank Transaction">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'linear-gradient(155deg, #1f8577, #0f544c)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowRightLeft size={16} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0b3e39' }}>New Bank Transaction</div>
            <div style={{ fontSize: 11, color: '#5c6567' }}>Save as draft or post to GL.</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Bank Account *">
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">Select account</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Type *">
            <select value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="Deposit">Receive Money (Deposit)</option>
              <option value="Withdrawal">Spend Money (Withdrawal)</option>
              <option value="Transfer">Transfer</option>
              <option value="Fee">Bank Charge / Fee</option>
              <option value="Interest">Bank Interest</option>
              <option value="Payment">Payment</option>
            </select>
          </Field>
          <Field label="Date *"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Amount *"><input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. INV-2026-000123" /></Field>
          <Field label="Payee / Payer"><input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Name" /></Field>
        </div>

        <Field label="Description *"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Customer payment INV-2026-000123" /></Field>

        {/* Account mapping — depends on type */}
        {(type === 'Deposit' || type === 'Interest') && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Income Account">
              <select value={incomeAccountId} onChange={(e) => setIncomeAccountId(e.target.value)}>
                <option value="">Select income account</option>
                {INCOME_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Or Counterparty (AR)">
              <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)}>
                <option value="">None</option>
                {AR_AP.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                {EQUITY_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                {LOAN_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        )}
        {(type === 'Withdrawal' || type === 'Fee' || type === 'Payment') && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Expense Account">
              <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                <option value="">Select expense account</option>
                {EXPENSE_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Or Counterparty (AP / Loan)">
              <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)}>
                <option value="">None</option>
                {AR_AP.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                {LOAN_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                {EQUITY_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        )}
        {type === 'Transfer' && (
          <Field label="Destination COA Account (if not using Transfers module)">
            <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)}>
              <option value="">Use Transfers module instead</option>
              {COA_OPTIONS_BANK_ONLY.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Field>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Source Module">
            <select value={sourceModule} onChange={(e) => setSourceModule(e.target.value as any)}>
              <option value="Manual">Manual</option>
              <option value="Sales">Sales</option>
              <option value="Purchases">Purchases</option>
              <option value="Payroll">Payroll</option>
              <option value="Loans">Loans</option>
              <option value="FixedAssets">Fixed Assets</option>
              <option value="OwnerEquity">Owner Equity</option>
              <option value="Transfer">Transfer</option>
            </select>
          </Field>
          <Field label="Source Reference">
            <div style={{ position: 'relative' }}>
              <input
                value={sourceReference}
                onChange={(e) => { setSourceReference(e.target.value); setShowSourcePicker(true); }}
                onFocus={() => sourceModule !== 'Manual' && setShowSourcePicker(true)}
                onBlur={() => setTimeout(() => setShowSourcePicker(false), 200)}
                placeholder={sourceModule === 'Manual' ? 'Optional' : 'Type to search, or pick from list'}
                style={{ paddingRight: sourceModule !== 'Manual' ? 32 : undefined }}
              />
              {sourceModule !== 'Manual' && (
                <Search size={12} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#5c6567', pointerEvents: 'none' }} />
              )}
              {showSourcePicker && sourceModule !== 'Manual' && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 2,
                  background: '#FEFDFB', border: '1px solid #e4ddd1', borderRadius: 7,
                  boxShadow: '0 12px 30px -10px rgba(0,0,0,.2)', maxHeight: 200, overflowY: 'auto',
                }}>
                  {sourceOptions.length === 0 ? (
                    <div style={{ padding: 10, fontSize: 11, color: '#5c6567' }}>
                      {sourceSearch || sourceReference ? 'No matches' : `Type to search ${sourceModule} records…`}
                    </div>
                  ) : (
                    sourceOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onMouseDown={() => { setSourceReference(opt.label); setSourceSearch(''); setShowSourcePicker(false); }}
                        style={{
                          width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 0,
                          background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12,
                          borderBottom: '1px solid #f1e9d8',
                        }}
                      >
                        <div style={{ fontWeight: 600, color: '#23282A' }}>{opt.label}</div>
                        {opt.sub && <div style={{ fontSize: 10, color: '#5c6567' }}>{opt.sub}</div>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </Field>
        </div>

        <Field label="Cheque Number (if applicable)">
          <input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} placeholder="Cheque #" />
        </Field>

        {/* GL Impact Preview */}
        {preview && preview.length > 0 && (
          <div style={{ background: '#eef7f6', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#166b5e', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>GL Impact Preview</div>
            {preview.map((l, i) => (
              <div key={i} style={{ fontSize: 12, color: '#0b3e39', display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span><strong>Dr</strong> {l.dr} · <strong>Cr</strong> {l.cr}</span>
                <span>{l.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            ))}
            <div style={{ fontSize: 10, color: '#166b5e', marginTop: 6 }}>
              <CheckCircle2 size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> Debits = Credits (balanced)
            </div>
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 12 }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e4ddd1', paddingTop: 12, marginTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5c6567', cursor: 'pointer' }}>
            <input type="checkbox" checked={postAsDraft} onChange={(e) => setPostAsDraft(e.target.checked)} />
            Save as draft (post later)
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary}>Cancel</button>
            <button onClick={submit} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Posting…' : postAsDraft ? 'Save Draft' : 'Post Transaction'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
};

const COA_OPTIONS_BANK_ONLY = [
  { id: CANONICAL_COA.BANK_NATIONAL, label: '11210 · National Bank' },
  { id: CANONICAL_COA.BANK_FDH, label: '11220 · FDH Bank' },
  { id: CANONICAL_COA.BANK_NBS, label: '11230 · NBS Bank' },
  { id: CANONICAL_COA.MOBILE_MONEY, label: '11240 · Mobile Money' },
  { id: CANONICAL_COA.CASH_DRAWER, label: '11110 · Cash Drawer' },
  { id: CANONICAL_COA.PETTY_CASH, label: '11120 · Petty Cash' },
];

const SOURCE_MODULE_STORE: Partial<Record<NonNullable<BankTransactionV2['sourceModule']>, string>> = {
  Sales: 'invoices',
  Purchases: 'purchaseInvoices',
  Payroll: 'payrollRuns',
  Loans: 'loans',
  FixedAssets: 'fixedAssets',
  OwnerEquity: 'ownerEquityTransactions',
  Transfer: 'transfers',
};

function sourceModuleStore(m: BankTransactionV2['sourceModule']): string | null {
  if (!m) return null;
  return SOURCE_MODULE_STORE[m] || null;
}

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
