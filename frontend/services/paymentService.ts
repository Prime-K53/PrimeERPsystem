import { dbService } from './db';
import { Invoice, Customer, CustomerPayment } from '../types';
import { roundFinancial } from '../utils/helpers';
import {
    buildCustomerReceiptDoc,
    calculateCustomerPaymentSnapshot
} from './receiptCalculationService';
import {
    buildConsolidatedLedgerFromRecords,
    buildLedgerFromRecords,
    getCustomerOpeningBalanceDetailed,
    mainAccountScope,
    type AccountScope,
} from './customerLedger';
import { resolveAccountScope } from './customerAccountScope';

export interface LedgerEntry {
    date: string;
    type: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE';
    reference_no: string;
    memo?: string;
    debit: number;
    credit: number;
}

type AnyRecord = Record<string, any>;

export interface LedgerScopeOptions {
    /** Explicit account scope. Defaults to Main — never "all accounts". */
    scope?: AccountScope | null;
    /** Parent customer record (enables stable branch-id resolution). */
    customer?: AnyRecord | null;
}

export const paymentService = {
    /**
     * Canonical outstanding balance — derived by the authoritative customer
     * ledger (services/customerLedger.ts), shared with the backend and all
     * other financial views. Previously this was a private per-invoice sum.
     *
     * Scope defaults to MAIN. Use `getCustomerOutstandingBalanceAllAccounts`
     * for intentional whole-customer aggregation.
     */
    async getCustomerOutstandingBalance(customerId: string, opts: LedgerScopeOptions = {}): Promise<number> {
        return roundFinancial(await getOutstandingViaLedger(customerId, opts));
    },

    /** Intentional Main + every-branch aggregate outstanding balance. */
    async getCustomerOutstandingBalanceAllAccounts(customerId: string): Promise<number> {
        return roundFinancial(await getOutstandingViaLedgerAllAccounts(customerId));
    },

    /**
     * Outstanding balance OF THE ACCOUNT a payment was received for.
     *
     * A receipt states "Your account balance is …" in its notes, so that number
     * must describe the account the money was taken for and nothing else. A
     * Main payment must never print a branch's balance, and a branch payment
     * must never print the parent's (or a sibling branch's) balance.
     *
     * `getCustomerOutstandingBalance` DEFAULTS to Main, so it can only be used
     * for a Main payment — every branch payment must come through here.
     *
     * A legacy payment that carries only a branch NAME which is shared by
     * several branches cannot be attributed to an account; it resolves to an
     * unattributable scope, matches no movement, and the balance sentence is
     * omitted rather than showing another account's figure.
     */
    async getOutstandingBalanceForPayment(payment: Partial<CustomerPayment> | AnyRecord | null | undefined): Promise<number> {
        const customerId = String(payment?.customerId || payment?.customer_id || '').trim();
        if (!customerId) return 0;
        const customer = await dbService.get<Customer>('customers', customerId).catch(() => null);
        const branchTag = payment?.subAccountId
            ?? payment?.sub_account_id
            ?? payment?.subAccountName
            ?? payment?.sub_account_name
            ?? null;
        const scope = resolveAccountScope(customerId, branchTag, customer as AnyRecord | null);
        if (!scope.isMain && !scope.branchId) return 0; // unresolvable → state no balance
        return roundFinancial(await getOutstandingViaLedger(customerId, { scope, customer: customer as AnyRecord | null }));
    },

    /**
     * Updates the customer's wallet if there is an overpayment.
     * Equivalent to:
     * UPDATE customers 
     * SET wallet_balance = wallet_balance + ? 
     * WHERE id = ?;
     */
    async updateCustomerWallet(customerId: string, amount: number): Promise<void> {
        const customer = await dbService.get<Customer>('customers', customerId);
        if (!customer) {
            throw new Error(`Customer with ID ${customerId} not found.`);
        }

        const updatedCustomer: Customer = {
            ...customer,
            walletBalance: roundFinancial((customer.walletBalance || 0) + amount)
        };

        await dbService.put('customers', updatedCustomer);

        // Log wallet transaction
        const transactionId = `WTX-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        await dbService.put('walletTransactions', {
            id: transactionId,
            customerId: customerId,
            date: new Date().toISOString(),
            amount: amount,
            type: amount > 0 ? 'Credit' : 'Debit',
            description: amount > 0 ? 'Overpayment credited to wallet' : 'Wallet balance adjusted',
            referenceId: 'MANUAL_ADJUSTMENT'
        });
    },

    /**
     * Internal reconciliation logic for consistent balance handling.
     * Only flags as overpayment if balance is negative.
     */
    processReconciliation(totalDue: number, amountPaid: number) {
        const balance = totalDue - amountPaid;
        return {
            isOverpaid: balance < 0,
            walletDeposit: balance < 0 ? Math.abs(balance) : 0,
            remainingBalance: balance > 0 ? balance : 0
        };
    },

    /**
     * @deprecated Receipt preview should use persisted payment snapshots.
     * Legacy compatibility wrapper retained for older call paths.
     */
    async processPayment(
        customerId: string,
        paymentAmount: number,
        invoiceIds: string[],
        customerName: string,
        paymentMethod: string,
        existingExcess?: number
    ) {
        const amountTendered = roundFinancial(Number(paymentAmount || 0));
        const allInvoices = await dbService.getAll<Invoice>('invoices');
        const targeted = allInvoices.filter(inv =>
            invoiceIds.includes(inv.id) &&
            (!customerId || inv.customerId === customerId)
        );

        let remaining = amountTendered;
        const appliedInvoices = targeted.map(inv => {
            const outstanding = roundFinancial(Math.max(0, (inv.totalAmount || 0) - (inv.paidAmount || 0)));
            const allocationAmount = roundFinancial(Math.min(remaining, outstanding));
            remaining = roundFinancial(remaining - allocationAmount);
            return {
                invoiceId: inv.id,
                allocationAmount,
                outstandingAmount: outstanding
            };
        }).filter(entry => entry.allocationAmount > 0);

        const snapshot = calculateCustomerPaymentSnapshot({
            amountTendered,
            appliedInvoices,
            excessHandling: (existingExcess || 0) > 0 ? 'Wallet' : undefined,
            paymentPurpose: appliedInvoices.length > 0 ? 'INVOICE_PAYMENT' : 'UNALLOCATED_PAYMENT',
            paymentDate: new Date().toISOString(),
            customerName
        });

        const pseudoPayment: CustomerPayment = {
            id: `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            date: new Date().toISOString(),
            customerId,
            customerName,
            amount: amountTendered,
            paymentMethod,
            allocations: appliedInvoices.map(entry => ({
                invoiceId: entry.invoiceId,
                amount: entry.allocationAmount
            })),
            status: 'Cleared',
            reconciled: false,
            excessHandling: snapshot.walletDeposit > 0 ? 'Wallet' : undefined,
            receiptSnapshot: snapshot,
            invoiceTotal: snapshot.invoiceTotalAtPosting,
            paymentStatus: snapshot.paymentStatus,
            balanceDue: snapshot.balanceDueAfterPayment,
            overpaymentAmount: snapshot.walletDeposit,
            walletDeposit: snapshot.walletDeposit,
            changeGiven: snapshot.changeGiven,
            amountApplied: snapshot.amountApplied,
            amountRetained: snapshot.amountRetained,
            calculationVersion: snapshot.calculationVersion
        };

        const currentBalance = await this.getCustomerOutstandingBalance(customerId);
        return buildCustomerReceiptDoc({
            payment: pseudoPayment,
            customerName,
            snapshot,
            currentBalance
        });
    },

    /**
     * Fetches the canonical customer ledger within a date range.
     * Inclusion rules, amounts (amountApplied ?? amountRetained ?? amount),
     * signs, and ordering all come from the authoritative ledger module —
     * identical to the backend and every other financial view.
     *
     * Scope defaults to MAIN; pass the selected branch scope explicitly so a
     * branch statement never merges Main or sibling-branch movements.
     */
    async getCustomerLedger(
        customerId: string,
        startDate: string,
        endDate: string,
        opts: LedgerScopeOptions = {},
    ): Promise<LedgerEntry[]> {
        const [allInvoices, allPayments] = await Promise.all([
            dbService.getAll<any>('invoices'),
            dbService.getAll<any>('customerPayments'),
        ]);
        const scope = opts.scope === undefined ? mainAccountScope(customerId) : opts.scope;
        // Opening balance is fetched for the SAME scope as the movements, so a
        // branch statement never inherits the parent opening. Explicit 0 for
        // unresolved branch openings (flagged by the caller via `scope`).
        const opening = opts.scope === null
            ? await getCustomerOpeningBalanceDetailed(customerId, null)
            : await getCustomerOpeningBalanceDetailed(customerId, scope);
        const ledger = buildLedgerFromRecords({
            customerId,
            scope,
            customer: opts.customer ?? null,
            invoices: allInvoices.filter(inv => inv.customerId === customerId),
            payments: allPayments.filter(payment => payment.customerId === customerId),
            openingBalance: opening.opening,
        });

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        return ledger.transactions
            .map(tx => ({
                date: String(tx.date || ''),
                type: tx.type === 'credit_note' ? 'CREDIT_NOTE' as const : tx.type === 'payment' ? 'PAYMENT' as const : 'INVOICE' as const,
                reference_no: tx.reference,
                memo: tx.description,
                debit: tx.debit,
                credit: tx.credit,
            }))
            .filter(entry => {
                const entryDate = new Date(entry.date);
                return !Number.isNaN(entryDate.getTime()) && entryDate >= start && entryDate <= end;
            });
    },

    /** Intentional Main + every-branch consolidated ledger within a date range. */
    async getCustomerLedgerAllAccounts(customerId: string, startDate: string, endDate: string): Promise<LedgerEntry[]> {
        return this.getCustomerLedger(customerId, startDate, endDate, { scope: null });
    }
};

