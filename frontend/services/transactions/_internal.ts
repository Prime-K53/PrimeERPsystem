import { dbService } from '../db';
import { logger } from '@/services/logger';
import { getFifoUnitCost } from '../fifoCostService';
import { currencyService } from '../currencyService';
import {
    LedgerEntry, BankAccount, BankTransaction, VATConfig,
    MultiCurrencyJournalEntry, MultiCurrencyTransactionLine, CurrencyGainLoss,
    Invoice
} from '../../types';
import { DEFAULT_ACCOUNTS } from '../../constants';
import { generateNextId, roundToCurrency } from '../../utils/helpers';
import { computeHierarchicalRollup, getNormalBalance, isPostedLedgerEntry, entryTouchesAccount } from '../accountingEngine';
import { classifyInventoryItem, isInventoryBearingItem, resolveInventoryCostPerUnit } from '../../utils/inventoryNormalization';

export const getCompanyConfig = () => {
    const saved = localStorage.getItem('nexus_company_config');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            logger.error("Failed to parse company config", e);
        }
    }
    return null;
};

export const getGLConfig = () => {
    const saved = localStorage.getItem('nexus_company_config');
    const defaultConfig = {
        defaultSalesAccount: '41100',
        salesRevenueAccount: '41100',
        incomeAccount: '41100',
        defaultInventoryAccount: '11400',
        defaultCOGSAccount: '51200',
        accountsReceivable: '11310',
        accountsPayable: '21110',
        cashDrawerAccount: '11110',
        bankAccount: '11210',
        mobileMoneyAccount: '11240',
        salesReturnAccount: '41100',
        customerDepositAccount: '21300',
        customerDeposits: '21300',
        walletAccount: '21300',
        otherIncomeAccount: '42000',
        defaultExpenseAccount: '52000',
        defaultLaborWagesAccount: '52100',
        retainedEarningsAccount: '32000',
        roundingAccount: '52900',
        fixedAssetAccount: '12100',
        accumulatedDepreciationAccount: '12500',
        depreciationExpenseAccount: '53000',
        revaluationReserveAccount: '32010',
        impairmentExpenseAccount: '53100',
        accumulatedImpairmentAccount: '12510',
        gainOnDisposalAccount: '42010',
        lossOnDisposalAccount: '53010',
        ownerCapitalAccount: '31000',
        ownerDrawingsAccount: '34000',
        bankChargesAccount: '52900',
        interestExpenseAccount: '54100',
        interestIncomeAccount: '42100',
        payePayableAccount: '21220',
        salariesExpenseAccount: '52100',
        accruedExpensesAccount: '21300',
        bankLoansAccount: '22100',
        otherLoansAccount: '22200',
        shareholderLoansAccount: '22300',
        accruedInterestPayableLTAccount: '22310',
        currentPortionLTDebtAccount: '22400',
        currentYearEarningsAccount: '33000',
        purchasesAccount: '51100',
        freightAccount: '51300',
        officeExpensesAccount: '52800',
        otherExpensesAccount: '54000',
        prepaymentsAccount: '11510',
        staffAdvancesAccount: '11520',
        discountReceivedAccount: '42200',
        vatPayableAccount: '21210',
        vatReceivableAccount: '21310',
        utilitiesAccount: '52300',
        telephoneAccount: '52400',
        internetAccount: '52500',
        printingAccount: '52600'
    };

    if (saved) {
        try {
            const config = JSON.parse(saved);
            return {
                ...defaultConfig,
                ...(config.glMapping || {})
            };
        } catch (e) {
            logger.error("Failed to parse company config", e);
        }
    }
    return defaultConfig;
};

/**
 * Resolve an account identifier (code, account_number, or id) to actual account.id
 * This function bridges legacy code-based references to the new hierarchical COA
 * 
 * @param identifier - Legacy code (e.g., '1000'), account_number (e.g., '11101'), or account.id
 * @param accounts - Optional pre-loaded accounts list
 * @returns The actual account.id or the identifier if not found (for backward compatibility)
 */
export const resolveToAccountId = (identifier: string, accounts?: any[]): string => {
    if (!identifier) return identifier;
    
    if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return identifier;
    }
    
    if (accounts && accounts.length > 0) {
        const found = accounts.find(a => 
            a.id === identifier || 
            a.code === identifier || 
            a.account_number === identifier
        );
        if (found) return found.id;
    }
    
    return identifier;
};

export async function loadAccountsFromStore(tx: any): Promise<any[]> {
    try {
        if (!tx) {
            const fromDb = await dbService.getAll<any>('accounts');
            return fromDb && fromDb.length > 0 ? fromDb : DEFAULT_ACCOUNTS;
        }
        const accountsStore = typeof tx.objectStore === 'function' ? tx.objectStore('accounts') : tx;
        if (!accountsStore || typeof accountsStore.getAll !== 'function') {
            const fromDb = await dbService.getAll<any>('accounts');
            return fromDb && fromDb.length > 0 ? fromDb : DEFAULT_ACCOUNTS;
        }
        const res = accountsStore.getAll();
        let loadedAccounts: any[] = [];
        if (res && typeof res.then === 'function') {
            loadedAccounts = await res;
        } else if (Array.isArray(res)) {
            loadedAccounts = res;
        } else if (res && typeof res === 'object') {
            loadedAccounts = await new Promise((resolve, reject) => {
                res.onsuccess = () => resolve(res.result);
                res.onerror = () => reject(res.error);
            });
        }
        if (!loadedAccounts || loadedAccounts.length === 0) {
            return DEFAULT_ACCOUNTS;
        }
        return loadedAccounts;
    } catch {
        return DEFAULT_ACCOUNTS;
    }
}

export function resolveGLAccount(
    accountRef: string | undefined,
    accounts: any[],
    options: ResolveAccountOptions = {}
): string | null {
    if (!accountRef) return null;
    return resolveAccountForPosting(accountRef, accounts, options);
}

export interface ResolveAccountOptions {
    allowInactive?: boolean;
    allowNonPosting?: boolean;
    companyId?: string;
    strict?: boolean;
}

export class UnresolvedAccountError extends Error {
    constructor(public readonly accountRef: string) {
        super(`Unable to resolve posting account: ${accountRef}`);
        this.name = 'UnresolvedAccountError';
    }
}

