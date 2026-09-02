/**
 * Financial Reporting Service
 *
 * Generates core financial statements:
 * - Trial Balance
 * - Balance Sheet
 * - Profit & Loss (Income Statement)
 * - Cash Flow Statement
 *
 * Follows accounting standards with proper account classification
 */

import { dbService } from './db';
import { Account, LedgerEntry } from '../types';
import { format, parseISO, startOfDay, endOfDay } from 'date-fns';

export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';

// Mapping from new uppercase format to display format
const ACCOUNT_TYPE_TO_DISPLAY: Record<string, AccountType> = {
  'ASSET': 'Asset',
  'LIABILITY': 'Liability',
  'EQUITY': 'Equity',
  'INCOME': 'Revenue',
  'EXPENSE': 'Expense'
};

// Reverse mapping from display/legacy to uppercase
const DISPLAY_TO_ACCOUNT_TYPE: Record<string, string> = {
  'Asset': 'ASSET',
  'asset': 'ASSET',
  'Liability': 'LIABILITY',
  'liability': 'LIABILITY',
  'Equity': 'EQUITY',
  'equity': 'EQUITY',
  'Revenue': 'INCOME',
  'revenue': 'INCOME',
  'Income': 'INCOME',
  'income': 'INCOME',
  'Expense': 'EXPENSE',
  'expense': 'EXPENSE'
};

/**
 * Check if a ledger entry's account reference matches an account.
 * Supports both:
 * - NEW entries: entry.debitAccountId === account.id (UUID)
 * - LEGACY entries: entry.debitAccountId === account.code (e.g., "1000")
 */
function accountMatchesEntry(entry: LedgerEntry, account: Account, side: 'debit' | 'credit'): boolean {
  const entryAccountRef = side === 'debit' ? entry.debitAccountId : entry.creditAccountId;
  if (!entryAccountRef) return false;
  
  // Match by account.id (new canonical ID)
  if (entryAccountRef === account.id) return true;
  
  // Match by account.code (legacy 4-digit code like "1000")
  if (account.code && entryAccountRef === account.code) return true;
  
  // Match by account.account_number (legacy 5-digit code like "11101")
  if (account.account_number && entryAccountRef === account.account_number) return true;
  
  return false;
}

/**
 * Get the account type from an account object, handling both legacy and new formats
 */
function getAccountType(account: Account): AccountType {
  // First check new account_type field (uppercase)
  if (account.account_type) {
    const normalized = account.account_type.toUpperCase();
    return ACCOUNT_TYPE_TO_DISPLAY[normalized] || 'Asset';
  }
  // Fall back to legacy type field (can be lowercase or titlecase)
  if (account.type) {
    const upperType = account.type.toUpperCase();
    if (upperType === 'REVENUE') return 'Revenue';
    return ACCOUNT_TYPE_TO_DISPLAY[upperType] || 'Asset';
  }
  return 'Asset';
}

/**
 * Check if account type is debit-normal (Asset, Expense)
 */
function isDebitNormalAccount(account: Account): boolean {
  const accountType = getAccountType(account);
  return accountType === 'Asset' || accountType === 'Expense';
}

/**
 * Check if account type is credit-normal (Liability, Equity, Revenue)
 */
function isCreditNormalAccount(account: Account): boolean {
  const accountType = getAccountType(account);
  return accountType === 'Liability' || accountType === 'Equity' || accountType === 'Revenue';
}

