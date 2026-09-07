/**
 * Interest Income Service
 * 
 * Phase 3: Module for tracking interest income
 * Handles:
 * - Bank deposit interest accrual and receipt
 * - Posting interest income to 42100
 * - Interest earned tracking
 */

import { dbService } from './db';
import { InterestIncomeEntry } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const STORE_NAME = 'interestIncomeEntries';

function getConfig() {
    return getGLConfig();
}

export const interestIncomeService = {
    STORE_NAME,

    async getAll(): Promise<InterestIncomeEntry[]> {
        try {
            const all = await dbService.getAll<InterestIncomeEntry>(STORE_NAME);
            return all.sort((a, b) => b.accrual_date.localeCompare(a.accrual_date));
        } catch (error) {
            logger.error('Failed to get interest income entries', error);
            return [];
        }
    },

    async getById(id: string): Promise<InterestIncomeEntry | null> {
        try {
            return await dbService.getById<InterestIncomeEntry>(STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get interest income entry ${id}`, error);
            return null;
        }
    },

    async accrueInterest(
        bankAccountId: string,
        amount: number,
        description: string,
        accrualDate: string,
        interestType: InterestIncomeEntry['interest_type'] = 'deposit_interest',
        reference: string = '',
        accounts: any[] = []
    ): Promise<InterestIncomeEntry | null> {
        const config = getConfig();
        const accts = accounts;

        const interestIncomeAccountId = resolveAccountForPosting(config.interestIncomeAccount, accts) || config.interestIncomeAccount;
        const accruedInterestAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || config.accruedExpensesAccount;

        try {
            await ledgerService.createJournalEntry({
                date: accrualDate,
                description: `Interest Accrual: ${description}`,
                reference: reference || `INT-ACCR-${generateId('IA')}`,
                lines: [
                    {
                        debitAccountId: accruedInterestAccountId,
                        creditAccountId: interestIncomeAccountId,
                        amount,
                        description: `Interest accrued: ${description}`,
                    }
                ],
                entryType: 'INTEREST_ACCRUAL',
            });

            const entry: InterestIncomeEntry = {
                id: generateId('INT'),
                bank_account_id: bankAccountId,
                interest_type: interestType,
                description,
                amount,
                accrual_date: accrualDate,
                status: 'accrued',
                reference,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, entry);
            return entry;
        } catch (error) {
            logger.error('Failed to accrue interest', error);
            return null;
        }
    },

    async recordInterestReceived(
        bankAccountId: string,
        amount: number,
        receivedDate: string,
        description: string,
        interestType: InterestIncomeEntry['interest_type'] = 'deposit_interest',
        reference: string = '',
        accounts: any[] = []
    ): Promise<InterestIncomeEntry | null> {
        const config = getConfig();
        const accts = accounts;

        const interestIncomeAccountId = resolveAccountForPosting(config.interestIncomeAccount, accts) || config.interestIncomeAccount;
        const bankAccountIdResolved = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            await ledgerService.createJournalEntry({
                date: receivedDate,
                description: `Interest Received: ${description}`,
                reference: reference || `INT-REC-${generateId('IR')}`,
                lines: [
                    {
                        debitAccountId: bankAccountIdResolved,
                        creditAccountId: interestIncomeAccountId,
                        amount,
                        description: `Interest received: ${description}`,
                    }
                ],
                entryType: 'INTEREST_RECEIVED',
            });

            const entry: InterestIncomeEntry = {
                id: generateId('INT'),
                bank_account_id: bankAccountId,
                interest_type: interestType,
                description,
                amount,
                accrual_date: receivedDate,
                received_date: receivedDate,
                status: 'received',
                reference,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, entry);
            return entry;
        } catch (error) {
            logger.error('Failed to record interest received', error);
            return null;
        }
    },

    async getInterestSummary(year?: number): Promise<{
        totalAccrued: number;
        totalReceived: number;
        entryCount: number;
    }> {
        const entries = await this.getAll();
        const filtered = entries.filter(entry => {
            if (year) {
                const d = new Date(entry.accrual_date);
                return d.getFullYear() === year;
            }
            return true;
        });

        return {
            totalAccrued: filtered.filter(e => e.status === 'accrued').reduce((sum, e) => sum + e.amount, 0),
            totalReceived: filtered.filter(e => e.status === 'received').reduce((sum, e) => sum + e.amount, 0),
            entryCount: filtered.length,
        };
    },

    async initializeStore(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { }
    },
};

export default interestIncomeService;
