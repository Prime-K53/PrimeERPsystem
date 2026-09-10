import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search,
  ChevronRight,
  ChevronDown,
  Plus,
  RefreshCw,
  FileSpreadsheet,
  MoreVertical,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  BookOpen,
  BarChart3,
  Copy
} from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useAuth } from '../../context/AuthContext';
import { Account, AccountType, AccountGroup } from '../../types';
import { format, parseISO } from 'date-fns';
import { AccountDetailsDashboard } from './components/AccountDetailsDashboard';
import { NewAccountModal } from './components/NewAccountModal';
import { currencyService } from '../../services/currencyService';
import { ConfirmDialogType } from '../../components/ConfirmDialog';
import { computeHierarchicalBalances } from '../../services/transactions/_internal';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './components/financeChrome';

const inkFaint = '#8C958D';
const assets = '#3F6D5C';
const liabilities = '#A14E3C';
const equity = '#4B4E76';
const income = '#8A7B3D';
const expenses = '#6B3F52';
const gold = '#8C703F';

const ACCOUNT_CATEGORY_CONFIG: Record<string, { label: string; color: string; range: string }> = {
  ASSET: { label: 'Assets', color: assets, range: '10000–12999' },
  LIABILITY: { label: 'Liabilities', color: liabilities, range: '20000–22999' },
  EQUITY: { label: 'Equity', color: equity, range: '30000–34999' },
  INCOME: { label: 'Income', color: income, range: '40000–42999' },
  EXPENSE: { label: 'Expenses', color: expenses, range: '50000–54999' },
};

