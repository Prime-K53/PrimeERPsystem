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
import { ArrowRightLeft, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import { BankTransactionV2 } from '../../../../types/bankingV2';
import { getDefaultDate, validateDateInFY } from '../../../../utils/financialYearUtils';
import { roundFinancial } from '../../../../utils/helpers';
import { CANONICAL_COA, resolveBankCOAId } from '../../../../services/bankingGLService';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
} from '../../components/financeChrome';

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
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<ArrowRightLeft size={19} color="#fff" />}
          title="New Bank Transaction"
          subtitle="Save as draft or post to GL — Banking ledger"
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Bank Account <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} style={selectStyle}>
                <option value="">Select account</option>
                {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Type <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <select value={type} onChange={(e) => setType(e.target.value as any)} style={selectStyle}>
                <option value="Deposit">Receive Money (Deposit)</option>
                <option value="Withdrawal">Spend Money (Withdrawal)</option>
                <option value="Transfer">Transfer</option>
                <option value="Fee">Bank Charge / Fee</option>
                <option value="Interest">Bank Interest</option>
                <option value="Payment">Payment</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Amount <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }} />
            </div>
            <div>
              <label style={labelStyle}>Reference
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. INV-2026-000123" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            </div>
            <div>
              <label style={labelStyle}>Payee / Payer
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Name" style={inputStyle} />
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Description <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Customer payment INV-2026-000123" style={inputStyle} />
          </div>

          {/* Account mapping — depends on type */}
          {(type === 'Deposit' || type === 'Interest') && (
            <>
              <div style={sectionLabelStyle}><span>Income Mapping</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                <div>
                  <label style={labelStyle}>Income Account</label>
                  <select value={incomeAccountId} onChange={(e) => setIncomeAccountId(e.target.value)} style={selectStyle}>
                    <option value="">Select income account</option>
                    {INCOME_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Or Counterparty (AR)</label>
                  <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)} style={selectStyle}>
                    <option value="">None</option>
                    {AR_AP.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    {EQUITY_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    {LOAN_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
          {(type === 'Withdrawal' || type === 'Fee' || type === 'Payment') && (
            <>
              <div style={sectionLabelStyle}><span>Expense Mapping</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                <div>
                  <label style={labelStyle}>Expense Account</label>
                  <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} style={selectStyle}>
                    <option value="">Select expense account</option>
                    {EXPENSE_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Or Counterparty (AP / Loan)</label>
                  <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)} style={selectStyle}>
                    <option value="">None</option>
                    {AR_AP.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    {LOAN_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    {EQUITY_ACCOUNTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
          {type === 'Transfer' && (
            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Destination COA Account
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <select value={counterpartyAccountId} onChange={(e) => setCounterpartyAccountId(e.target.value)} style={selectStyle}>
                <option value="">Use Transfers module instead</option>
                {COA_OPTIONS_BANK_ONLY.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          )}

          <div style={sectionLabelStyle}><span>Source Link & Cheque</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Source Module</label>
              <select value={sourceModule} onChange={(e) => setSourceModule(e.target.value as any)} style={selectStyle}>
                <option value="Manual">Manual</option>
                <option value="Sales">Sales</option>
                <option value="Purchases">Purchases</option>
                <option value="Payroll">Payroll</option>
                <option value="Loans">Loans</option>
                <option value="FixedAssets">Fixed Assets</option>
                <option value="OwnerEquity">Owner Equity</option>
                <option value="Transfer">Transfer</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Source Reference
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  value={sourceReference}
                  onChange={(e) => { setSourceReference(e.target.value); setShowSourcePicker(true); }}
                  onFocus={() => sourceModule !== 'Manual' && setShowSourcePicker(true)}
                  onBlur={() => setTimeout(() => setShowSourcePicker(false), 200)}
                  placeholder={sourceModule === 'Manual' ? 'Optional' : 'Type to search, or pick from list'}
                  style={{ ...inputStyle, paddingRight: sourceModule !== 'Manual' ? 32 : 12 }}
                />
                {sourceModule !== 'Manual' && (
                  <Search size={14} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, pointerEvents: 'none' }} />
                )}
                {showSourcePicker && sourceModule !== 'Manual' && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4,
                    background: paper, border: `1.4px solid ${hairline}`, borderRadius: 9,
                    boxShadow: '0 12px 30px -10px rgba(0,0,0,.2)', maxHeight: 200, overflowY: 'auto',
                  }}>
                    {sourceOptions.length === 0 ? (
                      <div style={{ padding: 12, fontSize: 12, color: inkSoft }}>
                        {sourceSearch || sourceReference ? 'No matches' : `Type to search ${sourceModule} records…`}
                      </div>
                    ) : (
                      sourceOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onMouseDown={() => { setSourceReference(opt.label); setSourceSearch(''); setShowSourcePicker(false); }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '8px 12px',
                            background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12,
                            borderBottom: `1px solid ${hairline}`,
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <div style={{ fontWeight: 600, color: ink }}>{opt.label}</div>
                          {opt.sub && <div style={{ fontSize: 11, color: inkSoft }}>{opt.sub}</div>}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Cheque Number (if applicable)
              <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
            </label>
            <input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} placeholder="Cheque #" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
          </div>

          {/* GL Impact Preview */}
          {preview && preview.length > 0 && (
            <div style={{ background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 10, padding: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: teal[800], letterSpacing: 0.1, textTransform: 'uppercase', marginBottom: 8 }}>GL Impact Preview</div>
              {preview.map((l, i) => (
                <div key={i} style={{ fontSize: 12.5, color: ink, display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontFamily: "'JetBrains Mono', monospace" }}>
                  <span><strong>Dr</strong> {l.dr} · <strong>Cr</strong> {l.cr}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{l.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: teal[700], marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={12} /> Debits = Credits (balanced)
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 9, background: '#fdeeee', border: `1px solid ${danger}`, color: danger, fontSize: 12.5, marginBottom: 16 }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: inkSoft, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={postAsDraft} onChange={(e) => setPostAsDraft(e.target.checked)} />
            Save as draft (post later)
          </label>
        </div>
        <ModalFooter
          stepLabel={postAsDraft ? 'Draft · post later' : 'Post · creates GL entry'}
          onCancel={onClose}
          submitLabel={saving ? 'Posting…' : postAsDraft ? 'Save Draft' : 'Post Transaction'}
          onSubmit={submit}
        />
      </div>
    </div>
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