const LEGACY_CODE_TO_CANONICAL: Record<string, string> = {
    '1000': '11110', // Cash Drawer
    '1050': '11210', // Bank
    '1060': '11240', // Mobile Money
    '1100': '11310', // Trade Debtors / AR
    '1200': '12100', // Fixed Asset
    '1300': '11400', // Inventory
    '1400': '11310', // AR
    '1500': '12100', // Fixed Asset
    '1600': '12500', // Acc Depreciation
    '2000': '21110', // Accounts Payable
    '2100': '21110', // Accounts Payable
    '2110': '21110', // Accounts Payable
    '2120': '21210', // Tax Payable
    '3000': '30000', // Equity
    '3100': '31000', // Capital
    '3200': '32000', // Retained Earnings
    '3400': '34000', // Drawings
    '4000': '41100', // Sales Revenue
    '4100': '41100', // Sales Product
    '4200': '41200', // Sales Service
    '5000': '51200', // COGS
    '5100': '51100', // Purchases
    '6000': '52000', // Expenses
    '6100': '52200', // Rent
    '6200': '52300', // Utilities
    '6300': '52100', // Salaries
};

export function resolveAccountForPosting(identifier: string, accounts: any[], options: ResolveAccountOptions = {}): string | null {
    if (!identifier) {
        if (options.strict) throw new UnresolvedAccountError(identifier || 'undefined');
        return null;
    }
    
    if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const account = accounts.find(a => a.id === identifier);
        if (!account) {
            if (options.strict) throw new UnresolvedAccountError(identifier);
            return null;
        }
        
        if (!options.allowInactive && (account.is_active === false || account.is_active === 0)) {
            if (options.strict) throw new UnresolvedAccountError(identifier);
            return null;
        }
        if (!options.allowNonPosting && (account.allow_posting === false || account.allow_posting === 0)) {
            if (options.strict) throw new UnresolvedAccountError(identifier);
            return null;
        }
        if (options.companyId && account.company_id && account.company_id !== options.companyId) {
            if (options.strict) throw new UnresolvedAccountError(identifier);
            return null;
        }
        return identifier;
    }
    
    let found = accounts.find(a => 
        a.id === identifier || 
        a.code === identifier || 
        a.account_number === identifier
    );

    if (!found && LEGACY_CODE_TO_CANONICAL[identifier]) {
        const canonical = LEGACY_CODE_TO_CANONICAL[identifier];
        found = accounts.find(a =>
            a.id === canonical ||
            a.code === canonical ||
            a.account_number === canonical
        );
    }
    
    if (!found) {
        if (options.strict) throw new UnresolvedAccountError(identifier);
        return null;
    }
    
    if (!options.allowInactive && (found.is_active === false || found.is_active === 0)) {
        if (options.strict) throw new UnresolvedAccountError(identifier);
        return null;
    }
    if (!options.allowNonPosting && (found.allow_posting === false || found.allow_posting === 0)) {
        const postingChild = accounts.find(a =>
            (a.parent_account_id === found.id || a.parent_account_id === found.code || a.parent_account_id === found.account_number) &&
            a.allow_posting !== false && a.allow_posting !== 0 &&
            a.is_active !== false && a.is_active !== 0
        );
        if (postingChild) {
            return postingChild.id;
        }
        if (options.strict) throw new UnresolvedAccountError(identifier);
        return null;
    }
    if (options.companyId && found.company_id && found.company_id !== options.companyId) {
        if (options.strict) throw new UnresolvedAccountError(identifier);
        return null;
    }
    
    return found.id;
}

export function requireResolvedAccount(identifier: string, accounts: any[], options: Omit<ResolveAccountOptions, 'strict'> = {}): string {
    const resolved = resolveAccountForPosting(identifier, accounts, { ...options, strict: true });
    if (!resolved) {
        throw new UnresolvedAccountError(identifier);
    }
    return resolved;
}

/**
 * Get account ID by role using the Account Resolution Service
 * Falls back to legacy code lookup if service unavailable
 */
export const getAccountIdByRole = async (role: string): Promise<string | null> => {
    try {
        const { accountResolutionService } = await import('../accountResolutionService');
        const roleMap: Record<string, import('../accountResolutionService').AccountRole> = {
            'AR': 'AR',
            'AP': 'AP',
            'CASH': 'CASH',
            'BANK': 'BANK',
            'SALES': 'SALES',
            'SALES_PRODUCT': 'SALES_PRODUCT',
            'SALES_SERVICE': 'SALES_SERVICE',
            'INVENTORY': 'INVENTORY',
            'COGS': 'COGS',
            'TAX_PAYABLE': 'TAX_PAYABLE',
            'RETAINED_EARNINGS': 'RETAINED_EARNINGS',
            'EXPENSE': 'EXPENSE',
            'EXPENSE_OPERATING': 'EXPENSE_OPERATING',
            'EXPENSE_SALARIES': 'EXPENSE_SALARIES',
            'EXPENSE_RENT': 'EXPENSE_RENT',
            'EXPENSE_UTILITIES': 'EXPENSE_UTILITIES',
            'EXPENSE_OTHER': 'EXPENSE_OTHER',
            'OTHER_INCOME': 'OTHER_INCOME',
            'PURCHASES': 'PURCHASES',
            'FIXED_ASSET': 'FIXED_ASSET',
            'ACCUMULATED_DEPRECIATION': 'ACCUMULATED_DEPRECIATION',
        };
        
        const targetRole = roleMap[role];
        if (!targetRole) return null;
        
        return await accountResolutionService.getAccountIdByRole(targetRole);
    } catch {
        // Fall back to legacy glMapping lookup
        const gl = getGLConfig();
        const roleToKey: Record<string, keyof typeof gl> = {
            'AR': 'accountsReceivable',
            'AP': 'accountsPayable',
            'CASH': 'cashDrawerAccount',
            'BANK': 'bankAccount',
            'SALES': 'defaultSalesAccount',
            'INVENTORY': 'defaultInventoryAccount',
            'COGS': 'defaultCOGSAccount',
            'RETAINED_EARNINGS': 'retainedEarningsAccount',
            'EXPENSE': 'defaultExpenseAccount',
            'EXPENSE_SALARIES': 'defaultLaborWagesAccount',
            'OTHER_INCOME': 'otherIncomeAccount',
        };
        const key = roleToKey[role];
        return key ? (gl[key] as string) : null;
    }
};

