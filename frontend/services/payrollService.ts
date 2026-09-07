/**
 * Payroll Service
 * 
 * Phase 2: Module for payroll processing
 * Handles:
 * - Employee management
 * - Salary payment processing
 * - PAYE tax deduction and posting to 21220
 * - Salary expense posting to 52100
 */

import { dbService } from './db';
import { Employee, PayrollEntry } from '../types';
import { getGLConfig, generateId, resolveAccountForPosting } from './transactions/_internal';
import { ledgerService } from './ledgerService';
import { logger } from './logger';

const EMPLOYEE_STORE = 'employees';
const PAYROLL_ENTRY_STORE = 'payrollEntries';

function getConfig() {
    return getGLConfig();
}

export const payrollService = {
    EMPLOYEE_STORE,
    PAYROLL_ENTRY_STORE,

    async getAllEmployees(): Promise<Employee[]> {
        try {
            const all = await dbService.getAll<Employee>(EMPLOYEE_STORE);
            return all.sort((a, b) => a.last_name.localeCompare(b.last_name));
        } catch (error) {
            logger.error('Failed to get employees', error);
            return [];
        }
    },

    async getEmployee(id: string): Promise<Employee | null> {
        try {
            return await dbService.getById<Employee>(EMPLOYEE_STORE, id);
        } catch (error) {
            logger.error(`Failed to get employee ${id}`, error);
            return null;
        }
    },

    async createEmployee(employee: Omit<Employee, 'id' | 'created_at' | 'updated_at'>): Promise<Employee> {
        const all = await this.getAllEmployees();
        const empNumber = `EMP-${String(all.length + 1).padStart(4, '0')}`;

        const newEmployee: Employee = {
            ...employee,
            id: empNumber,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        await dbService.put(EMPLOYEE_STORE, newEmployee);
        return newEmployee;
    },

    async updateEmployee(id: string, updates: Partial<Employee>): Promise<Employee | null> {
        const existing = await this.getEmployee(id);
        if (!existing) return null;

        const updated: Employee = {
            ...existing,
            ...updates,
            id: existing.id,
            updated_at: new Date().toISOString(),
        };

        await dbService.put(EMPLOYEE_STORE, updated);
        return updated;
    },

    async deleteEmployee(id: string): Promise<boolean> {
        const employee = await this.getEmployee(id);
        if (!employee) return false;
        if (employee.status === 'active') {
            throw new Error('Cannot delete an active employee. Terminate them first.');
        }
        await dbService.delete(EMPLOYEE_STORE, id);
        return true;
    },

    async getAllPayrollEntries(startDate?: string, endDate?: string): Promise<PayrollEntry[]> {
        try {
            const all = await dbService.getAll<PayrollEntry>(PAYROLL_ENTRY_STORE);
            return all.filter(entry => {
                if (startDate && entry.payment_date < startDate) return false;
                if (endDate && entry.payment_date > endDate) return false;
                return true;
            }).sort((a, b) => b.payment_date.localeCompare(a.payment_date));
        } catch (error) {
            logger.error('Failed to get payroll entries', error);
            return [];
        }
    },

    async getPayrollEntry(id: string): Promise<PayrollEntry | null> {
        try {
            return await dbService.getById<PayrollEntry>(PAYROLL_ENTRY_STORE, id);
        } catch (error) {
            logger.error(`Failed to get payroll entry ${id}`, error);
            return null;
        }
    },

    async processPayroll(
        employeeId: string,
        payPeriodStart: string,
        payPeriodEnd: string,
        paymentDate: string,
        grossSalary: number,
        payeAmount: number,
        pensionAmount: number = 0,
        otherDeductions: number = 0,
        deductionDescription: string = '',
        accounts: any[] = []
    ): Promise<PayrollEntry | null> {
        const config = getConfig();
        const accts = accounts;

        const salariesExpenseId = resolveAccountForPosting(config.salariesExpenseAccount, accts) || config.salariesExpenseAccount;
        const payePayableId = resolveAccountForPosting(config.payePayableAccount, accts) || config.payePayableAccount;
        const bankAccountId = resolveAccountForPosting(config.bankAccount, accts) || config.bankAccount;

        const totalDeductions = payeAmount + pensionAmount + otherDeductions;
        const netSalary = grossSalary - totalDeductions;

        try {
            const lines: any[] = [
                {
                    debitAccountId: salariesExpenseId,
                    creditAccountId: bankAccountId,
                    amount: netSalary,
                    description: `Net salary payment`,
                }
            ];

            if (payeAmount > 0) {
                lines.push({
                    debitAccountId: salariesExpenseId,
                    creditAccountId: payePayableId,
                    amount: payeAmount,
                    description: `PAYE tax deduction`,
                });
            }

            if (pensionAmount > 0) {
                lines.push({
                    debitAccountId: salariesExpenseId,
                    creditAccountId: bankAccountId,
                    amount: pensionAmount,
                    description: `Pension contribution`,
                });
            }

            await ledgerService.createJournalEntry({
                date: paymentDate,
                description: `Payroll: ${payPeriodStart} to ${payPeriodEnd}`,
                reference: `PAY-${generateId('PAY')}`,
                lines,
                entryType: 'PAYROLL',
            });

            const payrollEntry: PayrollEntry = {
                id: generateId('PE'),
                employee_id: employeeId,
                pay_period_start: payPeriodStart,
                pay_period_end: payPeriodEnd,
                payment_date: paymentDate,
                basic_salary: grossSalary,
                gross_salary: grossSalary,
                total_deductions: totalDeductions,
                net_salary: netSalary,
                paye_amount: payeAmount,
                pension_amount: pensionAmount,
                other_deductions: otherDeductions,
                deduction_description: deductionDescription,
                status: 'paid',
                created_at: new Date().toISOString(),
            };

            await dbService.put(PAYROLL_ENTRY_STORE, payrollEntry);
            return payrollEntry;
        } catch (error) {
            logger.error('Failed to process payroll', error);
            return null;
        }
    },

    async calculatePAYE(grossSalary: number): Promise<number> {
        const taxYear = new Date().getFullYear();
        const monthlyGross = grossSalary;

        let annualTaxableIncome = monthlyGross * 12;
        let annualTax = 0;

        const TAX_BRACKETS = [
            { min: 0, max: 300000, rate: 0 },
            { min: 300001, max: 540000, rate: 0.15 },
            { min: 540001, max: 900000, rate: 0.225 },
            { min: 900001, max: 1350000, rate: 0.30 },
            { min: 1350001, max: Infinity, rate: 0.35 },
        ];

        let remainingIncome = annualTaxableIncome;
        for (const bracket of TAX_BRACKETS) {
            if (remainingIncome <= 0) break;
            const taxableInBracket = Math.min(remainingIncome, bracket.max - bracket.min);
            if (annualTaxableIncome > bracket.min) {
                annualTax += taxableInBracket * bracket.rate;
                remainingIncome -= taxableInBracket;
            }
        }

        const monthlyPAYE = Math.round((annualTax / 12) * 100) / 100;
        return monthlyPAYE;
    },

    async getPayrollSummary(year?: number, month?: number): Promise<{
        totalGross: number;
        totalPAYE: number;
        totalPension: number;
        totalNet: number;
        employeeCount: number;
    }> {
        const entries = await this.getAllPayrollEntries();
        const filtered = entries.filter(entry => {
            const d = new Date(entry.payment_date);
            if (year && d.getFullYear() !== year) return false;
            if (month && d.getMonth() + 1 !== month) return false;
            return true;
        });

        return {
            totalGross: filtered.reduce((sum, e) => sum + e.gross_salary, 0),
            totalPAYE: filtered.reduce((sum, e) => sum + e.paye_amount, 0),
            totalPension: filtered.reduce((sum, e) => sum + (e.pension_amount || 0), 0),
            totalNet: filtered.reduce((sum, e) => sum + e.net_salary, 0),
            employeeCount: new Set(filtered.map(e => e.employee_id)).size,
        };
    },

    async initializeStores(): Promise<void> {
        try {
            await dbService.createObjectStore(EMPLOYEE_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
        try {
            await dbService.createObjectStore(PAYROLL_ENTRY_STORE, { keyPath: 'id' });
        } catch { /* store may exist */ }
    },
};

export default payrollService;