async function getOutstandingViaLedger(customerId: string, opts: LedgerScopeOptions = {}): Promise<number> {
    const [allInvoices, allPayments] = await Promise.all([
        dbService.getAll<any>('invoices'),
        dbService.getAll<any>('customerPayments'),
    ]);
    const scope = opts.scope === undefined ? mainAccountScope(customerId) : opts.scope;
    const opening = await getCustomerOpeningBalanceDetailed(customerId, scope);
    const ledger = buildLedgerFromRecords({
        customerId,
        scope,
        customer: opts.customer ?? null,
        invoices: allInvoices.filter(inv => inv.customerId === customerId),
        payments: allPayments.filter(payment => payment.customerId === customerId),
        openingBalance: opening.opening,
    });
    return ledger.outstandingBalance;
}

async function getOutstandingViaLedgerAllAccounts(customerId: string): Promise<number> {
    const [allInvoices, allPayments] = await Promise.all([
        dbService.getAll<any>('invoices'),
        dbService.getAll<any>('customerPayments'),
    ]);
    const opening = await getCustomerOpeningBalanceDetailed(customerId, null);
    const ledger = buildConsolidatedLedgerFromRecords({
        customerId,
        invoices: allInvoices.filter(inv => inv.customerId === customerId),
        payments: allPayments.filter(payment => payment.customerId === customerId),
        openingBalance: opening.opening,
    });
    return ledger.outstandingBalance;
}