export const generateId = (prefix: string, randomLength = 9): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, randomLength)}`;
};

export const calculateBankBalance = (transactions: BankTransaction[], accountId: string): number => {
    return transactions
        .filter(tx => tx.bankAccountId === accountId)
        .reduce((sum, tx) => sum + (tx.type === 'Deposit' ? tx.amount : -tx.amount), 0);
};

export const ensureBankAccounts = async (bankAccountsStore: any): Promise<BankAccount[]> => {
    const existing = await bankAccountsStore.getAll();
    if (existing.length > 0) return existing;

    const now = new Date().toISOString();
    const sampleAccounts: Omit<BankAccount, 'id' | 'balance' | 'availableBalance' | 'createdAt' | 'updatedAt'>[] = [
        {
            name: 'Cash Account',
            accountNumber: 'CASH-001',
            bankName: 'Prime Bank',
            accountType: 'Asset',
            status: 'Active',
            openingDate: now,
            currency: 'USD'
        },
        {
            name: 'Bank Account',
            accountNumber: 'BANK-001',
            bankName: 'Prime Bank',
            accountType: 'Asset',
            status: 'Active',
            openingDate: now,
            currency: 'USD'
        },
        {
            name: 'Mobile Money Account',
            accountNumber: 'MOMO-001',
            bankName: 'Mobile Money',
            accountType: 'Asset',
            status: 'Active',
            openingDate: now,
            currency: 'USD'
        }
    ];

    let seeded: BankAccount[] = [];
    let temp = [...existing];

    for (const accountData of sampleAccounts) {
        const newAccount: BankAccount = {
            ...accountData,
            id: generateNextId('BANK', temp),
            balance: 0,
            availableBalance: 0,
            createdAt: now,
            updatedAt: now
        };
        await bankAccountsStore.put(newAccount);
        temp.push(newAccount);
        seeded.push(newAccount);
    }

    return temp;
};

export const resolveBankAccountForPayment = (
    bankAccounts: BankAccount[],
    payment: { accountId?: string; paymentMethod?: string }
): BankAccount | undefined => {
    if (bankAccounts.length === 0) return undefined;

    if (payment.accountId) {
        const direct = bankAccounts.find(acc => acc.id === payment.accountId);
        if (direct) return direct;
    }

    const method = (payment.paymentMethod || '').toLowerCase();

    const matches = (acc: BankAccount, tokens: string[]) => {
        const name = (acc.name || '').toLowerCase();
        const number = (acc.accountNumber || '').toLowerCase();
        const bankName = (acc.bankName || '').toLowerCase();
        return tokens.some(token => 
            name.includes(token) || 
            number.includes(token) ||
            bankName.includes(token)
        );
    };

    if (method.includes('cash')) {
        return bankAccounts.find(acc => matches(acc, ['cash']));
    }

    if (method.includes('mobile') || method.includes('momo')) {
        return bankAccounts.find(acc => matches(acc, ['mobile', 'momo']));
    }

    if (method.includes('bank') || method.includes('card')) {
        return bankAccounts.find(acc => matches(acc, ['bank']));
    }

    return undefined;
};

export const reserveIdempotencyKey = async (
    tx: any,
    scope: string,
    sourceId: string,
    explicitKey?: string
) => {
    const store = tx.objectStore('idempotencyKeys');
    const key = String(explicitKey || `${scope}:${sourceId}`).trim();
    const existing = await store.get(key);
    if (existing) {
        throw new Error(`Duplicate financial request blocked for ${scope} (${sourceId}).`);
    }

    await store.put({
        id: key,
        scope,
        sourceId,
        createdAt: new Date().toISOString()
    });
};

export const clearIdempotencyKey = async (tx: any, scope: string, sourceId: string, explicitKey?: string) => {
    const store = tx.objectStore('idempotencyKeys');
    const key = String(explicitKey || `${scope}:${sourceId}`).trim();
    await store.delete(key);
};

export const getIdempotencyKeys = async (tx: any): Promise<any[]> => {
    const store = tx.objectStore('idempotencyKeys');
    return store.getAll();
};

export const ensureMirroredBankTransaction = async ({
    bankAccountsStore,
    bankTransactionsStore,
    date,
    amount,
    type,
    description,
    reference,
    accountId,
    paymentMethod,
    category,
    counterpartyName
}: {
    bankAccountsStore: any;
    bankTransactionsStore: any;
    date: string;
    amount: number;
    type: 'Deposit' | 'Withdrawal';
    description: string;
    reference: string;
    accountId?: string;
    paymentMethod?: string;
    category?: string;
    counterpartyName?: string;
}) => {
    const normalizedAmount = roundToCurrency(Math.max(0, Number(amount || 0)));
    if (normalizedAmount <= 0) return null;

    const bankAccounts = await ensureBankAccounts(bankAccountsStore);
    const bankAccount = resolveBankAccountForPayment(bankAccounts, {
        accountId,
        paymentMethod: paymentMethod || ''
    });
    if (!bankAccount) return null;

    const allBankTransactions = await bankTransactionsStore.getAll();
    const existing = allBankTransactions.find((entry: BankTransaction) =>
        entry.bankAccountId === bankAccount.id &&
        entry.reference === reference &&
        entry.type === type
    );
    if (existing) return existing;

    const bankTx: BankTransaction = {
        id: generateNextId('TXN', allBankTransactions),
        date,
        amount: normalizedAmount,
        type,
        description,
        reference,
        bankAccountId: bankAccount.id,
        counterparty: counterpartyName ? { name: counterpartyName } : undefined,
        category,
        reconciled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const nextTransactions = [...allBankTransactions, bankTx];
    await bankTransactionsStore.put(bankTx);

    const nextBalance = calculateBankBalance(nextTransactions, bankAccount.id);
    await bankAccountsStore.put({
        ...bankAccount,
        balance: roundToCurrency(nextBalance),
        availableBalance: roundToCurrency(nextBalance),
        updatedAt: new Date().toISOString()
    });

    return bankTx;
};

export const getVatConfig = (): VATConfig | undefined => {
    const saved = localStorage.getItem('nexus_company_config');
    if (saved) {
        try {
            const config = JSON.parse(saved);
            return config.vat;
        } catch (e) {
            logger.error("Failed to parse company config for VAT", e);
        }
    }
    return undefined;
};

export const toMoney = (value: number): number => {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
};

export const createMultiCurrencyJournalEntry = async (
    date: Date | string,
    description: string,
    lines: Array<{
        accountId: string;
        amount: number;
        currency: string;
        type: 'debit' | 'credit';
        description?: string;
    }>,
    transactionCurrency: string,
    reference?: string
): Promise<MultiCurrencyJournalEntry> => {
    const baseCurrency = currencyService.getBaseCurrency();
    
    const exchangeRate = transactionCurrency === baseCurrency 
        ? 1 
        : await currencyService.getExchangeRate(transactionCurrency, baseCurrency);
    
    const processedLines: MultiCurrencyTransactionLine[] = await Promise.all(
        lines.map(async (line) => {
            const baseAmount = line.currency === baseCurrency
                ? line.amount
                : currencyService.roundAmount(
                    (await currencyService.convert(line.amount, line.currency, baseCurrency)).baseAmount,
                    baseCurrency
                );
            
            return {
                accountId: line.accountId,
                amount: line.amount,
                currency: line.currency,
                baseAmount,
                baseCurrency,
                exchangeRate: line.currency === baseCurrency ? 1 : exchangeRate,
                exchangeRateDate: new Date(),
                debit: line.type === 'debit' ? line.amount : 0,
                credit: line.type === 'credit' ? line.amount : 0,
            };
        })
    );
    
    const totalDebit = processedLines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredit = processedLines.reduce((sum, l) => sum + l.credit, 0);
    const totalBaseDebit = processedLines.reduce((sum, l) => sum + (l.type === 'debit' ? l.baseAmount : 0), 0);
    const totalBaseCredit = processedLines.reduce((sum, l) => sum + (l.type === 'credit' ? l.baseAmount : 0), 0);
    
    return {
        id: generateId('MCJ'),
        date: typeof date === 'string' ? new Date(date) : date,
        description,
        reference,
        transactionCurrency,
        exchangeRate,
        exchangeRateDate: new Date(),
        lines: processedLines.map((l, i) => ({
            ...l,
            description: lines[i].description,
        })),
        totalDebit,
        totalCredit,
        totalBaseDebit,
        totalBaseCredit,
        createdBy: 'system',
        createdAt: new Date(),
        status: 'posted',
    };
};

export const calculatePaymentGainLoss = async (
    invoice: Invoice,
    paymentAmount: number,
    paymentCurrency: string,
    paymentRate: number
): Promise<CurrencyGainLoss | null> => {
    const baseCurrency = currencyService.getBaseCurrency();
    const invoiceCurrency = (invoice as Invoice & { currency?: string }).currency || baseCurrency;
    
    if (invoiceCurrency === paymentCurrency) {
        return null;
    }
    
    const invoiceRate = invoiceCurrency === baseCurrency 
        ? 1 
        : await currencyService.getExchangeRate(invoiceCurrency, baseCurrency);
    
    return currencyService.calculateGainLoss(
        invoice.id,
        invoice.totalAmount,
        invoiceCurrency,
        invoiceRate,
        paymentAmount,
        paymentRate
    );
};

export const resolveItemUnitCost = async (item: any, inventoryItem: any): Promise<number> => {
    const snapshotCost = Number(item?.productionCostSnapshot?.baseProductionCost);
    if (Number.isFinite(snapshotCost) && snapshotCost > 0) return snapshotCost;

    const batchSelections = item?.batchSelections;
    if (batchSelections && batchSelections.length > 0) {
        const totalQty = batchSelections.reduce((s: number, sel: any) => s + (sel.quantity || 0), 0);
        if (totalQty > 0) {
            const batches = await dbService.getAll<any>('materialBatches');
            const totalCost = batchSelections.reduce((sum: number, sel: any) => {
                const batch = batches.find((b: any) => b.id === sel.batchId);
                const unitCost = batch?.costPerUnit || 0;
                return sum + (unitCost * sel.quantity);
            }, 0);
            if (totalCost > 0) return totalCost / totalQty;
        }
    }

    const costingMethod = inventoryItem?.costingMethod || 'weighted_average';
    if (costingMethod === 'fifo') {
        try {
            const fifoCost = await getFifoUnitCost(inventoryItem?.id || item?.id);
            if (Number.isFinite(fifoCost) && fifoCost > 0) return fifoCost;
        } catch { /* fall through to weighted average */ }
    }

    const directCost = Number(resolveInventoryCostPerUnit(item) || resolveInventoryCostPerUnit(inventoryItem));
    if (Number.isFinite(directCost) && directCost > 0) return directCost;

    const variantId = item?.variantId;
    if (variantId && inventoryItem?.variants?.length) {
        const variant = inventoryItem.variants.find((v: any) => v.id === variantId);
        if (variant) {
            const variantCost = Number(resolveInventoryCostPerUnit(variant));
            if (Number.isFinite(variantCost) && variantCost > 0) return variantCost;
        }
    }

    const inventoryCost = Number(resolveInventoryCostPerUnit(inventoryItem));
    return Number.isFinite(inventoryCost) ? inventoryCost : 0;
};

export const resolveInventoryRecord = async (
    itemId: string | undefined,
    ...sources: any[]
) => {
    const normalizedItemId = String(itemId || '').trim();
    if (!normalizedItemId) return undefined;

    for (const source of sources) {
        if (!source) continue;

        if (Array.isArray(source)) {
            const match = source.find((entry) => String(entry?.id || '').trim() === normalizedItemId);
            if (match) return match;
            continue;
        }

        if (source instanceof Map) {
            const match = source.get(normalizedItemId);
            if (match) return match;
            continue;
        }

        if (typeof source.get === 'function') {
            const match = await source.get(normalizedItemId);
            if (match) return match;
        }
    }

    return undefined;
};

export const calculateItemsCost = async (
    items: any[],
    inventorySource: any,
    resolveId: (item: any) => string | undefined,
    fallbackInventorySource?: any
) => {
    let totalCost = 0;
    for (const item of items || []) {
        const itemId = resolveId(item);
        if (!itemId) continue;
        const invItem = await resolveInventoryRecord(itemId, inventorySource, fallbackInventorySource);
        // Same eligibility as the COGS legs: only stock-bearing lines
        // contribute cost. The line type governs; the stored record governs
        // when the line carries no type.
        const eligibilityProbe = item?.type ? item : invItem;
        if (!isInventoryBearingItem(eligibilityProbe)) continue;
        const unitCost = await resolveItemUnitCost(item, invItem);
        const qty = Number(item?.quantity || 0);
        if (qty > 0 && unitCost > 0) {
            totalCost += unitCost * qty;
        }
    }
    return roundToCurrency(totalCost);
};

/**
 * True when the invoice carries only service lines (and at least one line).
 * Uses the exact Service predicate shared by calculateItemsCost and
 * resolveInventoryAccountFromItems so revenue routing agrees with COGS.
 * Service-only invoices must credit 41200 Service Income, never 41100.
 */
export function isServiceOnlyInvoice(items: any[]): boolean {
    if (!items || items.length === 0) return false;
    return items.every((i: any) => i?.type === 'Service');
}

/**
 * Active (posted) invoice statuses. Draft/Cancelled/Void/Voided invoices must
 * not contribute AR, revenue, COGS or inventory movements. Credit notes pass
 * (they post negative revenue) — see utils/revenueRecognition.
 * Case-insensitive (backend voids as 'Voided', UI as 'cancelled', etc.).
 */
export function isPostedInvoiceStatus(status: any): boolean {
    const s = String(status || '').trim().toLowerCase();
    return s !== 'draft' && s !== 'cancelled' && s !== 'void' && s !== 'voided';
}

/**
 * Revenue account selector for invoice AR postings.
 * Explicit salesAccountId always wins (e.g. POS selector); service-only
 * invoices fall back to 41200 Service Income, everything else to the
 * default sales account (41100 Product Sales).
 * (Canonical rule lives in utils/revenueRecognition; kept inline here to
 * avoid a services<->utils import cycle.)
 */
export function resolveInvoiceRevenueAccount(invoice: any, defaultSalesAccount: string): string {
    if (invoice?.salesAccountId) return invoice.salesAccountId;
    if (isServiceOnlyInvoice(invoice?.items || [])) return '41200';
    return defaultSalesAccount;
}

/**
 * Lifecycle guard for invoice edits. Posted invoices (anything that already
 * journalised AR/revenue/COGS) are immutable by bare edit:
 * - cancelling must go through voidInvoice (full reversal), and
 * - totals/lines changes require void-and-reissue or a correction journal.
 * Settlement fields (paidAmount, Paid/Partial/Unpaid status) and draft edits
 * always pass through. Throws a guidance Error otherwise.
 */
export function assertInvoiceEditable(existing: any, next: any): void {
    if (!existing || String(existing.status || '') === 'Draft') return;
    const nextStatus = String(next?.status || '');
    if (nextStatus === 'Cancelled' || nextStatus === 'Voided') {
        throw new Error(
            `Invoice #${next?.id || existing?.id} has posted ledger entries and cannot be cancelled by edit. Use void/cancel with reversal instead.`
        );
    }
    const totalsChanged = Math.abs(Number(existing.totalAmount || 0) - Number(next?.totalAmount || 0)) > 0.005;
    if (totalsChanged || !sameInvoiceLines(existing.items, next?.items)) {
        throw new Error(
            `Invoice #${next?.id || existing?.id} totals/lines cannot be edited after posting (ledger already journalised ${Number(existing.totalAmount || 0).toFixed(2)}). Void and reissue, or post a correction, instead.`
        );
    }
}

