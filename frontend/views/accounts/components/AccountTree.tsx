import React, { useState, useCallback, useMemo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FolderClosed,
  FolderOpen,
  FileText,
  Lock,
  Search,
  MoreHorizontal,
  Edit2,
  Trash2,
  Plus,
  Eye,
  History,
  PowerOff,
  Power
} from 'lucide-react';
import { Account, AccountTreeNode, AccountType, AccountGroup } from '../../types';

interface AccountTreeProps {
  accounts: Account[];
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
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

const getTypeColor = (type: AccountType | string): string => {
  switch (type) {
    case 'ASSET': return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'LIABILITY': return 'text-red-600 bg-red-50 border-red-200';
    case 'EQUITY': return 'text-purple-600 bg-purple-50 border-purple-200';
    case 'INCOME': return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    case 'EXPENSE': return 'text-amber-600 bg-amber-50 border-amber-200';
    default: return 'text-slate-600 bg-slate-50 border-slate-200';
  }
};

const getGroupLabel = (group: AccountGroup | string | undefined): string => {
  if (!group) return '';
  const labels: Record<string, string> = {
    CURRENT_ASSET: 'Current Asset',
    FIXED_ASSET: 'Fixed Asset',
    CURRENT_LIABILITY: 'Current Liability',
    LONG_TERM_LIABILITY: 'Long-Term Liability',
    EQUITY: 'Equity',
    REVENUE: 'Revenue',
    OTHER_INCOME: 'Other Income',
    COST_OF_SALES: 'Cost of Sales',
    OPERATING_EXPENSE: 'Operating Expense',
    OTHER_EXPENSE: 'Other Expense'
  };
  return labels[group] || group;
};

interface AccountRowProps {
  account: Account;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddSubAccount: () => void;
  onViewLedger: () => void;
  onToggleActive: () => void;
  balance?: number;
  currencySymbol: string;
  canEdit: boolean;
  searchTerm?: string;
}

const AccountRow: React.FC<AccountRowProps> = ({
  account,
  depth,
  isExpanded,
  hasChildren,
  isSelected,
  onToggleExpand,
  onSelect,
  onEdit,
  onDelete,
  onAddSubAccount,
  onViewLedger,
  onToggleActive,
  balance,
  currencySymbol,
  canEdit,
  searchTerm
}) => {
  const [showActions, setShowActions] = useState(false);

  const highlightText = (text: string) => {
    if (!searchTerm) return text;
    const parts = text.split(new RegExp(`(${searchTerm})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === searchTerm.toLowerCase() ? (
        <mark key={i} className="bg-yellow-200 px-0.5 rounded">{part}</mark>
      ) : part
    );
  };

  const formatBalance = (value: number | undefined) => {
    if (value === undefined || value === null) return '—';
    const isNegative = value < 0;
    const absValue = Math.abs(value);
    return (
      <span className={value === 0 ? 'text-slate-300' : isNegative ? 'text-red-600' : 'text-slate-900'}>
        {isNegative ? '-' : ''}{currencySymbol}{absValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  };

  return (
    <div
      className={`group flex items-center hover:bg-blue-50/50 transition-colors border-b border-slate-100 ${
        isSelected ? 'bg-blue-50' : ''
      } ${!account.is_active ? 'opacity-50' : ''}`}
      style={{ paddingLeft: `${depth * 24 + 16}px` }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="flex items-center gap-2 py-3 flex-1 min-w-0">
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
            className="p-0.5 hover:bg-slate-200 rounded transition-colors flex-shrink-0"
          >
            {isExpanded ? (
              <ChevronDown size={16} className="text-slate-500" />
            ) : (
              <ChevronRight size={16} className="text-slate-500" />
            )}
          </button>
        ) : (
          <div className="w-6 flex-shrink-0" />
        )}

        <div className="flex-shrink-0">
          {hasChildren ? (
            isExpanded ? (
              <FolderOpen size={18} className="text-amber-500" />
            ) : (
              <FolderClosed size={18} className="text-amber-500" />
            )
          ) : (
            <FileText size={18} className="text-slate-400" />
          )}
        </div>

        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="font-mono text-xs font-bold text-slate-500 w-16 flex-shrink-0">
            {highlightText(account.account_number || account.code || '')}
          </span>
          <span className="font-semibold text-sm text-slate-900 truncate flex-shrink-0 w-48">
            {highlightText(account.name)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 px-4">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${getTypeColor(account.account_type || account.type)}`}>
          {account.account_type || account.type}
        </span>

        {account.account_group && (
          <span className="text-[10px] text-slate-400 font-medium w-28 truncate">
            {getGroupLabel(account.account_group)}
          </span>
        )}

        <span className="w-28 text-right font-semibold text-sm tabular-nums">
          {formatBalance(balance)}
        </span>

        {account.is_system_account && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
            <Lock size={10} />
            System
          </span>
        )}

        <span className={`w-16 text-center text-[10px] font-bold uppercase ${
          account.is_active ? 'text-emerald-600' : 'text-slate-400'
        }`}>
          {account.is_active ? 'Active' : 'Inactive'}
        </span>

        <div className={`flex items-center gap-1 transition-opacity ${showActions ? 'opacity-100' : 'opacity-0'}`}>
          <button
            onClick={(e) => { e.stopPropagation(); onViewLedger(); }}
            className="p-1.5 text-slate-400 hover:text-emerald-600 bg-white border border-slate-200 rounded-lg transition-colors"
            title="View Ledger"
          >
            <History size={14} />
          </button>

          {canEdit && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onAddSubAccount(); }}
                className="p-1.5 text-slate-400 hover:text-blue-600 bg-white border border-slate-200 rounded-lg transition-colors"
                title="Add Sub-account"
              >
                <Plus size={14} />
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="p-1.5 text-slate-400 hover:text-blue-600 bg-white border border-slate-200 rounded-lg transition-colors"
                title="Edit Account"
              >
                <Edit2 size={14} />
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onToggleActive(); }}
                className={`p-1.5 bg-white border border-slate-200 rounded-lg transition-colors ${
                  account.is_active
                    ? 'text-slate-400 hover:text-amber-600'
                    : 'text-slate-400 hover:text-emerald-600'
                }`}
                title={account.is_active ? 'Deactivate' : 'Activate'}
              >
                {account.is_active ? <PowerOff size={14} /> : <Power size={14} />}
              </button>

              {!account.is_system_account && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="p-1.5 text-slate-400 hover:text-red-600 bg-white border border-slate-200 rounded-lg transition-colors"
                  title="Delete Account"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const AccountTree: React.FC<AccountTreeProps> = ({
  accounts,
  expandedIds,
  onToggleExpand,
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
  const buildTree = useCallback((parentId: string | null = null, depth: number = 0): AccountTreeNode[] => {
    return accounts
      .filter(a => {
        const pid = a.parent_account_id ?? a.parent_id ?? null;
        return pid === parentId;
      })
      .filter(a => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (
          (a.name || '').toLowerCase().includes(term) ||
          (a.account_number || a.code || '').toLowerCase().includes(term) ||
          (a.description || '').toLowerCase().includes(term)
        );
      })
      .sort((a, b) => {
        const numA = a.account_number || a.code || '';
        const numB = b.account_number || b.code || '';
        return numA.localeCompare(numB, undefined, { numeric: true });
      })
      .map(account => ({
        ...account,
        depth,
        children: buildTree(account.id, depth + 1)
      }));
  }, [accounts, searchTerm]);

  const tree = useMemo(() => buildTree(), [buildTree]);

  const flattenTree = useCallback((nodes: AccountTreeNode[], result: AccountTreeNode[] = []): AccountTreeNode[] => {
    for (const node of nodes) {
      result.push(node);
      if (expandedIds.has(node.id) && node.children?.length) {
        flattenTree(node.children, result);
      }
    }
    return result;
  }, [expandedIds]);

  const flattenedNodes = useMemo(() => flattenTree(tree), [flattenTree, tree]);

  const autoExpandParents = useCallback((accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    if (account?.parent_account_id) {
      onToggleExpand(account.parent_account_id);
      autoExpandParents(account.parent_account_id);
    }
  }, [accounts, onToggleExpand]);

  if (accounts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col">
      {flattenedNodes.map(account => {
        const hasChildren = (account.children?.length ?? 0) > 0;
        const isExpanded = expandedIds.has(account.id);
        const balance = balances[account.id];

        return (
          <div
            key={account.id}
            onClick={() => onSelectAccount(account)}
            className="cursor-pointer"
          >
            <AccountRow
              account={account}
              depth={account.depth || 0}
              isExpanded={isExpanded}
              hasChildren={hasChildren}
              isSelected={selectedAccountId === account.id}
              onToggleExpand={() => onToggleExpand(account.id)}
              onSelect={() => onSelectAccount(account)}
              onEdit={() => onEditAccount(account)}
              onDelete={() => onDeleteAccount(account)}
              onAddSubAccount={() => onAddSubAccount(account)}
              onViewLedger={() => onViewLedger(account)}
              onToggleActive={() => onToggleActive(account)}
              balance={balance}
              currencySymbol={currencySymbol}
              canEdit={canEdit}
              searchTerm={searchTerm}
            />
          </div>
        );
      })}
    </div>
  );
};

export default AccountTree;
