/**
 * Income Summary Service
 * 
 * Phase 2: Module for year-end financial closing
 * Handles:
 * - Closing income accounts to 33000 (Current Year Earnings)
 * - Closing expense accounts to 33000
 * - Calculating net profit or net loss
 * - Transferring balance to retained earnings (32000)
 */

import { dbService } from './db';
import { IncomeSummaryEntry, LedgerEntry } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting, loadAccountsFromStore } from './transactions/_internal';
import { entryTouchesAccount, isPostedLedgerEntry } from './accountingEngine';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const STORE_NAME = 'incomeSummaryEntries';
const LEDGER_STORE = 'ledger';

export interface ClosingResult {
    totalIncome: number;
    totalExpenses: number;
    netProfit: number;
    netLoss: number;
    entriesClosed: number;
    journalEntryId: string | null;
}

export const incomeSummaryService = {
    STORE_NAME,

    async closeIncomeAccounts(
        fiscalYear: number,
        accounts: any[] = []
    ): Promise<ClosingResult | null> {
        const config = getGLConfig();
        const accts = accounts;

        const currentYearEarningsId = resolveAccountForPosting(config.currentYearEarningsAccount, accts) || config.currentYearEarningsAccount;

        try {
            const ledgerEntries = await dbService.getAll<LedgerEntry>(LEDGER_STORE);
            const periodStart = `${fiscalYear}-01-01`;
            const periodEnd = `${fiscalYear}-12-31`;

            const incomeAccounts = accts.filter((a: any) =>
                a.account_type === 'INCOME' ||
                a.account_group === 'REVENUE' ||
                a.account_group === 'OTHER_INCOME'
            );

            let totalIncome = 0;
            const accountClosures: { accountId: string; amount: number; name: string }[] = [];

            for (const account of incomeAccounts) {
                if (!account.allow_posting && !account.is_system_account) continue;

                // Resolve to the canonical posting id so the closing line
                // zeroes THIS account (not an arbitrary summary account).
                const accountId = resolveAccountForPosting(
                    account.id || account.account_number || account.code, accts
                ) || account.id || account.account_number || account.code;
                // Net activity for this account in the fiscal year, matched by
                // id/code/account_number so legacy-referenced rows are not
                // silently skipped. Drafts/voids never close.
                const credits = ledgerEntries
                    .filter(e =>
                        isPostedLedgerEntry(e) &&
                        entryTouchesAccount(e, account, 'credit') &&
                        e.date >= periodStart &&
                        e.date <= periodEnd
                    )
                    .reduce((sum: number, e: LedgerEntry) => sum + (e.amount || 0), 0);

                const debits = ledgerEntries
                    .filter(e =>
                        isPostedLedgerEntry(e) &&
                        entryTouchesAccount(e, account, 'debit') &&
                        e.date >= periodStart &&
                        e.date <= periodEnd
                    )
                    .reduce((sum: number, e: LedgerEntry) => sum + (e.amount || 0), 0);

                const netBalance = credits - debits;
                if (netBalance > 0) {
                    totalIncome += netBalance;
                    accountClosures.push({ accountId, amount: netBalance, name: account.name });
                }
            }

            if (totalIncome === 0) {
                return { totalIncome: 0, totalExpenses: 0, netProfit: 0, netLoss: 0, entriesClosed: 0, journalEntryId: null };
            }

            // Proper closing: debit EACH revenue account (zeroing it) and
            // credit Current Year Earnings. Debiting a single summary account
            // would leave the revenue balances in place and count the same
            // profit twice (once in Income, once in Equity).
            const lines = accountClosures.map(closure => ({
                debitAccountId: closure.accountId,
                creditAccountId: currentYearEarningsId,
                amount: closure.amount,
                description: `Close ${closure.name} for ${fiscalYear}`,
            }));

            const result = await ledgerService.createJournalEntry({
                date: `${fiscalYear}-12-31`,
                description: `Income Account Closures - FY ${fiscalYear}`,
                reference: `CLOSE-INCOME-${fiscalYear}`,
                lines,
                entryType: 'INCOME_CLOSURE',
            });

            for (const closure of accountClosures) {
                const entry: IncomeSummaryEntry = {
                    id: generateId('ISE'),
                    account_id: closure.accountId,
                    account_name: closure.name,
                    closing_type: 'income',
                    amount: closure.amount,
                    fiscal_year: fiscalYear,
                    journal_entry_id: result?.id,
                    created_at: new Date().toISOString(),
                };
                await dbService.put(STORE_NAME, entry);
            }

            return { totalIncome, totalExpenses: 0, netProfit: 0, netLoss: 0, entriesClosed: accountClosures.length, journalEntryId: result?.id };
        } catch (error) {
            logger.error('Failed to close income accounts', error);
            return null;
        }
    },

    async closeExpenseAccounts(
        fiscalYear: number,
        accounts: any[] = []
    ): Promise<ClosingResult | null> {
        const config = getGLConfig();
        const accts = accounts;

        const currentYearEarningsId = resolveAccountForPosting(config.currentYearEarningsAccount, accts) || config.currentYearEarningsAccount;

        try {
            const ledgerEntries = await dbService.getAll<LedgerEntry>(LEDGER_STORE);
            const periodStart = `${fiscalYear}-01-01`;
            const periodEnd = `${fiscalYear}-12-31`;

            const expenseAccounts = accts.filter((a: any) =>
                a.account_type === 'EXPENSE' ||
                a.account_group === 'OPERATING_EXPENSE' ||
                a.account_group === 'COST_OF_SALES' ||
                a.account_group === 'OTHER_EXPENSE'
            );

            let totalExpenses = 0;
            const accountClosures: { accountId: string; amount: number; name: string }[] = [];

            for (const account of expenseAccounts) {
                if (!account.allow_posting && !account.is_system_account) continue;

                // Resolve to the canonical posting id so the closing line
                // zeroes THIS account (not an arbitrary summary account).
                const accountId = resolveAccountForPosting(
                    account.id || account.account_number || account.code, accts
                ) || account.id || account.account_number || account.code;
                const debits = ledgerEntries
                    .filter(e =>
                        isPostedLedgerEntry(e) &&
                        entryTouchesAccount(e, account, 'debit') &&
                        e.date >= periodStart &&
                        e.date <= periodEnd
                    )
                    .reduce((sum: number, e: LedgerEntry) => sum + (e.amount || 0), 0);

                const credits = ledgerEntries
                    .filter(e =>
                        isPostedLedgerEntry(e) &&
                        entryTouchesAccount(e, account, 'credit') &&
                        e.date >= periodStart &&
                        e.date <= periodEnd
                    )
                    .reduce((sum: number, e: LedgerEntry) => sum + (e.amount || 0), 0);

                const netBalance = debits - credits;
                if (netBalance > 0) {
                    totalExpenses += netBalance;
                    accountClosures.push({ accountId, amount: netBalance, name: account.name });
                }
            }

            if (totalExpenses === 0) {
                return { totalIncome: 0, totalExpenses, netProfit: 0, netLoss: 0, entriesClosed: 0, journalEntryId: null };
            }

            // Proper closing: credit EACH expense account (zeroing it) and
            // debit Current Year Earnings.
            const lines = accountClosures.map(closure => ({
                debitAccountId: currentYearEarningsId,
                creditAccountId: closure.accountId,
                amount: closure.amount,
                description: `Close ${closure.name} for ${fiscalYear}`,
            }));

            const result = await ledgerService.createJournalEntry({
                date: `${fiscalYear}-12-31`,
                description: `Expense Account Closures - FY ${fiscalYear}`,
                reference: `CLOSE-EXPENSE-${fiscalYear}`,
                lines,
                entryType: 'EXPENSE_CLOSURE',
            });

            for (const closure of accountClosures) {
                const entry: IncomeSummaryEntry = {
                    id: generateId('ISE'),
                    account_id: closure.accountId,
                    account_name: closure.name,
                    closing_type: 'expense',
                    amount: closure.amount,
                    fiscal_year: fiscalYear,
                    journal_entry_id: result?.id,
                    created_at: new Date().toISOString(),
                };
                await dbService.put(STORE_NAME, entry);
            }

            return { totalIncome: 0, totalExpenses, netProfit: 0, netLoss: 0, entriesClosed: accountClosures.length, journalEntryId: result?.id };
        } catch (error) {
            logger.error('Failed to close expense accounts', error);
            return null;
        }
    },

    async closeYear(
        fiscalYear: number,
        accounts: any[] = []
    ): Promise<{
        netProfit: number;
        netLoss: number;
        incomeResult: ClosingResult | null;
        expenseResult: ClosingResult | null;
        retainedEarningsResult: ClosingResult | null;
    }> {
        const config = getGLConfig();
        const accts = accounts;

        const incomeResult = await this.closeIncomeAccounts(fiscalYear, accts);
        const expenseResult = await this.closeExpenseAccounts(fiscalYear, accts);

        const totalIncome = incomeResult?.totalIncome || 0;
        const totalExpenses = expenseResult?.totalExpenses || 0;
        const netProfit = totalIncome - totalExpenses;
        const netLoss = netProfit < 0 ? Math.abs(netProfit) : 0;

        let retainedEarningsResult: ClosingResult | null = null;

        if (netProfit > 0) {
            const retainedEarningsId = resolveAccountForPosting(config.retainedEarningsAccount, accts) || config.retainedEarningsAccount;
            const currentYearEarningsId = resolveAccountForPosting(config.currentYearEarningsAccount, accts) || config.currentYearEarningsAccount;

            retainedEarningsResult = await ledgerService.createJournalEntry({
                date: `${fiscalYear}-12-31`,
                description: `Transfer Net Profit to Retained Earnings - FY ${fiscalYear}`,
                reference: `CLOSE-NP-${fiscalYear}`,
                lines: [
                    {
                        debitAccountId: currentYearEarningsId,
                        creditAccountId: retainedEarningsId,
                        amount: netProfit,
                        description: `Net profit for ${fiscalYear} transferred to retained earnings`,
                    }
                ],
                entryType: 'RETAINED_EARNINGS_CLOSURE',
            }) as unknown as ClosingResult;

            const entry: IncomeSummaryEntry = {
                id: generateId('ISE'),
                account_id: currentYearEarningsId,
                account_name: 'Current Year Earnings',
                closing_type: 'net_profit',
                amount: netProfit,
                fiscal_year: fiscalYear,
                journal_entry_id: retainedEarningsResult?.journalEntryId || null,
                created_at: new Date().toISOString(),
            };
            await dbService.put(STORE_NAME, entry);
        } else if (netLoss > 0) {
            const retainedEarningsId = resolveAccountForPosting(config.retainedEarningsAccount, accts) || config.retainedEarningsAccount;
            const currentYearEarningsId = resolveAccountForPosting(config.currentYearEarningsAccount, accts) || config.currentYearEarningsAccount;

            retainedEarningsResult = await ledgerService.createJournalEntry({
                date: `${fiscalYear}-12-31`,
                description: `Transfer Net Loss to Retained Earnings - FY ${fiscalYear}`,
                reference: `CLOSE-NL-${fiscalYear}`,
                lines: [
                    {
                        debitAccountId: retainedEarningsId,
                        creditAccountId: currentYearEarningsId,
                        amount: netLoss,
                        description: `Net loss for ${fiscalYear} transferred to retained earnings`,
                    }
                ],
                entryType: 'RETAINED_EARNINGS_CLOSURE',
            }) as unknown as ClosingResult;

            const entry: IncomeSummaryEntry = {
                id: generateId('ISE'),
                account_id: currentYearEarningsId,
                account_name: 'Current Year Earnings',
                closing_type: 'net_loss',
                amount: netLoss,
                fiscal_year: fiscalYear,
                journal_entry_id: retainedEarningsResult?.journalEntryId || null,
                created_at: new Date().toISOString(),
            };
            await dbService.put(STORE_NAME, entry);
        }

        return { netProfit, netLoss, incomeResult, expenseResult, retainedEarningsResult };
    },

    async getClosingHistory(): Promise<IncomeSummaryEntry[]> {
        try {
            return await dbService.getAll<IncomeSummaryEntry>(STORE_NAME);
        } catch {
            return [];
        }
    },

    async initializeStore(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default incomeSummaryService;