export interface PostEditCorrectionSpec {
    direction: 'reduction' | 'increase';
    amount: number;
    debitAccountId: string;
    creditAccountId: string;
    referenceId: string;
    description: string;
    originalAr: number;
    netPostedAr: number;
    currentTotal: number;
}

const POST_EDIT_CORRECTION_TAG = 'POST-EDIT-CORRECTION';

export function postEditCorrectionBaseRef(invoiceId: string): string {
    return `${invoiceId}-${POST_EDIT_CORRECTION_TAG}`;
}

export function isPostEditCorrectionRef(invoiceId: string, referenceId: any): boolean {
    return String(referenceId || '').startsWith(postEditCorrectionBaseRef(invoiceId));
}

/**
 * Compute the AR/revenue correction needed when a posted invoice's commercial
 * total no longer matches its net posted AR.
 *
 * - originalArEntries: the original AR debit postings (LG-INV-AR and
 *   conversion equivalents), referenceId === invoiceId.
 * - priorCorrections: earlier POST-EDIT-CORRECTION entries for this invoice.
 * - arAccountId / revenueAccountId: the resolved pair from the ORIGINAL
 *   posting — the correction always reverses that same pair, never another
 *   revenue account.
 *
 * Returns null when books already agree (|diff| < 0.005). Throws STOP when a
 * prior correction touches a different account pair (manual reconciliation).
 */
