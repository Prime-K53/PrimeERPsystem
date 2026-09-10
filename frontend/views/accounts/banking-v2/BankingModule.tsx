/**
 * Banking module — Production entry point.
 *
 * Wires the existing Zustand store, IndexedDB-backed services, and the
 * ledgerService into a complete accounting module:
 *
 *  - Dashboard with Total / Cash / Unreconciled / This-Month KPIs
 *  - Bank Accounts table with action menu (View / Edit / New Transaction /
 *    Receive / Spend / Transfer / Reconcile / View Ledger / Deactivate)
 *  - Transactions table with action menu (View / Edit / Post / Reverse /
 *    Mark Cleared / Delete Draft / View Journal)
 *  - Reconciliation screen with live difference calc and adjustments
 *  - Reports (Bank Activity, Reconciliation Report, Cash & Bank Summary)
 *  - Source linking to Sales/Purchases/Payroll/Loans/OwnerEquity/FA/Transfer
 *  - Idempotent GL posting via bankingGLService
 *  - FY validation before posting
 *  - Audit log writes via the auditLogs store
 *
 * Reuses: ConfirmDialog, bankingStore, bankingService,
 * ledgerService, accountResolutionService, financialReportingService,
 * dbService, validateDateInFY.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, RefreshCw, Building2, Wallet, ArrowRightLeft, Landmark,
  CheckCircle2, AlertCircle, FileText, Eye, Edit2, Trash2, Lock,
  ArrowDownCircle, ArrowUpCircle, Search, Filter, Download, Printer,
  MoreHorizontal, ChevronDown, ChevronRight, Banknote, X, AlertTriangle,
  Sparkles, Upload,
} from 'lucide-react';

import { useBankingStore } from '../../../context/BankingContext';
import { useAuth } from '../../../context/AuthContext';
import { useData } from '../../../context/DataContext';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { bankingService } from '../../../services/bankingService';
import { dbService } from '../../../services/db';
import { logger } from '../../../services/logger';
import { financialReportingService } from '../../../services/financialReportingService';
import { validateDateInFY, getDefaultDate } from '../../../utils/financialYearUtils';
import { roundFinancial } from '../../../utils/helpers';
import { currencyService } from '../../../services/currencyService';

import {
  BankAccountV2, BankTransactionV2, ReconciliationV2,
} from '../../../types/bankingV2';
import {
  postBankTransactionGL, reverseBankingJournal,
  CANONICAL_COA, resolveBankCOAId,
} from '../../../services/bankingGLService';

import { NewTransactionModal } from './modals/NewTransactionModal';
import { NewAccountModal } from './modals/NewAccountModal';
import { ReconcileModal } from './modals/ReconcileModal';
import { TransactionDetailModal } from './modals/TransactionDetailModal';
import { StatementImportModal } from './modals/StatementImportModal';
import { AccountDetailDrawer } from './components/AccountDetailDrawer';
import { ReportsTab } from './components/ReportsTab';
import { ScheduledTransactionsTab } from './components/ScheduledTransactionsTab';
import { CashManagementTab } from './components/CashManagementTab';
import { AIAssistantTab } from './components/AIAssistantTab';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, EmptyState, tableCard, tableHeadRow, tableHeadCell,
} from '../components/financeChrome';

type Tab = 'dashboard' | 'accounts' | 'transactions' | 'reconciliation' | 'cash' | 'scheduled' | 'statements' | 'reports' | 'ai';

const fmt = (n: number, symbol: string) => `${symbol} ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ActionMenu: React.FC<{ items: Array<{ label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }> }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', color: inkSoft, cursor: 'pointer' }}
        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        aria-label="Actions"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', right: 0, top: '110%', zIndex: 30,
            background: paper, border: `1.4px solid ${hairline}`, borderRadius: 10,
            boxShadow: '0 12px 30px -10px rgba(0,0,0,.2)', minWidth: 180, padding: 4,
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {items.map((it, i) => (
            <button
              key={i}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                background: 'transparent', border: 'none', cursor: it.disabled ? 'not-allowed' : 'pointer',
                color: it.danger ? danger : ink, display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12.5, opacity: it.disabled ? 0.5 : 1,
              }}
              onMouseEnter={e => { if (!it.disabled) e.currentTarget.style.background = teal[50]; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const BankingModule: React.FC = () => {
  const store = useBankingStore();
  const { companyConfig, user } = useAuth();
  const { refreshAllData } = useData();

  const [tab, setTab] = useState<Tab>('dashboard');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>(getDefaultDate().slice(0, 7) + '-01');
  const [dateTo, setDateTo] = useState<string>(getDefaultDate());

  // Modals
  const [showNewAccount, setShowNewAccount] = useState<{ open: boolean; editAccount?: any } | null>(null);
  const [showNewTransaction, setShowNewTransaction] = useState<{ open: boolean; preset?: Partial<BankTransactionV2> } | null>(null);
  const [showReconcile, setShowReconcile] = useState<{ open: boolean; accountId?: string } | null>(null);
  const [showTxnDetail, setShowTxnDetail] = useState<{ open: boolean; txnId?: string } | null>(null);
  const [showAccountDrawer, setShowAccountDrawer] = useState<{ open: boolean; accountId?: string } | null>(null);
  const [showStatementImport, setShowStatementImport] = useState<{ open: boolean; accountId?: string } | null>(null);

  const [confirm, setConfirm] = useState<{
    open: boolean; title: string; message: string; type?: 'danger' | 'warning';
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const [coaBalances, setCoaBalances] = useState<Record<string, number>>({});

  // Load canonical book balances from COA
  useEffect(() => {
    if (store.accounts.length === 0) return;
    financialReportingService.getBookBalancesForBankAccounts(store.accounts as any)
      .then(setCoaBalances)
      .catch((err) => logger.error('Failed to load COA balances', err));
  }, [store.accounts.length]);

  // Reload on focus
  useEffect(() => {
    const onFocus = () => { store.fetchBankingData(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [store.fetchBankingData]);

  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

  // ---------- KPIs ----------
  const kpis = useMemo(() => {
    const active = store.accounts.filter((a: any) => a.status === 'Active');
    const totalBalance = active.reduce((s, a: any) => s + roundFinancial(a.balance || 0), 0);
    const cashAccounts = active.filter((a: any) => {
      const coa = (a as any).coaId || resolveBankCOAId(a);
      return coa === CANONICAL_COA.CASH_DRAWER || coa === CANONICAL_COA.PETTY_CASH || /cash/i.test(a.name || '');
    });
    const cashBalance = cashAccounts.reduce((s, a: any) => s + roundFinancial(a.balance || 0), 0);
    const unreconciledCount = store.transactions.filter((t) => !t.reconciled && t.status !== 'Draft' && t.status !== 'Reversed').length;
    const inMonth = store.transactions.filter((t) => {
      if (t.status === 'Draft' || t.status === 'Reversed') return false;
      return (t.date || '').slice(0, 7) === new Date().toISOString().slice(0, 7);
    });
    const monthIn = inMonth.filter((t) => ['Deposit', 'Interest'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
    const monthOut = inMonth.filter((t) => ['Withdrawal', 'Fee', 'Payment'].includes(t.type)).reduce((s, t) => s + roundFinancial(t.amount), 0);
    return { totalBalance, cashBalance, unreconciledCount, activeCount: active.length, monthIn, monthOut };
  }, [store.accounts, store.transactions]);

  // ---------- Filtered lists ----------
  const filteredTxns = useMemo(() => {
    return store.transactions
      .filter((t) => {
        if (filterType !== 'all' && t.type !== filterType) return false;
        if (filterStatus !== 'all' && (t as any).status !== filterStatus) return false;
        if (filterAccount !== 'all' && t.bankAccountId !== filterAccount) return false;
        if (dateFrom && (t.date || '') < dateFrom) return false;
        if (dateTo && (t.date || '') > dateTo) return false;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${t.description || ''} ${t.reference || ''} ${(t as any).counterparty?.name || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [store.transactions, filterType, filterStatus, filterAccount, dateFrom, dateTo, search]);

  // ---------- Actions ----------
  const postTransaction = useCallback(async (tx: BankTransactionV2) => {
    const account = store.accounts.find((a) => a.id === tx.bankAccountId) as any;
    if (!account) throw new Error('Bank account not found');
    if (account.status !== 'Active') throw new Error('Cannot post to inactive account');
    const fyErr = validateDateInFY(tx.date);
    if (fyErr) throw new Error(fyErr);
    if (roundFinancial(tx.amount) <= 0) throw new Error('Amount must be positive');
    if (!tx.description?.trim()) throw new Error('Description is required');

    const bankCOA = account.coaId || resolveBankCOAId(account);
    if (!bankCOA) throw new Error('Could not resolve COA account for this bank account');

    const updated: BankTransactionV2 = {
      ...tx,
      status: 'Posted',
      bankCOAId: bankCOA,
      postedAt: new Date().toISOString(),
      postedBy: user?.id,
    };

    // 1. Write to bankTransactions store
    await bankingService.createTransaction(updated as any);

    // 2. Post GL (idempotent)
    await postBankTransactionGL(updated, {
      bankAccountCOAId: bankCOA,
      counterpartyCOAId: (updated as any).counterpartyCOAId,
      expenseAccountId: (updated as any).expenseAccountId,
      incomeAccountId: (updated as any).incomeAccountId,
      createdBy: user?.id,
    });

    // 3. Audit
    try {
      await dbService.put('auditLogs', {
        id: `AL-${Date.now()}-${tx.id}`,
        timestamp: new Date().toISOString(),
        action: 'bank_transaction.post',
        entity_type: 'bank_transaction',
        entity_id: tx.id,
        user_id: user?.id,
        status: 'LOCAL',
        details_json: JSON.stringify({ type: tx.type, amount: tx.amount, bankAccountId: tx.bankAccountId }),
      });
    } catch (err) { /* non-blocking */ }

    await store.fetchBankingData();
  }, [store, user?.id]);

  const reverseTransaction = useCallback(async (tx: BankTransactionV2) => {
    if (tx.status !== 'Posted') throw new Error('Only posted transactions can be reversed');
    if (!tx.bankCOAId) throw new Error('No linked ledger entry — cannot reverse');
    const ids = await reverseBankingJournal(tx.bankCOAId, getDefaultDate(), `Reversal of ${tx.reference || tx.id}`);
    if (!ids || ids.length === 0) throw new Error('Failed to reverse GL entry');

    const reversed: BankTransactionV2 = {
      ...tx,
      status: 'Reversed',
      reversedAt: new Date().toISOString(),
      reversedBy: user?.id,
      reversalLedgerId: ids[0],
    };
    await bankingService.updateTransaction(reversed as any);
    await store.fetchBankingData();
  }, [store, user?.id]);

  const deleteDraft = useCallback(async (tx: BankTransactionV2) => {
    if (tx.status !== 'Draft') throw new Error('Only drafts can be deleted');
    await bankingService.deleteTransaction(tx.id);
    await store.fetchBankingData();
  }, [store]);

  const deactivateAccount = useCallback(async (accountId: string) => {
    await bankingService.updateAccount({ id: accountId, status: 'Inactive', closingDate: new Date().toISOString() } as any);
    await store.fetchBankingData();
  }, [store]);

  const reactivateAccount = useCallback(async (accountId: string) => {
    await bankingService.updateAccount({ id: accountId, status: 'Active', closingDate: undefined } as any);
    await store.fetchBankingData();
  }, [store]);

  // ---------- Render helpers ----------
  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: 'Dashboard', icon: <Landmark size={14} /> },
    { id: 'accounts', label: `Accounts (${store.accounts.length})`, icon: <Building2 size={14} /> },
    { id: 'transactions', label: `Transactions (${store.transactions.length})`, icon: <ArrowRightLeft size={14} /> },
    { id: 'reconciliation', label: 'Reconciliation', icon: <CheckCircle2 size={14} /> },
    { id: 'cash', label: 'Cash Mgmt', icon: <Banknote size={14} /> },
    { id: 'scheduled', label: `Scheduled (${(store as any).scheduledPayments?.length || 0})`, icon: <RefreshCw size={14} /> },
    { id: 'statements', label: 'Statements', icon: <FileText size={14} /> },
    { id: 'reports', label: 'Reports', icon: <FileText size={14} /> },
    { id: 'ai', label: 'AI Assistant', icon: <Sparkles size={14} /> },
  ];

  return (
    <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
      <PageHeader
        icon={<Wallet size={19} color="#fff" />}
        title="Banking & Finance"
        subtitle="Bank accounts, transactions, reconciliation & reports"
        actions={
          <>
            <button
              onClick={() => { store.fetchBankingData(); refreshAllData(); }}
              style={btnGhostStyle}
              onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <button
              onClick={() => setShowNewAccount({ open: true })}
              style={btnGhostStyle}
              onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
            >
              <Plus size={15} /> Add Bank Account
            </button>
            <button
              onClick={() => setShowNewTransaction({ open: true, preset: { type: 'Deposit', date: getDefaultDate() } as any })}
              style={btnPrimaryStyle}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <Plus size={15} /> New Transaction
            </button>
          </>
        }
      />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${hairline}`, overflowX: 'auto', padding: '0 28px', background: paper }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 14px', border: 'none', background: 'transparent',
              borderBottom: tab === t.id ? `2px solid ${teal[600]}` : '2px solid transparent',
              color: tab === t.id ? teal[700] : inkSoft,
              fontWeight: tab === t.id ? 700 : 500, fontSize: 13, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && (
        <>
          <KpiCards items={[
            { label: `Total Bank Balance · ${kpis.activeCount} active`, value: fmt(kpis.totalBalance, currency), icon: Landmark, color: teal[700], bg: teal[50] },
            { label: 'Cash & Drawer', value: fmt(kpis.cashBalance, currency), icon: Wallet, color: teal[600], bg: teal[50] },
            { label: 'Unreconciled · pending', value: String(kpis.unreconciledCount), icon: AlertCircle, color: kpis.unreconciledCount > 0 ? amber[600] : teal[700], bg: kpis.unreconciledCount > 0 ? amber[100] : teal[50] },
            { label: 'This Month In', value: fmt(kpis.monthIn, currency), icon: ArrowDownCircle, color: teal[700], bg: teal[50] },
            { label: 'This Month Out', value: fmt(kpis.monthOut, currency), icon: ArrowUpCircle, color: amber[600], bg: amber[100] },
            { label: 'Net Movement', value: fmt(kpis.monthIn - kpis.monthOut, currency), icon: ArrowRightLeft, color: kpis.monthIn - kpis.monthOut >= 0 ? teal[700] : danger, bg: kpis.monthIn - kpis.monthOut >= 0 ? teal[50] : '#fdeeee' },
          ]} />

          {/* Recent activity */}
          <div style={{ padding: '18px 28px 28px' }}>
            <div style={{ ...tableCard, padding: 20 }}>
              <div style={sectionLabelStyle}><span>Recent Activity</span></div>
              {store.transactions.length === 0 ? (
                <EmptyState icon={<Landmark size={32} />} title="No bank transactions yet" hint="Add a bank account and create your first transaction." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {store.transactions.slice(0, 6).map((t) => (
                    <div key={t.id}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 10, background: teal[50], border: `1px solid ${hairline}` }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: ink }}>{t.description}</div>
                        <div style={{ fontSize: 11, color: inkSoft }}>{t.date} · {t.type} · {store.accounts.find((a) => a.id === t.bankAccountId)?.name || '—'}</div>
                      </div>
                      <div style={{ fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: ['Deposit', 'Interest'].includes(t.type) ? teal[700] : danger }}>
                        {['Deposit', 'Interest'].includes(t.type) ? '+' : '−'}{fmt(t.amount, currency)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Accounts */}
      {tab === 'accounts' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          {store.accounts.length === 0 ? (
            <EmptyState icon={<Building2 size={32} />} title="No bank accounts yet" hint="Add your first bank account to begin tracking cash and bank activity." />
          ) : (
            <div style={tableCard}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={tableHeadRow}>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Account</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Bank</th>
                    <th style={{ ...tableHeadCell, textAlign: 'right' }}>Book Balance</th>
                    <th style={{ ...tableHeadCell, textAlign: 'right' }}>Unreconciled</th>
                    <th style={{ ...tableHeadCell, textAlign: 'center' }}>Status</th>
                    <th style={{ ...tableHeadCell, textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {store.accounts.map((a: any) => {
                    const active = a.status === 'Active';
                    const coaId = a.coaId || resolveBankCOAId(a);
                    const bookBal = coaBalances[coaId] ?? a.balance ?? 0;
                    const unreconciled = store.transactions.filter((t) => t.bankAccountId === a.id && !t.reconciled && (t as any).status !== 'Draft' && (t as any).status !== 'Reversed').length;
                    return (
                      <tr key={a.id}
                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: teal[100], color: teal[700], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>
                              {(a.name || '?').charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, color: ink }}>{a.name}</div>
                              <div style={{ fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{a.accountNumber} · {coaId || 'no COA map'}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 16px', fontSize: 13, color: inkSoft }}>{a.bankName || '—'}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: bookBal >= 0 ? teal[700] : danger }}>{fmt(bookBal, currency)}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: unreconciled > 0 ? amber[600] : inkSoft }}>{unreconciled}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: active ? teal[50] : '#fdeeee', color: active ? teal[700] : danger }}>
                            {a.status}
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <ActionMenu items={[
                            { label: 'View', icon: <Eye size={13} />, onClick: () => setShowAccountDrawer({ open: true, accountId: a.id }) },
                            ...(active ? [
                              { label: 'Edit', icon: <Edit2 size={13} />, onClick: () => setShowNewAccount({ open: true, editAccount: a }) },
                              { label: 'New Transaction', icon: <Plus size={13} />, onClick: () => setShowNewTransaction({ open: true, preset: { bankAccountId: a.id, date: getDefaultDate() } as any }) },
                              { label: 'Receive Money', icon: <ArrowDownCircle size={13} />, onClick: () => setShowNewTransaction({ open: true, preset: { bankAccountId: a.id, type: 'Deposit', date: getDefaultDate() } as any }) },
                              { label: 'Spend Money', icon: <ArrowUpCircle size={13} />, onClick: () => setShowNewTransaction({ open: true, preset: { bankAccountId: a.id, type: 'Withdrawal', date: getDefaultDate() } as any }) },
                              { label: 'Reconcile', icon: <CheckCircle2 size={13} />, onClick: () => setShowReconcile({ open: true, accountId: a.id }) },
                              { label: 'Import Statement', icon: <Upload size={13} />, onClick: () => setShowStatementImport({ open: true, accountId: a.id }) },
                              { label: 'Deactivate', icon: <Lock size={13} />, onClick: () => setConfirm({ open: true, title: 'Deactivate Account', message: `Mark ${a.name} as inactive? Posting new transactions will be blocked.`, type: 'warning', onConfirm: () => deactivateAccount(a.id) }) },
                            ] : [
                              { label: 'Reactivate', icon: <RefreshCw size={13} />, onClick: () => reactivateAccount(a.id) },
                            ]),
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Transactions */}
      {tab === 'transactions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ position: 'relative', flex: '1 1 220px' }}>
              <label style={labelStyle}>Search</label>
              <div style={{ position: 'relative' }}>
                <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description, reference, payee…" style={{ ...inputStyle, paddingLeft: 34 }} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Type</label>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ ...selectStyle, width: 160 }}>
                <option value="all">All Types</option>
                <option value="Deposit">Deposit</option>
                <option value="Withdrawal">Withdrawal</option>
                <option value="Transfer">Transfer</option>
                <option value="Fee">Fee</option>
                <option value="Interest">Interest</option>
                <option value="Payment">Payment</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ ...selectStyle, width: 150 }}>
                <option value="all">All Statuses</option>
                <option value="Draft">Draft</option>
                <option value="Posted">Posted</option>
                <option value="Reversed">Reversed</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Account</label>
              <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ ...selectStyle, width: 180 }}>
                <option value="all">All Accounts</option>
                {store.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>From</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div style={tableCard}>
            {filteredTxns.length === 0 ? (
              <div style={{ padding: 24 }}>
                <EmptyState icon={<ArrowRightLeft size={32} />} title="No transactions match" hint="Adjust filters or create a new transaction." />
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={tableHeadRow}>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Date</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Reference</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Description</th>
                    <th style={{ ...tableHeadCell, textAlign: 'left' }}>Account</th>
                    <th style={{ ...tableHeadCell, textAlign: 'right' }}>In</th>
                    <th style={{ ...tableHeadCell, textAlign: 'right' }}>Out</th>
                    <th style={{ ...tableHeadCell, textAlign: 'center' }}>Status</th>
                    <th style={{ ...tableHeadCell, textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTxns.map((t: any) => {
                    const status = t.status || 'Posted';
                    const isIn = ['Deposit', 'Interest'].includes(t.type);
                    const acc = store.accounts.find((a) => a.id === t.bankAccountId);
                    return (
                      <tr key={t.id}
                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: ink }}>{t.date}</td>
                        <td style={{ padding: '12px 16px', color: inkSoft, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{t.reference || t.id}</td>
                        <td style={{ padding: '12px 16px', fontWeight: 600, fontSize: 13, color: ink }}>{t.description}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13, color: inkSoft }}>{acc?.name || '—'}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: isIn ? teal[700] : inkSoft, fontWeight: 600 }}>{isIn ? fmt(t.amount, currency) : ''}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: !isIn ? danger : inkSoft, fontWeight: 600 }}>{!isIn ? fmt(t.amount, currency) : ''}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <span style={{
                            padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                            background: status === 'Posted' ? teal[50] : status === 'Draft' ? amber[100] : '#fdeeee',
                            color: status === 'Posted' ? teal[700] : status === 'Draft' ? amber[600] : danger,
                          }}>
                            {status}
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                          <ActionMenu items={[
                            { label: 'View', icon: <Eye size={13} />, onClick: () => setShowTxnDetail({ open: true, txnId: t.id }) },
                            ...(status === 'Draft' ? [
                              { label: 'Edit', icon: <Edit2 size={13} />, onClick: () => setShowNewTransaction({ open: true, preset: { ...t } }) },
                              { label: 'Post', icon: <CheckCircle2 size={13} />, onClick: () => setConfirm({ open: true, title: 'Post Transaction', message: `Post ${t.description}? This will create a GL entry.`, type: 'warning', onConfirm: () => postTransaction(t) }) },
                              { label: 'Delete', icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirm({ open: true, title: 'Delete Draft', message: 'Delete this draft? Cannot be undone.', type: 'danger', onConfirm: () => deleteDraft(t) }) },
                            ] : status === 'Posted' ? [
                              { label: 'Reverse', icon: <RefreshCw size={13} />, danger: true, onClick: () => setConfirm({ open: true, title: 'Reverse Transaction', message: 'This creates a reversing journal entry. The original entry remains intact.', type: 'danger', onConfirm: () => reverseTransaction(t) }) },
                              ...(!t.reconciled ? [{ label: 'Mark Cleared', icon: <CheckCircle2 size={13} />, onClick: async () => { await bankingService.updateTransaction({ id: t.id, reconciled: true, clearedDate: new Date().toISOString() } as any); store.fetchBankingData(); } }] : []),
                            ] : []),
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Reconciliation */}
      {tab === 'reconciliation' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <ReconciliationTab onOpen={(accountId) => setShowReconcile({ open: true, accountId })} accounts={store.accounts as any} reconciliations={store.reconciliations as any} transactions={store.transactions as any} currency={currency} />
        </div>
      )}

      {/* Reports */}
      {tab === 'reports' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <ReportsTab
            accounts={store.accounts as any}
            transactions={store.transactions as any}
            reconciliations={store.reconciliations as any}
            scheduledPayments={(store as any).scheduledPayments || []}
            currency={currency}
            coaBalances={coaBalances}
          />
        </div>
      )}

      {/* Cash Management */}
      {tab === 'cash' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <CashManagementTab
            accounts={store.accounts as any}
            transactions={store.transactions as any}
            scheduledPayments={(store as any).scheduledPayments || []}
            receivables={(store as any).receivables || []}
            payables={(store as any).payables || []}
            currency={currency}
            coaBalances={coaBalances}
          />
        </div>
      )}

      {/* Scheduled Transactions */}
      {tab === 'scheduled' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <ScheduledTransactionsTab
            accounts={store.accounts as any}
            scheduledPayments={(store as any).scheduledPayments || []}
            currency={currency}
            onRefresh={() => store.fetchBankingData()}
            onCreateTransaction={(tx) => bankingService.createTransaction(tx as any).then(() => store.fetchBankingData())}
          />
        </div>
      )}

      {/* Statements */}
      {tab === 'statements' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <StatementsTab
            accounts={store.accounts as any}
            statements={(store as any).statements || []}
            currency={currency}
            onImport={(accountId) => setShowStatementImport({ open: true, accountId })}
          />
        </div>
      )}

      {/* AI Assistant */}
      {tab === 'ai' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
          <AIAssistantTab
            accounts={store.accounts as any}
            transactions={store.transactions as any}
            reconciliations={store.reconciliations as any}
            scheduledPayments={(store as any).scheduledPayments || []}
            currency={currency}
            coaBalances={coaBalances}
          />
        </div>
      )}

      {/* Modals */}
      {showNewAccount?.open && (
        <NewAccountModal
          onClose={() => setShowNewAccount(null)}
          onSaved={async (account) => {
            if (showNewAccount.editAccount) {
              await store.updateAccount({ ...account, id: showNewAccount.editAccount.id } as any);
            } else {
              await store.createAccount(account as any);
            }
            setShowNewAccount(null);
            await store.fetchBankingData();
          }}
          existingAccounts={store.accounts as any}
          editing={showNewAccount.editAccount}
        />
      )}
      {showNewTransaction?.open && (
        <NewTransactionModal
          onClose={() => setShowNewTransaction(null)}
          onPost={async (tx) => { await postTransaction(tx); setShowNewTransaction(null); }}
          accounts={store.accounts as any}
          preset={showNewTransaction.preset}
        />
      )}
      {showReconcile?.open && (
        <ReconcileModal
          onClose={() => setShowReconcile(null)}
          account={store.accounts.find((a) => a.id === showReconcile.accountId) as any}
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          currency={currency}
          onCompleted={async () => { await store.fetchBankingData(); setShowReconcile(null); }}
        />
      )}
      {showTxnDetail?.open && (
        <TransactionDetailModal
          onClose={() => setShowTxnDetail(null)}
          txn={store.transactions.find((t) => t.id === showTxnDetail.txnId) as any}
          accounts={store.accounts as any}
          currency={currency}
          uploadedBy={user?.id}
        />
      )}
      {showAccountDrawer?.open && (
        <AccountDetailDrawer
          onClose={() => setShowAccountDrawer(null)}
          account={store.accounts.find((a) => a.id === showAccountDrawer.accountId) as any}
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          currency={currency}
          coaBalance={coaBalances[(store.accounts.find((a) => a.id === showAccountDrawer.accountId) as any)?.coaId] ?? (store.accounts.find((a) => a.id === showAccountDrawer.accountId) as any)?.balance ?? 0}
          onNewTransaction={() => setShowNewTransaction({ open: true, preset: { bankAccountId: showAccountDrawer.accountId } as any })}
          onReconcile={() => setShowReconcile({ open: true, accountId: showAccountDrawer.accountId })}
          onImportStatement={() => setShowStatementImport({ open: true, accountId: showAccountDrawer.accountId })}
        />
      )}
      {showStatementImport?.open && (
        <StatementImportModal
          onClose={() => setShowStatementImport(null)}
          account={store.accounts.find((a) => a.id === showStatementImport.accountId) as any}
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          currency={currency}
          onImported={async () => { await store.fetchBankingData(); }}
        />
      )}

      {/* Confirm dialog */}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirm.title}
          message={confirm.message}
          type={confirm.type}
          onConfirm={async () => { await confirm.onConfirm(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

// Inline tab component (kept here for simplicity)
const ReconciliationTab: React.FC<{
  onOpen: (accountId: string) => void;
  accounts: any[];
  reconciliations: any[];
  transactions: any[];
  currency: string;
}> = ({ onOpen, accounts, reconciliations, currency }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...tableCard, padding: 20 }}>
        <div style={sectionLabelStyle}><span>Reconcile a Bank Account</span></div>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: inkSoft }}>
          Match your book transactions against your bank statement. The system prevents completion unless the difference is zero.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {accounts.filter((a) => a.status === 'Active').map((a) => (
            <button
              key={a.id}
              onClick={() => onOpen(a.id)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: 14, borderRadius: 12, border: `1.4px solid ${hairline}`, background: paper, cursor: 'pointer', textAlign: 'left', transition: 'background .12s' }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = paper}
            >
              <span style={{ fontWeight: 600, color: ink, fontSize: 13 }}>{a.name}</span>
              <span style={{ fontSize: 11, color: inkSoft }}>{a.bankName}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: teal[700], fontFamily: "'JetBrains Mono', monospace" }}>{fmt(a.balance || 0, currency)}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...tableCard, padding: 20 }}>
        <div style={sectionLabelStyle}><span>Recent Reconciliations</span></div>
        {reconciliations.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={32} />} title="No reconciliations yet" hint="Reconcile a bank account to start tracking your statement-to-book balance." />
        ) : (
          <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={tableHeadRow}>
                  <th style={{ ...tableHeadCell, textAlign: 'left' }}>Date</th>
                  <th style={{ ...tableHeadCell, textAlign: 'left' }}>Account</th>
                  <th style={{ ...tableHeadCell, textAlign: 'right' }}>Book</th>
                  <th style={{ ...tableHeadCell, textAlign: 'right' }}>Statement</th>
                  <th style={{ ...tableHeadCell, textAlign: 'right' }}>Difference</th>
                  <th style={{ ...tableHeadCell, textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {reconciliations.slice(0, 10).map((r) => (
                  <tr key={r.id}
                    style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 14px', color: ink }}>{r.endDate}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: ink }}>{accounts.find((a) => a.id === r.bankAccountId)?.name || '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{fmt(r.bookBalance, currency)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{fmt(r.endingBalance, currency)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: Math.abs(r.difference) < 0.01 ? teal[700] : danger }}>{fmt(r.difference, currency)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: teal[50], color: teal[700] }}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const StatementsTab: React.FC<{
  onImport: (accountId?: string) => void;
  accounts: any[];
  statements: any[];
  currency: string;
}> = ({ onImport, accounts, statements, currency }) => {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const activeAccounts = accounts.filter((a) => a.status === 'Active');
  const filtered = selectedAccountId ? statements.filter((s) => s.bankAccountId === selectedAccountId) : statements;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={labelStyle}>Account</label>
          <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} style={{ ...selectStyle, width: 220 }}>
            <option value="">All Accounts</option>
            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <button onClick={() => onImport(selectedAccountId || undefined)}
          style={{ ...btnPrimaryStyle, marginLeft: 'auto' }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}>
          <Upload size={14} /> Import Statement (CSV)
        </button>
      </div>
      {filtered.length === 0 ? (
        <div style={{ ...tableCard, padding: 24 }}>
          <EmptyState icon={<FileText size={32} />} title="No statements imported yet" hint="Import a CSV bank statement to begin reconciliation. Duplicates are detected automatically." />
        </div>
      ) : (
        <div style={tableCard}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={tableHeadRow}>
                <th style={{ ...tableHeadCell, textAlign: 'left' }}>Imported</th>
                <th style={{ ...tableHeadCell, textAlign: 'left' }}>Account</th>
                <th style={{ ...tableHeadCell, textAlign: 'left' }}>File</th>
                <th style={{ ...tableHeadCell, textAlign: 'right' }}>Rows</th>
                <th style={{ ...tableHeadCell, textAlign: 'right' }}>Matched</th>
                <th style={{ ...tableHeadCell, textAlign: 'right' }}>Unmatched</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => (
                <tr key={s.id}
                  style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', color: ink }}>{(s.importedAt || '').slice(0, 10)}</td>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: ink }}>{accounts.find((a) => a.id === s.bankAccountId)?.name || '—'}</td>
                  <td style={{ padding: '10px 16px', color: inkSoft }}>{s.fileName || '—'}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{s.rowCount || 0}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: teal[700], fontWeight: 600 }}>{s.matchedCount || 0}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: (s.unmatchedCount || 0) > 0 ? danger : inkSoft, fontWeight: 600 }}>{s.unmatchedCount || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default BankingModule;
