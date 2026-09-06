import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search,
  ChevronRight,
  ChevronDown,
  Plus,
  RefreshCw,
  FileSpreadsheet
} from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useAuth } from '../../context/AuthContext';
import { Account, AccountType, AccountGroup } from '../../types';
import { format, parseISO } from 'date-fns';
import { AccountDetailsDashboard } from './components/AccountDetailsDashboard';
import { NewAccountModal } from './components/NewAccountModal';
import { currencyService } from '../../services/currencyService';
import { ConfirmDialog, ConfirmDialogType } from '../../components/ConfirmDialog';

const teal = { 50: '#eef7f6', 100: '#d4ebe3', 200: '#a6d9d3', 400: '#3fa294', 500: '#2d9a8a', 600: '#1f8577', 700: '#166b5e', 800: '#0f544c', 900: '#0a3d34' };
const amber = { 50: '#fef9e7', 100: '#fef3c7', 200: '#fde68a', 400: '#d99a3f', 500: '#d99a3f', 600: '#b45309', 700: '#92400e', 800: '#78350f', 900: '#451a03' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const inkFaint = '#8C958D';
const hairline = '#e4ddd1';
const danger = '#B23B3B';
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
      balances[acc.id] = acc.opening_balance || 0;
    });

    // Apply ledger entries (type-aware)
    (ledger || []).forEach((entry: any) => {
      // Skip reversals
      if (entry.entryType === 'Reversal' || entry.referenceType === 'reversal') return;
      if (entry.amount == null) return;

      const debitAcc = (accounts || []).find((a: Account) => a.id === entry.debitAccountId || a.code === entry.debitAccountId || a.account_number === entry.debitAccountId);
      const creditAcc = (accounts || []).find((a: Account) => a.id === entry.creditAccountId || a.code === entry.creditAccountId || a.account_number === entry.creditAccountId);

      const isDebitNormal = (acc: Account) => {
        const t = acc.account_type || acc.type || '';
        return t === 'ASSET' || t === 'EXPENSE' || t === 'Asset' || t === 'Expense';
      };

      if (debitAcc && balances[debitAcc.id] !== undefined) {
        const sign = isDebitNormal(debitAcc) ? 1 : -1;
        balances[debitAcc.id] = (balances[debitAcc.id] || 0) + (entry.amount * sign);
      }
      if (creditAcc && balances[creditAcc.id] !== undefined) {
        const sign = isDebitNormal(creditAcc) ? -1 : 1;
        balances[creditAcc.id] = (balances[creditAcc.id] || 0) + (entry.amount * sign);
      }
    });

    return balances;
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
        await updateAccount(editingAccount.id, data);
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
      await updateAccount(account.id, { is_active: !account.is_active });
      notify(`Account ${account.is_active ? 'deactivated' : 'activated'}`, 'success');
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

  const renderAccountRow = (account: Account, depth: number = 0) => {
    const code = account.account_number || account.code || '';
    const isExpanded = expandedNodes.has(code);
    const hasChildren = accounts.some(a => a.parent_account_id === account.id);
    const balance = accountBalances[account.id] || 0;

    return (
      <div key={account.id} className="relative">
        <div
          className={`flex items-center gap-3 py-2.5 px-4 border-b transition-colors cursor-pointer ${depth === 0 ? 'font-semibold' : ''}`}
          style={{ borderColor: hairline, paddingLeft: `${depth * 1.5 + 1}rem` }}
          onClick={() => {
            if (hasChildren) toggleNode(code);
            setSelectedAccount(account);
          }}
        >
          <div className="w-5 h-5 flex items-center justify-center flex-none">
            {hasChildren ? (
              <button
                className="w-4 h-4 flex items-center justify-center hover:text-[var(--ink)] transition-colors"
                style={{ color: inkFaint }}
                onClick={(e) => { e.stopPropagation(); toggleNode(code); }}
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : null}
          </div>
          <span className="font-mono text-sm font-medium min-w-[5rem] flex-none" style={{ color: inkSoft }}>
            {code}
          </span>
          <span className="text-sm flex-1 min-w-0 truncate" style={{ color: ink }}>
            {account.name}
          </span>
          <span className={`font-mono text-sm flex-none min-w-[9rem] text-right ${balance < 0 ? '' : ''}`} style={{ color: ink }}>
            {formatCurrency(balance)}
          </span>
        </div>
        {isExpanded && hasChildren && (
          <div style={{ background: `${paper}` }}>
            {accounts
              .filter(a => a.parent_account_id === account.id)
              .map(child => renderAccountRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen" style={{ background: paper, color: ink, fontFamily: "'Inter', 'DM Sans', sans-serif" }}>
      <style>{`
        :root {
          --paper: ${paper};
          --panel: #F4F5EE;
          --stripe: rgba(30,38,32,0.028);
          --ink: ${ink};
          --ink-soft: ${inkSoft};
          --ink-faint: ${inkFaint};
          --rule: ${hairline};
          --rule-strong: #A7A995;
          --gold: ${gold};
          --red: #B23B3B;
          --assets: ${assets};
          --liabilities: ${liabilities};
          --equity: ${equity};
          --income: ${income};
          --expenses: ${expenses};
          --serif: "Source Serif 4", Georgia, serif;
          --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        }
        * { box-sizing: border-box; }
        body { margin: 0; -webkit-font-smoothing: antialiased; }
        ::selection { background: var(--gold); color: #fff; }
      `}</style>

      {/* Masthead */}
      <div className="pt-8 pb-6 px-6">
        <div className="text-sm tracking-wide mb-5" style={{ color: inkSoft }}>
          Prime ERP <span style={{ color: gold }}>·</span> ledger reference
        </div>
        <h1 className="text-3xl font-semibold mb-3 leading-tight" style={{ fontFamily: "'Source Serif 4', Georgia, serif", color: ink }}>
          Chart of accounts
        </h1>
        <p className="text-base mb-5 leading-relaxed max-w-3xl" style={{ color: inkSoft, fontFamily: "'Source Serif 4', Georgia, serif" }}>
          Every account Prime ERP posts against, arranged the way the general ledger reads them: by code, from the balance sheet down through the income statement, with the current trial balance carried alongside.
        </p>
        
        {/* Accounting Equation */}
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5 border rounded-[14px] text-sm" style={{ background: '#F4F5EE', borderColor: hairline, borderLeft: `4px solid ${gold}` }}>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ color: assets }}>Assets</span>
            <span style={{ color: inkSoft }}>{formatMK(totals.assets)}</span>
          </span>
          <span style={{ color: inkFaint }}>=</span>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ color: liabilities }}>Liabilities</span>
            <span style={{ color: inkSoft }}>{formatMK(totals.liabilities)}</span>
          </span>
          <span style={{ color: inkFaint }}>+</span>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ color: equity }}>Equity</span>
            <span style={{ color: inkSoft }}>{formatMK(totals.equity)}</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-xs whitespace-nowrap" style={{ color: isBalanced ? assets : '#B23B3B' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: isBalanced ? assets : '#B23B3B' }}></span>
            {isBalanced ? 'Balances' : 'Out of balance'}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="px-6 pb-4 border-b" style={{ borderColor: hairline }}>
        <div className="flex gap-4 items-center">
          <div className="flex-1 flex items-center gap-2 border px-4 py-2.5 rounded-[14px]" style={{ borderColor: hairline, background: '#F4F5EE' }}>
            <Search size={16} style={{ color: inkFaint }} className="flex-none" />
            <input
              type="text"
              placeholder="Find an account by code or name"
              className="flex-1 bg-transparent border-none outline-none text-sm"
              style={{ color: ink, placeholderColor: inkFaint, fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex gap-4 text-sm" style={{ color: inkSoft }}>
            <button onClick={expandAll} className="border-b pb-px hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors" style={{ borderColor: '#A7A995' }}>
              Expand all
            </button>
            <button onClick={collapseAll} className="border-b pb-px hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors" style={{ borderColor: '#A7A995' }}>
              Collapse all
            </button>
          </div>
        </div>
      </div>

      {/* Main Layout */}
      <div className="px-6 py-6 grid gap-8" style={{ gridTemplateColumns: '16rem 1fr' }}>
        {/* Navigation Rail */}
        <nav className="flex flex-col gap-1">
          <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: inkFaint, fontSize: 11, letterSpacing: '0.06em' }}>
            Categories
          </div>
          {ACCOUNT_TYPE_ORDER.map(type => {
            const config = ACCOUNT_CATEGORY_CONFIG[type];
            const count = groupedByType[type]?.accounts.length || 0;
            return (
              <a
                key={type}
                href={`#${type.toLowerCase()}`}
                className={`flex items-center gap-2.5 px-3 py-2 text-sm no-underline transition-all rounded-[10px]`}
                style={{
                  color: activeCategory === type ? ink : inkSoft,
                  background: activeCategory === type ? '#F4F5EE' : 'transparent',
                  borderLeft: `2px solid ${activeCategory === type ? gold : 'transparent'}`,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  const el = categoryRefs.current[type];
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                <span 
                  className="w-2 h-2 rounded-full flex-none"
                  style={{ backgroundColor: config.color }}
                />
                <span className="flex-1">{config.label}</span>
                <span className="text-xs" style={{ color: inkFaint }}>{count}</span>
              </a>
            );
          })}
          <div className="mt-4 pt-3 border-t text-xs" style={{ borderColor: hairline, color: inkFaint }}>
            <b className="font-semibold" style={{ color: ink }}>{totalAccounts}</b> accounts total
          </div>
        </nav>

        {/* Main Content */}
        <main>
          <div className="space-y-8">
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
                >
                  {/* Category Header */}
                  <div className="flex items-center gap-3 mb-3 pb-2.5" style={{ borderBottom: `2px solid ${hairline}` }}>
                    <div 
                      className="w-1 self-stretch rounded-full"
                      style={{ backgroundColor: config.color }}
                    />
                    <h2 className="text-xl font-semibold" style={{ fontFamily: "'Source Serif 4', Georgia, serif", color: ink }}>
                      {config.label}
                    </h2>
                    <span className="ml-auto text-xs font-mono" style={{ color: inkFaint }}>{config.range}</span>
                  </div>

                  {/* Table Header */}
                  <div className="flex items-center gap-3 px-4 py-2.5 text-xs border-b" style={{ color: inkFaint, borderColor: '#A7A995', background: '#F4F5EE' }}>
                    <span className="w-5 flex-none"></span>
                    <span className="w-16 flex-none font-mono">Code</span>
                    <span className="flex-1 font-serif">Account</span>
                    <span className="w-32 text-right font-mono" style={{ borderLeft: `1px solid ${hairline}`, paddingLeft: 12 }}>Balance</span>
                  </div>

                  {/* Account List */}
                  <div className="border-x border-b rounded-b-[14px] overflow-hidden" style={{ borderColor: hairline }}>
                    {rootAccounts.map(account => renderAccountRow(account, 0))}
                  </div>

                  {searchTerm && rootAccounts.length === 0 && (
                    <div className="py-4 px-4 text-sm" style={{ color: inkFaint }}>
                      No accounts match that search.
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {filteredAccounts.length === 0 && (
            <div className="py-16 text-center" style={{ color: inkFaint }}>
              <Search size={36} className="mx-auto mb-4 opacity-40" />
              <p className="text-sm font-medium" style={{ color: inkSoft }}>No accounts found</p>
              <p className="text-xs mt-1.5">Try adjusting your search</p>
            </div>
          )}
        </main>
      </div>

      {/* Footer */}
      <footer className="px-6 py-5 mt-4 border-t text-xs" style={{ borderColor: hairline, color: inkFaint }}>
        Prime ERP · chart of accounts, {totalAccounts} accounts across {Object.values(groupedByType).filter(g => g.accounts.length > 0).length} categories. Balances shown in {companyConfig?.currencySymbol || currency}, current trial balance.
      </footer>

      {/* Account Details Dashboard */}
      {drilldownAccount && (
        <AccountDetailsDashboard
          account={drilldownAccount}
          onClose={() => setDrilldownAccount(null)}
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

      {/* Confirm Dialog */}
      <ConfirmDialog
        {...confirmState}
        onClose={() => setConfirmState(s => ({ ...s, open: false }))}
      />
    </div>
  );
};

export default ChartOfAccounts;
