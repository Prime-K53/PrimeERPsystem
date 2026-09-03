const crypto = require('crypto');
const { randomUUID } = require('crypto');
const repo = require('./supabaseRepository.cjs');
const auditService = require('../auditService.cjs');

const ACCOUNT_TYPE_NORMAL_BALANCE = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT'
};

const STANDARD_CHART_OF_ACCOUNTS = [
  // ASSETS (10000-19999)
  { account_number: '10000', name: 'Assets', account_type: 'ASSET', account_group: null, parent_account_number: null, subtype: null, is_system_account: true, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '11000', name: 'Current Assets', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '10000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  // Cash in Hand
  { account_number: '11100', name: 'Cash in Hand', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11000', subtype: 'CASH', is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11100', subtype: 'CASH', is_system_account: true, allow_posting: true, normal_balance: 'DEBIT', role: 'cash_drawer' },
  { account_number: '11120', name: 'Petty Cash', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11100', subtype: 'CASH', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  // Bank Accounts
  { account_number: '11200', name: 'Bank Accounts', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11000', subtype: 'BANK', is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '11210', name: 'National Bank', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11200', subtype: 'BANK', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'bank_national' },
  { account_number: '11220', name: 'FDH Bank', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11200', subtype: 'BANK', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'bank_fdh' },
  { account_number: '11230', name: 'NBS Bank', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11200', subtype: 'BANK', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'bank_nbs' },
  // Accounts Receivable
  { account_number: '11300', name: 'Accounts Receivable', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11000', subtype: 'RECEIVABLE', is_system_account: true, allow_posting: false, normal_balance: 'DEBIT', role: 'accounts_receivable' },
  { account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11300', subtype: 'RECEIVABLE', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  // Inventory
  { account_number: '11400', name: 'Inventory', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11000', subtype: 'INVENTORY', is_system_account: true, allow_posting: false, normal_balance: 'DEBIT', role: 'inventory' },
  { account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11400', subtype: 'INVENTORY', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11400', subtype: 'INVENTORY', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11400', subtype: 'INVENTORY', is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  // Other Current Assets
  { account_number: '11500', name: 'Other Current Assets', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '11510', name: 'Prepayments', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11500', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '11520', name: 'Staff Advances', account_type: 'ASSET', account_group: 'CURRENT_ASSET', parent_account_number: '11500', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  // Fixed Assets
  { account_number: '12000', name: 'Fixed Assets', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '10000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '12100', name: 'Motor Vehicles', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '12000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '12200', name: 'Furniture & Fixtures', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '12000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '12300', name: 'Computers & Equipment', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '12000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '12400', name: 'Buildings', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '12000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '12500', name: 'Accumulated Depreciation', account_type: 'ASSET', account_group: 'FIXED_ASSET', parent_account_number: '12000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT', role: 'accumulated_depreciation' },

  // LIABILITIES (20000-29999)
  { account_number: '20000', name: 'Liabilities', account_type: 'LIABILITY', account_group: null, parent_account_number: null, subtype: null, is_system_account: true, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '21000', name: 'Current Liabilities', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '20000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'CREDIT' },
  // Accounts Payable
  { account_number: '21100', name: 'Accounts Payable', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21000', subtype: 'PAYABLE', is_system_account: true, allow_posting: false, normal_balance: 'CREDIT', role: 'accounts_payable' },
  { account_number: '21110', name: 'Trade Creditors', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21100', subtype: 'PAYABLE', is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  // Tax Payable
  { account_number: '21200', name: 'Tax Payable', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21000', subtype: 'TAX', is_system_account: false, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '21210', name: 'VAT Payable', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21200', subtype: 'TAX', is_system_account: false, allow_posting: true, normal_balance: 'CREDIT', role: 'vat_payable' },
  { account_number: '21220', name: 'PAYE Payable', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21200', subtype: 'TAX', is_system_account: false, allow_posting: true, normal_balance: 'CREDIT', role: 'paye_payable' },
  { account_number: '21300', name: 'Accrued Expenses', account_type: 'LIABILITY', account_group: 'CURRENT_LIABILITY', parent_account_number: '21000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  // Long-Term Liabilities
  { account_number: '22000', name: 'Long-Term Liabilities', account_type: 'LIABILITY', account_group: 'LONG_TERM_LIABILITY', parent_account_number: '20000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '22100', name: 'Bank Loans', account_type: 'LIABILITY', account_group: 'LONG_TERM_LIABILITY', parent_account_number: '22000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  { account_number: '22200', name: 'Other Loans', account_type: 'LIABILITY', account_group: 'LONG_TERM_LIABILITY', parent_account_number: '22000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },

  // EQUITY (30000-39999)
  { account_number: '30000', name: 'Equity', account_type: 'EQUITY', account_group: 'EQUITY', parent_account_number: null, subtype: null, is_system_account: true, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', account_group: 'EQUITY', parent_account_number: '30000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  { account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', account_group: 'EQUITY', parent_account_number: '30000', subtype: null, is_system_account: true, allow_posting: true, normal_balance: 'CREDIT', role: 'retained_earnings' },
  { account_number: '33000', name: 'Current Year Earnings', account_type: 'EQUITY', account_group: 'EQUITY', parent_account_number: '30000', subtype: null, is_system_account: true, allow_posting: true, normal_balance: 'CREDIT' },
  { account_number: '34000', name: 'Drawings', account_type: 'EQUITY', account_group: 'EQUITY', parent_account_number: '30000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },

  // INCOME (40000-49999)
  { account_number: '40000', name: 'Income', account_type: 'INCOME', account_group: null, parent_account_number: null, subtype: null, is_system_account: true, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '41000', name: 'Sales', account_type: 'INCOME', account_group: 'REVENUE', parent_account_number: '40000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '41100', name: 'Product Sales', account_type: 'INCOME', account_group: 'REVENUE', parent_account_number: '41000', subtype: null, is_system_account: true, allow_posting: true, normal_balance: 'CREDIT', role: 'sales' },
  { account_number: '41200', name: 'Service Income', account_type: 'INCOME', account_group: 'REVENUE', parent_account_number: '41000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  { account_number: '42000', name: 'Other Income', account_type: 'INCOME', account_group: 'OTHER_INCOME', parent_account_number: '40000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'CREDIT' },
  { account_number: '42100', name: 'Interest Income', account_type: 'INCOME', account_group: 'OTHER_INCOME', parent_account_number: '42000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },
  { account_number: '42200', name: 'Discount Received', account_type: 'INCOME', account_group: 'OTHER_INCOME', parent_account_number: '42000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'CREDIT' },

  // EXPENSES (50000-59999)
  { account_number: '50000', name: 'Expenses', account_type: 'EXPENSE', account_group: null, parent_account_number: null, subtype: null, is_system_account: true, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '51000', name: 'Cost of Sales', account_type: 'EXPENSE', account_group: 'COST_OF_SALES', parent_account_number: '50000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '51100', name: 'Purchases', account_type: 'EXPENSE', account_group: 'COST_OF_SALES', parent_account_number: '51000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'purchases' },
  { account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', account_group: 'COST_OF_SALES', parent_account_number: '51000', subtype: null, is_system_account: true, allow_posting: true, normal_balance: 'DEBIT', role: 'cogs' },
  { account_number: '51300', name: 'Freight & Carriage', account_type: 'EXPENSE', account_group: 'COST_OF_SALES', parent_account_number: '51000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52000', name: 'Operating Expenses', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '50000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '52100', name: 'Salaries & Wages', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'salaries' },
  { account_number: '52200', name: 'Rent', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'rent' },
  { account_number: '52300', name: 'Utilities', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'utilities' },
  { account_number: '52400', name: 'Internet & Telephone', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52500', name: 'Advertising', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52600', name: 'Transport', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52700', name: 'Repairs & Maintenance', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52800', name: 'Office Expenses', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '52900', name: 'Bank Charges', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
  { account_number: '53000', name: 'Depreciation', account_type: 'EXPENSE', account_group: 'OPERATING_EXPENSE', parent_account_number: '52000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT', role: 'depreciation' },
  { account_number: '54000', name: 'Other Expenses', account_type: 'EXPENSE', account_group: 'OTHER_EXPENSE', parent_account_number: '50000', subtype: null, is_system_account: false, allow_posting: false, normal_balance: 'DEBIT' },
  { account_number: '54100', name: 'Interest Expense', account_type: 'EXPENSE', account_group: 'OTHER_EXPENSE', parent_account_number: '54000', subtype: null, is_system_account: false, allow_posting: true, normal_balance: 'DEBIT' },
];

class FinanceService {
  async _all(table, filters = {}) {
    return repo.getAll(table, filters);
  }

  async _getById(table, id) {
    return repo.getById(table, id);
  }

  async _upsert(table, record) {
    return repo.upsert(table, record);
  }

  async _softDelete(table, id) {
    return repo.softDelete(table, id);
  }

  _validateCurrency(currency) {
    const code = String(currency || 'USD').trim();
    const isoRegex = /^[A-Z]{3}$/;
    if (!isoRegex.test(code)) {
      throw new Error(`Invalid currency code: ${code}. Must be a 3-letter ISO code.`);
    }
  }

  /**
   * Resolve a sensible default account id for ledger postings. Used by
   * createExpense / createIncome when the caller did not supply an
   * explicit account_id. Returns null on failure so the caller can decide
   * whether to fall back gracefully.
   *
   * kind: 'expense'  ÔåÆ first expense-type account (or fallback 50000)
   * kind: 'income'   ÔåÆ first revenue/income-type account (or fallback 40000)
   * kind: 'cash'     ÔåÆ first cash/bank asset account (or fallback 11101)
   */
  async _resolveDefaultAccountId(kind, hint, companyId = null) {
    try {
      const accounts = await this.getAccounts({ company_id: companyId });
      const wantedType = kind === 'income' ? 'INCOME'
        : kind === 'cash' ? 'ASSET'
        : 'EXPENSE';
      const match = accounts.find((a) => String(a.account_type || '').toUpperCase() === wantedType
        && (a.subtype === kind || !a.subtype)
        && a.allow_posting !== false);
      if (match && match.id) return match.id;
      // Fall back to a known system code from the 5-digit template
      if (kind === 'cash') return '11110';   // Cash Drawer
      if (kind === 'income') return '41100'; // Product Sales
      return '51200';                         // Cost of Goods Sold
    } catch (err) {
      // Hard fallback when the chart of accounts is unreadable.
      if (kind === 'cash') return '11110';   // Cash Drawer
      if (kind === 'income') return '41100'; // Product Sales
      return '51200';                         // Cost of Goods Sold
    }
  }

  _mapLegacyTypeToNew(type) {
    const mapping = {
      'asset': 'ASSET',
      'liability': 'LIABILITY',
      'equity': 'EQUITY',
      'revenue': 'INCOME',
      'expense': 'EXPENSE'
    };
    return mapping[type?.toLowerCase()] || type;
  }

  _getNormalBalance(accountType) {
    return ACCOUNT_TYPE_NORMAL_BALANCE[accountType] || 'DEBIT';
  }

  _buildAccountTree(accounts, parentId = null, depth = 0) {
    return accounts
      .filter(a => a.parent_account_id === parentId)
      .map(account => ({
        ...account,
        depth,
        children: this._buildAccountTree(accounts, account.id, depth + 1)
      }))
      .sort((a, b) => (a.account_number || a.code || '').localeCompare(b.account_number || b.code || ''));
  }

  _flattenTree(tree) {
    const result = [];
    const flatten = (nodes) => {
      for (const node of nodes) {
        const { children, ...account } = node;
        result.push(account);
        if (children && children.length > 0) {
          flatten(children);
        }
      }
    };
    flatten(tree);
    return result;
  }

  _getDescendantIds(accounts, parentId) {
    const descendants = [];
    const stack = [parentId];
    while (stack.length > 0) {
      const currentId = stack.pop();
      for (const account of accounts) {
        if (account.parent_account_id === currentId) {
          descendants.push(account.id);
          stack.push(account.id);
        }
      }
    }
    return descendants;
  }

  async _getCompanyId(req) {
    try {
      if (req.headers['x-company-id']) {
        return req.headers['x-company-id'];
      }
      const companySetting = await repo.getAll('settings', { key: 'company_id' });
      if (companySetting && companySetting.length > 0) {
        return companySetting[0].value;
      }
    } catch (e) {
      // Fall through
    }
    return null;
  }

  // ÔöÇÔöÇ Chart of Accounts ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async getAccounts(options = {}) {
    let accounts = await repo.getAll('chart_of_accounts');

    // Filter by company if specified
    if (options.company_id) {
      accounts = accounts.filter(a => a.company_id === options.company_id);
    }

    // Filter inactive if specified
    if (!options.include_inactive) {
      accounts = accounts.filter(a => a.is_active !== false && a.is_active !== 0);
    }

    // Transform legacy data to new format if needed
    accounts = accounts.map(a => this._normalizeAccount(a));

    return accounts;
  }

  async getAccountTree(options = {}) {
    const accounts = await this.getAccounts(options);
    const tree = this._buildAccountTree(accounts);
    return tree;
  }

  _normalizeAccount(account) {
    // Handle legacy data format
    const normalized = { ...account };

    // Map legacy type to new account_type
    if (!normalized.account_type && normalized.type) {
      normalized.account_type = this._mapLegacyTypeToNew(normalized.type);
      normalized.normal_balance = this._getNormalBalance(normalized.account_type);
    }

    // Map legacy code to account_number if account_number not set
    if (!normalized.account_number && normalized.code) {
      // Convert 4-digit code to 5-digit if needed
      normalized.account_number = normalized.code.padStart(5, '0');
    }

    // Map legacy parent_id to parent_account_id
    if (!normalized.parent_account_id && normalized.parent_id) {
      normalized.parent_account_id = normalized.parent_id;
    }

    // Set normal_balance based on account_type if not set
    if (!normalized.normal_balance && normalized.account_type) {
      normalized.normal_balance = this._getNormalBalance(normalized.account_type);
    }

    // Ensure boolean fields
    normalized.is_active = normalized.is_active !== false && normalized.is_active !== 0;
    normalized.is_system_account = normalized.is_system_account === true || normalized.is_system_account === 1;
    normalized.allow_posting = normalized.allow_posting === true || normalized.allow_posting === 1;

    return normalized;
  }

  async getAccountById(id) {
    const account = await repo.getById('chart_of_accounts', id);
    if (account) {
      return this._normalizeAccount(account);
    }
    return null;
  }

  async getAccountByCode(code) {
    const accounts = await repo.getAll('chart_of_accounts');
    const account = accounts.find(a => a.code === code || a.account_number === code);
    if (account) {
      return this._normalizeAccount(account);
    }
    return null;
  }

  async createAccount(data, companyId = null) {
    this._validateCurrency(data.currency);

    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();

    // Determine account_type (required)
    let accountType = data.account_type;
    if (!accountType && data.type) {
      accountType = this._mapLegacyTypeToNew(data.type);
    }
    if (!accountType) {
      throw new Error('Account type is required');
    }

    // Determine account_number
    let accountNumber = data.account_number;
    if (!accountNumber && data.code) {
      accountNumber = data.code.padStart(5, '0');
    }
    if (!accountNumber) {
      // Generate next account number for type
      accountNumber = await this._generateAccountNumber(accountType, companyId);
    }

    // Validate unique account_number for company
    const existing = await repo.getAll('chart_of_accounts');
    const duplicate = existing.find(a =>
      a.account_number === accountNumber &&
      (companyId ? a.company_id === companyId : true)
    );
    if (duplicate) {
      throw new Error(`Account number ${accountNumber} already exists`);
    }

    // Validate parent if specified
    let parentAccountId = data.parent_account_id || data.parent_id || null;
    if (parentAccountId) {
      const parent = await this.getAccountById(parentAccountId);
      if (!parent) {
        throw new Error('Parent account not found');
      }
      // Validate parent is same account_type
      if (parent.account_type !== accountType) {
        throw new Error('Parent account must have the same account type');
      }
      // Validate no circular hierarchy
      if (!this._validateNoCircularHierarchy(parentAccountId, id, existing)) {
        throw new Error('This would create a circular hierarchy');
      }
    }

    const record = {
      id,
      company_id: companyId || data.company_id || null,
      account_number: accountNumber,
      name: data.name,
      account_type: accountType,
      account_group: data.account_group || null,
      subtype: data.subtype || null,
      parent_account_id: parentAccountId,
      normal_balance: data.normal_balance || this._getNormalBalance(accountType),
      is_system_account: data.is_system_account ? 1 : 0,
      allow_posting: data.allow_posting === true ? 1 : 0,
      is_active: data.is_active !== false && data.is_active !== 0 ? 1 : 0,
      opening_balance: data.opening_balance || 0,
      opening_balance_date: data.opening_balance_date || null,
      description: data.description || null,
      // Legacy fields for backward compatibility
      code: data.code || accountNumber,
      type: data.type || accountType.toLowerCase(),
      category: data.category || null,
      created_at: now,
      updated_at: now
    };

    await repo.upsert('chart_of_accounts', record);
    return this.getAccountById(id);
  }

  async _generateAccountNumber(accountType, companyId) {
    const accounts = await repo.getAll('chart_of_accounts');
    const typeRanges = {
      'ASSET': { min: 10000, max: 19999 },
      'LIABILITY': { min: 20000, max: 29999 },
      'EQUITY': { min: 30000, max: 39999 },
      'INCOME': { min: 40000, max: 49999 },
      'EXPENSE': { min: 50000, max: 59999 }
    };

    const range = typeRanges[accountType] || { min: 90000, max: 99999 };

    // Filter accounts by company and type
    const typeAccounts = accounts.filter(a => {
      const type = a.account_type || this._mapLegacyTypeToNew(a.type);
      if (type !== accountType) return false;
      if (companyId && a.company_id !== companyId) return false;
      return true;
    });

    // Find existing numbers in range
    const usedNumbers = typeAccounts
      .map(a => parseInt(a.account_number || a.code || '0', 10))
      .filter(n => n >= range.min && n <= range.max)
      .sort((a, b) => a - b);

    // Find first available number
    let nextNumber = range.min;
    for (const num of usedNumbers) {
      if (num === nextNumber) {
        nextNumber++;
      } else if (num > nextNumber) {
        break;
      }
    }

    if (nextNumber > range.max) {
      throw new Error(`Account number range exhausted for type ${accountType}`);
    }

    return nextNumber.toString().padStart(5, '0');
  }

  _validateNoCircularHierarchy(parentId, childId, accounts) {
    if (!parentId || !childId) return true;
    if (parentId === childId) return false;

    const visited = new Set();
    let current = parentId;

    while (current) {
      if (current === childId) return false;
      if (visited.has(current)) return false;
      visited.add(current);

      const account = accounts.find(a => a.id === current);
      current = account?.parent_account_id || account?.parent_id;
    }

    return true;
  }

  async updateAccount(id, data) {
    const old = await this.getAccountById(id);
    if (!old) throw new Error('Account not found');

    // Cannot modify system account classification
    if (old.is_system_account && data.account_type && data.account_type !== old.account_type) {
      throw new Error('Cannot change account type of a system account');
    }

    // Validate parent if changing
    let newParentId = data.parent_account_id ?? old.parent_account_id;
    if (newParentId) {
      // Cannot be own parent
      if (newParentId === id) {
        throw new Error('Account cannot be its own parent');
      }

      // Validate parent exists
      const parent = await this.getAccountById(newParentId);
      if (!parent) {
        throw new Error('Parent account not found');
      }

      // Parent must have same account_type
      const newType = data.account_type || old.account_type;
      if (parent.account_type !== newType) {
        throw new Error('Parent account must have the same account type');
      }

      // Check for circular hierarchy
      const accounts = await this.getAccounts();
      if (!this._validateNoCircularHierarchy(newParentId, id, accounts)) {
        throw new Error('This would create a circular hierarchy');
      }
    }

    // Validate account_number uniqueness if changing
    if (data.account_number && data.account_number !== old.account_number) {
      const existing = await repo.getAll('chart_of_accounts');
      const duplicate = existing.find(a =>
        a.id !== id &&
        a.account_number === data.account_number &&
        a.company_id === old.company_id
      );
      if (duplicate) {
        throw new Error(`Account number ${data.account_number} already exists`);
      }
    }

    const updates = { ...old };

    // Map new field names to legacy for backward compat
    const fieldMap = {
      account_number: 'account_number',
      name: 'name',
      account_type: 'account_type',
      account_group: 'account_group',
      subtype: 'subtype',
      parent_account_id: 'parent_account_id',
      normal_balance: 'normal_balance',
      is_system_account: 'is_system_account',
      allow_posting: 'allow_posting',
      is_active: 'is_active',
      opening_balance: 'opening_balance',
      opening_balance_date: 'opening_balance_date',
      description: 'description',
      // Legacy
      code: 'code',
      type: 'type',
      category: 'category'
    };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && fieldMap[key]) {
        updates[key] = value;
      }
    }

    // Convert booleans to integers for legacy columns
    if (updates.is_system_account === true) updates.is_system_account = 1;
    if (updates.is_system_account === false) updates.is_system_account = 0;
    if (updates.allow_posting === true) updates.allow_posting = 1;
    if (updates.allow_posting === false) updates.allow_posting = 0;
    if (updates.is_active === true) updates.is_active = 1;
    if (updates.is_active === false) updates.is_active = 0;

    updates.updated_at = new Date().toISOString();

    // Remove computed fields
    delete updates.children;
    delete updates.depth;

    await repo.upsert('chart_of_accounts', updates);
    return this.getAccountById(id);
  }

  async updateAccountStatus(id, isActive) {
    const account = await this.getAccountById(id);
    if (!account) throw new Error('Account not found');

    // Check if account has transactions
    const ledger = await repo.getAll('ledger_entries');
    const hasTransactions = ledger.some(e => e.account_id === id);
    if (hasTransactions && !isActive) {
      throw new Error('Cannot deactivate account with transaction history. Consider hiding it instead.');
    }

    return this.updateAccount(id, { is_active: isActive });
  }

  async deleteAccount(id) {
    const account = await this.getAccountById(id);
    if (!account) throw new Error('Account not found');

    // Cannot delete system accounts
    if (account.is_system_account) {
      throw new Error('Cannot delete system account');
    }

    // Check for child accounts
    const accounts = await this.getAccounts();
    const hasChildren = accounts.some(a => a.parent_account_id === id);
    if (hasChildren) {
      throw new Error('Cannot delete account with sub-accounts. Delete or reassign children first.');
    }

    // Check for transaction history
    const ledger = await repo.getAll('ledger_entries');
    const hasTransactions = ledger.some(e => e.account_id === id);
    if (hasTransactions) {
      throw new Error('Cannot delete account with transaction history. Deactivate it instead.');
    }

    await this._softDelete('chart_of_accounts', id);
    return { success: true };
  }

  // ÔöÇÔöÇ Standard Chart of Accounts ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async createStandardChart(companyId = null) {
    const results = [];
    const accountMap = {}; // Map account_number to created account

    // First pass: create all accounts without parent references
    for (const template of STANDARD_CHART_OF_ACCOUNTS) {
      // Check if account already exists
      const existing = await repo.getAll('chart_of_accounts');
      const found = existing.find(a =>
        a.account_number === template.account_number &&
        (companyId ? a.company_id === companyId : true)
      );

      if (found) {
        accountMap[template.account_number] = found;
        results.push({ action: 'skipped', account: found, reason: 'already exists' });
        continue;
      }

      // Create the account
      const accountData = {
        name: template.name,
        account_type: template.account_type,
        account_group: template.account_group,
        account_number: template.account_number,
        parent_account_id: null, // Will be set in second pass
        subtype: template.subtype || null,
        is_system_account: template.is_system_account === true,
        allow_posting: template.allow_posting === true,
        opening_balance: 0,
        opening_balance_date: null,
        description: `Standard ${template.account_type} account: ${template.name}`,
        company_id: companyId,
        normal_balance: template.normal_balance,
      };

      try {
        const created = await this.createAccount(accountData, companyId);
        accountMap[template.account_number] = created;
        results.push({ action: 'created', account: created });
      } catch (err) {
        results.push({ action: 'error', account: template, error: err.message });
      }
    }

    // Second pass: update parent references
    for (const template of STANDARD_CHART_OF_ACCOUNTS) {
      if (!template.parent_account_number) continue;

      const account = accountMap[template.account_number];
      const parent = accountMap[template.parent_account_number];

      if (account && parent && account.parent_account_id !== parent.id) {
        try {
          await this.updateAccount(account.id, { parent_account_id: parent.id });
          results.push({ action: 'linked', account: account.name, parent: parent.name });
        } catch (err) {
          results.push({ action: 'link_error', account: account.name, error: err.message });
        }
      }
    }

    return {
      company_id: companyId,
      created: results.filter(r => r.action === 'created').length,
      skipped: results.filter(r => r.action === 'skipped').length,
      errors: results.filter(r => r.action === 'error' || r.action === 'link_error'),
      details: results
    };
  }

  // ÔöÇÔöÇ Account Balance Calculation ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async calculateAccountBalance(accountId) {
    const account = await this.getAccountById(accountId);
    if (!account) throw new Error('Account not found');

    // Get opening balance
    const openingBalance = account.opening_balance || 0;

    // Get ledger entries
    const ledgerEntries = await repo.getAll('ledger_entries');
    const accountEntries = ledgerEntries.filter(e => e.account_id === accountId);

    // Calculate ledger balance
    let ledgerBalance = 0;
    for (const entry of accountEntries) {
      if (entry.entry_type === 'debit') {
        ledgerBalance += parseFloat(entry.amount) || 0;
      } else if (entry.entry_type === 'credit') {
        ledgerBalance -= parseFloat(entry.amount) || 0;
      }
    }

    // Apply normal balance convention
    if (account.normal_balance === 'CREDIT') {
      return openingBalance - ledgerBalance;
    }
    return openingBalance + ledgerBalance;
  }

  async calculateParentBalance(accountId, accounts = null) {
    const allAccounts = accounts || await this.getAccounts();
    const account = allAccounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    // Get direct balance
    let totalBalance = await this.calculateAccountBalance(accountId);

    // Add balances of all descendants
    const descendants = this._getDescendantIds(allAccounts, accountId);
    for (const descId of descendants) {
      totalBalance += await this.calculateAccountBalance(descId);
    }

    return totalBalance;
  }

  // ÔöÇÔöÇ Ledger ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async getLedger(accountId) {
    let rows = await repo.getAll('ledger_entries');
    if (accountId) {
      rows = rows.filter(e => e.account_id === accountId);
    }
    rows.sort((a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || '')));
    return rows;
  }

  async saveLedgerEntry(entry, currency = 'USD') {
    const id = entry.id || crypto.randomUUID();
    const record = {
      id,
      account_id: entry.account_id,
      account_code: entry.account_code || null,
      account_name: entry.account_name || null,
      entry_type: entry.entry_type,
      amount: entry.amount,
      currency: entry.currency || currency,
      description: entry.description || null,
      reference_type: entry.reference_type || null,
      reference_id: entry.reference_id || null,
      journal_id: entry.journal_id || null,
      entry_date: entry.entry_date,
      created_by: entry.created_by || null,
    };
    await repo.upsert('ledger_entries', record);
    return repo.getById('ledger_entries', id);
  }

  async reverseLedgerEntriesByReference(referenceType, referenceId) {
    const entries = await repo.getAll('ledger_entries', {
      'data->>reference_type': `eq.${referenceType}`,
      'data->>reference_id': `eq.${referenceId}`,
    });
    const journalId = randomUUID();
    for (const entry of entries) {
      await repo.upsert('ledger_entries', {
        id: randomUUID(),
        account_id: entry.account_id,
        account_code: entry.account_code,
        account_name: entry.account_name,
        entry_type: entry.entry_type === 'debit' ? 'credit' : 'debit',
        amount: entry.amount,
        currency: entry.currency,
        description: `Reversal of ${entry.description || entry.reference_id}`,
        reference_type: 'reversal',
        reference_id: referenceId,
        journal_id: journalId,
        entry_date: new Date().toISOString(),
        created_by: null,
      });
    }
    return journalId;
  }

  async voidExpenseLedger(id) {
    return this.reverseLedgerEntriesByReference('expense', id);
  }

  async voidIncomeLedger(id) {
    return this.reverseLedgerEntriesByReference('income', id);
  }

  // ÔöÇÔöÇ Expenses ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async getExpenses() {
    const rows = await repo.getAll('expenses');
    return rows.sort((a, b) => String(b.expense_date || '').localeCompare(String(a.expense_date || '')));
  }

  async createExpense(data) {
    this._validateCurrency(data.currency);

    // Validate accounts BEFORE persisting
      if (data.account_id) {
        const exists = await repo.getById('chart_of_accounts', data.account_id);
        if (!exists) throw new Error('Invalid expense account');
        if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Expense account does not allow posting');
        if (exists.is_active === false || exists.is_active === 0) throw new Error('Expense account is inactive');
      }
      if (data.offset_account_id) {
        const exists = await repo.getById('chart_of_accounts', data.offset_account_id);
        if (!exists) throw new Error('Invalid offset account');
        if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Offset account does not allow posting');
        if (exists.is_active === false || exists.is_active === 0) throw new Error('Offset account is inactive');
      }

    const id = data.id || crypto.randomUUID();
    const record = {
      id,
      category: data.category,
      vendor_name: data.vendor_name || null,
      amount: data.amount,
      currency: data.currency || 'USD',
      description: data.description || null,
      expense_date: data.expense_date,
      account_id: data.account_id || null,
      payment_method: data.payment_method || null,
      status: data.status || 'pending',
      receipt_url: data.receipt_url || null,
      created_by: data.created_by || null,
    };
    await repo.upsert('expenses', record);

    // F-03: post a paired ledger entry. An expense is a debit to the
    // expense category and a credit to the offsetting account (cash / bank
    // / accounts payable). The default offset account is "Cash in Hand"
    // (11101) when none is supplied; the explicit `data.account_id` is the
    // *expense* account and is the debit side. Operators can override
    // `data.offset_account_id` for accruals.
    try {
      const expenseAcctId = data.account_id || await this._resolveDefaultAccountId('expense', data.category, data.company_id);
      const offsetAcctId = data.offset_account_id || await this._resolveDefaultAccountId('cash', null, data.company_id);
      console.log(`[Finance] createExpense ${id}: expenseAcctId=${expenseAcctId}, offsetAcctId=${offsetAcctId}, data.account_id=${data.account_id}, data.offset_account_id=${data.offset_account_id}`);

      // Validate resolved accounts before posting
      if (data.account_id) {
        const exists = await repo.getById('chart_of_accounts', data.account_id);
        if (!exists) throw new Error('Invalid expense account');
        if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Expense account does not allow posting');
        if (exists.is_active === false || exists.is_active === 0) throw new Error('Expense account is inactive');
      }
      if (data.offset_account_id) {
        const exists = await repo.getById('chart_of_accounts', data.offset_account_id);
        if (!exists) throw new Error('Invalid offset account');
        if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Offset account does not allow posting');
        if (exists.is_active === false || exists.is_active === 0) throw new Error('Offset account is inactive');
      }

      if (expenseAcctId && offsetAcctId) {
        const journalId = randomUUID();
        console.log(`[Finance] createExpense ${id}: About to save debit ledger entry for ${expenseAcctId}`);
        await this.saveLedgerEntry({
          account_id: expenseAcctId,
          entry_type: 'debit',
          amount: data.amount,
          currency: data.currency || 'USD',
          description: data.description || `Expense: ${data.category}`,
          reference_type: 'expense',
          reference_id: id,
          journal_id: journalId,
          entry_date: data.expense_date || new Date().toISOString(),
          created_by: data.created_by || null,
        });
        console.log(`[Finance] createExpense ${id}: Debit saved. About to save credit.`);
        await this.saveLedgerEntry({
          account_id: offsetAcctId,
          entry_type: 'credit',
          amount: data.amount,
          currency: data.currency || 'USD',
          description: data.description || `Expense offset: ${data.category}`,
          reference_type: 'expense',
          reference_id: id,
          journal_id: journalId,
          entry_date: data.expense_date || new Date().toISOString(),
          created_by: data.created_by || null,
        });
        console.log(`[Finance] createExpense ${id}: Credit saved.`);
      }
    } catch (err) {
      // Never fail the expense creation because the ledger post failed —
      // the expense record itself is the source of truth for the UI. A
      // background reconciliation job can re-post the missing ledger rows.
      console.warn(`[financeService] expense ${id} ledger post skipped: ${err && err.message}`, err && err.stack);
    }

    return repo.getById('expenses', id);
  }

  async updateExpense(id, data) {
    const old = await repo.getById('expenses', id);
    if (!old) throw new Error('Expense not found');
    const updates = { ...old };
    const allowed = ['category', 'vendor_name', 'amount', 'currency', 'description', 'expense_date', 'account_id', 'payment_method', 'status', 'receipt_url'];
    for (const field of allowed) {
      if (data[field] !== undefined) {
        updates[field] = data[field] === null ? null : data[field];
      }
    }
    updates.updated_at = new Date().toISOString();
    const updated = await repo.upsert('expenses', updates);

    if (data.status === 'cancelled') {
      await this.voidExpenseLedger(id);
    }
    return updated;
  }

  async deleteExpense(id) {
    await this._softDelete('expenses', id);
    return { success: true };
  }

  // ÔöÇÔöÇ Income ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async getIncome() {
    const rows = await repo.getAll('income');
    return rows.sort((a, b) => String(b.income_date || '').localeCompare(String(a.income_date || '')));
  }

  async createIncome(data) {
    this._validateCurrency(data.currency);

    // Validate accounts BEFORE persisting
    if (data.account_id) {
      const exists = await repo.getById('chart_of_accounts', data.account_id);
      if (!exists) throw new Error('Invalid income account');
      if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Income account does not allow posting');
      if (exists.is_active === false || exists.is_active === 0) throw new Error('Income account is inactive');
    }
    if (data.offset_account_id) {
      const exists = await repo.getById('chart_of_accounts', data.offset_account_id);
      if (!exists) throw new Error('Invalid offset account');
      if (exists.allow_posting === false || exists.allow_posting === 0) throw new Error('Offset account does not allow posting');
      if (exists.is_active === false || exists.is_active === 0) throw new Error('Offset account is inactive');
    }

    const id = data.id || crypto.randomUUID();
    const record = {
      id,
      source: data.source,
      amount: data.amount,
      currency: data.currency || 'USD',
      description: data.description || null,
      income_date: data.income_date,
      account_id: data.account_id || null,
      payment_method: data.payment_method || null,
      reference: data.reference || null,
      created_by: data.created_by || null,
    };
    await repo.upsert('income', record);

    // F-03: post a paired ledger entry. Income is a credit to a revenue
    // account and a debit to the offsetting account (cash / bank / AR).
    try {
      const incomeAcctId = data.account_id || await this._resolveDefaultAccountId('income', data.source, data.company_id);
      const offsetAcctId = data.offset_account_id || await this._resolveDefaultAccountId('cash', null, data.company_id);
      if (incomeAcctId && offsetAcctId) {
        const journalId = randomUUID();
        await this.saveLedgerEntry({
          account_id: incomeAcctId,
          entry_type: 'credit',
          amount: data.amount,
          currency: data.currency || 'USD',
          description: data.description || `Income: ${data.source}`,
          reference_type: 'income',
          reference_id: id,
          journal_id: journalId,
          entry_date: data.income_date || new Date().toISOString(),
          created_by: data.created_by || null,
        });
        await this.saveLedgerEntry({
          account_id: offsetAcctId,
          entry_type: 'debit',
          amount: data.amount,
          currency: data.currency || 'USD',
          description: data.description || `Income offset: ${data.source}`,
          reference_type: 'income',
          reference_id: id,
          journal_id: journalId,
          entry_date: data.income_date || new Date().toISOString(),
          created_by: data.created_by || null,
        });
      }
    } catch (err) {
      console.warn(`[financeService] income ${id} ledger post skipped: ${err && err.message}`);
    }

    return repo.getById('income', id);
  }

  async deleteIncome(id) {
    await this.voidIncomeLedger(id);
    await this._softDelete('income', id);
    return { success: true };
  }

  // ÔöÇÔöÇ Budgets ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  async getBudgets() {
    const rows = await repo.getAll('budgets');
    return rows.sort((a, b) => String(b.fiscal_year || '').localeCompare(String(a.fiscal_year || '')));
  }

  async createBudget(data) {
    this._validateCurrency(data.currency);
    const id = data.id || crypto.randomUUID();
    const record = {
      id,
      name: data.name,
      fiscal_year: data.fiscal_year,
      category: data.category,
      budgeted_amount: data.budgeted_amount,
      currency: data.currency || 'USD',
      notes: data.notes || null,
      created_by: data.created_by || null,
    };
    await repo.upsert('budgets', record);
    return repo.getById('budgets', id);
  }

  async updateBudget(id, data) {
    const old = await repo.getById('budgets', id);
    if (!old) throw new Error('Budget not found');
    const updates = { ...old };
    const allowed = ['name', 'fiscal_year', 'category', 'budgeted_amount', 'currency', 'notes'];
    for (const field of allowed) {
      if (data[field] !== undefined) {
        updates[field] = data[field];
      }
    }
    updates.updated_at = new Date().toISOString();
    await repo.upsert('budgets', updates);
    return repo.getById('budgets', id);
  }

  async deleteBudget(id) {
    await this._softDelete('budgets', id);
    return { success: true };
  }

  // ── Transfers ──────────────────────────────────────────────────────
  async getTransfers() {
    const rows = await repo.getAll('transfers');
    return rows.sort((a, b) => String(b.transfer_date || b.created_at || '').localeCompare(String(a.transfer_date || a.created_at || '')));
  }

  async createTransfer(data, userId = null) {
    this._validateCurrency(data.currency);
    const id = data.id || crypto.randomUUID();
    const fromId = data.from_account_id;
    const toId = data.to_account_id;

    if (fromId === toId) {
      throw new Error('Source and destination accounts cannot be the same');
    }

    const fromAccount = await this.getAccountById(fromId);
    const toAccount = await this.getAccountById(toId);
    if (!fromAccount) throw new Error('Source account not found');
    if (!toAccount) throw new Error('Destination account not found');

    if (!fromAccount.allow_posting) throw new Error('Source account does not allow posting');
    if (!toAccount.allow_posting) throw new Error('Destination account does not allow posting');
    if (fromAccount.is_active === false) throw new Error('Source account is inactive');
    if (toAccount.is_active === false) throw new Error('Destination account is inactive');

    const transferDate = data.transfer_date || new Date().toISOString();
    const record = {
      id,
      from_account_id: fromId,
      to_account_id: toId,
      amount: data.amount,
      currency: data.currency || 'USD',
      description: data.description || null,
      reference: data.reference || null,
      transfer_date: transferDate,
      status: 'completed',
      created_by: userId,
    };
    await repo.upsert('transfers', record);

    const journalId = randomUUID();
    await this.saveLedgerEntry({
      account_id: toId,
      entry_type: 'debit',
      amount: data.amount,
      currency: data.currency || 'USD',
      description: data.description || `Transfer to ${toAccount.name}`,
      reference_type: 'transfer',
      reference_id: id,
      journal_id: journalId,
      entry_date: transferDate,
      created_by: userId,
    });
    await this.saveLedgerEntry({
      account_id: fromId,
      entry_type: 'credit',
      amount: data.amount,
      currency: data.currency || 'USD',
      description: data.description || `Transfer from ${fromAccount.name}`,
      reference_type: 'transfer',
      reference_id: id,
      journal_id: journalId,
      entry_date: transferDate,
      created_by: userId,
    });

    return repo.getById('transfers', id);
  }
}

module.exports = FinanceService;
