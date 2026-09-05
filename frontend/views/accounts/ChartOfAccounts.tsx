import React, { useState, useMemo, useEffect } from 'react';
import { logger } from '@/services/logger';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Landmark,
  Plus,
  Search,
  X,
  CheckCircle,
  AlertCircle,
  FolderTree,
  RefreshCw,
  FileSpreadsheet
} from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useAuth } from '../../context/AuthContext';
import { Account, AccountType, AccountGroup } from '../../types';
import { format, parseISO } from 'date-fns';
import { AccountDetailsDashboard } from './components/AccountDetailsDashboard';
import { AccountTree } from './components/AccountTree';
import { NewAccountModal } from './components/NewAccountModal';
import { currencyService } from '../../services/currencyService';
import { ConfirmDialog, ConfirmDialogType } from '../../components/ConfirmDialog';

const ACCOUNT_TYPES: (AccountType | 'All')[] = ['All', 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const ACCOUNT_GROUPS: (AccountGroup | 'All')[] = [
  'All',
  'CURRENT_ASSET',
  'FIXED_ASSET',
  'CURRENT_LIABILITY',
  'LONG_TERM_LIABILITY',
  'EQUITY',
  'REVENUE',
  'OTHER_INCOME',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_EXPENSE'
];

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

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<AccountType | 'All'>('All');
  const [filterGroup, setFilterGroup] = useState<AccountGroup | 'All'>('All');
  const [filterStatus, setFilterStatus] = useState<'All' | 'Active' | 'Inactive'>('All');

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [parentForNew, setParentForNew] = useState<Account | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Standard Chart Dialog
  const [showStandardChartDialog, setShowStandardChartDialog] = useState(false);
  const [isCreatingStandard, setIsCreatingStandard] = useState(false);

  // Confirm Dialog State
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    type?: ConfirmDialogType;
    onConfirm?: () => void;
  }>({ open: false, title: '', message: '' });

  // Drilldown State
  const [drilldownAccount, setDrilldownAccount] = useState<Account | null>(null);

  const canEdit = checkPermission('accounts.edit');

  // Handle incoming account drilldown from other modules
  useEffect(() => {
    if (location.state?.accountId && accounts.length > 0) {
      const account = accounts.find(
        a => a.id === location.state.accountId ||
        a.code === location.state.accountId ||
        a.account_number === location.state.accountId
      );
      if (account) {
        setDrilldownAccount(account);
        // Expand all parents
        let parentId = account.parent_account_id;
        while (parentId) {
          setExpandedIds(prev => new Set([...prev, parentId!]));
          const parent = accounts.find(a => a.id === parentId);
          parentId = parent?.parent_account_id;
        }
        navigate(location.pathname, { replace: true, state: {} });
      }
    }
  }, [location.state, accounts, navigate, location.pathname]);

  // Calculate account balances
  const accountBalances = useMemo(() => {
    const balances: Record<string, number> = {};
    const accountMap = new Map(accounts.map(a => [a.id, a]));

    // Initialize with opening balances
    accounts.forEach(acc => {
      const openingBalance = acc.opening_balance || 0;
      const isDebitNormal = acc.account_type === 'ASSET' || acc.account_type === 'EXPENSE';
      balances[acc.id] = isDebitNormal ? openingBalance : -openingBalance;
    });

    // Apply ledger entries
    (ledger || []).forEach(entry => {
      const debitAcc = accountMap.get(entry.debitAccountId || '');
      const creditAcc = accountMap.get(entry.creditAccountId || '');

      if (debitAcc) {
        const isDebitNormal = debitAcc.account_type === 'ASSET' || debitAcc.account_type === 'EXPENSE';
        balances[debitAcc.id] = (balances[debitAcc.id] || 0) + (isDebitNormal ? entry.amount : -entry.amount);
      }

      if (creditAcc) {
        const isDebitNormal = creditAcc.account_type === 'ASSET' || creditAcc.account_type === 'EXPENSE';
        balances[creditAcc.id] = (balances[creditAcc.id] || 0) + (isDebitNormal ? -entry.amount : entry.amount);
      }
    });

    return balances;
  }, [accounts, ledger]);

  // Filter accounts
  const filteredAccounts = useMemo(() => {
    return accounts.filter(a => {
      if (filterType !== 'All' && a.account_type !== filterType && a.type?.toUpperCase() !== filterType) {
        return false;
      }
      if (filterGroup !== 'All' && a.account_group !== filterGroup) {
        return false;
      }
      if (filterStatus === 'Active' && !a.is_active) return false;
      if (filterStatus === 'Inactive' && a.is_active) return false;

      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const matchName = (a.name || '').toLowerCase().includes(term);
        const matchNumber = (a.account_number || a.code || '').toLowerCase().includes(term);
        const matchDesc = (a.description || '').toLowerCase().includes(term);
        if (!matchName && !matchNumber && !matchDesc) return false;
      }

      return true;
    });
  }, [accounts, filterType, filterGroup, filterStatus, searchTerm]);

  const handleOpenModal = (account?: Account, parent?: Account | null) => {
    if (!canEdit) return;
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
        await updateAccount({ ...editingAccount, ...data } as Account);
        notify('Account updated successfully', 'success');
      } else {
        const newAccount: Account = {
          id: `ACC-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          name: data.name || '',
          account_type: data.account_type || 'ASSET',
          account_number: data.account_number || '',
          account_group: data.account_group,
          subtype: data.subtype,
          parent_account_id: data.parent_account_id,
          normal_balance: data.account_type === 'ASSET' || data.account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
          is_system_account: false,
          allow_posting: data.allow_posting !== false,
          is_active: data.is_active !== false,
          opening_balance: data.opening_balance || 0,
          opening_balance_date: data.opening_balance_date,
          description: data.description,
          balance: 0
        };
        await addAccount(newAccount);
        notify('Account created successfully', 'success');
      }
      handleCloseModal();
    } catch (err: any) {
      logger.error(err);
      notify(`Error saving account: ${err.message}`, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = (account: Account) => {
    if (!canEdit) return;

    if (account.is_system_account) {
      notify('System accounts cannot be deleted', 'error');
      return;
    }

    const hasChildren = accounts.some(a => a.parent_account_id === account.id);
    const hasTransactions = (ledger || []).some(
      e => e.debitAccountId === account.id || e.creditAccountId === account.id
    );

    let message = `Are you sure you want to delete "${account.name}"?`;
    if (hasChildren) {
      message = `Cannot delete "${account.name}" because it has sub-accounts. Remove sub-accounts first.`;
      setConfirmState({
        open: true,
        title: 'Cannot Delete',
        message,
        type: 'warning',
        confirmText: 'OK'
      });
      return;
    }
    if (hasTransactions) {
      message = `"${account.name}" has transaction history. Deactivating it is recommended. Delete anyway?`;
      setConfirmState({
        open: true,
        title: 'Delete Account',
        message,
        type: 'danger',
        confirmText: 'Delete',
        onConfirm: async () => {
          try {
            await deleteAccount(account.id);
            notify('Account deleted', 'info');
          } catch (err: any) {
            notify(`Delete failed: ${err.message}`, 'error');
          }
        }
      });
      return;
    }

    setConfirmState({
      open: true,
      title: 'Delete Account',
      message: `Are you sure you want to permanently delete "${account.name}"? This cannot be undone.`,
      type: 'danger',
      confirmText: 'Delete',
      onConfirm: async () => {
        try {
          await deleteAccount(account.id);
          notify('Account deleted', 'info');
        } catch (err: any) {
          notify(`Delete failed: ${err.message}`, 'error');
        }
      }
    });
  };

  const handleToggleActive = async (account: Account) => {
    if (!canEdit) return;

    const hasTransactions = (ledger || []).some(
      e => e.debitAccountId === account.id || e.creditAccountId === account.id
    );

    if (account.is_active && hasTransactions) {
      notify('Cannot deactivate account with transaction history', 'error');
      return;
    }

    try {
      await updateAccount({ ...account, is_active: !account.is_active } as Account);
      notify(`Account ${account.is_active ? 'deactivated' : 'activated'}`, 'success');
    } catch (err: any) {
      notify(`Error: ${err.message}`, 'error');
    }
  };

  const handleCreateStandardChart = async () => {
    setIsCreatingStandard(true);
    try {
      const response = await fetch('/api/accounts/standard-chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: companyConfig?.companyId })
      });

      if (!response.ok) {
        throw new Error('Failed to create standard chart');
      }

      const result = await response.json();
      await fetchFinanceData();
      setShowStandardChartDialog(false);
      notify(
        `Standard chart created: ${result.created} new accounts, ${result.skipped} already existed`,
        'success'
      );
    } catch (err: any) {
      notify(`Error creating standard chart: ${err.message}`, 'error');
    } finally {
      setIsCreatingStandard(false);
    }
  };

  const isEmpty = accounts.length === 0;

  return (
    <div className="p-6 max-w-[1800px] mx-auto h-[calc(100vh-4rem)] flex flex-col relative">
      {/* Header */}
      <div className="mb-6 flex flex-col md:flex-row justify-between md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-2 tracking-tight uppercase">
            <Landmark className="text-blue-600" size={24} />
            Chart of Accounts
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {isEmpty
              ? 'Set up your accounting structure'
              : `${accounts.length} accounts`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {canEdit && (
            <>
              {accounts.length === 0 && (
                <button
                  onClick={() => setShowStandardChartDialog(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 font-bold uppercase text-[11px] tracking-widest shadow-lg shadow-emerald-100 transition-all"
                >
                  <FileSpreadsheet size={16} />
                  Create Standard Chart
                </button>
              )}

              <button
                onClick={() => handleOpenModal()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold uppercase text-[11px] tracking-widest shadow-lg shadow-blue-100 transition-all"
              >
                <Plus size={16} />
                Add Account
              </button>
            </>
          )}
        </div>
      </div>

      {/* Empty State */}
      {isEmpty && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <FolderTree size={40} className="text-slate-400" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">No accounts yet</h2>
            <p className="text-slate-500 mb-6">
              Set up your standard chart of accounts to start recording transactions and building your financial reports.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => setShowStandardChartDialog(true)}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold transition-all shadow-lg shadow-blue-100"
              >
                <FileSpreadsheet size={18} />
                Create Standard Chart of Accounts
              </button>
              <button
                onClick={() => handleOpenModal()}
                className="flex items-center justify-center gap-2 px-6 py-3 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold transition-all"
              >
                <Plus size={18} />
                Add Account Manually
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      {!isEmpty && (
        <div className="bg-white/70 backdrop-blur-xl rounded-2xl shadow-sm border border-white/60 flex flex-col min-h-0 flex-1 overflow-hidden">
          {/* Toolbar */}
          <div className="p-4 border-b border-slate-200/60 flex flex-col md:flex-row gap-4 justify-between bg-slate-50/30">
            <div className="flex flex-wrap items-center gap-2">
              {/* Type Filter */}
              <select
                className="px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={filterType}
                onChange={e => setFilterType(e.target.value as AccountType | 'All')}
              >
                {ACCOUNT_TYPES.map(type => (
                  <option key={type} value={type}>
                    {type === 'All' ? 'All Types' : type.charAt(0) + type.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>

              {/* Group Filter */}
              <select
                className="px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={filterGroup}
                onChange={e => setFilterGroup(e.target.value as AccountGroup | 'All')}
              >
                {ACCOUNT_GROUPS.map(group => (
                  <option key={group} value={group}>
                    {group === 'All' ? 'All Groups' : group.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>

              {/* Status Filter */}
              <select
                className="px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as 'All' | 'Active' | 'Inactive')}
              >
                <option value="All">All Status</option>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>

            {/* Search */}
            <div className="relative w-full md:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                placeholder="Search accounts..."
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Table Header */}
          <div className="grid items-center py-3 bg-slate-50/80 backdrop-blur text-slate-500 font-bold border-b border-slate-200/60 text-[9px] uppercase tracking-widest" style={{ gridTemplateColumns: '180px 1fr 140px 140px 36px' }}>
            <div className="text-left px-4">Account Type</div>
            <div className="text-left">Account Name</div>
            <div className="text-right">Account Balance</div>
            <div className="text-right">Total Balance</div>
            <div className="text-center"></div>
          </div>

          {/* Account Tree */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <AccountTree
              accounts={filteredAccounts}
              onSelectAccount={setSelectedAccount}
              onEditAccount={(acc) => handleOpenModal(acc)}
              onDeleteAccount={handleDelete}
              onAddSubAccount={(acc) => handleOpenModal(undefined, acc)}
              onViewLedger={setDrilldownAccount}
              onToggleActive={handleToggleActive}
              selectedAccountId={selectedAccount?.id}
              searchTerm={searchTerm}
              balances={accountBalances}
              currencySymbol={currency}
              canEdit={canEdit}
            />

            {filteredAccounts.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <Search size={48} className="mb-4 opacity-50" />
                <p className="text-sm font-medium">No accounts found</p>
                <p className="text-xs mt-1">Try adjusting your search or filters</p>
              </div>
            )}
          </div>
        </div>
      )}

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
        currencySymbol={currency}
        isSubmitting={isSubmitting}
      />

      {/* Standard Chart Dialog */}
      {showStandardChartDialog && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fadeIn border border-slate-200">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center">
                  <FileSpreadsheet size={24} className="text-emerald-600" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Create Standard Chart</h2>
                  <p className="text-sm text-slate-500">Add the standard accounting structure</p>
                </div>
              </div>

              <p className="text-sm text-slate-600 mb-6">
                This will create the standard Prime ERP accounting hierarchy including:
              </p>

              <ul className="text-sm text-slate-600 mb-6 space-y-1">
                <li className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-emerald-500" />
                  Assets (Current & Fixed)
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-emerald-500" />
                  Liabilities (Current & Long-Term)
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-emerald-500" />
                  Equity accounts
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-emerald-500" />
                  Income accounts
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-emerald-500" />
                  Expense accounts
                </li>
              </ul>

              <p className="text-xs text-slate-400 mb-6">
                Existing accounts will not be deleted or duplicated.
                This operation is idempotent.
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowStandardChartDialog(false)}
                  className="flex-1 py-3 border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-colors"
                  disabled={isCreatingStandard}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateStandardChart}
                  className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  disabled={isCreatingStandard}
                >
                  {isCreatingStandard ? 'Creating...' : 'Create Chart'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => !open && setConfirmState(c => ({ ...c, open: false }))}
        onConfirm={() => {
          confirmState.onConfirm?.();
          setConfirmState(c => ({ ...c, open: false }));
        }}
        onCancel={() => setConfirmState(c => ({ ...c, open: false }))}
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        type={confirmState.type || 'question'}
      />
    </div>
  );
};

export default ChartOfAccounts;
