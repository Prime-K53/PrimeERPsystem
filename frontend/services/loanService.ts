/**
 * Loan Service
 * 
 * Phase 2: Module for managing loans and borrowings
 * Handles:
 * - Bank loans (22100)
 * - Other loans (22200)
 * - Interest calculations
 * - Principal and interest repayment postings
 * - Interest expense posting to 54100
 * - Interest income posting to 42100
 */

import { dbService } from './db';
import { Loan, LoanRepayment } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const LOAN_STORE = 'loans';
const REPAYMENT_STORE = 'loanRepayments';

function getConfig() {
    return getGLConfig();
}

export const loanService = {
    LOAN_STORE,
    REPAYMENT_STORE,

    async getAllLoans(): Promise<Loan[]> {
        try {
            const all = await dbService.getAll<Loan>(LOAN_STORE);
            return all.sort((a, b) => b.start_date.localeCompare(a.start_date));
        } catch (error) {
            logger.error('Failed to get loans', error);
            return [];
        }
    },

    async getLoan(id: string): Promise<Loan | null> {
        try {
            return await dbService.getById<Loan>(LOAN_STORE, id);
        } catch (error) {
            logger.error(`Failed to get loan ${id}`, error);
            return null;
        }
    },

    async createLoan(loan: Omit<Loan, 'id' | 'created_at' | 'updated_at' | 'current_balance'>): Promise<Loan> {
        const newLoan: Loan = {
            ...loan,
            id: generateId('LOAN'),
            current_balance: loan.principal_amount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        await dbService.put(LOAN_STORE, newLoan);

        const config = getConfig();
        const loanAccountId = loan.loan_type === 'bank_loan'
            ? resolveAccountForPosting(config.bankLoansAccount, []) || config.bankLoansAccount
            : resolveAccountForPosting(config.otherLoansAccount, []) || config.otherLoansAccount;
        const bankAccountId = resolveAccountForPosting(config.bankAccount, []) || config.bankAccount;

        await ledgerService.createJournalEntry({
            date: loan.start_date,
            description: `Loan received: ${loan.lender_name}`,
            reference: `LOAN-DRW-${newLoan.id}`,
            lines: [
                {
                    debitAccountId: bankAccountId,
                    creditAccountId: loanAccountId,
                    amount: loan.principal_amount,
                    description: `Principal received from ${loan.lender_name}`,
                }
            ],
            entryType: 'LOAN_DRAWDOWN',
        });

        return newLoan;
    },

    async updateLoan(id: string, updates: Partial<Loan>): Promise<Loan | null> {
        const existing = await this.getLoan(id);
        if (!existing) return null;

        const updated: Loan = {
            ...existing,
            ...updates,
            id: existing.id,
            updated_at: new Date().toISOString(),
        };

        await dbService.put(LOAN_STORE, updated);
        return updated;
    },

    async calculateInterest(loan: Loan, daysElapsed: number): Promise<number> {
        const annualRate = loan.interest_rate / 100;
        const dailyRate = annualRate / 365;
        return Math.round(loan.current_balance * dailyRate * daysElapsed * 100) / 100;
    },

    async processRepayment(
        loanId: string,
        principalAmount: number,
        interestAmount: number,
        repaymentDate: string,
        reference?: string,
        accounts: any[] = []
    ): Promise<LoanRepayment | null> {
        const loan = await this.getLoan(loanId);
        if (!loan) return null;

        if (principalAmount + interestAmount <= 0) {
            throw new Error('Repayment amount must be positive');
        }

        const config = getConfig();
        const accts = accounts;

        const loanAccountId = loan.loan_type === 'bank_loan'
            ? resolveAccountForPosting(config.bankLoansAccount, accts) || config.bankLoansAccount
            : resolveAccountForPosting(config.otherLoansAccount, accts) || config.otherLoansAccount;
        const bankAccountId = resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;
        const interestExpenseId = resolveAccountForPosting(config.interestExpenseAccount, accts) || config.interestExpenseAccount;

        const totalPayment = principalAmount + interestAmount;

        try {
            const lines: any[] = [];

            if (principalAmount > 0) {
                lines.push({
                    debitAccountId: loanAccountId,
                    creditAccountId: bankAccountId,
                    amount: principalAmount,
                    description: `Loan principal repayment`,
                });
            }

            if (interestAmount > 0) {
                lines.push({
                    debitAccountId: interestExpenseId,
                    creditAccountId: bankAccountId,
                    amount: interestAmount,
                    description: `Interest payment`,
                });
            }

            await ledgerService.createJournalEntry({
                date: repaymentDate,
                description: `Loan repayment: ${loan.lender_name}`,
                reference: reference || `LOAN-REP-${generateId('REP')}`,
                lines,
                entryType: 'LOAN_REPAYMENT',
            });

            const newBalance = loan.current_balance - principalAmount;
            await this.updateLoan(loanId, {
                current_balance: Math.max(0, newBalance),
                status: newBalance <= 0 ? 'fully_paid' : loan.status,
            });

            const repayment: LoanRepayment = {
                id: generateId('LREP'),
                loan_id: loanId,
                repayment_date: repaymentDate,
                principal_amount: principalAmount,
                interest_amount: interestAmount,
                total_payment: totalPayment,
                remaining_balance: Math.max(0, newBalance),
                reference,
                created_at: new Date().toISOString(),
            };

            await dbService.put(REPAYMENT_STORE, repayment);
            return repayment;
        } catch (error) {
            logger.error('Failed to process loan repayment', error);
            return null;
        }
    },

    async postMonthlyInterestAccrual(
        periodYear: number,
        periodMonth: number,
        accounts: any[] = []
    ): Promise<void> {
        const loans = await this.getAllLoans();
        const config = getConfig();
        const accts = accounts;

        const accruedInterestAccountId = resolveAccountForPosting(config.accruedExpensesAccount, accts) || config.accruedExpensesAccount;
        const interestExpenseId = resolveAccountForPosting(config.interestExpenseAccount, accts) || config.interestExpenseAccount;

        for (const loan of loans) {
            if (loan.status !== 'active') continue;

            const lastRepayment = await this.getLastRepayment(loan.id);
            const startDate = lastRepayment
                ? new Date(lastRepayment.repayment_date)
                : new Date(loan.start_date);
            const endDate = new Date(periodYear, periodMonth - 1, 1);
            const daysElapsed = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

            if (daysElapsed <= 0) continue;

            const interestAmount = await this.calculateInterest(loan, daysElapsed);

            if (interestAmount > 0) {
                await ledgerService.createJournalEntry({
                    date: endDate.toISOString(),
                    description: `Interest accrual: ${loan.lender_name}`,
                    reference: `LOAN-INT-ACCR-${generateId('INT')}`,
                    lines: [
                        {
                            debitAccountId: interestExpenseId,
                            creditAccountId: accruedInterestAccountId,
                            amount: interestAmount,
                            description: `Interest accrual for ${loan.lender_name}`,
                        }
                    ],
                    entryType: 'INTEREST_ACCRUAL',
                });
            }
        }
    },

    async getLastRepayment(loanId: string): Promise<LoanRepayment | null> {
        try {
            const all = await dbService.getAll<LoanRepayment>(REPAYMENT_STORE);
            const filtered = all.filter(r => r.loan_id === loanId);
            if (filtered.length === 0) return null;
            return filtered.sort((a, b) => b.repayment_date.localeCompare(a.repayment_date))[0];
        } catch {
            return null;
        }
    },

    async getRepayments(loanId: string): Promise<LoanRepayment[]> {
        try {
            const all = await dbService.getAll<LoanRepayment>(REPAYMENT_STORE);
            return all
                .filter(r => r.loan_id === loanId)
                .sort((a, b) => b.repayment_date.localeCompare(a.repayment_date));
        } catch {
            return [];
        }
    },

    async getLoanSummary(): Promise<{
        totalOutstanding: number;
        totalInterestPaid: number;
        activeLoans: number;
    }> {
        const loans = await this.getAllLoans();
        const repayments = await dbService.getAll<LoanRepayment>(REPAYMENT_STORE);

        return {
            totalOutstanding: loans.reduce((sum, l) => sum + l.current_balance, 0),
            totalInterestPaid: repayments.reduce((sum, r) => sum + r.interest_amount, 0),
            activeLoans: loans.filter(l => l.status === 'active').length,
        };
    },

    async initializeStores(): Promise<void> {
        try {
            await dbService.createObjectStore(LOAN_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
        try {
            await dbService.createObjectStore(REPAYMENT_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default loanService;
