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
import { ConfirmDialogType } from '../../../components/ConfirmDialog';
import { getCanonicalAccountType, isPostedLedgerEntry } from '../../../services/accountingEngine';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './financeChrome';

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
    const accountNumber = (account as any).account_number;
    return (ledger || []).filter((e: any) =>
      e.debitAccountId === account.id ||
      e.debitAccountId === account.code ||
      e.debitAccountId === accountNumber ||
      e.creditAccountId === account.id ||
      e.creditAccountId === account.code ||
      e.creditAccountId === accountNumber
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
    // Canonical type resolution (synced accounts may only carry account_type).
    const canonicalType = getCanonicalAccountType(account as any);
    const isAssetOrExpense = canonicalType === 'ASSET' || canonicalType === 'EXPENSE';
    const touches = (ref: unknown): boolean =>
      ref === account.id || ref === account.code || ref === (account as any).account_number;

    accountEntries.forEach((entry: any) => {
      // Balance and totals reflect posted truth; the ledger tab itself still
      // lists every row for audit visibility.
      if (!isPostedLedgerEntry(entry)) return;
      const isDebit = touches(entry.debitAccountId);
      const isCredit = touches(entry.creditAccountId);

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

    const chartData = [...accountEntries]
      .filter((entry: any) => isPostedLedgerEntry(entry))
      .reverse().slice(-90).map((entry: any) => {
      const isDebit = touches(entry.debitAccountId);
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
      const isDebit = entry.debitAccountId === account.id || entry.debitAccountId === account.code || entry.debitAccountId === (account as any).account_number;
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

  const kpiItems = [
    { label: 'Balance', value: `${stats.balance < 0 ? '(' : ''}${currency}${Math.abs(stats.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}${stats.balance < 0 ? ')' : ''}`, icon: Activity, color: stats.balance >= 0 ? teal[700] : danger, bg: stats.balance >= 0 ? teal[50] : '#fdeeee' },
    { label: 'Debits', value: `${currency}${stats.totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, icon: ArrowUpRight, color: danger, bg: '#fdeeee' },
    { label: 'Credits', value: `${currency}${stats.totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, icon: ArrowDownLeft, color: teal[700], bg: teal[50] },
  ];

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={{ ...modalShell(800), height: '90vh' }} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<Landmark size={19} color="#fff" />}
          title={account.name}
          subtitle={`${account.code || account.account_number} · ${account.type || account.account_type} Account · ${filteredEntries.length} transactions${account.is_active ? '' : ' · Inactive'}${account.account_group ? ` · ${account.account_group.replace(/_/g, ' ')}` : ''}`}
          onClose={onClose}
        />
        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 28px', borderBottom: `1px solid ${hairline}`, background: paper }}>
            <button onClick={handleEdit} title="Edit account"
              style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Pencil size={16} style={{ color: inkSoft }} />
            </button>
            <button onClick={handleToggleActive} title={account.is_active ? 'Deactivate' : 'Activate'}
              style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {account.is_active ? <EyeOff size={16} style={{ color: inkSoft }} /> : <Eye size={16} style={{ color: teal[600] }} />}
            </button>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: inkSoft }}>Normal: <b style={{ color: ink }}>{account.normal_balance || 'DEBIT'}</b></span>
          </div>
        )}

        <div style={{ padding: '0 28px' }}>
          <KpiCards items={kpiItems} />
        </div>

        {/* Tabs */}
        <div style={{ padding: '12px 28px 0', borderBottom: `1px solid ${hairline}`, background: paper, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', fontSize: 13,
                fontWeight: activeTab === tab.id ? 700 : 500, cursor: 'pointer',
                border: 'none', background: 'transparent',
                borderBottom: activeTab === tab.id ? `2px solid ${teal[600]}` : '2px solid transparent',
                color: activeTab === tab.id ? teal[700] : inkSoft,
              }}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* LEDGER TAB */}
          {activeTab === 'ledger' && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              {/* Filters */}
              <div style={{ padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                  <input
                    type="text"
                    placeholder="Search transactions..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    style={{ ...inputStyle, paddingLeft: 34 }}
                  />
                </div>
                <select
                  value={dateRangeFilter}
                  onChange={e => setDateRangeFilter(e.target.value as any)}
                  style={{ ...selectStyle, width: 170 }}
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
                  style={btnGhostStyle}
                  onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                  onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                >
                  <Download size={15} />
                  Export
                </button>
              </div>

              {/* Table */}
              <div style={{ flex: 1, overflow: 'auto', padding: '0 28px' }}>
                <div style={tableCard}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr style={tableHeadRow}>
                      <th style={{ padding: '12px 16px', fontWeight: 700 }}>Date</th>
                      <th style={{ padding: '12px 16px', fontWeight: 700 }}>Description</th>
                      <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Debit</th>
                      <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Credit</th>
                      <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Running Balance</th>
                      <th style={{ padding: '12px 16px', fontWeight: 700 }}>Ref</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedEntries.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center' }}>
                          <EmptyState icon={<BookOpen size={32} />} title="No transactions found" hint="Try adjusting filters." />
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
                          <tr key={entry.id} style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                            onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <td style={{ padding: '12px 16px', fontSize: 13, color: inkSoft }}>
                              {format(new Date(entry.date), 'dd MMM yyyy')}
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <span style={{ fontWeight: 600, fontSize: 13, color: ink }}>{entry.description || '—'}</span>
                            </td>
                            <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                              {isDebit ? (
                                <span style={{ fontWeight: 600, color: danger }}>
                                  {currency}{entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span style={{ color: hairline }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                              {!isDebit ? (
                                <span style={{ fontWeight: 600, color: teal[700] }}>
                                  {currency}{entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </span>
                              ) : (
                                <span style={{ color: hairline }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                              <span style={{ fontWeight: 700, color: runningBalance >= 0 ? ink : danger }}>
                                {runningBalance < 0 ? '(' : ''}{currency}{Math.abs(runningBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}{runningBalance < 0 ? ')' : ''}
                              </span>
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <span style={{ padding: '3px 10px', background: teal[50], color: inkSoft, fontSize: 11, borderRadius: 20, fontFamily: "'JetBrains Mono', monospace" }}>
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
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ padding: '12px 28px', borderTop: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: paper }}>
                  <span style={{ fontSize: 11.5, color: inkSoft }}>
                    Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to {Math.min(currentPage * ITEMS_PER_PAGE, filteredEntries.length)} of {filteredEntries.length}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', opacity: currentPage === 1 ? 0.4 : 1 }}
                      onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span style={{ fontSize: 13, fontWeight: 600, color: ink }}>{currentPage} / {totalPages}</span>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', opacity: currentPage === totalPages ? 0.4 : 1 }}
                      onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
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
            <div style={{ height: '100%', overflow: 'auto', padding: '20px 28px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Account Info */}
                <div style={{ background: teal[50], borderRadius: 12, padding: 16, border: `1px solid ${teal[100]}` }}>
                  <div style={sectionLabelStyle}><span>Account Information</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Account Name</span>
                      <span style={{ fontWeight: 600, color: ink }}>{account.name}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Account Code</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: ink }}>{account.code || account.account_number}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Account Number</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: ink }}>{account.account_number || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Account Type</span>
                      <span style={{ fontWeight: 600, color: ink }}>{account.type || account.account_type}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Account Group</span>
                      <span style={{ color: ink }}>{account.account_group?.replace(/_/g, ' ') || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Subtype</span>
                      <span style={{ color: ink }}>{account.subtype || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Classification */}
                <div style={{ background: teal[50], borderRadius: 12, padding: 16, border: `1px solid ${teal[100]}` }}>
                  <div style={sectionLabelStyle}><span>Classification</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Normal Balance</span>
                      <span style={{ fontWeight: 600, color: ink }}>{account.normal_balance || 'DEBIT'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Allow Posting</span>
                      <span style={{ fontWeight: 600, color: ink }}>{account.allow_posting ? 'Yes' : 'No'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>System Account</span>
                      <span style={{ fontWeight: 600, color: ink }}>{account.is_system_account ? 'Yes' : 'No'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Status</span>
                      <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, background: account.is_active ? '#d1fae5' : amber[100], color: account.is_active ? '#065f46' : amber[600] }}>
                        {account.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Opening Balance</span>
                      <span style={{ fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>
                        {currency}{(account.opening_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Hierarchy */}
                <div style={{ background: teal[50], borderRadius: 12, padding: 16, border: `1px solid ${teal[100]}` }}>
                  <div style={sectionLabelStyle}><span>Hierarchy</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Parent Account</span>
                      <span style={{ fontWeight: 600, color: ink }}>
                        {parentAccount ? `${parentAccount.name} (${parentAccount.code || parentAccount.account_number})` : 'Root Account'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Child Accounts</span>
                      <span style={{ fontWeight: 600, color: ink }}>
                        {childAccounts.length} sub-account{childAccounts.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  {childAccounts.length > 0 && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${hairline}` }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 8px' }}>Sub-Accounts</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {childAccounts.slice(0, 5).map(child => (
                          <div key={child.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                            <span style={{ color: ink }}>{child.name}</span>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}>{child.code || child.account_number}</span>
                          </div>
                        ))}
                        {childAccounts.length > 5 && (
                          <p style={{ fontSize: 11.5, color: inkSoft }}>+{childAccounts.length - 5} more</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Balance Summary */}
                <div style={{ background: teal[50], borderRadius: 12, padding: 16, border: `1px solid ${teal[100]}` }}>
                  <div style={sectionLabelStyle}><span>Balance Summary</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Current Balance</span>
                      <span style={{ fontWeight: 700, color: stats.balance >= 0 ? ink : danger, fontFamily: "'JetBrains Mono', monospace" }}>
                        {stats.balance < 0 ? '(' : ''}{currency}{Math.abs(stats.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}{stats.balance < 0 ? ')' : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Total Debits</span>
                      <span style={{ fontWeight: 600, color: danger, fontFamily: "'JetBrains Mono', monospace" }}>
                        {currency}{stats.totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Total Credits</span>
                      <span style={{ fontWeight: 600, color: teal[700], fontFamily: "'JetBrains Mono', monospace" }}>
                        {currency}{stats.totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: inkSoft }}>Transaction Count</span>
                      <span style={{ fontWeight: 600, color: ink }}>{accountEntries.length}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AUDIT TAB */}
          {activeTab === 'audit' && (
            <div style={{ height: '100%', overflow: 'auto', padding: '20px 28px' }}>
              {auditLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, fontSize: 13, color: inkSoft }}>Loading audit trail...</div>
              ) : auditLogs.length === 0 ? (
                <EmptyState icon={<Shield size={32} />} title="No audit logs found for this account" hint="Activity will appear here once posted." />
              ) : (
                <AuditTimeline logs={auditLogs as TimelineAuditLogEntry[]} title={`Audit Trail: ${account.code}`} />
              )}
            </div>
          )}
        </div>
        <ModalFooter stepLabel="Account · ledger detail" onCancel={onClose} submitLabel="Done" onSubmit={onClose} />
      </div>

      {confirmState.open && (
        <div style={modalOverlayStyle} onClick={() => setConfirmState(s => ({ ...s, open: false }))}>
          <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
            <AccentStripe />
            <ModalHeader
              icon={<Shield size={19} color="#fff" />}
              title={confirmState.title || 'Confirm'}
              subtitle="Please confirm this action"
              onClose={() => setConfirmState(s => ({ ...s, open: false }))}
              dangerTile
            />
            <div style={{ padding: '24px 28px 8px' }}>
              <p style={{ fontSize: 13.5, color: ink, margin: 0, lineHeight: 1.6 }}>{confirmState.message}</p>
            </div>
            <ModalFooter
              stepLabel="Confirm · account"
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