export function computePostEditCorrection(args: {
    invoiceId: string;
    currentTotal: number;
    originalArEntries: Array<{ debitAccountId: string; creditAccountId: string; amount: number }>;
    priorCorrections: Array<{ debitAccountId: string; creditAccountId: string; amount: number; referenceId: string }>;
    arAccountId: string;
    revenueAccountId: string;
}): PostEditCorrectionSpec | null {
    const { invoiceId, currentTotal, originalArEntries, priorCorrections, arAccountId, revenueAccountId } = args;
    const originalAr = roundToCurrency(originalArEntries.reduce((s, e) => s + Number(e.amount || 0), 0));
    let netPostedAr = originalAr;
    for (const c of priorCorrections) {
        const amt = Number(c.amount || 0);
        const touchesAr = c.debitAccountId === arAccountId || c.creditAccountId === arAccountId;
        const touchesRevenue = c.debitAccountId === revenueAccountId || c.creditAccountId === revenueAccountId;
        if (!touchesAr || !touchesRevenue) {
            throw new Error(
                `STOP: prior correction ${c.referenceId} for invoice #${invoiceId} touches an unexpected account pair. Manual reconciliation required — no automatic correction posted.`
            );
        }
        // Reduction corrections credit AR; increase corrections debit AR.
        netPostedAr = roundToCurrency(netPostedAr + (c.debitAccountId === arAccountId ? amt : -amt));
    }
    const diff = roundToCurrency(Number(currentTotal || 0) - netPostedAr);
    if (Math.abs(diff) < 0.005) return null;
    const baseRef = postEditCorrectionBaseRef(invoiceId);
    const referenceId = priorCorrections.length === 0 ? baseRef : `${baseRef}-${priorCorrections.length + 1}`;
    if (diff < 0) {
        const amount = roundToCurrency(-diff);
        return {
            direction: 'reduction',
            amount,
            debitAccountId: revenueAccountId,
            creditAccountId: arAccountId,
            referenceId,
            description: `POST-EDIT CORRECTION: Invoice #${invoiceId} adjusted ${originalAr.toFixed(2)} -> ${Number(currentTotal || 0).toFixed(2)} (Δ -${amount.toFixed(2)})`,
            originalAr,
            netPostedAr,
            currentTotal: Number(currentTotal || 0),
        };
    }
    const amount = roundToCurrency(diff);
    return {
        direction: 'increase',
        amount,
        debitAccountId: arAccountId,
        creditAccountId: revenueAccountId,
        referenceId,
        description: `POST-EDIT CORRECTION: Invoice #${invoiceId} adjusted ${originalAr.toFixed(2)} -> ${Number(currentTotal || 0).toFixed(2)} (Δ +${amount.toFixed(2)})`,
        originalAr,
        netPostedAr,
        currentTotal: Number(currentTotal || 0),
    };
}

