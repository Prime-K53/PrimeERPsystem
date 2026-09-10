/**
 * Ledger Service
 * 
 * Phase 1: Core module for general ledger operations
 * Provides:
 * - Journal entry creation with double-entry validation
 * - Balance calculations
 * - Account ledger retrieval
 */

import { dbService } from './db';
import { LedgerEntry } from '../types';
import { loadAccountsFromStore, resolveAccountForPosting, getCompanyConfig, generateId } from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';
import { logger } from './logger';

interface JournalLine {
    debitAccountId: string;
    creditAccountId: string;
    amount: number;
    description?: string;
}

interface CreateJournalEntryParams {
    date: string;
    description: string;
    reference?: string;
    lines: JournalLine[];
    entryType?: string;
    createdBy?: string;
}

export const ledgerService = {
    STORE_NAME: 'ledger',

    async createJournalEntry(params: CreateJournalEntryParams): Promise<{ id: string; entries: LedgerEntry[] } | null> {
        const { date, description, reference, lines, entryType, createdBy } = params;

        if (!lines || lines.length === 0) {
            logger.warn('No journal lines provided');
            return null;
        }

        const totalDebit = lines.reduce((sum, l) => sum + (l.amount || 0), 0);
        const totalCredit = lines.reduce((sum, l) => sum + (l.amount || 0), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new Error(`Journal entry is not balanced: Debits ${totalDebit} != Credits ${totalCredit}`);
        }

        try {
            const entries: LedgerEntry[] = [];

            for (const line of lines) {
                const entry: LedgerEntry = {
                    id: generateId('LG'),
                    date,
                    description: line.description || description,
                    debitAccountId: line.debitAccountId,
                    creditAccountId: line.creditAccountId,
                    amount: line.amount,
                    entryType,
                    referenceId: reference,
                    reconciled: false,
                    customerId: undefined,
                    customerName: undefined,
                    created_at: new Date().toISOString(),
                    created_by: createdBy,
                };
                entries.push(entry);
            }

            await dbService.executeAtomicOperation(
                [this.STORE_NAME, 'accounts'],
                async (tx) => {
                    const store = tx.objectStore(this.STORE_NAME);
                    const accountsStore = tx.objectStore('accounts');
                    const accounts = await loadAccountsFromStore(tx);
                    const companyConfig = getCompanyConfig();
                    const companyId = companyConfig?.companyId;

                    for (const entry of entries) {
                        const resolvedDebit = resolveAccountForPosting(entry.debitAccountId!, accounts, { companyId });
                        const resolvedCredit = resolveAccountForPosting(entry.creditAccountId!, accounts, { companyId });

                        if (!resolvedDebit || !resolvedCredit) {
                            throw new Error(`Could not resolve accounts: ${entry.debitAccountId} / ${entry.creditAccountId}`);
                        }

                        entry.debitAccountId = resolvedDebit;
                        entry.creditAccountId = resolvedCredit;

                        await store.put(entry);
                    }
                }
            );

            return {
                id: entries[0]?.id || generateId('JE'),
                entries,
            };
        } catch (error) {
            logger.error('Failed to create journal entry', error);
            throw error;
        }
    },

    async getEntriesByAccount(accountId: string, startDate?: string, endDate?: string): Promise<LedgerEntry[]> {
        try {
            const all = await dbService.getAll<LedgerEntry>(this.STORE_NAME);
            return all.filter(entry => {
                const matchesAccount = entry.debitAccountId === accountId || entry.creditAccountId === accountId;
                
                if (startDate && entry.date < startDate) return false;
                if (endDate && entry.date > endDate) return false;
                
                return matchesAccount;
            }).sort((a, b) => a.date.localeCompare(b.date));
        } catch (error) {
            logger.error('Failed to get ledger entries', error);
            return [];
        }
    },

    async calculateBalance(accountId: string, startDate?: string, endDate?: string): Promise<number> {
        const entries = await this.getEntriesByAccount(accountId, startDate, endDate);
        
        let debitTotal = 0;
        let creditTotal = 0;

        for (const entry of entries) {
            // Exclude explicitly marked draft/void/reversal rows so the
            // balance always reflects posted accounting truth.
            if (!isPostedLedgerEntry(entry)) continue;
            if (entry.debitAccountId === accountId) {
                debitTotal += entry.amount;
            }
            if (entry.creditAccountId === accountId) {
                creditTotal += entry.amount;
            }
        }

        return debitTotal - creditTotal;
    },

    async getAllEntries(startDate?: string, endDate?: string): Promise<LedgerEntry[]> {
        try {
            const all = await dbService.getAll<LedgerEntry>(this.STORE_NAME);
            return all.filter(entry => {
                if (startDate && entry.date < startDate) return false;
                if (endDate && entry.date > endDate) return false;
                return true;
            }).sort((a, b) => b.date.localeCompare(a.date));
        } catch (error) {
            logger.error('Failed to get all ledger entries', error);
            return [];
        }
    },

    async getEntryById(id: string): Promise<LedgerEntry | null> {
        try {
            return await dbService.getById<LedgerEntry>(this.STORE_NAME, id);
        } catch (error) {
            logger.error(`Failed to get ledger entry ${id}`, error);
            return null;
        }
    },

    async reverseEntry(entryId: string, reversalDate: string, reason: string): Promise<LedgerEntry[] | null> {
        const original = await this.getEntryById(entryId);
        if (!original) return null;

        const reversalEntries: LedgerEntry[] = [];

        try {
            await dbService.executeAtomicOperation(
                [this.STORE_NAME],
                async (tx) => {
                    const store = tx.objectStore(this.STORE_NAME);

                    // A reversal is a SINGLE offsetting entry with swapped
                    // sides: it nets the original to zero exactly once.
                    // (Writing two swapped copies would reverse 2x.)
                    const reversal: LedgerEntry = {
                        ...original,
                        id: generateId('LG'),
                        date: reversalDate,
                        description: `REVERSAL: ${original.description || ''} - ${reason}`,
                        debitAccountId: original.creditAccountId,
                        creditAccountId: original.debitAccountId,
                        referenceId: `REV-${original.id}`,
                    };

                    await store.put(reversal);

                    reversalEntries.push(reversal);
                }
            );

            return reversalEntries;
        } catch (error) {
            logger.error('Failed to reverse journal entry', error);
            return null;
        }
    },
};

export default ledgerService;
