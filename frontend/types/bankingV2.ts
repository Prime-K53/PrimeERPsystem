/**
 * Banking module extended types.
 *
 * These extend the existing banking.ts surface with the fields needed for
 * production-quality accounting integration:
 *   - explicit draft/posted/reversed lifecycle
 *   - GL journal linkage
 *   - cheque workflow (when underlying accounting can safely support it)
 *   - reconciliation status fields
 *
 * The existing BankTransaction interface in `types/banking.ts` is preserved
 * for backward compatibility; new code uses these types.
 */

import { BankTransaction as LegacyBankTransaction, BankAccount as LegacyBankAccount } from './banking';

export type BankTxnStatus = 'Draft' | 'Posted' | 'Reversed';

export interface BankTransactionV2 extends LegacyBankTransaction {
  status: BankTxnStatus;
  postedAt?: string;
  postedBy?: string;
  reversedAt?: string;
  reversedBy?: string;
  reversalOfId?: string;
  reversalLedgerId?: string;
  /** Canonical 5-digit COA id mapped to the bank-account side. */
  bankCOAId?: string;
  /** The COA account that should be debited/credited on the counterparty side. */
  counterpartyCOAId?: string;
  /** Expense account override (Spend Money, Bank Charge, etc.) */
  expenseAccountId?: string;
  /** Income account override (Receive Money, Bank Interest, etc.) */
  incomeAccountId?: string;
  /** Source linking — where did this transaction originate? */
  sourceModule?: 'Sales' | 'Purchases' | 'Payroll' | 'Loans' | 'FixedAssets' | 'OwnerEquity' | 'Transfer' | 'Manual';
  sourceId?: string;
  sourceReference?: string;
  /** Cheque workflow */
  cheque?: {
    number?: string;
    issueDate?: string;
    payee?: string;
    status?: 'Draft' | 'Issued' | 'Presented' | 'Cleared' | 'Cancelled' | 'Bounced';
    clearedDate?: string;
  };
}

export interface BankAccountV2 extends LegacyBankAccount {
  /** Canonical 5-digit COA id for this account (e.g. 11210, 11110). */
  coaId?: string;
  /** Account type semantic for the banking module. */
  bankAccountType?: 'Current' | 'Savings' | 'Business' | 'Cash' | 'PettyCash' | 'MobileMoney' | 'Other';
  /** Branch information. */
  branch?: string;
  /** Notes field for internal context. */
  notes?: string;
  /** Opening balance in account currency. */
  openingBalance?: number;
  /** Opening balance date (ISO yyyy-mm-dd). */
  openingBalanceDate?: string;
  /** Last successful reconciliation id. */
  lastReconciliationId?: string;
  /** Last successful reconciliation date. */
  lastReconciliationDate?: string;
}

export type ReconciliationStatus = 'Draft' | 'InProgress' | 'Completed' | 'Cancelled';

export interface ReconciliationV2 {
  id: string;
  bankAccountId: string;
  startDate: string;
  endDate: string;
  statementEndingBalance: number;
  bookBalance: number;
  clearedBalance: number;
  unclearedBalance: number;
  difference: number;
  status: ReconciliationStatus;
  clearedTransactionIds: string[];
  adjustments: Array<{
    id: string;
    date: string;
    amount: number;
    type: 'BankCharge' | 'Interest' | 'DirectDebit' | 'DirectDeposit' | 'ErrorCorrection';
    description: string;
    ledgerEntryId?: string;
  }>;
  createdBy?: string;
  createdAt: string;
  completedBy?: string;
  completedAt?: string;
  notes?: string;
}

export const ACCOUNT_TYPE_LABELS: Record<NonNullable<BankAccountV2['bankAccountType']>, string> = {
  Current: 'Current Account',
  Savings: 'Savings Account',
  Business: 'Business Account',
  Cash: 'Cash Drawer',
  PettyCash: 'Petty Cash',
  MobileMoney: 'Mobile Money',
  Other: 'Other',
};
