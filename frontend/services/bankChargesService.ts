/**
 * Bank Charges Service
 * 
 * Phase 1: Module for tracking and posting bank charges to correct GL account
 * Previously bank charges were being posted to wrong account (54000 instead of 52900)
 */

import { dbService } from './db';
import { BankChargeEntry } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const STORE_NAME = 'bankChargeEntries';

function getConfig() {
    return getGLConfig();
}

export const bankChargesService = {
    STORE_NAME,

    async getAll(): Promise<BankChargeEntry[]> {
        try {
            const all = await dbService.getAll<BankChargeEntry>(STORE_NAME);
            return all.sort((a, b) => b.date.localeCompare(a.date));
        } catch (error) {
            logger.error('Failed to get bank charges', error);
            return [];
        }
    },

    async getById(id: string): Promise<BankChargeEntry | null> {
        try {
            return await dbService.getById<BankChargeEntry>(STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get bank charge ${id}`, error);
            return null;
        }
    },

    async createBankCharge(
        bankAccountId: string,
        amount: number,
        description: string,
        date: string,
        accounts?: any[]
    ): Promise<BankChargeEntry | null> {
        const config = getConfig();
        const accts = accounts || [];

        const bankChargesAccountId = resolveAccountForPosting(config.bankChargesAccount, accts) || config.bankChargesAccount;
        const sourceBankAccountId = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            await ledgerService.createJournalEntry({
                date,
                description: `Bank Charge: ${description}`,
                reference: `BANK-CHG-${generateId('BCHG')}`,
                lines: [
                    {
                        debitAccountId: bankChargesAccountId,
                        creditAccountId: sourceBankAccountId,
                        amount,
                        description: `Bank charges - ${description}`,
                    }
                ],
                entryType: 'BANK_CHARGES',
            });

            const charge: BankChargeEntry = {
                id: generateId('BCHG'),
                bank_account_id: sourceBankAccountId,
                date,
                description,
                amount,
                created_at: new Date().toISOString(),
            };

            await dbService.put(STORE_NAME, charge);
            return charge;
        } catch (error) {
            logger.error('Failed to create bank charge', error);
            return null;
        }
    },

    async getTotalBankCharges(startDate?: string, endDate?: string, accounts?: any[]): Promise<number> {
        const charges = await this.getAll();
        return charges
            .filter(c => {
                if (startDate && c.date < startDate) return false;
                if (endDate && c.date > endDate) return false;
                return true;
            })
            .reduce((sum, c) => sum + c.amount, 0);
    },

    async initializeStore(): Promise<void> {
        try {
            await dbService.createObjectStore(STORE_NAME, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default bankChargesService;