function sameInvoiceLines(a: any, b: any): boolean {
    const norm = (items: any) => (items || []).map((it: any) => [
        String(it?.id ?? it?.productId ?? it?.name ?? ''),
        Number(it?.quantity ?? it?.qty ?? 0),
        Number(it?.price ?? it?.unitPrice ?? it?.sellingPrice ?? 0),
    ].join('|')).sort().join(';');
    return norm(a) === norm(b);
}

export interface CogsLeg {
    /** Resolved ledger account id to credit (11410/11420/11430 child). */
    inventoryAccountId: string | null;
    /** Canonical code for reporting/fallback. */
    inventoryAccountCode: string;
    /** Rounded leg amount. */
    amount: number;
}

/**
 * Split invoice COGS across inventory accounts by line cost.
 *
 * Each stocked line is costed with resolveItemUnitCost (the authoritative
 * hierarchy: productionCostSnapshot → batch → FIFO → stored cost → variant)
 * and classified with resolveInventoryAccountByItemType. Service lines are
 * excluded (services never relieve inventory).
 *
 * This replaces majority-vote single-account posting so mixed invoices
 * relieve each 114xx account for its own share (DR 51200 = Σ CR 114xx).
 */
export const calculateCogsLegsPerInventoryAccount = async (
    items: any[],
    inventorySource: any,
    resolveId: (item: any) => string | undefined,
    accounts: any[],
    getFallbackInventoryAccountId: (() => string | null) | string | null,
    fallbackInventorySource?: any
): Promise<CogsLeg[]> => {
    const byAccount = new Map<string, { code: string; amount: number }>();
    for (const item of items || []) {
        const itemId = resolveId(item);
        if (!itemId) continue;
        const invItem = await resolveInventoryRecord(itemId, inventorySource, fallbackInventorySource);
        // Authoritative eligibility: only Raw Material / Stationery lines
        // relieve inventory. Product/Service lines carry no inventory value,
        // so they generate no COGS inventory-credit leg (their costs were
        // captured when raw materials were consumed in production). The line
        // type governs; when it is absent the stored record's type governs.
        const eligibilityProbe = item?.type ? item : invItem;
        if (!isInventoryBearingItem(eligibilityProbe)) continue;
        const unitCost = await resolveItemUnitCost(item, invItem);
        const qty = Number(item?.quantity || 0);
        if (!(qty > 0) || !(unitCost > 0)) continue;
        const lineCost = unitCost * qty;
        // Unknown/missing types keep the historical default bucket (11410),
        // matching resolveInventoryAccountByItemType's documented behavior.
        const resolvedId = resolveInventoryAccountByItemType(item?.type || (invItem as any)?.type, accounts)
            || resolveInventoryAccountByItemType('product', accounts);
        // Lazy fallback: only resolved when a line genuinely cannot be
        // classified (strict resolvers throw on broken COAs — never evaluate
        // that path for healthy account charts).
        const key = resolvedId || 'FALLBACK';
        const code = codeOfAccountId(resolvedId, accounts) || '11410';
        const prev = byAccount.get(key) || { code, amount: 0 };
        prev.amount += lineCost;
        byAccount.set(key, prev);
    }
    const legs: CogsLeg[] = [];
    let fallbackId: string | null | undefined;
    for (const [key, v] of byAccount) {
        const amount = roundToCurrency(v.amount);
        if (!(amount > 0)) continue;
        let accountId: string | null = key === 'FALLBACK' ? null : key;
        if (!accountId && key === 'FALLBACK') {
            if (fallbackId === undefined) {
                fallbackId = typeof getFallbackInventoryAccountId === 'function'
                    ? getFallbackInventoryAccountId()
                    : getFallbackInventoryAccountId;
            }
            accountId = fallbackId;
        }
        legs.push({
            inventoryAccountId: accountId,
            inventoryAccountCode: v.code,
            amount,
        });
    }
    return legs;
};

const codeOfAccountId = (id: string | null, accounts: any[]): string | null => {
    if (!id) return null;
    const found = (accounts || []).find((a: any) => a.id === id);
    return found ? String(found.code || found.account_number || '') : null;
};

