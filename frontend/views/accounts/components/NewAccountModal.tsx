import React, { useState, useEffect, useMemo } from 'react';
import { BookOpen, AlertCircle } from 'lucide-react';
import { Account, AccountType, AccountGroup, AccountSubtype, NormalBalance } from '../../../types';
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
  currencySymbol: currencySymbolProp,
  isSubmitting = false
}) => {
  const { companyConfig } = useAuth();
  const currencySymbol = currencySymbolProp || companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
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

  const errStyle = (hasErr: boolean) => (hasErr ? { ...inputStyle, borderColor: danger } : inputStyle);
  const errSelectStyle = (hasErr: boolean) => (hasErr ? { ...selectStyle, borderColor: danger } : selectStyle);

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<BookOpen size={19} color="#fff" />}
          title={isEditing ? 'Edit Account' : 'Add New Account'}
          subtitle={parentAccount ? `Child of ${parentAccount.name} · Chart of accounts` : 'Chart of accounts — ledger reference'}
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <form id="coa-account-form" onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
              <div>
                <label style={labelStyle}>Account Type <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                <select
                  style={errSelectStyle(!!errors.account_type)}
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
                  <p style={{ fontSize: 11.5, color: danger, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertCircle size={12} /> {errors.account_type}
                  </p>
                )}
                {account?.is_system_account && (
                  <p style={{ fontSize: 11, color: amber[600], margin: '6px 0 0' }}>
                    System account type cannot be changed
                  </p>
                )}
              </div>

              <div>
                <label style={labelStyle}>Account Group</label>
                <select
                  style={selectStyle}
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

            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Parent Account</label>
              <select
                style={selectStyle}
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
                <p style={{ fontSize: 11.5, color: danger, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertCircle size={12} /> {errors.parent_account_id}
                </p>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
              <div>
                <label style={labelStyle}>
                  Account Number
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. 11101"
                  style={{ ...errStyle(!!errors.account_number), fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                  value={formData.account_number}
                  onChange={e => setFormData(f => ({ ...f, account_number: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                  maxLength={5}
                />
                <p style={{ fontSize: 11, color: inkSoft, margin: '6px 0 0' }}>5 digits (auto-generated if empty)</p>
                {errors.account_number && (
                  <p style={{ fontSize: 11.5, color: danger, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertCircle size={12} /> {errors.account_number}
                  </p>
                )}
              </div>

              <div>
                <label style={labelStyle}>Subtype</label>
                <select
                  style={selectStyle}
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

            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Account Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <input
                type="text"
                placeholder="e.g. Main Cash"
                style={errStyle(!!errors.name)}
                value={formData.name}
                onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                maxLength={200}
              />
              {errors.name && (
                <p style={{ fontSize: 11.5, color: danger, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertCircle size={12} /> {errors.name}
                </p>
              )}
            </div>

            <div style={sectionLabelStyle}><span>Opening Balance</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
              <div>
                <label style={labelStyle}>Opening Balance</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>
                    {currencySymbol}
                  </span>
                  <input
                    type="text"
                    placeholder="0.00"
                    style={{ ...errStyle(!!errors.opening_balance), paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                    value={formData.opening_balance}
                    onChange={e => setFormData(f => ({ ...f, opening_balance: e.target.value }))}
                  />
                </div>
                {errors.opening_balance && (
                  <p style={{ fontSize: 11.5, color: danger, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertCircle size={12} /> {errors.opening_balance}
                  </p>
                )}
              </div>

              <div>
                <label style={labelStyle}>Opening Balance Date</label>
                <input
                  type="date"
                  style={inputStyle}
                  value={formData.opening_balance_date}
                  onChange={e => setFormData(f => ({ ...f, opening_balance_date: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>
                Description
                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
              </label>
              <textarea
                placeholder="Optional description…"
                style={textareaStyle}
                rows={3}
                value={formData.description}
                onChange={e => setFormData(f => ({ ...f, description: e.target.value }))}
                maxLength={500}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: ink, fontWeight: 500 }}>
                <input
                  type="checkbox"
                  checked={formData.allow_posting}
                  onChange={e => setFormData(f => ({ ...f, allow_posting: e.target.checked }))}
                />
                Allow Posting
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: ink, fontWeight: 500 }}>
                <input
                  type="checkbox"
                  checked={formData.is_active}
                  onChange={e => setFormData(f => ({ ...f, is_active: e.target.checked }))}
                />
                Active
              </label>
            </div>
          </form>
        </div>
        <ModalFooter
          stepLabel={isEditing ? 'Edit · chart of accounts' : 'New account · chart of accounts'}
          onCancel={onClose}
          submitLabel={isSubmitting ? 'Saving…' : isEditing ? 'Update Account' : 'Save Account'}
          submitFormId="coa-account-form"
        />
      </div>
    </div>
  );
};

export default NewAccountModal;
