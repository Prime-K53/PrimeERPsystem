import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  MoreHorizontal,
  Lock,
  Edit2,
  Trash2,
  Plus,
  Eye,
  History,
  PowerOff,
  Power,
  Building2,
  Landmark,
  TrendingUp,
  TrendingDown,
  Wallet,
  CreditCard,
  DollarSign,
  Receipt,
  Package,
  Settings,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import { Account } from '../../types';

interface AccountTreeProps {
  accounts: Account[];
  onSelectAccount: (account: Account) => void;
  onEditAccount: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
  onAddSubAccount: (account: Account) => void;
  onViewLedger: (account: Account) => void;
  onToggleActive: (account: Account) => void;
  selectedAccountId?: string;
  searchTerm?: string;
  balances?: Record<string, number>;
  currencySymbol?: string;
  canEdit?: boolean;
}

interface AccountRowProps {
  account: Account;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddSubAccount: () => void;
  onViewLedger: () => void;
  onToggleActive: () => void;
  balance?: number;
  currencySymbol: string;
  canEdit: boolean;
}

const ACCOUNT_TYPE_CONFIG: Record<string, { label: string; color: string; bgColor: string; icon: React.ReactNode }> = {
  ASSET: { label: 'Asset', color: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200', icon: <Building2 size={12} /> },
  LIABILITY: { label: 'Liability', color: 'text-red-700', bgColor: 'bg-red-50 border-red-200', icon: <CreditCard size={12} /> },
  EQUITY: { label: 'Equity', color: 'text-violet-700', bgColor: 'bg-violet-50 border-violet-200', icon: <Wallet size={12} /> },
  INCOME: { label: 'Revenue', color: 'text-green-700', bgColor: 'bg-green-50 border-green-200', icon: <TrendingUp size={12} /> },
  EXPENSE: { label: 'Expense', color: 'text-orange-700', bgColor: 'bg-orange-50 border-orange-200', icon: <TrendingDown size={12} /> },
};

const getAccountTypeConfig = (type?: string) => {
  return ACCOUNT_TYPE_CONFIG[type || 'ASSET'] || ACCOUNT_TYPE_CONFIG['ASSET'];
};

const SUBTYPE_CONFIG: Record<string, { label: string; bgColor: string; textColor: string }> = {
  BANK: { label: 'Bank', bgColor: 'bg-blue-50', textColor: 'text-blue-700' },
  RECEIVABLE: { label: 'Receivable', bgColor: 'bg-cyan-50', textColor: 'text-cyan-700' },
  PAYABLE: { label: 'Payable', bgColor: 'bg-rose-50', textColor: 'text-rose-700' },
  INVENTORY: { label: 'Inventory', bgColor: 'bg-amber-50', textColor: 'text-amber-700' },
  TAX: { label: 'Tax', bgColor: 'bg-purple-50', textColor: 'text-purple-700' },
  CASH: { label: 'Cash', bgColor: 'bg-emerald-50', textColor: 'text-emerald-700' },
  FIXED: { label: 'Fixed Asset', bgColor: 'bg-stone-50', textColor: 'text-stone-700' },
  CURRENT: { label: 'Current', bgColor: 'bg-sky-50', textColor: 'text-sky-700' },
  NON_CURRENT: { label: 'Non-Current', bgColor: 'bg-slate-50', textColor: 'text-slate-700' },
};

const getSubtypeConfig = (subtype?: string) => {
  if (!subtype) return null;
  return SUBTYPE_CONFIG[subtype] || { label: subtype, bgColor: 'bg-slate-100', textColor: 'text-slate-600' };
};

const formatCurrency = (value: number | undefined, currencySymbol: string) => {
  if (value === undefined || value === null) return { text: '—', color: 'text-slate-300', prefix: '' };
  const isNegative = value < 0;
  const absValue = Math.abs(value);
  const formatted = `${currencySymbol}${absValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    text: formatted,
    color: isNegative ? 'text-red-600' : 'text-slate-900',
    prefix: isNegative ? '(' : ''
  };
};

const AccountRow: React.FC<AccountRowProps> = ({
  account,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
  onAddSubAccount,
  onViewLedger,
  onToggleActive,
  balance,
  currencySymbol,
  canEdit
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const typeConfig = getAccountTypeConfig(account.account_type);
  const formatted = formatCurrency(balance, currencySymbol);
  const subtypeConfig = getSubtypeConfig(account.subtype);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleDropdownClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDropdown(prev => !prev);
  };

  const isSystem = account.is_system_account;
  const isInactive = !account.is_active;

  return (
    <div
      className={`group grid items-center transition-all duration-150 cursor-pointer border-b border-slate-100 ${
        isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50/80'
      } ${isInactive ? 'opacity-50' : ''}`}
      style={{ gridTemplateColumns: '100px 1fr 130px 140px 36px' }}
      onClick={onSelect}
    >
      {/* Account Number */}
      <div className="px-4 py-3">
        <span className="font-mono text-xs font-medium text-slate-500 tracking-tight">
          {account.account_number || account.code || '—'}
        </span>
      </div>

      {/* Account Name & Subtype */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-slate-900 truncate">
            {account.name}
          </span>
          {isInactive && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-500 rounded">
              INACTIVE
            </span>
          )}
        </div>
        {subtypeConfig && (
          <div className="flex items-center gap-2 mt-1">
            <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded-full ${subtypeConfig.bgColor} ${subtypeConfig.textColor}`}>
              {subtypeConfig.label}
            </span>
            {account.description && (
              <span className="text-[11px] text-slate-400 truncate max-w-[200px]" title={account.description}>
                {account.description}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Type Badge */}
      <div className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border ${typeConfig.bgColor} ${typeConfig.color}`}>
          {typeConfig.icon}
          {typeConfig.label}
        </span>
      </div>

      {/* Balance */}
      <div className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {(balance !== undefined && balance < 0) ? (
            <ArrowDownRight size={12} className="text-red-400" />
          ) : (balance !== undefined && balance > 0) ? (
            <ArrowUpRight size={12} className="text-emerald-400" />
          ) : null}
          <span className={`font-semibold text-sm tabular-nums ${formatted.color}`}>
            {formatted.prefix}{formatted.text}{(balance !== undefined && balance < 0) ? ')' : ''}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="px-1 py-3 flex items-center justify-center relative" ref={dropdownRef}>
        <button
          onClick={handleDropdownClick}
          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          title="Actions"
        >
          <MoreHorizontal size={16} />
        </button>
        {showDropdown && (
          <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5 z-50 min-w-[180px]">
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Eye size={14} className="text-slate-400" />
              View Account
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Receipt size={14} className="text-slate-400" />
              View Ledger
            </button>
            {canEdit && !isSystem && (
              <>
                <div className="my-1.5 border-t border-slate-100" />
                <button
                  onClick={(e) => { e.stopPropagation(); onAddSubAccount(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Plus size={14} className="text-slate-400" />
                  Add Sub-Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Edit2 size={14} className="text-slate-400" />
                  Edit Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleActive(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  {account.is_active ? <PowerOff size={14} className="text-slate-400" /> : <Power size={14} className="text-slate-400" />}
                  {account.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={14} />
                  Delete Account
                </button>
              </>
            )}
            {isSystem && (
              <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-amber-600 bg-amber-50/50">
                <Lock size={12} />
                System Account
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

interface GroupHeaderRowProps {
  typeLabel: string;
  typeTotal: number;
  currencySymbol: string;
  accountCount: number;
}

const GroupHeaderRow: React.FC<GroupHeaderRowProps> = ({ typeLabel, typeTotal, currencySymbol, accountCount }) => {
  const formatted = formatCurrency(typeTotal, currencySymbol);
  const typeConfig = getAccountTypeConfig(typeLabel.toUpperCase().replace(' ', '_'));

  return (
    <div
      className="grid items-center bg-gradient-to-r from-slate-100/90 to-slate-50/90 border-b-2 border-slate-200/80 backdrop-blur-sm"
      style={{ gridTemplateColumns: '100px 1fr 130px 140px 36px' }}
    >
      <div className="px-4 py-2.5">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider rounded-md ${typeConfig.bgColor} ${typeConfig.color}`}>
          {typeConfig.icon}
          {typeLabel}
        </span>
      </div>
      <div className="px-4 py-2.5">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
          {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
        </span>
      </div>
      <div className="px-4 py-2.5"></div>
      <div className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Total</span>
          <span className={`font-bold text-sm tabular-nums ${formatted.color}`}>
            {formatted.prefix}{formatted.text}{(typeTotal < 0) ? ')' : ''}
          </span>
        </div>
      </div>
      <div className="px-1 py-2.5"></div>
    </div>
  );
};

