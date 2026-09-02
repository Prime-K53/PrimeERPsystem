import React, { useState, useEffect, useMemo } from 'react';
import { X, CheckCircle, AlertCircle } from 'lucide-react';
import { Account, AccountType, AccountGroup, AccountSubtype, NormalBalance } from '../../types';

interface NewAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: Partial<Account>) => Promise<void>;
  account?: Account | null;
  parentAccount?: Account | null;
  accounts: Account[];
  currencySymbol?: string;
  isSubmitting?: boolean;
}

const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const ACCOUNT_GROUPS: Record<AccountType, AccountGroup[]> = {
  ASSET: ['CURRENT_ASSET', 'FIXED_ASSET'],
  LIABILITY: ['CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  EQUITY: ['EQUITY'],
  INCOME: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE']
};

const ACCOUNT_SUBTYPES: AccountSubtype[] = ['BANK', 'RECEIVABLE', 'PAYABLE', 'INVENTORY', 'TAX', 'CASH'];

const getTypeLabel = (type: AccountType): string => {
  const labels: Record<AccountType, string> = {
    ASSET: 'Asset',
    LIABILITY: 'Liability',
    EQUITY: 'Equity',
    INCOME: 'Income',
    EXPENSE: 'Expense'
  };
  return labels[type];
};

const getGroupLabel = (group: AccountGroup): string => {
  const labels: Record<AccountGroup, string> = {
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
  return labels[group];
};

export const NewAccountModal: React.FC<NewAccountModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  account,
  parentAccount,
  accounts,
  currencySymbol = '$',
  isSubmitting = false
}) => {
  const [formData, setFormData] = useState<{
    account_type: AccountType | '';
    account_group: AccountGroup | '';
    parent_account_id: string;
    account_number: string;
    name: string;
    subtype: AccountSubtype | '';
    opening_balance: string;
    opening_balance_date: string;
    description: string;
    allow_posting: boolean;
    is_active: boolean;
  }>({
    account_type: '',
    account_group: '',
    parent_account_id: '',
    account_number: '',
    name: '',
    subtype: '',
    opening_balance: '0',
    opening_balance_date: '',
    description: '',
    allow_posting: true,
    is_active: true
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (account) {
      setFormData({
        account_type: account.account_type || '',
        account_group: account.account_group || '',
        parent_account_id: account.parent_account_id || '',
        account_number: account.account_number || account.code || '',
        name: account.name || '',
        subtype: account.subtype || '',
        opening_balance: String(account.opening_balance || 0),
        opening_balance_date: account.opening_balance_date || '',
        description: account.description || '',
        allow_posting: account.allow_posting !== false,
        is_active: account.is_active !== false
      });
    } else if (parentAccount) {
      setFormData({
        account_type: parentAccount.account_type || '',
        account_group: parentAccount.account_group || '',
        parent_account_id: parentAccount.id,
        account_number: '',
        name: '',
        subtype: '',
        opening_balance: '0',
        opening_balance_date: '',
        description: '',
        allow_posting: true,
        is_active: true
      });
    } else {
      setFormData({
        account_type: '',
        account_group: '',
        parent_account_id: '',
        account_number: '',
        name: '',
        subtype: '',
        opening_balance: '0',
        opening_balance_date: '',
        description: '',
        allow_posting: true,
        is_active: true
      });
    }
    setErrors({});
  }, [account, parentAccount, isOpen]);

  const filteredGroups = useMemo(() => {
    if (!formData.account_type) return [];
    return ACCOUNT_GROUPS[formData.account_type] || [];
  }, [formData.account_type]);

  const filteredParents = useMemo(() => {
    return accounts.filter(a => {
      if (formData.account_type && a.account_type !== formData.account_type) return false;
      if (account && a.id === account.id) return false;
      return true;
    });
  }, [accounts, formData.account_type, account]);

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.account_type) {
      newErrors.account_type = 'Account type is required';
    }

    if (!formData.name.trim()) {
      newErrors.name = 'Account name is required';
    } else if (formData.name.length > 200) {
      newErrors.name = 'Account name must be 200 characters or less';
    }

    if (formData.account_number && !/^\d{5}$/.test(formData.account_number)) {
      newErrors.account_number = 'Account number must be exactly 5 digits';
    }

    if (formData.opening_balance && isNaN(parseFloat(formData.opening_balance))) {
      newErrors.opening_balance = 'Opening balance must be a number';
    }

    if (formData.parent_account_id) {
      const parent = accounts.find(a => a.id === formData.parent_account_id);
      if (parent && parent.account_type !== formData.account_type) {
        newErrors.parent_account_id = 'Parent must have the same account type';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const submitData: Partial<Account> = {
      account_type: formData.account_type as AccountType,
      account_group: (formData.account_group || undefined) as AccountGroup | undefined,
      parent_account_id: formData.parent_account_id || undefined,
      account_number: formData.account_number || undefined,
      name: formData.name.trim(),
      subtype: (formData.subtype || undefined) as AccountSubtype | undefined,
      opening_balance: parseFloat(formData.opening_balance) || 0,
      opening_balance_date: formData.opening_balance_date || undefined,
      description: formData.description.trim() || undefined,
      allow_posting: formData.allow_posting,
      is_active: formData.is_active
    };

    await onSubmit(submitData);
  };

  if (!isOpen) return null;

  const isEditing = !!account;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-fadeIn border border-slate-200">
        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <h2 className="text-xl font-bold text-slate-900">
            {isEditing ? 'Edit Account' : 'Add New Account'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Account Type <span className="text-red-500">*</span>
              </label>
              <select
                className={`w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none ${
                  errors.account_type ? 'border-red-500' : 'border-slate-200'
                } ${account?.is_system_account ? 'bg-slate-100 cursor-not-allowed' : ''}`}
                value={formData.account_type}
                onChange={e => {
                  setFormData(f => ({
                    ...f,
                    account_type: e.target.value as AccountType,
                    account_group: ''
                  }));
                }}
                disabled={isEditing && !!account?.is_system_account}
              >
                <option value="">Select Type</option>
                {ACCOUNT_TYPES.map(type => (
                  <option key={type} value={type}>{getTypeLabel(type)}</option>
                ))}
              </select>
              {errors.account_type && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} /> {errors.account_type}
                </p>
              )}
              {account?.is_system_account && (
                <p className="text-[10px] text-amber-600 mt-1">
                  System account type cannot be changed
                </p>
              )}
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Account Group
              </label>
              <select
                className="w-full p-2.5 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                value={formData.account_group}
                onChange={e => setFormData(f => ({ ...f, account_group: e.target.value as AccountGroup }))}
                disabled={filteredGroups.length === 0}
              >
                <option value="">Select Group</option>
                {filteredGroups.map(group => (
                  <option key={group} value={group}>{getGroupLabel(group)}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
              Parent Account
            </label>
            <select
              className="w-full p-2.5 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
              value={formData.parent_account_id}
              onChange={e => setFormData(f => ({ ...f, parent_account_id: e.target.value }))}
            >
              <option value="">No Parent (Root Level)</option>
              {filteredParents.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.account_number || acc.code} - {acc.name}
                </option>
              ))}
            </select>
            {errors.parent_account_id && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> {errors.parent_account_id}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Account Number
              </label>
              <input
                type="text"
                placeholder="e.g. 11101"
                className={`w-full p-2.5 border rounded-lg text-sm font-mono font-bold focus:ring-2 focus:ring-blue-500 outline-none ${
                  errors.account_number ? 'border-red-500' : 'border-slate-200'
                }`}
                value={formData.account_number}
                onChange={e => setFormData(f => ({ ...f, account_number: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                maxLength={5}
              />
              <p className="text-[10px] text-slate-400 mt-1">5 digits (auto-generated if empty)</p>
              {errors.account_number && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} /> {errors.account_number}
                </p>
              )}
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Subtype
              </label>
              <select
                className="w-full p-2.5 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                value={formData.subtype}
                onChange={e => setFormData(f => ({ ...f, subtype: e.target.value as AccountSubtype }))}
              >
                <option value="">Select Subtype</option>
                {ACCOUNT_SUBTYPES.map(sub => (
                  <option key={sub} value={sub}>{sub}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
              Account Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Main Cash"
              className={`w-full p-2.5 border rounded-lg text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none ${
                errors.name ? 'border-red-500' : 'border-slate-200'
              }`}
              value={formData.name}
              onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
              maxLength={200}
            />
            {errors.name && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> {errors.name}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Opening Balance
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                  {currencySymbol}
                </span>
                <input
                  type="text"
                  placeholder="0.00"
                  className={`w-full pl-8 p-2.5 border rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none ${
                    errors.opening_balance ? 'border-red-500' : 'border-slate-200'
                  }`}
                  value={formData.opening_balance}
                  onChange={e => setFormData(f => ({ ...f, opening_balance: e.target.value }))}
                />
              </div>
              {errors.opening_balance && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} /> {errors.opening_balance}
                </p>
              )}
            </div>

            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                Opening Balance Date
              </label>
              <input
                type="date"
                className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                value={formData.opening_balance_date}
                onChange={e => setFormData(f => ({ ...f, opening_balance_date: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
              Description
            </label>
            <textarea
              placeholder="Optional description..."
              className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              rows={2}
              value={formData.description}
              onChange={e => setFormData(f => ({ ...f, description: e.target.value }))}
              maxLength={500}
            />
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={formData.allow_posting}
                onChange={e => setFormData(f => ({ ...f, allow_posting: e.target.checked }))}
              />
              <span className="text-sm font-medium text-slate-700">Allow Posting</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={formData.is_active}
                onChange={e => setFormData(f => ({ ...f, is_active: e.target.checked }))}
              />
              <span className="text-sm font-medium text-slate-700">Active</span>
            </label>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                'Saving...'
              ) : (
                <>
                  <CheckCircle size={18} />
                  {isEditing ? 'Update Account' : 'Save Account'}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewAccountModal;