const ACCOUNT_TYPE_ORDER: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const ChartOfAccounts: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    accounts,
    ledger,
    addAccount,
    updateAccount,
    deleteAccount,
    fetchFinanceData
  } = useFinance();
  const { checkPermission, notify, companyConfig } = useAuth();

  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [parentForNew, setParentForNew] = useState<Account | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showStandardChartDialog, setShowStandardChartDialog] = useState(false);
  const [isCreatingStandard, setIsCreatingStandard] = useState(false);
  const [drilldownAccount, setDrilldownAccount] = useState<Account | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>('ASSET');
  const [actionMenuAccountId, setActionMenuAccountId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    type?: ConfirmDialogType;
    onConfirm?: () => void;
  }>({ open: false, title: '', message: '' });

  const canEdit = checkPermission('accounts.edit');
  const categoryRefs = useRef<Record<string, HTMLElement | null>>({});

  const formatCurrency = (value: number) => {
    const abs = Math.abs(value);
    const formatted = `${currency}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return value < 0 ? `(${formatted})` : formatted;
  };

  const formatMK = (n: number) => {
    const abs = Math.abs(Math.round(n)).toLocaleString('en-US');
    return n < 0 ? `(${currency} ${abs})` : `${currency} ${abs}`;
  };

  const filteredAccounts = useMemo(() => {
    if (!searchTerm) return accounts;
    const term = searchTerm.toLowerCase();
    return accounts.filter(a =>
      (a.name || '').toLowerCase().includes(term) ||
      (a.account_number || a.code || '').toLowerCase().includes(term) ||
      (a.description || '').toLowerCase().includes(term)
    );
  }, [accounts, searchTerm]);

  // Calculate account balances from ledger (type-aware, excluding reversals)
  const accountBalances = useMemo(() => {
    const balances: Record<string, number> = {};

    // Initialize with opening balances from accounts
    (accounts || []).forEach((acc: Account) => {
      const openingBalance = acc.opening_balance || 0;
      const normalBalance = acc.normal_balance || 'DEBIT';
      balances[acc.id] = normalBalance === 'CREDIT' ? -openingBalance : openingBalance;
    });

    // Apply ledger entries (type-aware)
    (ledger || []).forEach((entry: any) => {
      // Skip reversals
      if (entry.entryType === 'Reversal' || entry.referenceType === 'reversal') return;
      if (entry.amount == null) return;

      const debitAcc = (accounts || []).find((a: Account) => a.id === entry.debitAccountId || a.code === entry.debitAccountId || a.account_number === entry.debitAccountId);
      const creditAcc = (accounts || []).find((a: Account) => a.id === entry.creditAccountId || a.code === entry.creditAccountId || a.account_number === entry.creditAccountId);

      const getNormalBalance = (acc: Account): 'DEBIT' | 'CREDIT' => {
        if (acc.normal_balance === 'CREDIT' || acc.normal_balance === 'DEBIT') {
          return acc.normal_balance;
        }
        const t = (acc.account_type || acc.type || '').toUpperCase();
        if (t === 'ASSET' || t === 'EXPENSE') return 'DEBIT';
        if (t === 'LIABILITY' || t === 'EQUITY' || t === 'INCOME') return 'CREDIT';
        return 'DEBIT';
      };

      if (debitAcc && balances[debitAcc.id] !== undefined) {
        const normal = getNormalBalance(debitAcc);
        const sign = normal === 'DEBIT' ? 1 : -1;
        balances[debitAcc.id] = (balances[debitAcc.id] || 0) + (entry.amount * sign);
      }
      if (creditAcc && balances[creditAcc.id] !== undefined) {
        const normal = getNormalBalance(creditAcc);
        const sign = normal === 'DEBIT' ? -1 : 1;
        balances[creditAcc.id] = (balances[creditAcc.id] || 0) + (entry.amount * sign);
      }
    });

    // Hierarchical rollup: parent accounts aggregate their descendants
    const hierarchicalBalances = computeHierarchicalBalances(accounts, balances, {
      respectNormalBalance: true
    });

    return hierarchicalBalances;
  }, [accounts, ledger]);

  const groupedByType = useMemo(() => {
    const groups: Record<string, { accounts: Account[]; total: number }> = {};

    ACCOUNT_TYPE_ORDER.forEach(type => {
      groups[type] = { accounts: [], total: 0 };
    });

    filteredAccounts.forEach(acc => {
      const type = acc.account_type || 'ASSET';
      if (!groups[type]) {
        groups[type] = { accounts: [], total: 0 };
      }
      groups[type].accounts.push(acc);
      const balance = accountBalances[acc.id] || 0;
      groups[type].total += balance;
    });

    return groups;
  }, [filteredAccounts, accountBalances]);

  const totals = useMemo(() => {
    const result = { assets: 0, liabilities: 0, equity: 0, income: 0, expenses: 0 };
    Object.entries(groupedByType).forEach(([type, data]) => {
      if (type === 'ASSET') result.assets = data.total;
      else if (type === 'LIABILITY') result.liabilities = data.total;
      else if (type === 'EQUITY') result.equity = data.total;
      else if (type === 'INCOME') result.income = data.total;
      else if (type === 'EXPENSE') result.expenses = data.total;
    });
    return result;
  }, [groupedByType]);

  const isBalanced = Math.abs(totals.assets - (totals.liabilities + totals.equity)) < 0.01;
  const totalAccounts = Object.values(groupedByType).reduce((sum, g) => sum + g.accounts.length, 0);

  const toggleNode = (code: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  const expandAll = () => {
    const allCodes = new Set<string>();
    filteredAccounts.forEach(acc => {
      if (acc.account_number || acc.code) {
        allCodes.add(String(acc.account_number || acc.code));
      }
    });
    setExpandedNodes(allCodes);
  };

  const collapseAll = () => {
    setExpandedNodes(new Set());
  };

  const handleOpenModal = (account?: Account | null, parent?: Account | null) => {
    setEditingAccount(account || null);
    setParentForNew(parent || null);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingAccount(null);
    setParentForNew(null);
  };

  const handleSubmitAccount = async (data: Partial<Account>) => {
    setIsSubmitting(true);
    try {
      if (editingAccount) {
        const updatedAccount = { ...editingAccount, ...data };
        await updateAccount(updatedAccount);
        notify('Account updated successfully', 'success');
      } else {
        await addAccount(data as Account);
        notify('Account created successfully', 'success');
      }
      handleCloseModal();
    } catch (err: any) {
      notify(err.message || 'Failed to save account', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = (account: Account) => {
    if (account.is_system_account) {
      notify('Cannot delete system accounts', 'error');
      return;
    }
    setConfirmState({
      open: true,
      title: 'Delete Account',
      message: `Are you sure you want to delete "${account.name}"? This action cannot be undone.`,
      confirmText: 'Delete',
      type: 'danger',
      onConfirm: async () => {
        try {
          await deleteAccount(account.id);
          notify('Account deleted successfully', 'success');
          setConfirmState(s => ({ ...s, open: false }));
        } catch (err: any) {
          notify(err.message || 'Failed to delete account', 'error');
        }
      }
    });
  };

  const handleToggleActive = async (account: Account) => {
    try {
      const newStatus = !account.is_active;
      const updatedAccount = { ...account, is_active: newStatus };
      await updateAccount(updatedAccount);
      notify(`Account ${newStatus ? 'activated' : 'deactivated'}`, 'success');
    } catch (err: any) {
      notify(err.message || 'Failed to update account', 'error');
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('data-category');
            if (id) setActiveCategory(id);
          }
        });
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );

    Object.values(categoryRefs.current).forEach(ref => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, [groupedByType]);

  // Close action menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setActionMenuAccountId(null);
      }
    };
    if (actionMenuAccountId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [actionMenuAccountId]);

  const renderAccountRow = (account: Account, depth: number = 0) => {
    const code = account.account_number || account.code || '';
    const isExpanded = expandedNodes.has(code);
    // parent_account_id can be stored as either UUID (ACC-XXXX) or numeric (XXXXX)
    // So we compare using account_number which is always numeric
    const accountNum = account.account_number || account.code || '';
    const hasChildren = accounts.some(a =>
      (a.parent_account_id === accountNum) ||
      (a.parent_account_id === account.id)
    );
    const balance = accountBalances[account.id] || 0;
    const isMenuOpen = actionMenuAccountId === account.id;

    const handleActionClick = (action: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setActionMenuAccountId(null);

      switch (action) {
        case 'view-ledger':
          setDrilldownAccount(account);
          break;
        case 'view-details':
          setDrilldownAccount(account);
          break;
        case 'rename':
          handleOpenModal(account, null);
          break;
        case 'toggle-active':
          handleToggleActive(account);
          break;
        case 'delete':
          handleDelete(account);
          break;
        case 'copy-code':
          navigator.clipboard.writeText(accountNum);
          notify(`Copied ${accountNum} to clipboard`, 'success');
          break;
        case 'add-child':
          handleOpenModal(null, account);
          break;
      }
    };

    return (
      <div key={account.id} className="relative">
        <div
          className={`flex items-center gap-3 py-2.5 px-4 border-b cursor-pointer ${depth === 0 ? 'font-semibold' : ''}`}
          style={{ borderColor: hairline, paddingLeft: `${depth * 1.5 + 1}rem`, transition: 'background .12s' }}
          onMouseEnter={e => e.currentTarget.style.background = teal[50]}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          onClick={() => {
            if (hasChildren) toggleNode(code);
            setSelectedAccount(account);
          }}
        >
          <div className="w-5 h-5 flex items-center justify-center flex-none">
            {hasChildren ? (
              <button
                style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: inkSoft, border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 6 }}
                onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={(e) => { e.stopPropagation(); toggleNode(code); }}
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : null}
          </div>
          <span className="font-mono text-sm font-medium min-w-[5rem] flex-none" style={{ color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>
            {code}
          </span>
          <span className="text-sm flex-1 min-w-0 truncate" style={{ color: ink, fontWeight: depth === 0 ? 600 : 400 }}>
            {account.name}
          </span>
          {!account.is_active && (
            <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, background: amber[100], color: amber[600] }}>
              Inactive
            </span>
          )}
          <span className="font-mono text-sm flex-none min-w-[9rem] text-right" style={{ color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
            {formatCurrency(balance)}
          </span>
          {/* Quick Action Menu */}
          <div className="relative flex-none ml-4" ref={isMenuOpen ? actionMenuRef : undefined}>
            <button
              style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: inkSoft }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={(e) => { e.stopPropagation(); setActionMenuAccountId(isMenuOpen ? null : account.id); }}
              title="Actions"
            >
              <MoreVertical size={14} />
            </button>
            {isMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 py-1 w-48 rounded-lg shadow-lg border z-50"
                style={{ background: paper, borderColor: hairline }}
              >
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                  style={{ color: ink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={(e) => handleActionClick('view-ledger', e)}
                >
                  <BookOpen size={14} />
                  View Ledger
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                  style={{ color: ink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={(e) => handleActionClick('view-details', e)}
                >
                  <BarChart3 size={14} />
                  Account Details
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                  style={{ color: ink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={(e) => handleActionClick('rename', e)}
                >
                  <Pencil size={14} />
                  Rename
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                  style={{ color: ink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={(e) => handleActionClick('add-child', e)}
                >
                  <Plus size={14} />
                  Add Sub-Account
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                  style={{ color: ink, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={(e) => handleActionClick('copy-code', e)}
                >
                  <Copy size={14} />
                  Copy Code
                </button>
                {canEdit && (
                  <>
                    <div className="my-1 border-t" style={{ borderColor: hairline }} />
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: account.is_active ? amber[600] : teal[700], background: 'transparent', border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      onClick={(e) => handleActionClick('toggle-active', e)}
                    >
                      {account.is_active ? <EyeOff size={14} /> : <Eye size={14} />}
                      {account.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    {!account.is_system_account && (
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                        style={{ color: danger, background: 'transparent', border: 'none', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#fdeeee'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        onClick={(e) => handleActionClick('delete', e)}
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {isExpanded && hasChildren && (
          <div style={{ background: `${paper}` }}>
            {accounts
              .filter(a => (a.parent_account_id === accountNum) || (a.parent_account_id === account.id))
              .map(child => renderAccountRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const kpiItems = [
    { label: 'Assets', value: formatMK(totals.assets), icon: BookOpen, color: teal[700], bg: teal[50] },
    { label: 'Liabilities', value: formatMK(totals.liabilities), icon: BookOpen, color: amber[600], bg: amber[100] },
    { label: 'Equity', value: formatMK(totals.equity), icon: BarChart3, color: teal[700], bg: teal[50] },
    { label: isBalanced ? 'Balanced' : 'Out of balance', value: `${totalAccounts} accounts`, icon: BookOpen, color: isBalanced ? teal[700] : danger, bg: isBalanced ? teal[50] : '#fdeeee' },
  ];

  return (
    <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
      <PageHeader
        icon={<BookOpen size={19} color="#fff" />}
        title="Chart of Accounts"
        subtitle="Ledger reference — accounts by code with trial balance"
        actions={<>
          <button onClick={expandAll} style={btnGhostStyle}
            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
          >
            Expand all
          </button>
          <button onClick={collapseAll} style={btnGhostStyle}
            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
          >
            Collapse all
          </button>
          {canEdit && (
            <button onClick={() => handleOpenModal(null, null)} style={btnPrimaryStyle}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <Plus size={15} />
              New Account
            </button>
          )}
        </>}
      />

      <KpiCards items={kpiItems} />

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
          <input
            type="text"
            placeholder="Find an account by code or name"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 34, fontFamily: "'JetBrains Mono', monospace" }}
          />
        </div>
      </div>

      {/* Main Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '14rem 1fr', gap: 20, padding: '0 28px 28px', flex: 1, overflow: 'hidden' }}>
        {/* Navigation Rail */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ ...sectionLabelStyle, margin: '4px 0 10px' }}><span>Categories</span></div>
          {ACCOUNT_TYPE_ORDER.map(type => {
            const config = ACCOUNT_CATEGORY_CONFIG[type];
            const count = groupedByType[type]?.accounts.length || 0;
            return (
              <a
                key={type}
                href={`#${type.toLowerCase()}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', fontSize: 13, textDecoration: 'none',
                  borderRadius: 9, transition: 'background .12s',
                  color: activeCategory === type ? teal[800] : inkSoft,
                  background: activeCategory === type ? teal[50] : 'transparent',
                  borderLeft: `3px solid ${activeCategory === type ? teal[600] : 'transparent'}`,
                  fontWeight: activeCategory === type ? 700 : 500,
                }}
                onMouseEnter={e => { if (activeCategory !== type) e.currentTarget.style.background = teal[50]; }}
                onMouseLeave={e => { if (activeCategory !== type) e.currentTarget.style.background = 'transparent'; }}
                onClick={(e) => {
                  e.preventDefault();
                  const el = categoryRefs.current[type];
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                <span
                  style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, backgroundColor: config.color }}
                />
                <span style={{ flex: 1 }}>{config.label}</span>
                <span style={{ fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{count}</span>
              </a>
            );
          })}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${hairline}`, fontSize: 11.5, color: inkSoft }}>
            <b style={{ fontWeight: 700, color: ink }}>{totalAccounts}</b> accounts total
          </div>
        </nav>

        {/* Main Content */}
        <main style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {ACCOUNT_TYPE_ORDER.map(type => {
              const config = ACCOUNT_CATEGORY_CONFIG[type];
              const group = groupedByType[type];
              if (!group || group.accounts.length === 0) return null;

              const rootAccounts = group.accounts.filter(a => !a.parent_account_id);

              return (
                <section
                  key={type}
                  id={type.toLowerCase()}
                  data-category={type}
                  ref={el => { categoryRefs.current[type] = el; }}
                  className="scroll-mt-6"
                  style={tableCard}
                >
                  {/* Category Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${hairline}` }}>
                    <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, backgroundColor: config.color }} />
                    <h2 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontWeight: 400, fontSize: 18, margin: 0, color: teal[800] }}>
                      {config.label}
                    </h2>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: inkSoft, fontFamily: "'JetBrains Mono', monospace" }}>{config.range}</span>
                  </div>

                  {/* Table Header */}
                  <div style={{ ...tableHeadRow, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
                    <span style={{ width: 20, flexShrink: 0 }}></span>
                    <span style={{ width: 80, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace" }}>Code</span>
                    <span style={{ flex: 1 }}>Account</span>
                    <span style={{ width: 144, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", paddingRight: 16 }}>Balance</span>
                    <span style={{ width: 48, flexShrink: 0, textAlign: 'center', marginLeft: 16 }}>Actions</span>
                  </div>

                  {/* Account List */}
                  <div style={{ overflow: 'hidden' }}>
                    {rootAccounts.map(account => renderAccountRow(account, 0))}
                  </div>

                  {searchTerm && rootAccounts.length === 0 && (
                    <div style={{ padding: '16px', fontSize: 13, color: inkSoft }}>
                      No accounts match that search.
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {filteredAccounts.length === 0 && (
            <EmptyState icon={<Search size={32} />} title="No accounts found" hint="Try adjusting your search" />
          )}
        </main>
      </div>

      {/* Footer */}
      <footer style={{ padding: '14px 28px', borderTop: `1px solid ${hairline}`, fontSize: 11.5, color: inkSoft, background: paper }}>
        Prime ERP · chart of accounts, {totalAccounts} accounts across {Object.values(groupedByType).filter(g => g.accounts.length > 0).length} categories. Balances shown in {companyConfig?.currencySymbol || currency}, current trial balance.
      </footer>

      {/* Account Details Dashboard */}
      {drilldownAccount && (
        <AccountDetailsDashboard
          account={drilldownAccount}
          onClose={() => setDrilldownAccount(null)}
          onEdit={(account) => {
            setDrilldownAccount(null);
            handleOpenModal(account, null);
          }}
        />
      )}

      {/* New/Edit Account Modal */}
      <NewAccountModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onSubmit={handleSubmitAccount}
        account={editingAccount}
        parentAccount={parentForNew}
        accounts={accounts}
        isSubmitting={isSubmitting}
      />

      {/* Confirm Dialog — danger chrome */}
      {confirmState.open && (
        <div style={modalOverlayStyle} onClick={() => setConfirmState(s => ({ ...s, open: false }))}>
          <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
            <AccentStripe />
            <ModalHeader
              icon={<Trash2 size={19} color="#fff" />}
              title={confirmState.title || 'Confirm'}
              subtitle="This action cannot be undone"
              onClose={() => setConfirmState(s => ({ ...s, open: false }))}
              dangerTile
            />
            <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
              <p style={{ fontSize: 13.5, color: ink, margin: 0, lineHeight: 1.6 }}>{confirmState.message}</p>
            </div>
            <ModalFooter
              stepLabel="Confirm · destructive"
              onCancel={() => setConfirmState(s => ({ ...s, open: false }))}
              submitLabel={confirmState.confirmText || 'Confirm'}
              onSubmit={() => confirmState.onConfirm?.()}
              danger
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ChartOfAccounts;
