/**
 * VAT Service
 *
 * Phase 4: Module for handling VAT transactions with proper GL posting
 * Handles:
 * - Input VAT (purchases) posting to 21210
 * - Output VAT (sales) posting to 21210
 * - VAT payment/reversal when returns are filed
 */

import { dbService } from './db';
import { VatTransaction, VatReturn, VATConfig } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const VAT_TRANSACTIONS_STORE = 'vatTransactions';
const VAT_RETURNS_STORE = 'vatReturns';

function getConfig() {
    return getGLConfig();
}

export const vatService = {
    VAT_TRANSACTIONS_STORE,
    VAT_RETURNS_STORE,

    async getAllTransactions(): Promise<VatTransaction[]> {
        try {
            const all = await dbService.getAll<VatTransaction>(VAT_TRANSACTIONS_STORE);
            return all.sort((a, b) => b.date.localeCompare(a.date));
        } catch (error) {
            logger.error('Failed to get VAT transactions', error);
            return [];
        }
    },

    async getTransaction(id: string): Promise<VatTransaction | null> {
        try {
            return await dbService.getById<VatTransaction>(VAT_TRANSACTIONS_STORE, id);
        } catch (error) {
            logger.error(`Failed to get VAT transaction ${id}`, error);
            return null;
        }
    },

    async recordInputVat(
        amount: number,
        rate: number,
        date: string,
        description: string,
        purchaseReference: string = '',
        expenseAccountId: string,
        bankAccountId: string,
        accounts: any[] = [],
        companyId?: string
    ): Promise<VatTransaction | null> {
        const config = getConfig();
        const accts = accounts;
        const vatPayableId = resolveAccountForPosting(config.vatPayableAccount, accts) || config.vatPayableAccount || '21210';
        const expenseAcctId = resolveAccountForPosting(expenseAccountId, accts) || expenseAccountId;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `VAT Input: ${description}`,
                reference: `VAT-IN-${generateId('VI')}`,
                lines: [
                    {
                        debitAccountId: expenseAcctId,
                        creditAccountId: vatPayableId,
                        amount,
                        description: `VAT on purchase: ${description}`,
                    }
                ],
                entryType: 'VAT_INPUT',
                metadata: { vatRate: rate, vatType: 'input' },
            });

            const transaction: VatTransaction = {
                id: generateId('VAT_IN'),
                date,
                type: 'Input',
                amount,
                rate,
                vatAmount: amount,
                reference: purchaseReference,
                description,
                isFiled: false,
                companyId,
                glEntryId: journalEntry?.id,
                created_at: new Date().toISOString(),
            };

            await dbService.put(VAT_TRANSACTIONS_STORE, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to record input VAT', error);
            return null;
        }
    },

    async recordOutputVat(
        amount: number,
        rate: number,
        date: string,
        description: string,
        salesReference: string = '',
        salesAccountId: string,
        accounts: any[] = [],
        companyId?: string
    ): Promise<VatTransaction | null> {
        const config = getConfig();
        const accts = accounts;
        const vatReceivableId = resolveAccountForPosting(config.vatReceivableAccount, accts) || '21310';
        const salesAcctId = resolveAccountForPosting(salesAccountId, accts) || salesAccountId;

        try {
            const journalEntry = await ledgerService.createJournalEntry({
                date,
                description: `VAT Output: ${description}`,
                reference: `VAT-OUT-${generateId('VO')}`,
                lines: [
                    {
                        debitAccountId: vatReceivableId,
                        creditAccountId: salesAcctId,
                        amount,
                        description: `VAT on sale: ${description}`,
                    }
                ],
                entryType: 'VAT_OUTPUT',
                metadata: { vatRate: rate, vatType: 'output' },
            });

            const transaction: VatTransaction = {
                id: generateId('VAT_OUT'),
                date,
                type: 'Output',
                amount,
                rate,
                vatAmount: amount,
                reference: salesReference,
                description,
                isFiled: false,
                companyId,
                glEntryId: journalEntry?.id,
                created_at: new Date().toISOString(),
            };

            await dbService.put(VAT_TRANSACTIONS_STORE, transaction);
            return transaction;
        } catch (error) {
            logger.error('Failed to record output VAT', error);
            return null;
        }
    },

    async fileVatReturn(
        returnId: string,
        paymentDate: string,
        bankAccountId: string,
        accounts: any[] = []
    ): Promise<VatReturn | null> {
        const config = getConfig();
        const accts = accounts;
        const vatPayableId = resolveAccountForPosting(config.vatPayableAccount, accts) || '21210';
        const bankId = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            const returns = await dbService.getAll<VatReturn>(VAT_RETURNS_STORE);
            const vatReturn = returns.find(r => r.id === returnId);
            if (!vatReturn) return null;

            const netPayable = vatReturn.netPayable > 0 ? vatReturn.netPayable : Math.abs(vatReturn.netPayable);

            if (vatReturn.netPayable > 0) {
                await ledgerService.createJournalEntry({
                    date: paymentDate,
                    description: `VAT Payment for period ${vatReturn.period}`,
                    reference: `VAT-PAY-${generateId('VP')}`,
                    lines: [
                        {
                            debitAccountId: vatPayableId,
                            creditAccountId: bankId,
                            amount: netPayable,
                            description: `VAT payment for ${vatReturn.period}`,
                        }
                    ],
                    entryType: 'VAT_PAYMENT',
                });
            } else if (vatReturn.netPayable < 0) {
                await ledgerService.createJournalEntry({
                    date: paymentDate,
                    description: `VAT Refund claimed for period ${vatReturn.period}`,
                    reference: `VAT-REF-${generateId('VR')}`,
                    lines: [
                        {
                            debitAccountId: bankId,
                            creditAccountId: vatPayableId,
                            amount: Math.abs(vatReturn.netPayable),
                            description: `VAT refund for ${vatReturn.period}`,
                        }
                    ],
                    entryType: 'VAT_REFUND',
                });
            }

            const updatedReturn: VatReturn = {
                ...vatReturn,
                status: 'Paid',
                filingDate: new Date().toISOString(),
                paymentDate,
            };

            await dbService.put(VAT_RETURNS_STORE, updatedReturn);

            const transactions = await this.getAllTransactions();
            const filedTxIds = vatReturn.transactions || [];
            for (const txId of filedTxIds) {
                const tx = transactions.find(t => t.id === txId);
                if (tx) {
                    await dbService.put(VAT_TRANSACTIONS_STORE, { ...tx, isFiled: true, returnId });
                }
            }

            return updatedReturn;
        } catch (error) {
            logger.error('Failed to file VAT return', error);
            return null;
        }
    },

    async getVatSummary(year?: number): Promise<{
        totalInput: number;
        totalOutput: number;
        netPayable: number;
        transactionCount: number;
    }> {
        const transactions = await this.getAllTransactions();
        const filtered = transactions.filter(tx => {
            if (year) {
                const d = new Date(tx.date);
                return d.getFullYear() === year;
            }
            return true;
        });

        const totalInput = filtered.filter(t => t.type === 'Input').reduce((sum, t) => sum + (t.vatAmount || t.amount), 0);
        const totalOutput = filtered.filter(t => t.type === 'Output').reduce((sum, t) => sum + (t.vatAmount || t.amount), 0);

        return {
            totalInput,
            totalOutput,
            netPayable: totalOutput - totalInput,
            transactionCount: filtered.length,
        };
    },

    async initializeStores(): Promise<void> {
        try { await dbService.createObjectStore(VAT_TRANSACTIONS_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(VAT_RETURNS_STORE, { keyPath: 'id' }); } catch { }
    },
};

export default vatService;
