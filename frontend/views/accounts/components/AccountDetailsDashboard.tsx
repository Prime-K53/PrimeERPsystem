import { useMemo, useState, useEffect } from 'react';
import {
  Landmark, TrendingUp, History, Shield, Activity, X,
  Search, Filter, Download, Pencil, Eye, EyeOff,
  ChevronLeft, ChevronRight, Calendar, FileText,
  BookOpen, Settings, CreditCard, ArrowUpRight, ArrowDownLeft
} from 'lucide-react';
import type { Account, AuditLogEntry as TimelineAuditLogEntry } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useFinance } from '../../../context/FinanceContext';
import { auditLogService } from '../../../services/auditLogService';
import type { AuditLogEntry } from '../../../services/auditLogService';
import { AuditTimeline } from '../../shared/components/AuditTimeline';
import { currencyService } from '../../../services/currencyService';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, AreaChart, Area
} from 'recharts';
import { ResponsiveContainer } from '@/components/charts/ResponsiveContainer';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isWithinInterval } from 'date-fns';
import { ConfirmDialog, ConfirmDialogType } from '../../../components/ConfirmDialog';

interface AccountDetailsDashboardProps {
  account: Account;
  onClose: () => void;
  onEdit?: (account: Account) => void;
}

type TabType = 'ledger' | 'details' | 'audit';

const ITEMS_PER_PAGE = 20;

