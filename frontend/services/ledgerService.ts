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

// Optional split-line form for true multi-leg journals.
// When `splits` is provided, balance is enforced as SUM(debit) === SUM(credit).
export interface JournalSplit {
    accountId: string;
    debit?: number;
    credit?: number;
    description?: string;
}

interface CreateJournalEntryParams {
    date: string;
    description: string;
    reference?: string;
    lines: JournalLine[];
    splits?: JournalSplit[];
    entryType?: string;
    createdBy?: string;
}

export const ledgerService = {
    STORE_NAME: 'ledger',

    async createJournalEntry(params: CreateJournalEntryParams): Promise<{ id: string; entries: LedgerEntry[] } | null> {
        const { date, description, reference, lines, splits, entryType, createdBy } = params;

        if ((!lines || lines.length === 0) && (!splits || splits.length === 0)) {
            logger.warn('No journal lines provided');
            return null;
        }

        // Split-line journals: enforce SUM(debit) === SUM(credit).
        if (splits && splits.length > 0) {
            let splitDebit = 0;
            let splitCredit = 0;
            for (const s of splits) {
                const d = Number(s.debit || 0);
                const c = Number(s.credit || 0);
                if (!s.accountId) throw new Error('Journal split is missing accountId');
                if (!Number.isFinite(d) || !Number.isFinite(c)) throw new Error('Journal split amount is not a number');
                if (d < 0 || c < 0) throw new Error('Journal split amounts must be >= 0');
                if (d > 0 && c > 0) throw new Error('Journal split cannot be both debit and credit');
                if (d === 0 && c === 0) throw new Error('Journal split amount must be > 0 on one side');
                splitDebit += d;
                splitCredit += c;
            }
            if (Math.abs(splitDebit - splitCredit) > 0.01) {
                throw new Error(`Journal entry is not balanced: Debits ${splitDebit} != Credits ${splitCredit}`);
            }
        }

        // Pair-line journals: each line is one Dr/Cr pair of the same amount,
        // so balance is structural — validate what can actually be wrong.
        const safeLines = lines || [];
        let totalDebit = 0;
        let totalCredit = 0;
        for (const l of safeLines) {
            const amount = Number(l.amount || 0);
            if (!l.debitAccountId || !l.creditAccountId) {
                throw new Error('Journal line is missing debit/credit account');
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new Error(`Journal line amount must be > 0 (got ${String((l as JournalLine).amount)})`);
            }
            if (l.debitAccountId === l.creditAccountId) {
                throw new Error(`Journal line posts to itself: ${l.debitAccountId}`);
            }
            totalDebit += amount;
            totalCredit += amount;
        }

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new Error(`Journal entry is not balanced: Debits ${totalDebit} != Credits ${totalCredit}`);
        }

        try {
            const entries: LedgerEntry[] = [];
            const journalId = generateId('JE');

            for (const line of safeLines) {
                const entry: LedgerEntry = {
                    id: generateId('LG'),
                    date,
                    description: line.description || description,
                    debitAccountId: line.debitAccountId,
                    creditAccountId: line.creditAccountId,
                    amount: Number(line.amount),
                    entryType,
                    referenceId: reference || journalId,
                    reconciled: false,
                    customerId: undefined,
                    customerName: undefined,
                    created_at: new Date().toISOString(),
                    created_by: createdBy,
                };
                entries.push(entry);
            }

            // Expand split-line journals into balanced Dr/Cr pairs so they fit
            // the existing pair-based ledger store without losing balance.
            if (splits && splits.length > 0) {
                const debits = splits
                    .filter((s) => Number(s.debit || 0) > 0)
                    .map((s) => ({ accountId: s.accountId, amount: Number(s.debit || 0), description: s.description }));
                const credits = splits
                    .filter((s) => Number(s.credit || 0) > 0)
                    .map((s) => ({ accountId: s.accountId, amount: Number(s.credit || 0), description: s.description }));
                let di = 0;
                let ci = 0;
                let dRem = debits.length > 0 ? debits[0].amount : 0;
                let cRem = credits.length > 0 ? credits[0].amount : 0;
                while (di < debits.length && ci < credits.length) {
                    const take = Math.min(dRem, cRem);
                    entries.push({
                        id: generateId('LG'),
                        date,
                        description: debits[di].description || credits[ci].description || description,
                        debitAccountId: debits[di].accountId,
                        creditAccountId: credits[ci].accountId,
                        amount: Number(take.toFixed(2)),
                        entryType,
                        referenceId: reference || journalId,
                        reconciled: false,
                        customerId: undefined,
                        customerName: undefined,
                        created_at: new Date().toISOString(),
                        created_by: createdBy,
                    });
                    dRem = Number((dRem - take).toFixed(2));
                    cRem = Number((cRem - take).toFixed(2));
                    if (dRem <= 0.005) { di += 1; dRem = di < debits.length ? debits[di].amount : 0; }
                    if (cRem <= 0.005) { ci += 1; cRem = ci < credits.length ? credits[ci].amount : 0; }
                }
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
