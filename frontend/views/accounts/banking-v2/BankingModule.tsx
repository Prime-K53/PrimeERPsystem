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
 * Reuses: Dialog, ConfirmDialog, EmptyState, bankingStore, bankingService,
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
import { Dialog } from '../../../components/Dialog';
import EmptyState from '../../../components/EmptyState';
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

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const teal = { 50: '#eef7f6', 100: '#d4ebe3', 400: '#3fa294', 500: '#2d9a8a', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c', 900: '#0a3d34' };
const amber = { 50: '#fef9e7', 400: '#d99a3f', 600: '#b45309' };
const danger = { 50: '#fef2f2', 400: '#dc2626', 600: '#991b1b' };
const emerald = { 50: '#f0fdf4', 400: '#16a34a', 600: '#059669' };

type Tab = 'dashboard' | 'accounts' | 'transactions' | 'reconciliation' | 'cash' | 'scheduled' | 'statements' | 'reports' | 'ai';

interface KpiCardProps { label: string; value: string; sub?: string; tone?: 'neutral' | 'positive' | 'warning' | 'danger'; icon?: React.ReactNode; }
const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, tone = 'neutral', icon }) => {
  const color = tone === 'positive' ? emerald[600] : tone === 'warning' ? amber[600] : tone === 'danger' ? danger[600] : teal[700];
  return (
    <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: inkSoft }}>{label}</span>
        {icon && <span style={{ color }}>{icon}</span>}
      </div>
      <span style={{ fontSize: 22, fontWeight: 700, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: inkSoft }}>{sub}</span>}
    </div>
  );
};