export const AccountDetailsDashboard: React.FC<AccountDetailsDashboardProps> = ({ account, onClose, onEdit }) => {
  const { companyConfig, checkPermission, notify } = useAuth();
  const { ledger, accounts, updateAccount } = useFinance();
  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

  const [activeTab, setActiveTab] = useState<TabType>('ledger');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [dateRangeFilter, setDateRangeFilter] = useState<'all' | '7d' | '30d' | '90d' | 'thisMonth' | 'lastMonth' | 'custom'>('thisMonth');
  const [customDateRange, setCustomDateRange] = useState({ start: '', end: '' });
  const [currentPage, setCurrentPage] = useState(1);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    type?: ConfirmDialogType;
    onConfirm?: () => void;
  }>({ open: false, title: '', message: '' });

  const canEdit = checkPermission('accounts.edit');

  const accountEntries = useMemo(() => {
    return (ledger || []).filter((e: any) =>
      e.debitAccountId === account.id ||
      e.debitAccountId === account.code ||
      e.creditAccountId === account.id ||
      e.creditAccountId === account.code
    ).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [ledger, account]);

  const filteredEntries = useMemo(() => {
    let entries = accountEntries;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      entries = entries.filter((e: any) =>
        (e.description || '').toLowerCase().includes(term) ||
        (e.referenceId || '').toLowerCase().includes(term) ||
        String(e.amount).includes(term)
      );
    }

    const now = new Date();
    let startDate: Date | null = null;

    switch (dateRangeFilter) {
      case '7d':
        startDate = subMonths(now, 1 / 4);
        break;
      case '30d':
        startDate = subMonths(now, 1);
        break;
      case '90d':
        startDate = subMonths(now, 3);
        break;
      case 'thisMonth':
        startDate = startOfMonth(now);
        break;
      case 'lastMonth':
        const lastMonth = subMonths(now, 1);
        startDate = startOfMonth(lastMonth);
        break;
      case 'custom':
        if (customDateRange.start) {
          startDate = parseISO(customDateRange.start);
        }
        break;
      default:
        startDate = null;
    }

    if (startDate) {
      entries = entries.filter((e: any) => {
        const entryDate = new Date(e.date);
        return entryDate >= startDate!;
      });
    }

    if (customDateRange.end) {
      const endDate = parseISO(customDateRange.end);
      entries = entries.filter((e: any) => {
        const entryDate = new Date(e.date);
        return entryDate <= endDate;
      });
    }

    return entries;
  }, [accountEntries, searchTerm, dateRangeFilter, customDateRange]);

  const paginatedEntries = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredEntries.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredEntries, currentPage]);

  const totalPages = Math.ceil(filteredEntries.length / ITEMS_PER_PAGE);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, dateRangeFilter, customDateRange]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setAuditLoading(true);
      const data = await auditLogService.getEntityLogs('Account', account.code || account.id);
      const auditMap = new Map<string, AuditLogEntry>();

      (data ?? []).forEach((log: any) => {
        const entry: AuditLogEntry = {
          id: String(log.id ?? ''),
          timestamp: String(log.timestamp ?? log.date ?? new Date().toISOString()),
          action: String(log.action ?? 'LEDGER'),
          entity_type: String(log.entity_type ?? log.entityType ?? 'Account'),
          entity_id: String(log.entity_id ?? log.entityId ?? ''),
          user_id: String(log.user_id ?? log.userId ?? ''),
          details_json: log.details_json,
          details: log.details,
          correlation_id: log.correlation_id ?? log.correlationId,
          ip_address: log.ip_address,
          user_agent: log.user_agent,
          status: String(log.status || 'LOCAL')
        };
        const key = `${entry.action}-${entry.entity_id}-${entry.timestamp}-${entry.details ?? entry.details_json ?? ''}`;
        auditMap.set(key, entry);
      });

      if (!cancelled) {
        const merged = Array.from(auditMap.values())
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setAuditLogs(merged);
        setAuditLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [account.code, account.id]);

  const stats = useMemo(() => {
    let balance = 0;
    let totalDebit = 0;
    let totalCredit = 0;
    const isAssetOrExpense = account.type === 'Asset' || account.type === 'Expense';

    accountEntries.forEach((entry: any) => {
      const isDebit = entry.debitAccountId === account.id || entry.debitAccountId === account.code;
      const isCredit = entry.creditAccountId === account.id || entry.creditAccountId === account.code;

      if (isDebit) totalDebit += entry.amount;
      if (isCredit) totalCredit += entry.amount;

      if (isAssetOrExpense) {
        if (isDebit) balance += entry.amount;
        if (isCredit) balance -= entry.amount;
      } else {
        if (isCredit) balance += entry.amount;
        if (isDebit) balance -= entry.amount;
      }
    });

    const chartData = [...accountEntries].reverse().slice(-90).map((entry: any) => {
      const isDebit = entry.debitAccountId === account.id || entry.debitAccountId === account.code;
      return {
        date: entry.date,
        balance: isAssetOrExpense
          ? (isDebit ? balance : balance - entry.amount)
          : (isDebit ? balance + entry.amount : balance),
        amount: entry.amount,
        type: isDebit ? 'Debit' : 'Credit'
      };
    });

    return { balance, totalDebit, totalCredit, chartData };
  }, [accountEntries, account]);

  const parentAccount = useMemo(() => {
    if (!account.parent_account_id) return null;
    return accounts.find(a =>
      a.id === account.parent_account_id ||
      a.code === account.parent_account_id ||
      a.account_number === account.parent_account_id
    );
  }, [account, accounts]);

  const childAccounts = useMemo(() => {
    return accounts.filter(a =>
      a.parent_account_id === account.id ||
      a.parent_account_id === account.code ||
      a.parent_account_id === account.account_number
    );
  }, [account, accounts]);

  const handleExportCSV = () => {
    const headers = ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Reference'];
    const rows = filteredEntries.map((entry: any) => {
      const isDebit = entry.debitAccountId === account.id || entry.debitAccountId === account.code;
      return [
        new Date(entry.date).toLocaleDateString(),
        entry.description || '',
        isDebit ? entry.amount.toFixed(2) : '',
        !isDebit ? entry.amount.toFixed(2) : '',
        '',
        entry.referenceId || ''
      ];
    });

    const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${account.name.replace(/\s+/g, '_')}_ledger_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Ledger exported to CSV', 'success');
  };

  const handleToggleActive = () => {
    setConfirmState({
      open: true,
      title: account.is_active ? 'Deactivate Account' : 'Activate Account',
      message: `Are you sure you want to ${account.is_active ? 'deactivate' : 'activate'} "${account.name}"? ${account.is_active ? 'Inactive accounts cannot be used for new transactions.' : ''}`,
      confirmText: account.is_active ? 'Deactivate' : 'Activate',
      type: 'warning',
      onConfirm: async () => {
        try {
          await updateAccount(account.id, { is_active: !account.is_active });
          notify(`Account ${account.is_active ? 'deactivated' : 'activated'} successfully`, 'success');
          setConfirmState(s => ({ ...s, open: false }));
        } catch (err: any) {
          notify(err.message || 'Failed to update account', 'error');
        }
      }
    });
  };

  const handleEdit = () => {
    if (onEdit) {
      onEdit(account);
    }
  };

  const tabs = [
    { id: 'ledger' as TabType, label: 'Ledger', icon: BookOpen },
    { id: 'details' as TabType, label: 'Details', icon: Settings },
    { id: 'audit' as TabType, label: 'Audit Trail', icon: Shield }
  ];

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-6xl h-[90vh] rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Compact Header */}
        <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-50 to-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-sm">
              <Landmark size={20} />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-gray-900">{account.name}</h2>
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded-full">
                  {account.code || account.account_number}
                </span>
                {!account.is_active && (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full">
                    Inactive
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500 mt-0.5">
                <span className="flex items-center gap-1">
                  <Activity size={12} className="text-emerald-500" />
                  {account.type} Account
                </span>
                {account.account_group && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>{account.account_group.replace(/_/g, ' ')}</span>
                  </>
                )}
                <span className="text-gray-300">·</span>
                <span className="font-medium">{filteredEntries.length} transactions</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <>
                <button
                  onClick={handleEdit}
                  className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  title="Edit account"
                >
                  <Pencil size={18} />
                </button>
                <button
                  onClick={handleToggleActive}
                  className="p-2 text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                  title={account.is_active ? 'Deactivate' : 'Activate'}
                >
                  {account.is_active ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Stats Bar */}
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50 flex items-center gap-6 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase">Balance</span>
            <span className={`text-sm font-bold tabular-nums ${stats.balance >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
              {stats.balance < 0 ? '(' : ''}{currency}{Math.abs(stats.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}{stats.balance < 0 ? ')' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ArrowUpRight size={14} className="text-red-500" />
            <span className="text-[10px] font-bold text-gray-400 uppercase">Debits</span>
            <span className="text-sm font-bold text-gray-700 tabular-nums">
              {currency}{stats.totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ArrowDownLeft size={14} className="text-emerald-500" />
            <span className="text-[10px] font-bold text-gray-400 uppercase">Credits</span>
            <span className="text-sm font-bold text-gray-700 tabular-nums">
              {currency}{stats.totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] font-bold text-gray-400 uppercase">Normal</span>
            <span className="text-xs font-semibold text-gray-600">{account.normal_balance || 'DEBIT'}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-5 border-b border-gray-200 bg-white flex items-center gap-1 shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-hidden">
          {/* LEDGER TAB */}
          {activeTab === 'ledger' && (
            <div className="h-full flex flex-col">
              {/* Filters */}
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-4 shrink-0">
                <div className="flex-1 relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search transactions..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                  />
                </div>
                <select
                  value={dateRangeFilter}
                  onChange={e => setDateRangeFilter(e.target.value as any)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="all">All Time</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                  <option value="90d">Last 90 Days</option>
                  <option value="thisMonth">This Month</option>
                  <option value="lastMonth">Last Month</option>
                </select>
                <button
                  onClick={handleExportCSV}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Download size={14} />
                  Export
                </button>
              </div>

              {/* Table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase">Date</th>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase">Description</th>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase text-right">Debit</th>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase text-right">Credit</th>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase text-right">Running Balance</th>
                      <th className="px-4 py-3 text-[10px] font-bold text-gray-500 uppercase">Ref</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {paginatedEntries.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-12 text-center text-gray-400 text-sm">
                          No transactions found
                        </td>
                      </tr>
                    ) : (
                      paginatedEntries.map((entry: any, idx: number) => {
                        const isDebit = entry.debitAccountId === account.id || entry.debitAccountId === account.code;
                        const globalIndex = (currentPage - 1) * ITEMS_PER_PAGE + idx;
                        const prevEntries = filteredEntries.slice(0, globalIndex + 1);
                        let runningBalance = 0;
                        const isAssetOrExpense = account.type === 'Asset' || account.type === 'Expense';

                        prevEntries.forEach((e: any, i: number) => {
                          const debit = e.debitAccountId === account.id || e.debitAccountId === account.code;
                          const credit = e.creditAccountId === account.id || e.creditAccountId === account.code;
                          if (isAssetOrExpense) {
                            if (debit) runningBalance += e.amount;
                            if (credit) runningBalance -= e.amount;
                          } else {
                            if (credit) runningBalance += e.amount;
                            if (debit) runningBalance -= e.amount;
                          }
                        });

                        return (
                          <tr key={entry.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {format(new Date(entry.date), 'dd MMM yyyy')}
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-900">{entry.description || '—'}</span>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {isDebit ? (
                                <span className="font-medium text-red-600">
                                  {currency}{entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {!isDebit ? (
                                <span className="font-medium text-emerald-600">
                                  {currency}{entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              <span className={`font-semibold ${runningBalance >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
                                {runningBalance < 0 ? '(' : ''}{currency}{Math.abs(runningBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}{runningBalance < 0 ? ')' : ''}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded font-mono">
                                {entry.referenceId || '—'}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between shrink-0">
                  <span className="text-xs text-gray-500">
                    Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to {Math.min(currentPage * ITEMS_PER_PAGE, filteredEntries.length)} of {filteredEntries.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-sm font-medium">{currentPage} / {totalPages}</span>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* DETAILS TAB */}
          {activeTab === 'details' && (
            <div className="h-full overflow-auto p-5">
              <div className="grid grid-cols-2 gap-6">
                {/* Account Info */}
                <div className="bg-gray-50 rounded-xl p-4">
                  <h3 className="text-xs font-bold text-gray-500 uppercase mb-4">Account Information</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Account Name</span>
                      <span className="text-sm font-semibold text-gray-900">{account.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Account Code</span>
                      <span className="text-sm font-mono font-semibold text-gray-900">{account.code || account.account_number}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Account Number</span>
                      <span className="text-sm font-mono text-gray-900">{account.account_number || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Account Type</span>
                      <span className="text-sm font-semibold text-gray-900">{account.type || account.account_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Account Group</span>
                      <span className="text-sm text-gray-900">{account.account_group?.replace(/_/g, ' ') || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Subtype</span>
                      <span className="text-sm text-gray-900">{account.subtype || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Classification */}
                <div className="bg-gray-50 rounded-xl p-4">
                  <h3 className="text-xs font-bold text-gray-500 uppercase mb-4">Classification</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Normal Balance</span>
                      <span className="text-sm font-semibold text-gray-900">{account.normal_balance || 'DEBIT'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Allow Posting</span>
                      <span className="text-sm font-semibold text-gray-900">{account.allow_posting ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">System Account</span>
                      <span className="text-sm font-semibold text-gray-900">{account.is_system_account ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Status</span>
                      <span className={`text-sm font-semibold ${account.is_active ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {account.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Opening Balance</span>
                      <span className="text-sm font-semibold text-gray-900">
                        {currency}{(account.opening_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Hierarchy */}
                <div className="bg-gray-50 rounded-xl p-4">
                  <h3 className="text-xs font-bold text-gray-500 uppercase mb-4">Hierarchy</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Parent Account</span>
                      <span className="text-sm font-semibold text-gray-900">
                        {parentAccount ? `${parentAccount.name} (${parentAccount.code || parentAccount.account_number})` : 'Root Account'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Child Accounts</span>
                      <span className="text-sm font-semibold text-gray-900">
                        {childAccounts.length} sub-account{childAccounts.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  {childAccounts.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Sub-Accounts</p>
                      <div className="space-y-1">
                        {childAccounts.slice(0, 5).map(child => (
                          <div key={child.id} className="flex justify-between text-sm">
                            <span className="text-gray-700">{child.name}</span>
                            <span className="font-mono text-gray-500">{child.code || child.account_number}</span>
                          </div>
                        ))}
                        {childAccounts.length > 5 && (
                          <p className="text-xs text-gray-400">+{childAccounts.length - 5} more</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Balance Summary */}
                <div className="bg-gray-50 rounded-xl p-4">
                  <h3 className="text-xs font-bold text-gray-500 uppercase mb-4">Balance Summary</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Current Balance</span>
                      <span className={`text-sm font-bold ${stats.balance >= 0 ? 'text-gray-900' : 'text-red-600'}`}>
                        {stats.balance < 0 ? '(' : ''}{currency}{Math.abs(stats.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}{stats.balance < 0 ? ')' : ''}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Total Debits</span>
                      <span className="text-sm font-semibold text-red-600">
                        {currency}{stats.totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Total Credits</span>
                      <span className="text-sm font-semibold text-emerald-600">
                        {currency}{stats.totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Transaction Count</span>
                      <span className="text-sm font-semibold text-gray-900">{accountEntries.length}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AUDIT TAB */}
          {activeTab === 'audit' && (
            <div className="h-full overflow-auto p-5">
              {auditLoading ? (
                <div className="text-center py-12 text-gray-400 text-sm">Loading audit trail...</div>
              ) : auditLogs.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  <Shield size={32} className="mx-auto mb-2 opacity-50" />
                  No audit logs found for this account
                </div>
              ) : (
                <AuditTimeline logs={auditLogs as TimelineAuditLogEntry[]} title={`Audit Trail: ${account.code}`} />
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        {...confirmState}
        onClose={() => setConfirmState(s => ({ ...s, open: false }))}
      />
    </div>
  );
};
