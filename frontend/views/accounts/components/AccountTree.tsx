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
import { Account } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { currencyService } from '../../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './financeChrome';

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

const ACCOUNT_TYPE_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  ASSET: { label: 'Asset', color: teal[700], bg: teal[50], icon: <Building2 size={12} /> },
  LIABILITY: { label: 'Liability', color: danger, bg: '#fdeeee', icon: <CreditCard size={12} /> },
  EQUITY: { label: 'Equity', color: teal[800], bg: teal[100], icon: <Wallet size={12} /> },
  INCOME: { label: 'Revenue', color: teal[700], bg: teal[50], icon: <TrendingUp size={12} /> },
  EXPENSE: { label: 'Expense', color: amber[600], bg: amber[100], icon: <TrendingDown size={12} /> },
};

const getAccountTypeConfig = (type?: string) => {
  return ACCOUNT_TYPE_CONFIG[type || 'ASSET'] || ACCOUNT_TYPE_CONFIG['ASSET'];
};

const SUBTYPE_CONFIG: Record<string, { label: string; bg: string; fg: string }> = {
  BANK: { label: 'Bank', bg: teal[50], fg: teal[700] },
  RECEIVABLE: { label: 'Receivable', bg: teal[50], fg: teal[700] },
  PAYABLE: { label: 'Payable', bg: '#fdeeee', fg: danger },
  INVENTORY: { label: 'Inventory', bg: amber[100], fg: amber[600] },
  TAX: { label: 'Tax', bg: teal[100], fg: teal[800] },
  CASH: { label: 'Cash', bg: teal[50], fg: teal[700] },
  FIXED: { label: 'Fixed Asset', bg: teal[50], fg: inkSoft },
  CURRENT: { label: 'Current', bg: teal[50], fg: teal[700] },
  NON_CURRENT: { label: 'Non-Current', bg: teal[50], fg: inkSoft },
};

const getSubtypeConfig = (subtype?: string) => {
  if (!subtype) return null;
  return SUBTYPE_CONFIG[subtype] || { label: subtype, bg: teal[50], fg: inkSoft };
};

const formatCurrency = (value: number | undefined, currencySymbol: string) => {
  if (value === undefined || value === null) return { text: '—', color: inkSoft, prefix: '' };
  const isNegative = value < 0;
  const absValue = Math.abs(value);
  const formatted = `${currencySymbol}${absValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    text: formatted,
    color: isNegative ? danger : ink,
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
      className="group grid items-center cursor-pointer"
      style={{
        gridTemplateColumns: '100px 1fr 130px 140px 36px',
        borderBottom: `1px solid ${hairline}`,
        background: isSelected ? teal[50] : 'transparent',
        opacity: isInactive ? 0.55 : 1,
        transition: 'background .12s',
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = teal[50]; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      onClick={onSelect}
    >
      {/* Account Number */}
      <div className="px-4 py-3">
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500, color: inkSoft }}>
          {account.account_number || account.code || '—'}
        </span>
      </div>

      {/* Account Name & Subtype */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontWeight: 600, fontSize: 13, color: ink }}>
            {account.name}
          </span>
          {isInactive && (
            <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, background: amber[100], color: amber[600] }}>
              Inactive
            </span>
          )}
        </div>
        {subtypeConfig && (
          <div className="flex items-center gap-2 mt-1">
            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 20, background: subtypeConfig.bg, color: subtypeConfig.fg }}>
              {subtypeConfig.label}
            </span>
            {account.description && (
              <span className="truncate max-w-[200px]" style={{ fontSize: 11, color: inkSoft }} title={account.description}>
                {account.description}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Type Badge */}
      <div className="px-4 py-3">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, background: typeConfig.bg, color: typeConfig.color }}>
          {typeConfig.icon}
          {typeConfig.label}
        </span>
      </div>

      {/* Balance */}
      <div className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {(balance !== undefined && balance < 0) ? (
            <ArrowDownRight size={12} style={{ color: danger }} />
          ) : (balance !== undefined && balance > 0) ? (
            <ArrowUpRight size={12} style={{ color: teal[600] }} />
          ) : null}
          <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: formatted.color }}>
            {formatted.prefix}{formatted.text}{(balance !== undefined && balance < 0) ? ')' : ''}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="px-1 py-3 flex items-center justify-center relative" ref={dropdownRef}>
        <button
          onClick={handleDropdownClick}
          style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: inkSoft }}
          onMouseEnter={e => e.currentTarget.style.background = teal[50]}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          title="Actions"
        >
          <MoreHorizontal size={16} />
        </button>
        {showDropdown && (
          <div className="absolute right-0 top-full mt-1 py-1 z-50 min-w-[180px]" style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 12, boxShadow: '0 8px 24px -8px rgba(0,0,0,.25)', overflow: 'hidden' }}>
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: ink, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Eye size={14} style={{ color: inkSoft }} />
              View Account
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onViewLedger(); setShowDropdown(false); }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: ink, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => e.currentTarget.style.background = teal[50]}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <Receipt size={14} style={{ color: inkSoft }} />
              View Ledger
            </button>
            {canEdit && !isSystem && (
              <>
                <div style={{ margin: '4px 0', borderTop: `1px solid ${hairline}` }} />
                <button
                  onClick={(e) => { e.stopPropagation(); onAddSubAccount(); setShowDropdown(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: ink, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <Plus size={14} style={{ color: inkSoft }} />
                  Add Sub-Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(); setShowDropdown(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: ink, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <Edit2 size={14} style={{ color: inkSoft }} />
                  Edit Account
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleActive(); setShowDropdown(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: ink, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {account.is_active ? <PowerOff size={14} style={{ color: inkSoft }} /> : <Power size={14} style={{ color: teal[600] }} />}
                  {account.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); setShowDropdown(false); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 13, color: danger, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fdeeee'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <Trash2 size={14} />
                  Delete Account
                </button>
              </>
            )}
            {isSystem && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', fontSize: 11.5, color: amber[600], background: amber[100] }}>
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
      className="grid items-center"
      style={{ ...tableHeadRow, gridTemplateColumns: '100px 1fr 130px 140px 36px' }}
    >
      <div className="px-4 py-2.5">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.08, borderRadius: 20, background: typeConfig.bg, color: typeConfig.color }}>
          {typeConfig.icon}
          {typeLabel}
        </span>
      </div>
      <div className="px-4 py-2.5">
        <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>
          {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
        </span>
      </div>
      <div className="px-4 py-2.5"></div>
      <div className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>Total</span>
          <span style={{ fontWeight: 700, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: formatted.color }}>
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
  currencySymbol: currencySymbolProp,
  canEdit = false
}) => {
  const { companyConfig } = useAuth();
  const currencySymbol = currencySymbolProp || companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
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
    return <EmptyState icon={<Building2 size={32} />} title="No accounts found" hint="Create your first account to get started." />;
  }

  return (
    <div className="flex flex-col" style={tableCard}>
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