export const AccountTree: React.FC<AccountTreeProps> = ({
  accounts,
  onSelectAccount,
  onEditAccount,
  onDeleteAccount,
  onAddSubAccount,
  onViewLedger,
  onToggleActive,
  selectedAccountId,
  searchTerm = '',
  balances = {},
  currencySymbol = '$',
  canEdit = false
}) => {
  const filteredAccounts = useMemo(() => {
    if (!searchTerm) return accounts;
    const term = searchTerm.toLowerCase();
    return accounts.filter(a =>
      (a.name || '').toLowerCase().includes(term) ||
      (a.account_number || a.code || '').toLowerCase().includes(term) ||
      (a.description || '').toLowerCase().includes(term)
    );
  }, [accounts, searchTerm]);

  const sortedAccounts = useMemo(() => {
    return [...filteredAccounts].sort((a, b) => {
      const numA = a.account_number || a.code || '';
      const numB = b.account_number || b.code || '';
      return numA.localeCompare(numB, undefined, { numeric: true });
    });
  }, [filteredAccounts]);

  const groupedByType = useMemo(() => {
    const groups: { id: string; type: string; typeLabel: string; accounts: Account[]; total: number }[] = [];
    let currentType: string | undefined;
    let currentGroup: { id: string; type: string; typeLabel: string; accounts: Account[]; total: number } | undefined;

    sortedAccounts.forEach(acc => {
      const type = acc.account_type || acc.type || 'ASSET';
      const typeLabel = getAccountTypeConfig(type).label;
      const balance = balances[acc.id] || 0;

      if (type !== currentType) {
        currentType = type;
        const startKey = acc.id || acc.account_number || acc.code;
        currentGroup = {
          id: `section:${type}:${startKey}`,
          type,
          typeLabel,
          accounts: [],
          total: 0
        };
        groups.push(currentGroup);
      }
      currentGroup!.accounts.push(acc);
      currentGroup!.total += balance;
    });

    return groups;
  }, [sortedAccounts, balances]);

  if (accounts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col">
      {groupedByType.map((group) => (
        <React.Fragment key={group.id}>
          <GroupHeaderRow
            typeLabel={group.typeLabel}
            typeTotal={group.total}
            currencySymbol={currencySymbol}
            accountCount={group.accounts.length}
          />
          {group.accounts.map(account => {
            const balance = balances[account.id];
            const isSelected = selectedAccountId === account.id;
            return (
              <AccountRow
                key={account.id}
                account={account}
                isSelected={isSelected}
                onSelect={() => onSelectAccount(account)}
                onEdit={() => onEditAccount(account)}
                onDelete={() => onDeleteAccount(account)}
                onAddSubAccount={() => onAddSubAccount(account)}
                onViewLedger={() => onViewLedger(account)}
                onToggleActive={() => onToggleActive(account)}
                balance={balance}
                currencySymbol={currencySymbol}
                canEdit={canEdit}
              />
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
};

export default AccountTree;
