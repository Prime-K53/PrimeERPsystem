/**
 * Account Resolution Service
 * 
 * Phase 2: Centralized account resolution for the hierarchical Chart of Accounts.
 * This service resolves semantic accounting roles to actual account.id values.
 * 
 * Semantic roles:
 * - AR (Accounts Receivable)
 * - AP (Accounts Payable)
 * - CASH (Main Cash)
 * - BANK (Bank Accounts)
 * - SALES (Product/Service Sales)
 * - INVENTORY
 * - COGS (Cost of Goods Sold)
 * - TAX_PAYABLE
 * - RETAINED_EARNINGS
 * - EQUITY
 * - EXPENSE
 * - DRAWINGS
 * 
 * This service ensures that:
 * 1. All new accounting transactions use account.id as canonical identity
 * 2. Legacy code lookups are supported for backward compatibility
 * 3. Account validation (active, allow_posting, company ownership) is enforced
 */

import { Account } from '../types';
import { dbService } from './db';
import { DEFAULT_ACCOUNTS } from '../constants';

export type AccountRole = 
  | 'AR' 
  | 'AP' 
  | 'CASH' 
  | 'BANK' 
  | 'MOBILE_MONEY'
  | 'SALES' 
  | 'SALES_PRODUCT'
  | 'SALES_SERVICE'
  | 'INVENTORY' 
  | 'COGS' 
  | 'TAX_PAYABLE'
  | 'TAX_INPUT'
  | 'RETAINED_EARNINGS' 
  | 'EQUITY'
  | 'CAPITAL'
  | 'DRAWINGS'
  | 'EXPENSE'
  | 'EXPENSE_OPERATING'
  | 'EXPENSE_SALARIES'
  | 'EXPENSE_RENT'
  | 'EXPENSE_UTILITIES'
  | 'EXPENSE_OTHER'
  | 'OTHER_INCOME'
  | 'PURCHASES'
  | 'FIXED_ASSET'
  | 'ACCUMULATED_DEPRECIATION';

interface AccountResolutionOptions {
  companyId?: string;
  allowInactive?: boolean;
  allowNonPosting?: boolean;
}

interface ResolvedAccount {
  id: string;
  code: string;
  account_number: string;
  name: string;
  account_type: string;
  account_group?: string;
  subtype?: string;
  normal_balance: string;
  role: AccountRole;
}

/**
 * Legacy code to account role mapping
 * These are used to resolve existing glMapping configurations
 */
 const LEGACY_CODE_ROLE_MAP: Record<string, AccountRole> = {
   // Assets
   '1000': 'CASH',
   '1050': 'BANK',
   '1060': 'MOBILE_MONEY',
   '1100': 'AR',
   '11300': 'AR',
   '11310': 'AR',
   '1200': 'FIXED_ASSET',
   '1300': 'INVENTORY',
   '1400': 'AR',
   '1500': 'FIXED_ASSET',
   '1600': 'ACCUMULATED_DEPRECIATION',
   '11100': 'CASH',
   '11110': 'CASH',
   '11120': 'CASH',
   '11200': 'BANK',
   '11210': 'BANK',
   '11220': 'BANK',
   '11230': 'BANK',
   '11400': 'INVENTORY',
   '11410': 'INVENTORY',
   '11420': 'INVENTORY',
   '11430': 'INVENTORY',
   '12000': 'FIXED_ASSET',
   '12100': 'FIXED_ASSET',
   '12200': 'FIXED_ASSET',
   '12300': 'FIXED_ASSET',
   '12400': 'FIXED_ASSET',
   '12500': 'ACCUMULATED_DEPRECIATION',
   '11500': 'OTHER_CURRENT_ASSET',
   '11510': 'OTHER_CURRENT_ASSET',
   '11520': 'OTHER_CURRENT_ASSET',
   // Liabilities
   '2000': 'AP',
   '2100': 'AP',
   '2110': 'AP',
   '21100': 'AP',
   '21110': 'AP',
   '2120': 'TAX_PAYABLE',
   '21210': 'TAX_PAYABLE',
   '21220': 'TAX_PAYABLE',
   '21300': 'AP',
   '2200': 'AP',
   '22000': 'AP',
   '22100': 'AP',
   '22200': 'AP',
   // Equity
   '3000': 'EQUITY',
   '3100': 'CAPITAL',
   '3200': 'RETAINED_EARNINGS',
   '3300': 'RETAINED_EARNINGS',
   '3400': 'DRAWINGS',
   '30000': 'EQUITY',
   '31000': 'CAPITAL',
   '32000': 'RETAINED_EARNINGS',
   '33000': 'RETAINED_EARNINGS',
   '34000': 'DRAWINGS',
   // Income
   '4000': 'SALES',
   '4100': 'SALES',
   '4110': 'SALES_PRODUCT',
   '4120': 'SALES_SERVICE',
   '40000': 'SALES',
   '41000': 'SALES',
   '41100': 'SALES_PRODUCT',
   '41200': 'SALES_SERVICE',
   '4200': 'OTHER_INCOME',
   '42100': 'OTHER_INCOME',
   '42200': 'OTHER_INCOME',
   '4900': 'OTHER_INCOME',
   // Expenses
   '5000': 'EXPENSE',
   '5100': 'COGS',
   '5110': 'PURCHASES',
   '5120': 'COGS',
   '51100': 'COGS',
   '51200': 'COGS',
   '51300': 'COGS',
   '5200': 'EXPENSE_OPERATING',
   '5210': 'EXPENSE_SALARIES',
   '5220': 'EXPENSE_RENT',
   '5230': 'EXPENSE_UTILITIES',
   '5300': 'EXPENSE_OTHER',
   '5400': 'EXPENSE_OTHER',
   '52000': 'EXPENSE_OPERATING',
   '52100': 'EXPENSE_SALARIES',
   '52200': 'EXPENSE_RENT',
   '52300': 'EXPENSE_UTILITIES',
   '52400': 'EXPENSE_OPERATING',
   '52500': 'EXPENSE_OPERATING',
   '52600': 'EXPENSE_OPERATING',
   '52700': 'EXPENSE_OPERATING',
   '52800': 'EXPENSE_OPERATING',
   '52900': 'EXPENSE_OPERATING',
   '53000': 'EXPENSE_OPERATING',
   '54100': 'EXPENSE_OPERATING',
   '6100': 'EXPENSE',
   '6200': 'EXPENSE_OPERATING',
   '6300': 'EXPENSE_SALARIES',
 };

