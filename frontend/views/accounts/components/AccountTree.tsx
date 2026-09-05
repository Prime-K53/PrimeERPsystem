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
  Power
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

const formatBalance = (value: number | undefined, currencySymbol: string) => {
  if (value === undefined || value === null) return <span className="text-slate-300">—</span>;
  const isNegative = value < 0;
  const absValue = Math.abs(value);
  return (
    <span className={value === 0 ? 'text-slate-300' : isNegative ? 'text-red-600' : 'text-slate-900'}>
      {isNegative ? '-' : ''}{currencySymbol}{absValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
};

const getSubtypeLabel = (subtype?: string): string => {
  if (!subtype) return 'Uncategorized';
  const labels: Record<string, string> = {
    BANK: 'Bank Accounts',
    RECEIVABLE: 'Accounts Receivable',
    PAYABLE: 'Accounts Payable',
    INVENTORY: 'Inventory',
    TAX: 'Tax Accounts',
    CASH: 'Cash & Cash Equivalents'
  };
  return labels[subtype] || subtype;
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

  return (
    <div
      className={`group grid items-center hover:bg-blue-50/50 transition-colors border-b border-slate-100 cursor-pointer ${
        isSelected ? 'bg-blue-50' : ''
      } ${!account.is_active ? 'opacity-50' : ''}`}
      style={{ gridTemplateColumns: '180px 1fr 140px 140px 36px' }}
      onClick={onSelect}
    >
      <div className="px-4 py-3"></div>

      <div className="px-4 py-3 text-left">
        <span className="font-semibold text-sm text-slate-900">
          {account.name}
        </span>
      </div>

      <div className="px-4 py-3 text-right font-semibold text-sm tabular-nums">
        {formatBalance(balance, currencySymbol)}
      </div>

      <div className="px-4 py-3"></div>

      <div className="px-1 py-3 flex items-center justify-end relative" ref={dropdownRef}>
        <button
          onClick={handleDropdownClick}
          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          title="Actions"
        >
          <MoreHorizontal size={16} />
        </button>
        {showDropdown && (
          <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Eye size={14} />
              View Account
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <History size={14} />
              View Ledger
            </button>
            {canEdit && !isSystem && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddSubAccount(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Plus size={14} />
                  Add Child Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Edit2 size={14} />
                  Edit Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleActive(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  {account.is_active ? <PowerOff size={14} /> : <Power size={14} />}
                  {account.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); setShowDropdown(false); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={14} />
                  Delete Account
                </button>
              </>
            )}
            {isSystem && (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-amber-600">
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
}

const GroupHeaderRow: React.FC<GroupHeaderRowProps> = ({ typeLabel, typeTotal, currencySymbol }) => {
  return (
    <div
      className="grid items-center bg-slate-100/80 border-b border-slate-200"
      style={{ gridTemplateColumns: '180px 1fr 140px 140px 36px' }}
    >
      <div className="px-4 py-3 text-left">
        <span className="text-[10px] font-black uppercase tracking-wider text-slate-700">
          {typeLabel}
        </span>
      </div>
      <div className="px-4 py-3"></div>
      <div className="px-4 py-3"></div>
      <div className="px-4 py-3 text-right font-bold text-sm tabular-nums text-slate-900">
        {formatBalance(typeTotal, currencySymbol)}
      </div>
      <div className="px-1 py-3"></div>
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
    const groups: { type: string; typeLabel: string; accounts: Account[]; total: number }[] = [];
    let currentType: string | undefined;
    let currentGroup: { type: string; typeLabel: string; accounts: Account[]; total: number } | undefined;

    sortedAccounts.forEach(acc => {
      const type = acc.subtype || acc.account_type || acc.type || 'OTHER';
      const typeLabel = getSubtypeLabel(acc.subtype || acc.account_type);
      const balance = balances[acc.id] || 0;

      if (type !== currentType) {
        currentType = type;
        currentGroup = { type, typeLabel, accounts: [], total: 0 };
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
        <React.Fragment key={group.type}>
          <GroupHeaderRow
            typeLabel={group.typeLabel}
            typeTotal={group.total}
            currencySymbol={currencySymbol}
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
