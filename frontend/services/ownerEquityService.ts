/**
 * Owner Equity Service
 * 
 * Phase 1: Module for tracking owner capital contributions and drawings
 * Handles:
 * - Capital contributions (money put into the business by owner)
 * - Capital withdrawals/drawings (money taken out by owner)
 * - Profit distributions
 * - Loss allocations
 */

import { dbService } from './db';
import { OwnerEquityTransaction } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const STORE_NAME = 'ownerEquityTransactions';

function getConfig() {
    return getGLConfig();
}

export const ownerEquityService = {
    STORE_NAME,

    async getAll(): Promise<OwnerEquityTransaction[]> {
        try {
            const all = await dbService.getAll<OwnerEquityTransaction>(STORE_NAME);
            return all.sort((a, b) => b.date.localeCompare(a.date));
        } catch (error) {
            logger.error('Failed to get owner equity transactions', error);
            return [];
        }
    },

    async getById(id: string): Promise<OwnerEquityTransaction | null> {
        try {
            return await dbService.getById<OwnerEquityTransaction>(STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get owner equity transaction ${id}`, error);
            return null;
        }
    },

    async createCapitalContribution(
        amount: number,
        description: string,
        date: string,
        reference?: string,
        accounts?: any[],
        bankAccountId?: string,
        ownerName?: string
    ): Promise<OwnerEquityTransaction | null> {
        const config = getConfig();
        const accts = accounts || [];

        const capitalAccountId = resolveAccountForPosting(config.ownerCapitalAccount, accts) || config.ownerCapitalAccount;
        const resolvedBankAccountId = bankAccountId
            ? resolveAccountForPosting(bankAccountId, accts) || bankAccountId
            : resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `Capital Contribution: ${description}`,
                reference: reference || `CAP-${generateId('CAP')}`,
                lines: [
                    {
                        debitAccountId: resolvedBankAccountId,
                        creditAccountId: capitalAccountId,
                        amount,
                        description: `Capital contribution - ${description}`,
                    }
                ],
                entryType: 'OWNER_CAPITAL_CONTRIBUTION',
            });

            const transaction: OwnerEquityTransaction = {
                id: generateId('OE'),
                transaction_type: 'capital_contribution',
                amount,
                description,
                reference,
                journal_entry_id: (journalEntry as any)?.id,
                owner_name: ownerName,
                owner_account_id: resolvedBankAccountId,
                capital_account_id: capitalAccountId,
                drawings_account_id: '',
                date,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to create capital contribution', error);
            return null;
        }
    },

    async createCapitalWithdrawal(
        amount: number,
        description: string,
        date: string,
        reference?: string,
        accounts?: any[],
        bankAccountId?: string,
        ownerName?: string
    ): Promise<OwnerEquityTransaction | null> {
        const config = getConfig();
        const accts = accounts || [];

        const drawingsAccountId = resolveAccountForPosting(config.ownerDrawingsAccount, accts) || config.ownerDrawingsAccount;
        const resolvedBankAccountId = bankAccountId
            ? resolveAccountForPosting(bankAccountId, accts) || bankAccountId
            : resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `Capital Withdrawal: ${description}`,
                reference: reference || `WD-${generateId('WD')}`,
                lines: [
                    {
                        debitAccountId: drawingsAccountId,
                        creditAccountId: resolvedBankAccountId,
                        amount,
                        description: `Owner withdrawal - ${description}`,
                    }
                ],
                entryType: 'OWNER_DRAWINGS',
            });

            const transaction: OwnerEquityTransaction = {
                id: generateId('OE'),
                transaction_type: 'capital_withdrawal',
                amount,
                description,
                reference,
                journal_entry_id: (journalEntry as any)?.id,
                owner_name: ownerName,
                owner_account_id: resolvedBankAccountId,
                capital_account_id: '',
                drawings_account_id: drawingsAccountId,
                date,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to create capital withdrawal', error);
            return null;
        }
    },

    async createProfitDistribution(
        amount: number,
        description: string,
        date: string,
        reference?: string,
        accounts?: any[],
        bankAccountId?: string,
        ownerName?: string
    ): Promise<OwnerEquityTransaction | null> {
        const config = getConfig();
        const accts = accounts || [];

        const drawingsAccountId = resolveAccountForPosting(config.ownerDrawingsAccount, accts) || config.ownerDrawingsAccount;
        const retainedEarningsId = resolveAccountForPosting(config.retainedEarningsAccount, accts) || config.retainedEarningsAccount;
        const resolvedBankAccountId = bankAccountId
            ? resolveAccountForPosting(bankAccountId, accts) || bankAccountId
            : resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `Profit Distribution: ${description}`,
                reference: reference || `PD-${generateId('PD')}`,
                lines: [
                    {
                        debitAccountId: retainedEarningsId,
                        creditAccountId: resolvedBankAccountId,
                        amount,
                        description: `Profit distribution to owner - ${description}`,
                    }
                ],
                entryType: 'PROFIT_DISTRIBUTION',
            });

            const transaction: OwnerEquityTransaction = {
                id: generateId('OE'),
                transaction_type: 'profit_distribution',
                amount,
                description,
                reference,
                journal_entry_id: (journalEntry as any)?.id,
                owner_name: ownerName,
                owner_account_id: resolvedBankAccountId,
                capital_account_id: '',
                drawings_account_id: drawingsAccountId,
                date,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to create profit distribution', error);
            return null;
        }
    },

    async createLossAllocation(
        amount: number,
        description: string,
        date: string,
        reference?: string,
        accounts?: any[],
        bankAccountId?: string,
        ownerName?: string
    ): Promise<OwnerEquityTransaction | null> {
        const config = getConfig();
        const accts = accounts || [];

        const capitalAccountId = resolveAccountForPosting(config.ownerCapitalAccount, accts) || config.ownerCapitalAccount;
        const resolvedBankAccountId = bankAccountId
            ? resolveAccountForPosting(bankAccountId, accts) || bankAccountId
            : resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `Loss Allocation: ${description}`,
                reference: reference || `LA-${generateId('LA')}`,
                lines: [
                    {
                        debitAccountId: resolvedBankAccountId,
                        creditAccountId: capitalAccountId,
                        amount,
                        description: `Loss allocation to owner capital - ${description}`,
                    }
                ],
                entryType: 'LOSS_ALLOCATION',
            });

            const transaction: OwnerEquityTransaction = {
                id: generateId('OE'),
                transaction_type: 'loss_allocation',
                amount,
                description,
                reference,
                journal_entry_id: (journalEntry as any)?.id,
                owner_name: ownerName,
                owner_account_id: resolvedBankAccountId,
                capital_account_id: capitalAccountId,
                drawings_account_id: '',
                date,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to create loss allocation', error);
            return null;
        }
    },

    async getCapitalBalance(accounts?: any[]): Promise<{ capital: number; drawings: number; net: number }> {
        const config = getConfig();
        const accts = accounts || [];

        const capitalAccountId = resolveAccountForPosting(config.ownerCapitalAccount, accts);
        const drawingsAccountId = resolveAccountForPosting(config.ownerDrawingsAccount, accts);

        let capitalBalance = 0;
        let drawingsBalance = 0;

        if (capitalAccountId) {
            const raw = await ledgerService.calculateBalance(capitalAccountId);
            capitalBalance = -raw;
        }

        if (drawingsAccountId) {
            const raw = await ledgerService.calculateBalance(drawingsAccountId);
            drawingsBalance = raw;
        }

        return {
            capital: capitalBalance,
            drawings: drawingsBalance,
            net: capitalBalance - drawingsBalance,
        };
    },

    async initializeStore(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default ownerEquityService;