const fmt = (n: number, symbol: string) => `${symbol} ${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ActionMenu: React.FC<{ items: Array<{ label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }> }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ padding: 6, borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer' }}
        aria-label="Actions"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', right: 0, top: '110%', zIndex: 30,
            background: paper, border: `1px solid ${hairline}`, borderRadius: 10,
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
                color: it.danger ? danger[600] : ink, display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12.5, opacity: it.disabled ? 0.5 : 1,
              }}
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
    <div style={{ background: '#f6f3ed', minHeight: '100%', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: ink, fontFamily: "'DM Serif Display', Georgia, serif" }}>Banking & Finance</h1>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft }}>Bank accounts, transactions, reconciliation, and reports.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => { store.fetchBankingData(); refreshAllData(); }}
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => setShowNewAccount({ open: true })}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, boxShadow: `0 6px 16px -6px ${teal[800]}` }}
          >
            <Plus size={14} /> Add Bank Account
          </button>
          <button
            onClick={() => setShowNewTransaction({ open: true, preset: { type: 'Deposit', date: getDefaultDate() } as any })}
            style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${teal[600]}`, background: paper, color: teal[700], cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}
          >
            <Plus size={14} /> New Transaction
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${hairline}`, overflowX: 'auto' }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <KpiCard label="Total Bank Balance" value={fmt(kpis.totalBalance, currency)} icon={<Landmark size={16} />} sub={`${kpis.activeCount} active accounts`} />
          <KpiCard label="Cash & Drawer" value={fmt(kpis.cashBalance, currency)} icon={<Wallet size={16} />} />
          <KpiCard label="Unreconciled" value={String(kpis.unreconciledCount)} icon={<AlertCircle size={16} />} tone={kpis.unreconciledCount > 0 ? 'warning' : 'positive'} sub="transactions pending" />
          <KpiCard label="This Month In" value={fmt(kpis.monthIn, currency)} icon={<ArrowDownCircle size={16} />} tone="positive" />
          <KpiCard label="This Month Out" value={fmt(kpis.monthOut, currency)} icon={<ArrowUpCircle size={16} />} tone="warning" />
          <KpiCard label="Net Movement" value={fmt(kpis.monthIn - kpis.monthOut, currency)} icon={<ArrowRightLeft size={16} />} tone={kpis.monthIn - kpis.monthOut >= 0 ? 'positive' : 'danger'} />

          {/* Recent activity */}
          <div style={{ gridColumn: '1 / -1', background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent Activity</h3>
            {store.transactions.length === 0 ? (
              <EmptyState module="banking" customTitle="No bank transactions yet" customDescription="Add a bank account and create your first transaction." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {store.transactions.slice(0, 6).map((t) => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: teal[50] }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: ink }}>{t.description}</div>
                      <div style={{ fontSize: 11, color: inkSoft }}>{t.date} · {t.type} · {store.accounts.find((a) => a.id === t.bankAccountId)?.name || '—'}</div>
                    </div>
                    <div style={{ fontWeight: 700, color: ['Deposit', 'Interest'].includes(t.type) ? emerald[600] : danger[600] }}>
                      {['Deposit', 'Interest'].includes(t.type) ? '+' : '−'}{fmt(t.amount, currency)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Accounts */}
      {tab === 'accounts' && (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, overflow: 'hidden' }}>
          {store.accounts.length === 0 ? (
            <div style={{ padding: 28 }}>
              <EmptyState module="banking" customTitle="No bank accounts yet" customDescription="Add your first bank account to begin tracking cash and bank activity." actionLabel="Add Bank Account" onAction={() => setShowNewAccount({ open: true })} />
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: teal[50], color: teal[800] }}>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Account</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Bank</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Book Balance</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Unreconciled</th>
                  <th style={{ textAlign: 'center', padding: '10px 12px', fontWeight: 700 }}>Status</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {store.accounts.map((a: any) => {
                  const active = a.status === 'Active';
                  const coaId = a.coaId || resolveBankCOAId(a);
                  const bookBal = coaBalances[coaId] ?? a.balance ?? 0;
                  const unreconciled = store.transactions.filter((t) => t.bankAccountId === a.id && !t.reconciled && (t as any).status !== 'Draft' && (t as any).status !== 'Reversed').length;
                  return (
                    <tr key={a.id} style={{ borderTop: `1px solid ${hairline}` }}>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ fontWeight: 600, color: ink }}>{a.name}</div>
                        <div style={{ fontSize: 11, color: inkSoft }}>{a.accountNumber} · {coaId || 'no COA map'}</div>
                      </td>
                      <td style={{ padding: '10px 12px', color: inkSoft }}>{a.bankName || '—'}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: bookBal >= 0 ? emerald[600] : danger[600] }}>{fmt(bookBal, currency)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: unreconciled > 0 ? amber[600] : inkSoft }}>{unreconciled}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <span style={{ padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: active ? emerald[50] : danger[50], color: active ? emerald[600] : danger[600] }}>
                          {a.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
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
          )}
        </div>
      )}

      {/* Transactions */}
      {tab === 'transactions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', background: paper, padding: 10, borderRadius: 12, border: `1px solid ${hairline}` }}>
            <div style={{ position: 'relative', flex: '1 1 220px' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description, reference, payee…" style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }} />
            </div>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Types</option>
              <option value="Deposit">Deposit</option>
              <option value="Withdrawal">Withdrawal</option>
              <option value="Transfer">Transfer</option>
              <option value="Fee">Fee</option>
              <option value="Interest">Interest</option>
              <option value="Payment">Payment</option>
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Statuses</option>
              <option value="Draft">Draft</option>
              <option value="Posted">Posted</option>
              <option value="Reversed">Reversed</option>
            </select>
            <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
              <option value="all">All Accounts</option>
              {store.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12 }} />
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, fontSize: 12 }} />
          </div>

          <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, overflow: 'hidden' }}>
            {filteredTxns.length === 0 ? (
              <div style={{ padding: 24 }}>
                <EmptyState module="banking" customTitle="No transactions match" customDescription="Adjust filters or create a new transaction." actionLabel="New Transaction" onAction={() => setShowNewTransaction({ open: true })} />
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: teal[50], color: teal[800] }}>
                    <th style={{ textAlign: 'left', padding: '10px 12px' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px' }}>Reference</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px' }}>Description</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px' }}>Account</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px' }}>In</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px' }}>Out</th>
                    <th style={{ textAlign: 'center', padding: '10px 12px' }}>Status</th>
                    <th style={{ textAlign: 'right', padding: '10px 12px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTxns.map((t: any) => {
                    const status = t.status || 'Posted';
                    const isIn = ['Deposit', 'Interest'].includes(t.type);
                    const acc = store.accounts.find((a) => a.id === t.bankAccountId);
                    return (
                      <tr key={t.id} style={{ borderTop: `1px solid ${hairline}` }}>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{t.date}</td>
                        <td style={{ padding: '10px 12px', color: inkSoft, whiteSpace: 'nowrap' }}>{t.reference || t.id}</td>
                        <td style={{ padding: '10px 12px' }}>{t.description}</td>
                        <td style={{ padding: '10px 12px', color: inkSoft }}>{acc?.name || '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: isIn ? emerald[600] : inkSoft, fontWeight: 600 }}>{isIn ? fmt(t.amount, currency) : ''}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: !isIn ? danger[600] : inkSoft, fontWeight: 600 }}>{!isIn ? fmt(t.amount, currency) : ''}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                          <span style={{
                            padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                            background: status === 'Posted' ? emerald[50] : status === 'Draft' ? amber[50] : danger[50],
                            color: status === 'Posted' ? emerald[600] : status === 'Draft' ? amber[600] : danger[600],
                          }}>
                            {status}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
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
        <ReconciliationTab onOpen={(accountId) => setShowReconcile({ open: true, accountId })} accounts={store.accounts as any} reconciliations={store.reconciliations as any} transactions={store.transactions as any} currency={currency} />
      )}

      {/* Reports */}
      {tab === 'reports' && (
        <ReportsTab
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          reconciliations={store.reconciliations as any}
          scheduledPayments={(store as any).scheduledPayments || []}
          currency={currency}
          coaBalances={coaBalances}
        />
      )}

      {/* Cash Management */}
      {tab === 'cash' && (
        <CashManagementTab
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          scheduledPayments={(store as any).scheduledPayments || []}
          receivables={(store as any).receivables || []}
          payables={(store as any).payables || []}
          currency={currency}
          coaBalances={coaBalances}
        />
      )}

      {/* Scheduled Transactions */}
      {tab === 'scheduled' && (
        <ScheduledTransactionsTab
          accounts={store.accounts as any}
          scheduledPayments={(store as any).scheduledPayments || []}
          currency={currency}
          onRefresh={() => store.fetchBankingData()}
          onCreateTransaction={(tx) => bankingService.createTransaction(tx as any).then(() => store.fetchBankingData())}
        />
      )}

      {/* Statements */}
      {tab === 'statements' && (
        <StatementsTab
          accounts={store.accounts as any}
          statements={(store as any).statements || []}
          currency={currency}
          onImport={(accountId) => setShowStatementImport({ open: true, accountId })}
        />
      )}

      {/* AI Assistant */}
      {tab === 'ai' && (
        <AIAssistantTab
          accounts={store.accounts as any}
          transactions={store.transactions as any}
          reconciliations={store.reconciliations as any}
          scheduledPayments={(store as any).scheduledPayments || []}
          currency={currency}
          coaBalances={coaBalances}
        />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reconcile a Bank Account</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: inkSoft }}>
          Match your book transactions against your bank statement. The system prevents completion unless the difference is zero.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {accounts.filter((a) => a.status === 'Active').map((a) => (
            <button
              key={a.id}
              onClick={() => onOpen(a.id)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: 14, borderRadius: 12, border: `1px solid ${hairline}`, background: '#fff', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontWeight: 600, color: ink, fontSize: 13 }}>{a.name}</span>
              <span style={{ fontSize: 11, color: inkSoft }}>{a.bankName}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: teal[700] }}>{fmt(a.balance || 0, currency)}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 14, padding: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent Reconciliations</h3>
        {reconciliations.length === 0 ? (
          <EmptyState module="banking" customTitle="No reconciliations yet" customDescription="Reconcile a bank account to start tracking your statement-to-book balance." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: teal[50] }}>
                <th style={{ textAlign: 'left', padding: 8 }}>Date</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Account</th>
                <th style={{ textAlign: 'right', padding: 8 }}>Book</th>
                <th style={{ textAlign: 'right', padding: 8 }}>Statement</th>
                <th style={{ textAlign: 'right', padding: 8 }}>Difference</th>
                <th style={{ textAlign: 'center', padding: 8 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {reconciliations.slice(0, 10).map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${hairline}` }}>
                  <td style={{ padding: 8 }}>{r.endDate}</td>
                  <td style={{ padding: 8 }}>{accounts.find((a) => a.id === r.bankAccountId)?.name || '—'}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{fmt(r.bookBalance, currency)}</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{fmt(r.endingBalance, currency)}</td>
                  <td style={{ padding: 8, textAlign: 'right', color: Math.abs(r.difference) < 0.01 ? emerald[600] : danger[600] }}>{fmt(r.difference, currency)}</td>
                  <td style={{ padding: 8, textAlign: 'center' }}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: paper, padding: 10, borderRadius: 10, border: `1px solid ${hairline}`, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Account</span>
        <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${hairline}`, fontSize: 12, background: paper }}>
          <option value="">All Accounts</option>
          {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button onClick={() => onImport(selectedAccountId || undefined)} style={{ marginLeft: 'auto', padding: '8px 14px', borderRadius: 7, border: 'none', background: `linear-gradient(155deg, ${teal[600]}, ${teal[800]})`, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Upload size={14} /> Import Statement (CSV)
        </button>
      </div>
      {filtered.length === 0 ? (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, padding: 20 }}>
          <EmptyState module="banking" customTitle="No statements imported yet" customDescription="Import a CSV bank statement to begin reconciliation. Duplicates are detected automatically." actionLabel="Import Statement" onAction={() => onImport(selectedAccountId || undefined)} />
        </div>
      ) : (
        <div style={{ background: paper, border: `1px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: teal[50], color: teal[800] }}>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Imported</th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Account</th>
                <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>File</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Rows</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Matched</th>
                <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Unmatched</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => (
                <tr key={s.id} style={{ borderTop: `1px solid ${hairline}` }}>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{(s.importedAt || '').slice(0, 10)}</td>
                  <td style={{ padding: '10px 12px' }}>{accounts.find((a) => a.id === s.bankAccountId)?.name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: inkSoft }}>{s.fileName || '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>{s.rowCount || 0}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: emerald[600] }}>{s.matchedCount || 0}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: (s.unmatchedCount || 0) > 0 ? danger[600] : inkSoft }}>{s.unmatchedCount || 0}</td>
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