export interface TrialBalanceEntry {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalanceReport {
  periodStart: string;
  periodEnd: string;
  entries: TrialBalanceEntry[];
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  generatedAt: string;
}

export interface BalanceSheetItem {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: number;
  subCategory?: string;
}

export interface BalanceSheetReport {
  asOfDate: string;
  assets: {
    current: BalanceSheetItem[];
    fixed: BalanceSheetItem[];
    other: BalanceSheetItem[];
    total: number;
  };
  liabilities: {
    current: BalanceSheetItem[];
    longTerm: BalanceSheetItem[];
    total: number;
  };
  equity: {
    items: BalanceSheetItem[];
    total: number;
  };
  totalLiabilitiesAndEquity: number;
  isBalanced: boolean;
  generatedAt: string;
}

export interface ProfitLossItem {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: number;
  category: 'revenue' | 'cogs' | 'expense' | 'otherIncome' | 'otherExpense';
}

export interface ProfitLossReport {
  periodStart: string;
  periodEnd: string;
  revenue: {
    items: ProfitLossItem[];
    total: number;
  };
  cogs: {
    items: ProfitLossItem[];
    total: number;
  };
  grossProfit: number;
  operatingExpenses: {
    items: ProfitLossItem[];
    total: number;
  };
  operatingIncome: number;
  otherIncome: {
    items: ProfitLossItem[];
    total: number;
  };
  otherExpenses: {
    items: ProfitLossItem[];
    total: number;
  };
  netIncome: number;
  generatedAt: string;
}

export interface CashFlowItem {
  description: string;
  amount: number;
  category: 'operating' | 'investing' | 'financing';
}

export interface CashFlowReport {
  periodStart: string;
  periodEnd: string;
  method: 'direct' | 'indirect';
  operatingActivities: {
    items: CashFlowItem[];
    netCash: number;
  };
  investingActivities: {
    items: CashFlowItem[];
    netCash: number;
  };
  financingActivities: {
    items: CashFlowItem[];
    netCash: number;
  };
  netCashChange: number;
  beginningCash: number;
  endingCash: number;
  generatedAt: string;
}

class FinancialReportingService {
  /**
   * Generate Trial Balance for a period
   * Validates that debits = credits
   */
  async generateTrialBalance(
    periodStart: string,
    periodEnd: string
  ): Promise<TrialBalanceReport> {
    const [accounts, ledger] = await Promise.all([
      dbService.getAll<Account>('accounts'),
      dbService.getAll<LedgerEntry>('ledger')
    ]);

    const entries: TrialBalanceEntry[] = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const account of accounts) {
      // Calculate balance for this account in the period
      // Support both new account.id and legacy account.code references
      let debitAmount = 0;
      let creditAmount = 0;

      const accountEntries = ledger.filter(entry => {
        const entryDate = entry.date?.split('T')[0];
        return entryDate >= periodStart &&
               entryDate <= periodEnd &&
               (accountMatchesEntry(entry, account, 'debit') || accountMatchesEntry(entry, account, 'credit'));
      });

      for (const entry of accountEntries) {
        if (accountMatchesEntry(entry, account, 'debit')) {
          debitAmount += entry.amount;
        }
        if (accountMatchesEntry(entry, account, 'credit')) {
          creditAmount += entry.amount;
        }
      }

      // Calculate running balance based on account type
      let balance = 0;
      const accountType = getAccountType(account);

      if (isDebitNormalAccount(account)) {
        balance = debitAmount - creditAmount;
      } else {
        balance = creditAmount - debitAmount;
      }

      // Only include accounts with activity
      if (debitAmount !== 0 || creditAmount !== 0 || balance !== 0) {
        entries.push({
          accountId: account.id,
          accountCode: account.code || account.id,
          accountName: account.name,
          accountType,
          debit: debitAmount,
          credit: creditAmount,
          balance
        });

        totalDebits += debitAmount;
        totalCredits += creditAmount;
      }
    }

