import type { Account } from '../types';

/**
 * Canonical account-type checks (Phase 2 / A8).
 *
 * Accounts exist in two shapes:
 *  - canonical: `account_type: 'ASSET'|'LIABILITY'|'EQUITY'|'INCOME'|'EXPENSE'`
 *  - legacy:    `type: 'Asset'|'Liability'|'Equity'|'Revenue'|'Expense'` (any case)
 *
 * Every UI filter must check BOTH fields case-insensitively, otherwise live
 * accounts (INCOME) disappear from dropdowns that only test `type === 'Revenue'`.
 */
export const normalizeAccountType = (a: Partial<Account> | any): string =>
  String(a?.account_type ?? a?.type ?? '').trim().toUpperCase();

const matches = (a: Partial<Account> | any, ...wanted: string[]): boolean =>
  wanted.includes(normalizeAccountType(a));

export const isAssetAccount = (a: Partial<Account> | any): boolean =>
  matches(a, 'ASSET');

export const isLiabilityAccount = (a: Partial<Account> | any): boolean =>
  matches(a, 'LIABILITY');

export const isEquityAccount = (a: Partial<Account> | any): boolean =>
  matches(a, 'EQUITY');

export const isIncomeAccount = (a: Partial<Account> | any): boolean =>
  // 'REVENUE' is the legacy display name for INCOME (see DEFAULT_ACCOUNTS type:'Revenue').
  matches(a, 'INCOME', 'REVENUE');

export const isExpenseAccount = (a: Partial<Account> | any): boolean =>
  matches(a, 'EXPENSE');

export const isPostableAccount = (a: Partial<Account> | any): boolean =>
  a?.allow_posting !== false && a?.allow_posting !== 0;

export const isActiveAccount = (a: Partial<Account> | any): boolean =>
  a?.is_active !== false && a?.is_active !== 0;