export const validateLedgerBalance = (entries: LedgerEntry[], context: string) => {
    const debitAccountSums: Record<string, number> = {};
    const creditAccountSums: Record<string, number> = {};
    for (const entry of entries) {
        const amount = Number(entry.amount || 0);
        debitAccountSums[entry.debitAccountId] = (debitAccountSums[entry.debitAccountId] || 0) + amount;
        creditAccountSums[entry.creditAccountId] = (creditAccountSums[entry.creditAccountId] || 0) + amount;
    }
    const totalDebits = Object.values(debitAccountSums).reduce((s, v) => s + v, 0);
    const totalCredits = Object.values(creditAccountSums).reduce((s, v) => s + v, 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
        console.warn(`[LEDGER MISMATCH] ${context}: Debits ${totalDebits.toFixed(2)} !== Credits ${totalCredits.toFixed(2)} (diff: ${(totalDebits - totalCredits).toFixed(2)})`);
    }
};

export const distributePosRetainedAmounts = (
    payments: { method: string; amount: number; accountId?: string }[],
    totalAmount: number
): number[] => {
    const retained = payments.map(payment => toMoney(payment.amount));
    let remainingChange = Math.max(0, toMoney(payments.reduce((sum, payment) => sum + payment.amount, 0) - totalAmount));
    if (remainingChange <= 0) return retained;

    const cashIndexes = payments
        .map((payment, index) => ({ payment, index }))
        .filter(entry => entry.payment.method === 'Cash')
        .map(entry => entry.index);

    const deductionOrder = cashIndexes.length > 0
        ? cashIndexes
        : (payments.length > 0 ? [payments.length - 1] : []);

    const deductFromIndex = (index: number) => {
        if (remainingChange <= 0) return;
        const current = retained[index] || 0;
        if (current <= 0) return;
        const deduction = Math.min(current, remainingChange);
        retained[index] = toMoney(current - deduction);
        remainingChange = toMoney(remainingChange - deduction);
    };

    for (const index of deductionOrder) {
        deductFromIndex(index);
        if (remainingChange <= 0) break;
    }

    if (remainingChange > 0) {
        for (let index = retained.length - 1; index >= 0; index -= 1) {
            deductFromIndex(index);
            if (remainingChange <= 0) break;
        }
    }

    return retained.map(amount => Math.max(0, toMoney(amount)));
};

export interface JournalLineInput {
    debitAccountRef?: string;
    creditAccountRef?: string;
    amount: number;
    description: string;
    referenceId?: string;
    customerId?: string;
    customerName?: string;
    reconciled?: boolean;
    entryType?: string;
    date?: string;
}

export function buildResolvedJournalLine(
    input: JournalLineInput,
    accounts: any[],
    options: ResolveAccountOptions = {}
): Omit<LedgerEntry, 'id' | 'date'> | null {
    const resolvedDebit = resolveGLAccount(input.debitAccountRef, accounts, options);
    const resolvedCredit = resolveGLAccount(input.creditAccountRef, accounts, options);
    
    if (!resolvedDebit && !resolvedCredit) {
        logger.warn('[JOURNAL] Could not resolve either debit or credit account', {
            debitRef: input.debitAccountRef,
            creditRef: input.creditAccountRef
        });
        return null;
    }
    
    return {
        debitAccountId: resolvedDebit || input.debitAccountRef!,
        creditAccountId: resolvedCredit || input.creditAccountRef!,
        amount: input.amount,
        description: input.description,
        referenceId: input.referenceId,
        customerId: input.customerId,
        customerName: input.customerName,
        reconciled: input.reconciled || false,
        entryType: input.entryType,
    };
}

export function buildResolvedJournalLines(
    inputs: JournalLineInput[],
    accounts: any[],
    options: ResolveAccountOptions = {}
): Omit<LedgerEntry, 'id' | 'date'>[] {
    return inputs
        .map(input => buildResolvedJournalLine(input, accounts, options))
        .filter((line): line is Omit<LedgerEntry, 'id' | 'date'> => line !== null);
}

export function resolveInventoryAccountByItemType(
    itemType: string | undefined,
    accounts: any[]
): string | null {
    if (!itemType) return null;

    const normalizedType = String(itemType).toLowerCase();
    // Canonical mapping — must match resolveInventoryGLAccountCode in
    // utils/inventoryNormalization.ts so opening journals and COGS relieve
    // the SAME account. 'Product' (resale merchandise, including the UI's
    // Finished Good collapse) posts to 11410; only explicit finished-goods
    // types post to 11430. Never silently default: unknown types fall back
    // to 11410 only to preserve the historical default bucket.
    let targetCode = '11410'; // Default: Merchandise Inventory

    if (normalizedType === 'material' || normalizedType === 'raw material' || normalizedType === 'raw' || normalizedType === 'consumable') {
        targetCode = '11420'; // Raw Materials
    } else if (normalizedType === 'finished good' || normalizedType === 'finished goods') {
        targetCode = '11430'; // Finished Goods (distinct from Merchandise)
    } else if (normalizedType === 'product' || normalizedType === 'merchandise') {
        targetCode = '11410'; // Merchandise Inventory
    } else if (normalizedType === 'stationery' || normalizedType === 'stationaries') {
        targetCode = '11420'; // Stationery tracked with Raw Materials
    }
    
    const found = accounts.find(a =>
        a.code === targetCode ||
        a.account_number === targetCode ||
        a.id === targetCode
    );
    
    if (found && found.allow_posting !== false && found.allow_posting !== 0) {
        return found.id;
    }
    
    const postingChild = accounts.find(a =>
        (a.parent_account_id === found?.id || a.parent_account_id === found?.code || a.parent_account_id === found?.account_number) &&
        a.allow_posting !== false && a.allow_posting !== 0 &&
        a.is_active !== false && a.is_active !== 0
    );
    
    if (postingChild) return postingChild.id;
    return found?.id || null;
}

