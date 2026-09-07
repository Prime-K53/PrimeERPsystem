/**
 * Prepayments Service
 * 
 * Phase 3: Module for managing prepayments and deferred expenses
 * Handles:
 * - Prepayments (rent, insurance, subscriptions) - posts to 11510
 * - Staff advances - posts to 11520
 * - Amortization of prepayments to expense accounts
 */

import { dbService } from './db';
import { Prepayment, PrepaymentAmortization, StaffAdvance } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const PREPAYMENT_STORE = 'prepayments';
const PREPAYMENT_AMORT_STORE = 'prepaymentAmortizations';
const STAFF_ADVANCE_STORE = 'staffAdvances';

function getConfig() {
    return getGLConfig();
}

export const prepaymentsService = {
    PREPAYMENT_STORE,
    PREPAYMENT_AMORT_STORE,
    STAFF_ADVANCE_STORE,

    async getAllPrepayments(): Promise<Prepayment[]> {
        try {
            const all = await dbService.getAll<Prepayment>(PREPAYMENT_STORE);
            return all.sort((a, b) => b.payment_date.localeCompare(a.payment_date));
        } catch (error) {
            logger.error('Failed to get prepayments', error);
            return [];
        }
    },

    async getPrepayment(id: string): Promise<Prepayment | null> {
        try {
            return await dbService.getById<Prepayment>(PREPAYMENT_STORE, id);
        } catch (error) {
            logger.error(`Failed to get prepayment ${id}`, error);
            return null;
        }
    },

    async createPrepayment(
        prepaymentType: Prepayment['prepayment_type'],
        description: string,
        payee: string,
        amount: number,
        paymentDate: string,
        startDate: string,
        endDate: string | undefined,
        amortizationPeriods: number,
        accountId: string,
        bankAccountId: string,
        notes: string = '',
        accounts: any[] = []
    ): Promise<Prepayment | null> {
        const config = getConfig();
        const accts = accounts;

        const prepaymentAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || '11510';
        const bankAccountIdResolved = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            await ledgerService.createJournalEntry({
                date: paymentDate,
                description: `Prepayment: ${description}`,
                reference: `PRE-${generateId('PRE')}`,
                lines: [
                    {
                        debitAccountId: prepaymentAccountId,
                        creditAccountId: bankAccountIdResolved,
                        amount,
                        description: `Prepayment to ${payee}: ${description}`,
                    }
                ],
                entryType: 'PREPAYMENT',
            });

            const prepayment: Prepayment = {
                id: generateId('PRE'),
                prepayment_type: prepaymentType,
                description,
                payee,
                amount,
                payment_date: paymentDate,
                start_date: startDate,
                end_date: endDate,
                amortization_periods: amortizationPeriods,
                periods_remaining: amortizationPeriods,
                account_id: accountId,
                bank_account_id: bankAccountId,
                status: 'active',
                notes,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            await dbService.put(PREPAYMENT_STORE, prepayment);
            return prepayment;
        } catch (error) {
            logger.error('Failed to create prepayment', error);
            return null;
        }
    },

    async amortizePrepayment(
        prepaymentId: string,
        amount: number,
        amortizationDate: string,
        accounts: any[] = []
    ): Promise<PrepaymentAmortization | null> {
        const prepayment = await this.getPrepayment(prepaymentId);
        if (!prepayment) return null;

        const config = getConfig();
        const accts = accounts;

        const prepaymentAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || '11510';

        try {
            await ledgerService.createJournalEntry({
                date: amortizationDate,
                description: `Prepayment Amortization: ${prepayment.description}`,
                reference: `PRE-AMORT-${generateId('PA')}`,
                lines: [
                    {
                        debitAccountId: prepayment.account_id,
                        creditAccountId: prepaymentAccountId,
                        amount,
                        description: `Amortization: ${prepayment.description}`,
                    }
                ],
                entryType: 'PREPAYMENT_AMORTIZATION',
            });

            const newPeriodsRemaining = Math.max(0, prepayment.periods_remaining - 1);
            const updatedStatus = newPeriodsRemaining === 0 ? 'expired' : 'active';

            await this.updatePrepayment(prepaymentId, {
                periods_remaining: newPeriodsRemaining,
                status: updatedStatus as Prepayment['status'],
            });

            const amortization: PrepaymentAmortization = {
                id: generateId('PAM'),
                prepayment_id: prepaymentId,
                amortization_date: amortizationDate,
                amount,
                periods_amortized: 1,
                created_at: new Date().toISOString(),
            };

            await dbService.put(PREPAYMENT_AMORT_STORE, amortization);
            return amortization;
        } catch (error) {
            logger.error('Failed to amortize prepayment', error);
            return null;
        }
    },

    async updatePrepayment(id: string, updates: Partial<Prepayment>): Promise<Prepayment | null> {
        const existing = await this.getPrepayment(id);
        if (!existing) return null;

        const updated: Prepayment = {
            ...existing,
            ...updates,
            id: existing.id,
            updated_at: new Date().toISOString(),
        };

        await dbService.put(PREPAYMENT_STORE, updated);
        return updated;
    },

    async getPrepaymentAmortizations(prepaymentId: string): Promise<PrepaymentAmortization[]> {
        try {
            const all = await dbService.getAll<PrepaymentAmortization>(PREPAYMENT_AMORT_STORE);
            return all.filter(a => a.prepayment_id === prepaymentId);
        } catch {
            return [];
        }
    },

    async getAllStaffAdvances(): Promise<StaffAdvance[]> {
        try {
            const all = await dbService.getAll<StaffAdvance>(STAFF_ADVANCE_STORE);
            return all.sort((a, b) => b.issue_date.localeCompare(a.issue_date));
        } catch (error) {
            logger.error('Failed to get staff advances', error);
            return [];
        }
    },

    async getStaffAdvance(id: string): Promise<StaffAdvance | null> {
        try {
            return await dbService.getById<StaffAdvance>(STAFF_ADVANCE_STORE, id);
        } catch (error) {
            logger.error(`Failed to get staff advance ${id}`, error);
            return null;
        }
    },

    async createStaffAdvance(
        employeeName: string,
        amount: number,
        purpose: string,
        issueDate: string,
        expectedRepaymentDate: string | undefined,
        bankAccountId: string,
        accounts: any[] = []
    ): Promise<StaffAdvance | null> {
        const config = getConfig();
        const accts = accounts;

        const staffAdvancesAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || '11520';
        const bankAccountIdResolved = resolveAccountForPosting(bankAccountId, accts) || bankAccountId;

        try {
            await ledgerService.createJournalEntry({
                date: issueDate,
                description: `Staff Advance: ${purpose}`,
                reference: `SA-${generateId('SA')}`,
                lines: [
                    {
                        debitAccountId: staffAdvancesAccountId,
                        creditAccountId: bankAccountIdResolved,
                        amount,
                        description: `Advance to ${employeeName}: ${purpose}`,
                    }
                ],
                entryType: 'STAFF_ADVANCE',
            });

            const advance: StaffAdvance = {
                id: generateId('SA'),
                employee_name: employeeName,
                advance_number: `ADV-${generateId('ADV')}`,
                amount,
                purpose,
                issue_date: issueDate,
                expected_repayment_date: expectedRepaymentDate,
                repayment_amount: 0,
                status: 'pending',
                deductions: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            await dbService.put(STAFF_ADVANCE_STORE, advance);
            return advance;
        } catch (error) {
            logger.error('Failed to create staff advance', error);
            return null;
        }
    },

    async recordRepayment(
        advanceId: string,
        amount: number,
        repaymentDate: string,
        accounts: any[] = []
    ): Promise<StaffAdvance | null> {
        const advance = await this.getStaffAdvance(advanceId);
        if (!advance) return null;

        const config = getConfig();
        const accts = accounts;

        const staffAdvancesAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || '11520';
        const bankAccountIdResolved = resolveAccountForPosting(advance.bank_account_id, accts) || advance.bank_account_id;

        try {
            await ledgerService.createJournalEntry({
                date: repaymentDate,
                description: `Staff Advance Repayment: ${advance.purpose}`,
                reference: `SA-REP-${generateId('SAR')}`,
                lines: [
                    {
                        debitAccountId: bankAccountIdResolved,
                        creditAccountId: staffAdvancesAccountId,
                        amount,
                        description: `Repayment from ${advance.employee_name}`,
                    }
                ],
                entryType: 'STAFF_ADVANCE_REPAYMENT',
            });

            const newRepaymentAmount = advance.repayment_amount + amount;
            const newStatus = newRepaymentAmount >= advance.amount ? 'repaid' :
                             newRepaymentAmount > 0 ? 'partial' : 'pending';

            const updated: StaffAdvance = {
                ...advance,
                repayment_amount: newRepaymentAmount,
                actual_repayment_date: newStatus === 'repaid' ? repaymentDate : undefined,
                status: newStatus as StaffAdvance['status'],
                updated_at: new Date().toISOString(),
            };

            await dbService.put(STAFF_ADVANCE_STORE, updated);
            return updated;
        } catch (error) {
            logger.error('Failed to record advance repayment', error);
            return null;
        }
    },

    async getPrepaymentsSummary(): Promise<{
        totalPrepayments: number;
        totalStaffAdvances: number;
        activePrepayments: number;
        activeAdvances: number;
    }> {
        const prepayments = await this.getAllPrepayments();
        const advances = await this.getAllStaffAdvances();

        return {
            totalPrepayments: prepayments.reduce((sum, p) => sum + p.amount, 0),
            totalStaffAdvances: advances.reduce((sum, a) => sum + a.amount, 0),
            activePrepayments: prepayments.filter(p => p.status === 'active').length,
            activeAdvances: advances.filter(a => a.status !== 'repaid').length,
        };
    },

    async initializeStores(): Promise<void> {
        try { await dbService.createObjectStore(PREPAYMENT_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(PREPAYMENT_AMORT_STORE, { keyPath: 'id' }); } catch { }
        try { await dbService.createObjectStore(STAFF_ADVANCE_STORE, { keyPath: 'id' }); } catch { }
    },
};

export default prepaymentsService;