/**
 * Default account IDs for each role (used when no company-specific mapping exists)
 * These correspond to the DEFAULT_ACCOUNTS in constants.ts
 */
 const DEFAULT_ROLE_ACCOUNT_IDS: Partial<Record<AccountRole, string>> = {
   'AR': '11310',
   'AP': '21110',
   'CASH': '11110',
   'PETTY_CASH': '11120',
   'BANK': '11210',
   'SALES': '41100',
   'SALES_PRODUCT': '41100',
   'SALES_SERVICE': '41200',
   'INVENTORY': '11400',
   'COGS': '51200',
   'TAX_PAYABLE': '21210',
   'TAX_INPUT': '21210',
   'RETAINED_EARNINGS': '32000',
   'EQUITY': '30000',
   'CAPITAL': '31000',
   'DRAWINGS': '34000',
   'EXPENSE': '52000',
   'EXPENSE_OPERATING': '52000',
   'EXPENSE_SALARIES': '52100',
   'EXPENSE_RENT': '52200',
   'EXPENSE_UTILITIES': '52300',
   'EXPENSE_OTHER': '52900',
   'OTHER_INCOME': '42000',
   'PURCHASES': '51100',
   'FIXED_ASSET': '12100',
   'ACCUMULATED_DEPRECIATION': '12500',
   'MOBILE_MONEY': '11210',
   'OTHER_CURRENT_ASSET': '11510',
 };

/**
 * Account Resolution Service
 */
class AccountResolutionService {
  private accountsCache: Account[] | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 5000;

  /**
   * Get all accounts (with caching)
   */
  private async getAccounts(): Promise<Account[]> {
    const now = Date.now();
    if (this.accountsCache && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return this.accountsCache;
    }
    
    let accounts: Account[] = [];
    try {
      accounts = await dbService.getAll<Account>('accounts');
    } catch {
      accounts = DEFAULT_ACCOUNTS;
    }
    
    if (accounts.length === 0) {
      accounts = DEFAULT_ACCOUNTS;
    }
    
    this.accountsCache = accounts;
    this.cacheTimestamp = now;
    return accounts;
  }

