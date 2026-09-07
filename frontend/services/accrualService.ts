/**
 * Accrual Service
 * 
 * Phase 2: Module for managing accruals (expenses incurred but not yet paid)
 * Handles:
 * - Salary/wage accruals
 * - Interest accruals
 * - Expense accruals
 * - Tax accruals
 * - Reversal of accruals when paid
 */

import { dbService } from './db';
import { AccrualEntry } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const STORE_NAME = 'accrualEntries';

function getConfig() {
    return getGLConfig();
}

export const accrualService = {
    STORE_NAME,

    async getAll(): Promise<AccrualEntry[]> {
        try {
            const all = await dbService.getAll<AccrualEntry>(STORE_NAME);
            return all.sort((a, b) => {
                const dateCompare = b.period_year - a.period_year || b.period_month - a.period_month;
                return dateCompare;
            });
        } catch (error) {
            logger.error('Failed to get accruals', error);
            return [];
        }
    },

    async getById(id: string): Promise<AccrualEntry | null> {
        try {
            return await dbService.getById<AccrualEntry>(STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get accrual ${id}`, error);
            return null;
        }
    },

    async getByPeriod(year: number, month: number): Promise<AccrualEntry[]> {
        const all = await this.getAll();
        return all.filter(a => a.period_year === year && a.period_month === month);
    },

    async createAccrual(
        accrualType: AccrualEntry['accrual_type'],
        description: string,
        accountId: string,
        accruedAmount: number,
        periodYear: number,
        periodMonth: number,
        reversalDate?: string,
        accounts: any[] = []
    ): Promise<AccrualEntry | null> {
        const config = getConfig();
        const accts = accounts;

        const accruedExpensesAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || config.accruedExpensesAccount;

        try {
            await ledgerService.createJournalEntry({
                date: new Date(periodYear, periodMonth - 1, 1).toISOString(),
                description: `Accrual: ${description}`,
                reference: `ACCR-${generateId('ACCR')}`,
                lines: [
                    {
                        debitAccountId: accountId,
                        creditAccountId: accruedExpensesAccountId,
                        amount: accruedAmount,
                        description,
                    }
                ],
                entryType: 'ACCRUAL',
            });

            const accrual: AccrualEntry = {
                id: generateId('ACCR'),
                accrual_type: accrualType,
                description,
                account_id: accountId,
                accrued_amount: accruedAmount,
                reversal_date: reversalDate,
                period_year: periodYear,
                period_month: periodMonth,
                status: 'posted',
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, accrual);
            return accrual;
        } catch (error) {
            logger.error('Failed to create accrual', error);
            return null;
        }
    },

    async reverseAccrual(accrualId: string, accounts: any[] = []): Promise<AccrualEntry | null> {
        const accrual = await this.getById(accrualId);
        if (!accrual) return null;

        if (accrual.status === 'reversed') {
            throw new Error('Accrual already reversed');
        }

        const config = getConfig();
        const accts = accounts;

        const accruedExpensesAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || config.accruedExpensesAccount;

        try {
            await ledgerService.createJournalEntry({
                date: accrual.reversal_date || new Date().toISOString(),
                description: `Reversal: ${accrual.description}`,
                reference: `ACCR-REV-${generateId('ACCR')}`,
                lines: [
                    {
                        debitAccountId: accruedExpensesAccountId,
                        creditAccountId: accrual.account_id,
                        amount: accrual.accrued_amount,
                        description: `Reversal of ${accrual.description}`,
                    }
                ],
                entryType: 'ACCRUAL_REVERSAL',
            });

            const updated: AccrualEntry = {
                ...accrual,
                status: 'reversed',
            };

            await dbService.put(STORE_NAME, updated);
            return updated;
        } catch (error) {
            logger.error('Failed to reverse accrual', error);
            return null;
        }
    },

    async getAccrualsSummary(year?: number, month?: number): Promise<{
        totalAccrued: number;
        byType: Record<string, number>;
    }> {
        const all = await this.getAll();
        const filtered = all.filter(a => {
            if (a.status !== 'posted') return false;
            if (year && a.period_year !== year) return false;
            if (month && a.period_month !== month) return false;
            return true;
        });

        const byType: Record<string, number> = {};
        let totalAccrued = 0;

        for (const accrual of filtered) {
            totalAccrued += accrual.accrued_amount;
            byType[accrual.accrual_type] = (byType[accrual.accrual_type] || 0) + accrual.accrued_amount;
        }

        return { totalAccrued, byType };
    },

    async createSalaryAccrual(
        amount: number,
        periodYear: number,
        periodMonth: number,
        accounts: any[] = []
    ): Promise<AccrualEntry | null> {
        const config = getConfig();
        const salariesAccountId = resolveAccountForPosting(config.salariesExpenseAccount, accounts) || config.salariesExpenseAccount;

        return this.createAccrual(
            'salary_accrual',
            `Salary accrual for ${periodYear}-${String(periodMonth).padStart(2, '0')}`,
            salariesAccountId,
            amount,
            periodYear,
            periodMonth,
            new Date(periodYear, periodMonth - 1, 28).toISOString().split('T')[0],
            accounts
        );
    },

    async createInterestAccrual(
        loanId: string,
        interestAmount: number,
        periodYear: number,
        periodMonth: number,
        accounts: any[] = []
    ): Promise<AccrualEntry | null> {
        const config = getConfig();
        const interestExpenseId = resolveAccountForPosting(config.interestExpenseAccount, accounts) || config.interestExpenseAccount;

        return this.createAccrual(
            'interest_accrual',
            `Interest accrual for loan ${loanId}`,
            interestExpenseId,
            interestAmount,
            periodYear,
            periodMonth,
            undefined,
            accounts
        );
    },

    async initializeStore(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default accrualService;
