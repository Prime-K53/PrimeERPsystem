/**
 * Utility Expenses Service
 *
 * Phase 4: Module for managing utility expenses
 * Handles:
 * - Electricity (52300)
 * - Water (52300)
 * - Telephone (52400)
 * - Internet (52500)
 * - Printing & Stationery (52600)
 */

import { dbService } from './db';
import { UtilityExpense, UtilityPayment } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const UTILITY_EXPENSES_STORE = 'utilityExpenses';
const UTILITY_PAYMENTS_STORE = 'utilityPayments';

export type UtilityType = 'electricity' | 'water' | 'telephone' | 'internet' | 'printing' | 'other';

function getConfig() {
    return getGLConfig();
}

function getUtilityAccount(type: UtilityType): string {
    const config = getConfig();
    switch (type) {
        case 'electricity':
        case 'water':
            return config.utilitiesAccount || '52300';
        case 'telephone':
            return config.telephoneAccount || '52400';
        case 'internet':
            return config.internetAccount || '52500';
        case 'printing':
            return config.printingAccount || '52600';
        default:
            return config.defaultExpenseAccount || '52000';
    }
}

export const utilityExpenseService = {
    UTILITY_EXPENSES_STORE,
    UTILITY_PAYMENTS_STORE,

    async getAllExpenses(): Promise<UtilityExpense[]> {
        try {
            const all = await dbService.getAll<UtilityExpense>(UTILITY_EXPENSES_STORE);
            return all.sort((a, b) => b.period_start.localeCompare(a.period_start));
        } catch (error) {
            logger.error('Failed to get utility expenses', error);
            return [];
        }
    },

    async getExpense(id: string): Promise<UtilityExpense | null> {
        try {
            return await dbService.getById<UtilityExpense>(UTILITY_EXPENSES_STORE, id);
        } catch (error) {
            logger.error(`Failed to get utility expense ${id}`, error);
            return null;
        }
    },

    async recordExpense(
        utilityType: UtilityType,
        amount: number,
        periodStart: string,
        periodEnd: string,
        provider: string,
        accountNumber: string,
        description: string = '',
        accounts: any[] = [],
        companyId?: string
    ): Promise<UtilityExpense | null> {
        const expenseAccountId = getUtilityAccount(utilityType);

        try {
            const expense: UtilityExpense = {
                id: generateId('UTIL'),
                utility_type: utilityType,
                provider,
                account_number: accountNumber,
                amount,
                period_start: periodStart,
                period_end: periodEnd,
                status: 'pending',
                description,
                companyId,
                created_at: new Date().toISOString(),
            };

            await dbService.put(UTILITY_EXPENSES_STORE, expense);
            return expense;
        } catch (error) {
            logger.error('Failed to record utility expense', error);
            return null;
        }
    },

    async payExpense(
        expenseId: string,
        amount: number,
        paymentDate: string,
        bankAccountId: string,
        reference: string = '',
        accounts: any[] = []
    ): Promise<UtilityPayment | null> {
        const expense = await this.getExpense(expenseId);
        if (!expense) return null;

        const config = getConfig();
        const accts = accounts;
        const expenseAccountId = resolveAccountForPosting(getUtilityAccount(expense.utility_type as UtilityType), accts);
        const bankId = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            await ledgerService.createJournalEntry({
                date: paymentDate,
                description: `${expense.provider} payment (${expense.utility_type})`,
                reference: reference || `UTIL-PAY-${generateId('UP')}`,
                lines: [
                    {
                        debitAccountId: expenseAccountId || getUtilityAccount(expense.utility_type as UtilityType),
                        creditAccountId: bankId,
                        amount,
                        description: `Payment for ${expense.utility_type}: ${expense.provider}`,
                    }
                ],
                entryType: 'UTILITY_PAYMENT',
            });

            const payment: UtilityPayment = {
                id: generateId('UP'),
                expense_id: expenseId,
                amount,
                payment_date: paymentDate,
                bank_account_id: bankAccountId,
                reference,
                created_at: new Date().toISOString(),
            };

            await dbService.put(UTILITY_PAYMENTS_STORE, payment);

            await this.updateExpense(expenseId, {
                status: amount >= expense.amount ? 'paid' : 'partial',
                paid_amount: (expense.paid_amount || 0) + amount,
            });

            return payment;
        } catch (error) {
            logger.error('Failed to pay utility expense', error);
            return null;
        }
    },

    async accrueExpense(
        utilityType: UtilityType,
        amount: number,
        accrualDate: string,
        provider: string,
        description: string = '',
        accounts: any[] = []
    ): Promise<UtilityExpense | null> {
        const config = getConfig();
        const accts = accounts;
        const expenseAccountId = getUtilityAccount(utilityType);
        const accruedExpenseId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || config.accruedExpensesAccount;

        try {
            await ledgerService.createJournalEntry({
                date: accrualDate,
                description: `${provider} utility accrual (${utilityType})`,
                reference: `UTIL-ACCR-${generateId('UA')}`,
                lines: [
                    {
                        debitAccountId: expenseAccountId,
                        creditAccountId: accruedExpenseId,
                        amount,
                        description: `Accrual: ${description || utilityType}`,
                    }
                ],
                entryType: 'UTILITY_ACCRUAL',
            });

            const periodStart = accrualDate;
            const periodEnd = new Date(new Date(accrualDate).setMonth(new Date(accrualDate).getMonth() + 1)).toISOString().split('T')[0];

            const expense: UtilityExpense = {
                id: generateId('UTIL'),
                utility_type: utilityType,
                provider,
                account_number: '',
                amount,
                period_start: periodStart,
                period_end: periodEnd,
                status: 'accrued',
                description,
                created_at: new Date().toISOString(),
            };

            await dbService.put(UTILITY_EXPENSES_STORE, expense);
            return expense;
        } catch (error) {
            logger.error('Failed to accrue utility expense', error);
            return null;
        }
    },

    async updateExpense(id: string, updates: Partial<UtilityExpense>): Promise<UtilityExpense | null> {
        const existing = await this.getExpense(id);
        if (!existing) return null;

        const updated: UtilityExpense = {
            ...existing,
            ...updates,
            id: existing.id,
        };

        await dbService.put(UTILITY_EXPENSES_STORE, updated);
        return updated;
    },

    async getUtilitySummary(year?: number): Promise<{
        totalExpenses: number;
        byType: Record<string, number>;
        unpaidCount: number;
    }> {
        const expenses = await this.getAllExpenses();
        const filtered = expenses.filter(e => {
            if (year) {
                const d = new Date(e.period_start);
                return d.getFullYear() === year;
            }
            return true;
        });

        const byType: Record<string, number> = {};
        filtered.forEach(e => {
            byType[e.utility_type] = (byType[e.utility_type] || 0) + e.amount;
        });

        return {
            totalExpenses: filtered.reduce((sum, e) => sum + e.amount, 0),
            byType,
            unpaidCount: filtered.filter(e => e.status === 'pending' || e.status === 'accrued').length,
        };
    },

    async initializeStores(): Promise<void> {
        try { await dbService.createObjectStore(UTILITY_EXPENSES_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(UTILITY_PAYMENTS_STORE, { keyPath: 'id' }); } catch { }
    },
};

export default utilityExpenseService;