  /**
   * Clear the accounts cache
   */
  clearCache(): void {
    this.accountsCache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Find an account by ID or code (for backward compatibility)
   */
  private findAccount(accounts: Account[], identifier: string): Account | undefined {
    return accounts.find(a => 
      a.id === identifier || 
      a.code === identifier || 
      a.account_number === identifier
    );
  }

  /**
   * Resolve an account by semantic role
   */
  async resolveByRole(
    role: AccountRole, 
    options: AccountResolutionOptions = {}
  ): Promise<ResolvedAccount | null> {
    const accounts = await this.getAccounts();
    
    // Find accounts matching the role
    let candidates = accounts.filter(a => {
      // Check if account has subtype matching role
      if (a.subtype) {
        const subtypeMap: Record<string, AccountRole[]> = {
          'RECEIVABLE': ['AR'],
          'PAYABLE': ['AP'],
          'CASH': ['CASH', 'PETTY_CASH'],
          'BANK': ['BANK'],
          'INVENTORY': ['INVENTORY'],
          'SALES': ['SALES', 'SALES_PRODUCT', 'SALES_SERVICE'],
          'COGS': ['COGS'],
          'TAX': ['TAX_PAYABLE', 'TAX_INPUT'],
          'FIXED_ASSET': ['FIXED_ASSET'],
        };
        const mappedRoles = subtypeMap[a.subtype.toUpperCase()] || [];
        if (mappedRoles.includes(role)) return true;
      }
      
      // Check account_group matching role
      if (a.account_group) {
        const groupMap: Record<string, AccountRole[]> = {
          'CURRENT_ASSET': ['AR', 'CASH', 'BANK', 'INVENTORY'],
          'FIXED_ASSET': ['FIXED_ASSET'],
          'CURRENT_LIABILITY': ['AP', 'TAX_PAYABLE'],
          'EQUITY': ['EQUITY', 'CAPITAL', 'RETAINED_EARNINGS', 'DRAWINGS'],
          'REVENUE': ['SALES', 'SALES_PRODUCT', 'SALES_SERVICE', 'OTHER_INCOME'],
          'COST_OF_SALES': ['COGS', 'PURCHASES'],
          'OPERATING_EXPENSE': ['EXPENSE', 'EXPENSE_OPERATING', 'EXPENSE_SALARIES', 'EXPENSE_RENT', 'EXPENSE_UTILITIES'],
          'OTHER_EXPENSE': ['EXPENSE_OTHER'],
        };
        const mappedRoles = groupMap[a.account_group.toUpperCase()] || [];
        if (mappedRoles.includes(role)) return true;
      }
      
      // Fall back to account type
      const typeRoleMap: Record<string, AccountRole[]> = {
        'ASSET': ['AR', 'CASH', 'BANK', 'INVENTORY', 'FIXED_ASSET'],
        'LIABILITY': ['AP', 'TAX_PAYABLE'],
        'EQUITY': ['EQUITY', 'CAPITAL', 'RETAINED_EARNINGS', 'DRAWINGS'],
        'INCOME': ['SALES', 'SALES_PRODUCT', 'SALES_SERVICE', 'OTHER_INCOME'],
        'EXPENSE': ['EXPENSE', 'EXPENSE_OPERATING', 'EXPENSE_SALARIES', 'EXPENSE_RENT', 'EXPENSE_UTILITIES', 'EXPENSE_OTHER', 'COGS', 'PURCHASES'],
      };
      const upperType = (a.account_type || a.type || '').toUpperCase();
      const mappedRoles = typeRoleMap[upperType] || [];
      return mappedRoles.includes(role);
    });

    // Filter by company if specified
    if (options.companyId) {
      candidates = candidates.filter(a => 
        !a.company_id || a.company_id === options.companyId
      );
    }

    // Filter by active status
    if (!options.allowInactive) {
      candidates = candidates.filter(a => a.is_active !== false && a.is_active !== 0);
    }

    // Filter by allow_posting
    if (!options.allowNonPosting) {
      candidates = candidates.filter(a => a.allow_posting !== false && a.allow_posting !== 0);
    }

    if (candidates.length === 0) {
      return null;
    }

    // Prefer system accounts for core roles
    const systemCandidate = candidates.find(a => a.is_system_account);
    const preferred = systemCandidate || candidates[0];

    return {
      id: preferred.id,
      code: preferred.code || preferred.account_number || preferred.id,
      account_number: preferred.account_number || preferred.code || preferred.id,
      name: preferred.name,
      account_type: preferred.account_type || preferred.type || 'ASSET',
      account_group: preferred.account_group,
      subtype: preferred.subtype,
      normal_balance: preferred.normal_balance || 'DEBIT',
      role,
    };
  }

  /**
   * Resolve an account by ID, code, or account_number
   * Supports backward compatibility with legacy codes
   */
  async resolveAccount(
    identifier: string,
    options: AccountResolutionOptions = {}
  ): Promise<ResolvedAccount | null> {
    const accounts = await this.getAccounts();
    
    const account = this.findAccount(accounts, identifier);
    if (!account) {
      return null;
    }

    // Check company ownership
    if (options.companyId && account.company_id && account.company_id !== options.companyId) {
      return null;
    }

    // Check inactive
    if (!options.allowInactive && account.is_active === false || account.is_active === 0) {
      return null;
    }

    // Determine the role from legacy code mapping
    const legacyCode = account.code || account.account_number;
    let role: AccountRole = 'EXPENSE';
    if (legacyCode && LEGACY_CODE_ROLE_MAP[legacyCode]) {
      role = LEGACY_CODE_ROLE_MAP[legacyCode];
    } else if (account.account_type || account.type) {
      const upperType = (account.account_type || account.type || '').toUpperCase();
      if (upperType === 'ASSET') role = 'CASH';
      else if (upperType === 'LIABILITY') role = 'AP';
      else if (upperType === 'EQUITY') role = 'EQUITY';
      else if (upperType === 'INCOME') role = 'SALES';
      else if (upperType === 'EXPENSE') role = 'EXPENSE';
    }

    return {
      id: account.id,
      code: account.code || account.account_number || account.id,
      account_number: account.account_number || account.code || account.id,
      name: account.name,
      account_type: account.account_type || account.type || 'ASSET',
      account_group: account.account_group,
      subtype: account.subtype,
      normal_balance: account.normal_balance || 'DEBIT',
      role,
    };
  }

  /**
   * Get the account ID for a semantic role
   */
  async getAccountIdByRole(role: AccountRole, companyId?: string): Promise<string | null> {
    const resolved = await this.resolveByRole(role, { companyId });
    return resolved?.id || null;
  }

  /**
   * Validate that an account can receive postings
   */
  async validatePostingAccount(
    accountId: string,
    options: AccountResolutionOptions = {}
  ): Promise<{ valid: boolean; error?: string }> {
    const account = await this.resolveAccount(accountId, { allowInactive: true });
    
    if (!account) {
      return { valid: false, error: 'Account not found' };
    }

    if (!options.allowInactive && !account.is_system_account) {
      const fullAccount = (await this.getAccounts()).find(a => a.id === accountId);
      if (fullAccount && (fullAccount.is_active === false || fullAccount.is_active === 0)) {
        return { valid: false, error: 'Account is inactive' };
      }
    }

    // Check allow_posting flag
    const fullAccount = (await this.getAccounts()).find(a => a.id === accountId);
    if (fullAccount && fullAccount.allow_posting === false || fullAccount?.allow_posting === 0) {
      // Group accounts (parents) should not allow posting
      return { valid: false, error: 'Account does not allow posting (group account)' };
    }

    return { valid: true };
  }

  /**
   * Resolve multiple accounts by role
   */
  async resolveMultiple(roles: AccountRole[]): Promise<Map<AccountRole, ResolvedAccount | null>> {
    const results = new Map<AccountRole, ResolvedAccount | null>();
    for (const role of roles) {
      results.set(role, await this.resolveByRole(role));
    }
    return results;
  }

  /**
   * Get all system accounts
   */
  async getSystemAccounts(): Promise<ResolvedAccount[]> {
    const accounts = await this.getAccounts();
    const systemAccounts = accounts.filter(a => a.is_system_account);
    return systemAccounts.map(a => ({
      id: a.id,
      code: a.code || a.account_number || a.id,
      account_number: a.account_number || a.code || a.id,
      name: a.name,
      account_type: a.account_type || a.type || 'ASSET',
      account_group: a.account_group,
      subtype: a.subtype,
      normal_balance: a.normal_balance || 'DEBIT',
      role: 'EXPENSE' as AccountRole,
    }));
  }

  /**
   * Get account balance (combining opening balance + ledger entries)
   */
  async getAccountBalance(accountId: string): Promise<number> {
    const account = await this.resolveAccount(accountId);
    if (!account) return 0;

    const openingBalance = account.normal_balance === 'CREDIT' 
      ? -(account.opening_balance || 0)
      : (account.opening_balance || 0);

    try {
      const ledger = await dbService.getAll<{ debitAccountId: string; creditAccountId: string; amount: number }>('ledger');
      let balance = openingBalance;

      for (const entry of ledger) {
        if (entry.debitAccountId === accountId) {
          balance += entry.amount;
        }
        if (entry.creditAccountId === accountId) {
          balance -= entry.amount;
        }
      }

      return balance;
    } catch {
      return openingBalance;
    }
  }
}

export const accountResolutionService = new AccountResolutionService();
export default accountResolutionService;