export function resolveInventoryAccountFromItems(
    items: any[],
    accounts: any[]
): string | null {
    if (!items || items.length === 0) return null;
    
    // Eligibility-first: only stock-bearing lines (Raw Material /
    // Stationery) may select an inventory account. Product/Service lines
    // must never pull a GRN/PO toward an inventory account.
    const eligibleItems = items.filter((i: any) => isInventoryBearingItem(i));
    if (eligibleItems.length === 0) return null;

    const nonServiceItems = eligibleItems.filter((i: any) => i.type !== 'Service');
    if (nonServiceItems.length === 0) return null;
    
    const typeCounts: Record<string, number> = {};
    for (const item of nonServiceItems) {
        const t = String(item.type || 'product').toLowerCase();
        typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
    return resolveInventoryAccountByItemType(dominantType, accounts);
}

export function computeHierarchicalBalances(
    accounts: any[],
    leafBalances: Record<string, number>,
    options: { respectNormalBalance?: boolean } = {}
): Record<string, number> {
    // Canonical implementation lives in accountingEngine (single source of
    // truth). This wrapper preserves the historical signature used across
    // the codebase. Rollup is DISPLAY-only: callers must use
    // computeTypeTotals()/computeOwnBalances() for aggregate totals so that
    // parent and child balances are never double-counted.
    //
    // NOTE: `leafBalances` are treated as OWN (pre-rollup) balances. The
    // engine resolves parent links across id/code/account_number, treats
    // dangling references as roots, and is immune to parent/child cycles.
    void options;
    return computeHierarchicalRollup(accounts ?? [], leafBalances ?? {});
}

/**
 * Diagnostic utility for inventory ↔ GL reconciliation.
 * Reports physical inventory valuation, GL inventory balance, and variance
 * broken down by inventory category (Merchandise, Raw Materials, Finished Goods).
 */
export function computeInventoryReconciliation(
    inventoryItems: any[],
    accounts: any[],
    ledgerEntries: any[]
): {
    physicalInventoryValue: number;
    glInventoryValue: number;
    variance: number;
    merchandiseValue: number;
    rawMaterialsValue: number;
    finishedGoodsValue: number;
    glMerchandiseValue: number;
    glRawMaterialsValue: number;
    glFinishedGoodsValue: number;
    unclassifiedItems: any[];
    negativeInventoryItems: any[];
    zeroCostItems: any[];
} {
    // Derive inventory child codes from glMapping where possible, falling back to canonical defaults.
    // The default config defines a single 'defaultInventoryAccount' (the parent), so we look up
    // its actual children in the accounts list. If a custom-mapped parent is configured, we use
    // its children; otherwise we use the canonical 11410/11420/11430.
    const gl = getGLConfig();
    const defaultParentCode = gl.defaultInventoryAccount || '11400';

    // Find children: any account whose parent_account_id matches the default parent
    const parentAccount = accounts.find(a =>
        a.code === defaultParentCode ||
        a.account_number === defaultParentCode ||
        a.id === defaultParentCode
    );
    const parentIdOrCode = parentAccount?.id || defaultParentCode;

    const dynamicChildren = accounts
        .filter(a => a.parent_account_id === parentIdOrCode || a.parent_account_id === defaultParentCode)
        .map(a => a.account_number || a.code || a.id);

    // Final list: dynamic children if any, otherwise canonical defaults
    const INVENTORY_CHILD_CODES = dynamicChildren.length > 0
        ? dynamicChildren
        : ['11410', '11420', '11430'];
    const PARENT_INVENTORY_CODE = defaultParentCode;

    // Calculate physical inventory valuation by category through the
    // canonical classifier (one cost rule, one GL mapping, every record
    // shape). Services/deleted/negative/zero-cost/unmapped items are
    // reported, never silently valued.
    let merchandiseValue = 0;
    let rawMaterialsValue = 0;
    let finishedGoodsValue = 0;
    let unclassifiedItems: any[] = [];
    let negativeInventoryItems: any[] = [];
    let zeroCostItems: any[] = [];

    for (const item of inventoryItems || []) {
        const classified = classifyInventoryItem(item);
        if (!classified.included) {
            if (classified.exclusionReason === 'NEGATIVE_STOCK') negativeInventoryItems.push(item);
            else if (classified.exclusionReason === 'ZERO_COST' || classified.exclusionReason === 'MISSING_COST') zeroCostItems.push(item);
            else if (classified.exclusionReason === 'UNMAPPED_TYPE') unclassifiedItems.push(item);
            continue;
        }
        if (classified.expectedAccount === '11430') finishedGoodsValue += classified.inventoryValue;
        else if (classified.expectedAccount === '11420') rawMaterialsValue += classified.inventoryValue;
        else merchandiseValue += classified.inventoryValue;
    }

    // Calculate GL balances for each inventory child account
    const getAccountCode = (acc: any): string => acc.account_number || acc.code || acc.id;

    const glBalances: Record<string, number> = {};
    for (const code of INVENTORY_CHILD_CODES) {
        const account = accounts.find(a => getAccountCode(a) === code);
        if (!account) { glBalances[code] = 0; continue; }

        const balance = ledgerEntries.reduce((s: number, e: any) => {
            if (!isPostedLedgerEntry(e)) return s;
            if (entryTouchesAccount(e, account, 'debit')) return s + e.amount;
            if (entryTouchesAccount(e, account, 'credit')) return s - e.amount;
            return s;
        }, 0);

        // Normal-positive presentation (explicit normal_balance wins, else
        // type-derived). See accountingEngine.getNormalBalance.
        glBalances[code] = getNormalBalance(account) === 'DEBIT' ? balance : -balance;
    }

    // Map first child to merchandise, second to raw materials, third to finished goods
    // (preserves canonical mapping while allowing custom hierarchies to be reflected)
    const merchandiseCode = INVENTORY_CHILD_CODES[0] || '11410';
    const rawMaterialsCode = INVENTORY_CHILD_CODES[1] || '11420';
    const finishedGoodsCode = INVENTORY_CHILD_CODES[2] || '11430';

    const glMerchandiseValue = glBalances[merchandiseCode] || 0;
    const glRawMaterialsValue = glBalances[rawMaterialsCode] || 0;
    const glFinishedGoodsValue = glBalances[finishedGoodsCode] || 0;
    const glInventoryValue = glMerchandiseValue + glRawMaterialsValue + glFinishedGoodsValue;
    const physicalInventoryValue = merchandiseValue + rawMaterialsValue + finishedGoodsValue;
    const variance = physicalInventoryValue - glInventoryValue;

    return {
        physicalInventoryValue,
        glInventoryValue,
        variance,
        merchandiseValue,
        rawMaterialsValue,
        finishedGoodsValue,
        glMerchandiseValue,
        glRawMaterialsValue,
        glFinishedGoodsValue,
        unclassifiedItems,
        negativeInventoryItems,
        zeroCostItems
    };
}