    // Sort by account code
    entries.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    return {
      periodStart,
      periodEnd,
      entries,
      totalDebits,
      totalCredits,
      isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generate Balance Sheet as of a specific date
   */
  async generateBalanceSheet(asOfDate: string): Promise<BalanceSheetReport> {
    const [accounts, ledger] = await Promise.all([
      dbService.getAll<Account>('accounts'),
      dbService.getAll<LedgerEntry>('ledger')
    ]);

    const assets: BalanceSheetItem[] = [];
    const liabilities: BalanceSheetItem[] = [];
    const equity: BalanceSheetItem[] = [];

    for (const account of accounts) {
      const accountType = getAccountType(account);

      // Skip revenue and expense accounts (they close to retained earnings)
      if (accountType === 'Revenue' || accountType === 'Expense') {
        continue;
      }

      // Calculate balance up to the as-of date
      // Support both new account.id and legacy account.code references
      let balance = 0;

      const accountEntries = ledger.filter(entry => {
        const entryDate = entry.date?.split('T')[0];
        return entryDate <= asOfDate &&
               (accountMatchesEntry(entry, account, 'debit') || accountMatchesEntry(entry, account, 'credit'));
      });

      for (const entry of accountEntries) {
        if (accountMatchesEntry(entry, account, 'debit')) {
          balance += entry.amount;
        }
        if (accountMatchesEntry(entry, account, 'credit')) {
          balance -= entry.amount;
        }
      }

      // For liability and equity, reverse the sign for proper presentation
      if (accountType === 'Liability' || accountType === 'Equity') {
        balance = -balance;
      }

      if (Math.abs(balance) > 0.001) {
        const item: BalanceSheetItem = {
          accountId: account.id,
          accountCode: account.code || account.id,
          accountName: account.name,
          amount: balance
        };

        if (accountType === 'Asset') {
          assets.push(item);
        } else if (accountType === 'Liability') {
          liabilities.push(item);
        } else if (accountType === 'Equity') {
          equity.push(item);
        }
      }
    }

    // Calculate retained earnings (net income since inception)
    const retainedEarnings = await this.calculateRetainedEarnings(asOfDate);
    
    // Add retained earnings to equity
    if (retainedEarnings !== 0) {
      equity.push({
        accountId: 'retained-earnings',
        accountCode: '3001',
        accountName: 'Retained Earnings',
        amount: retainedEarnings
      });
    }

    // Categorize assets
    const currentAssets = assets.filter(a => this.isCurrentAsset(a.accountCode));
    const fixedAssets = assets.filter(a => this.isFixedAsset(a.accountCode));
    const otherAssets = assets.filter(a => 
      !this.isCurrentAsset(a.accountCode) && !this.isFixedAsset(a.accountCode)
    );

    // Categorize liabilities
    const currentLiabilities = liabilities.filter(l => this.isCurrentLiability(l.accountCode));
    const longTermLiabilities = liabilities.filter(l => !this.isCurrentLiability(l.accountCode));

    const totalAssets = assets.reduce((sum, a) => sum + a.amount, 0);
    const totalLiabilities = liabilities.reduce((sum, l) => sum + l.amount, 0);
    const totalEquity = equity.reduce((sum, e) => sum + e.amount, 0);

    return {
      asOfDate,
      assets: {
        current: currentAssets,
        fixed: fixedAssets,
        other: otherAssets,
        total: totalAssets
      },
      liabilities: {
        current: currentLiabilities,
        longTerm: longTermLiabilities,
        total: totalLiabilities
      },
      equity: {
        items: equity,
        total: totalEquity
      },
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generate Profit & Loss Statement for a period
   */
  async generateProfitLoss(
    periodStart: string,
    periodEnd: string
  ): Promise<ProfitLossReport> {
    const [accounts, ledger] = await Promise.all([
      dbService.getAll<Account>('accounts'),
      dbService.getAll<LedgerEntry>('ledger')
    ]);

    const revenue: ProfitLossItem[] = [];
    const cogs: ProfitLossItem[] = [];
    const operatingExpenses: ProfitLossItem[] = [];
    const otherIncome: ProfitLossItem[] = [];
    const otherExpenses: ProfitLossItem[] = [];

    for (const account of accounts) {
      const accountType = getAccountType(account);

      if (accountType !== 'Revenue' && accountType !== 'Expense') {
        continue;
      }

      // Calculate amount for the period
      // Support both new account.id and legacy account.code references
      let amount = 0;
      
      const accountEntries = ledger.filter(entry => {
        const entryDate = entry.date?.split('T')[0];
        return entryDate >= periodStart && 
               entryDate <= periodEnd &&
               (accountMatchesEntry(entry, account, 'debit') || accountMatchesEntry(entry, account, 'credit'));
      });

      for (const entry of accountEntries) {
        if (accountType === 'Revenue') {
          // Revenue increases on credit
          if (accountMatchesEntry(entry, account, 'credit')) {
            amount += entry.amount;
          }
          if (accountMatchesEntry(entry, account, 'debit')) {
            amount -= entry.amount;
          }
        } else {
          // Expenses increase on debit
          if (accountMatchesEntry(entry, account, 'debit')) {
            amount += entry.amount;
          }
          if (accountMatchesEntry(entry, account, 'credit')) {
            amount -= entry.amount;
          }
        }
      }

      if (Math.abs(amount) > 0.001) {
        const item: ProfitLossItem = {
          accountId: account.id,
          accountCode: account.code || account.id,
          accountName: account.name,
          amount,
          category: this.classifyPLAccount(account.code || '', accountType)
        };

        switch (item.category) {
          case 'revenue':
            revenue.push(item);
            break;
          case 'cogs':
            cogs.push(item);
            break;
          case 'expense':
            operatingExpenses.push(item);
            break;
          case 'otherIncome':
            otherIncome.push(item);
            break;
          case 'otherExpense':
            otherExpenses.push(item);
            break;
        }
      }
    }

    const totalRevenue = revenue.reduce((sum, r) => sum + r.amount, 0);
    const totalCOGS = cogs.reduce((sum, c) => sum + c.amount, 0);
    const grossProfit = totalRevenue - totalCOGS;
    const totalOperatingExpenses = operatingExpenses.reduce((sum, e) => sum + e.amount, 0);
    const operatingIncome = grossProfit - totalOperatingExpenses;
    const totalOtherIncome = otherIncome.reduce((sum, i) => sum + i.amount, 0);
    const totalOtherExpenses = otherExpenses.reduce((sum, e) => sum + e.amount, 0);
    const netIncome = operatingIncome + totalOtherIncome - totalOtherExpenses;

    return {
      periodStart,
      periodEnd,
      revenue: { items: revenue, total: totalRevenue },
      cogs: { items: cogs, total: totalCOGS },
      grossProfit,
      operatingExpenses: { items: operatingExpenses, total: totalOperatingExpenses },
      operatingIncome,
      otherIncome: { items: otherIncome, total: totalOtherIncome },
      otherExpenses: { items: otherExpenses, total: totalOtherExpenses },
      netIncome,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generate Cash Flow Statement (Indirect Method)
   */
  async generateCashFlowStatement(
    periodStart: string,
    periodEnd: string,
    method: 'direct' | 'indirect' = 'indirect'
  ): Promise<CashFlowReport> {
    const [accounts, ledger] = await Promise.all([
      dbService.getAll<Account>('accounts'),
      dbService.getAll<LedgerEntry>('ledger')
    ]);

    // Get cash accounts (check both legacy code and new account_number)
    const cashAccountIds = accounts
      .filter(a => {
        const code = a.code || '';
        const number = a.account_number || '';
        const isCashByCode = code.startsWith('100') || code.startsWith('1110');
        const isCashByNumber = number.startsWith('11100') || number.startsWith('11101') || number.startsWith('11102');
        const isCashByName = (a.name || '').toLowerCase().includes('cash');
        const isCashBySubtype = a.subtype === 'CASH' || a.account_group === 'CURRENT_ASSET';
        return isCashByCode || isCashByNumber || (isCashByName && isCashBySubtype);
      })
      .map(a => a.id);

    const beginningCash = await this.calculateCashBalance(cashAccountIds, periodStart);
    const endingCash = await this.calculateCashBalance(cashAccountIds, periodEnd);

    const operatingItems: CashFlowItem[] = [];
    const investingItems: CashFlowItem[] = [];
    const financingItems: CashFlowItem[] = [];

    if (method === 'indirect') {
      // Start with net income
      const pl = await this.generateProfitLoss(periodStart, periodEnd);
      
      operatingItems.push({
        description: 'Net Income',
        amount: pl.netIncome,
        category: 'operating'
      });

      // Add back non-cash expenses (depreciation)
      const depreciation = await this.calculateDepreciation(periodStart, periodEnd);
      if (depreciation > 0) {
        operatingItems.push({
          description: 'Depreciation and Amortization',
          amount: depreciation,
          category: 'operating'
        });
      }

      // Changes in working capital
      const arChange = await this.calculateWorkingCapitalChange('1100', periodStart, periodEnd);
      if (arChange !== 0) {
        operatingItems.push({
          description: 'Changes in Accounts Receivable',
          amount: -arChange, // Negative because increase in AR is cash outflow
          category: 'operating'
        });
      }

      const apChange = await this.calculateWorkingCapitalChange('2000', periodStart, periodEnd);
      if (apChange !== 0) {
        operatingItems.push({
          description: 'Changes in Accounts Payable',
          amount: apChange, // Positive because increase in AP is cash inflow
          category: 'operating'
        });
      }

      const inventoryChange = await this.calculateWorkingCapitalChange('1200', periodStart, periodEnd);
      if (inventoryChange !== 0) {
        operatingItems.push({
          description: 'Changes in Inventory',
          amount: -inventoryChange,
          category: 'operating'
        });
      }
    }

    // Calculate totals
    const operatingCash = operatingItems.reduce((sum, i) => sum + i.amount, 0);
    const investingCash = investingItems.reduce((sum, i) => sum + i.amount, 0);
    const financingCash = financingItems.reduce((sum, i) => sum + i.amount, 0);

    return {
      periodStart,
      periodEnd,
      method,
      operatingActivities: { items: operatingItems, netCash: operatingCash },
      investingActivities: { items: investingItems, netCash: investingCash },
      financingActivities: { items: financingItems, netCash: financingCash },
      netCashChange: endingCash - beginningCash,
      beginningCash,
      endingCash,
      generatedAt: new Date().toISOString()
    };
  }

  // Helper methods
  private isCurrentAsset(accountCode: string): boolean {
    // Old 4-digit: 10xx, 11xx, 12xx (Cash, Bank, Receivable, Inventory)
    // New 5-digit: 110xx, 120xx, 130xx (Current asset ranges)
    return accountCode.startsWith('11') ||
           accountCode.startsWith('12') ||
           accountCode.startsWith('13') ||
           accountCode.startsWith('110') ||
           accountCode.startsWith('120') ||
           accountCode.startsWith('130') ||
           accountCode.startsWith('140');
  }

  private isFixedAsset(accountCode: string): boolean {
    // Old 4-digit: 15xx, 16xx
    // New 5-digit: 150xx, 160xx
    return accountCode.startsWith('15') ||
           accountCode.startsWith('16') ||
           accountCode.startsWith('150') ||
           accountCode.startsWith('160');
  }

  private isCurrentLiability(accountCode: string): boolean {
    // Old 4-digit: 20xx, 21xx
    // New 5-digit: 210xx, 220xx (Current liability ranges)
    return accountCode.startsWith('20') ||
           accountCode.startsWith('21') ||
           accountCode.startsWith('210') ||
           accountCode.startsWith('220') ||
           accountCode.startsWith('230');
  }

  private isLongTermLiability(accountCode: string): boolean {
    // New 5-digit: 221xx, 222xx (Long-term liability ranges)
    return accountCode.startsWith('221') ||
           accountCode.startsWith('222');
  }

  private classifyPLAccount(accountCode: string, accountType: AccountType): ProfitLossItem['category'] {
    if (accountType === 'Revenue') {
      // Old: 49xx, New: 42xxx (Other income)
      if (accountCode.startsWith('49') || accountCode.startsWith('420')) return 'otherIncome';
      return 'revenue';
    }

    if (accountType === 'Expense') {
      // Old: 50xx (COGS), 61xx-68xx (Expenses), 69xx (Other)
      // New: 51xxx (COGS), 52xxx-53xxx (Operating), 54xxx (Other)
      if (accountCode.startsWith('50') || accountCode.startsWith('510')) return 'cogs';
      if (accountCode.startsWith('69') || accountCode.startsWith('540')) return 'otherExpense';
      return 'expense';
    }

    return 'expense';
  }

  private async calculateRetainedEarnings(asOfDate: string): Promise<number> {
    const ledger = await dbService.getAll<LedgerEntry>('ledger');
    const accounts = await dbService.getAll<Account>('accounts');

    const revenueAccountIds = accounts
      .filter(a => getAccountType(a) === 'Revenue')
      .map(a => a.id);

    const expenseAccountIds = accounts
      .filter(a => getAccountType(a) === 'Expense')
      .map(a => a.id);

    let retainedEarnings = 0;

    for (const entry of ledger) {
      const entryDate = entry.date?.split('T')[0];
      if (entryDate > asOfDate) continue;

      // Revenue increases retained earnings (credit)
      if (revenueAccountIds.includes(entry.creditAccountId)) {
        retainedEarnings += entry.amount;
      }
      if (revenueAccountIds.includes(entry.debitAccountId)) {
        retainedEarnings -= entry.amount;
      }

      // Expenses decrease retained earnings (debit)
      if (expenseAccountIds.includes(entry.debitAccountId)) {
        retainedEarnings -= entry.amount;
      }
      if (expenseAccountIds.includes(entry.creditAccountId)) {
        retainedEarnings += entry.amount;
      }
    }

    return retainedEarnings;
  }

  private async calculateCashBalance(accountIds: string[], asOfDate: string): Promise<number> {
    const ledger = await dbService.getAll<LedgerEntry>('ledger');
    let balance = 0;

    for (const entry of ledger) {
      const entryDate = entry.date?.split('T')[0];
      if (entryDate > asOfDate) continue;

      if (accountIds.includes(entry.debitAccountId)) {
        balance += entry.amount;
      }
      if (accountIds.includes(entry.creditAccountId)) {
        balance -= entry.amount;
      }
    }

    return balance;
  }

  private async calculateDepreciation(periodStart: string, periodEnd: string): Promise<number> {
    const ledger = await dbService.getAll<LedgerEntry>('ledger');
    let depreciation = 0;

    for (const entry of ledger) {
      const entryDate = entry.date?.split('T')[0];
      if (entryDate < periodStart || entryDate > periodEnd) continue;

      // Look for depreciation entries (typically debit to depreciation expense)
      if (entry.description?.toLowerCase().includes('depreciation')) {
        depreciation += entry.amount;
      }
    }

    return depreciation;
  }

  private async calculateWorkingCapitalChange(
    accountCodePrefix: string,
    periodStart: string,
    periodEnd: string
  ): Promise<number> {
    const accounts = await dbService.getAll<Account>('accounts');
    const ledger = await dbService.getAll<LedgerEntry>('ledger');

    const accountIds = accounts
      .filter(a => {
        const code = a.code || '';
        const number = a.account_number || '';
        // Check both legacy 4-digit code and new 5-digit account_number
        return code.startsWith(accountCodePrefix) || number.startsWith(accountCodePrefix);
      })
      .map(a => a.id);

    let beginningBalance = 0;
    let endingBalance = 0;

    for (const entry of ledger) {
      const entryDate = entry.date?.split('T')[0];
      
      let amount = 0;
      if (accountIds.includes(entry.debitAccountId)) {
        amount = entry.amount;
      } else if (accountIds.includes(entry.creditAccountId)) {
        amount = -entry.amount;
      } else {
        continue;
      }

      if (entryDate < periodStart) {
        beginningBalance += amount;
      }
      if (entryDate <= periodEnd) {
        endingBalance += amount;
      }
    }

    return endingBalance - beginningBalance;
  }
}

