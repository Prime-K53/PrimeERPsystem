/**
 * inventoryAdjustmentAccounting.ts
 *
 * Semantic accounting for inventory stock adjustments.
 *
 * ROOT CAUSE (Sept 12 defect):
 *   transactionService.adjustStock() hardcoded `otherIncomeAccount = '42000'`
 *   and resolved it via the GENERIC resolveAccountForPosting() with
 *   allowNonPosting:false. Because 42000 Other Income is a NON-POSTING parent
 *   (allow_posting:false), the generic resolver silently returned its FIRST
 *   posting child — 42100 Interest Income (before 42200 in COA order).
 *   102 bulk Smart-Adjust ADD postings therefore credited ACC-42100 instead
 *   of an opening-equity or COGS account (K348,704,525 total).
 *
 *   The same parent-fallback path existed in syncInventoryValuation() and the
 *   LG-REC reconciliation writer, plus a `gl.otherIncomeAccount || '42100'`
 *   fallback in AuditorBridge.
 *
 * DESIGN (fail-closed, semantic):
 *   - Stock adjustments require an EXPLICIT accounting reason. No silent
 *     income fallback is permitted.
 *   - OPENING_BALANCE  -> DR Inventory (11410/11420/11430) / CR opening equity
 *                         (31000 Owner's Capital, fallback 32000 Retained
 *                         Earnings — same precedence as openingBalanceService).
 *   - OPERATIONAL_ADJUSTMENT / RECONCILIATION (gain, qty increase):
 *                         DR Inventory / CR COGS (51200). Symmetric with the
 *                         loss leg and with the endToEndAccounting test
 *                         convention. Never income.
 *   - OPERATIONAL_ADJUSTMENT / RECONCILIATION (loss, qty decrease):
 *                         DR COGS (51200) / CR Inventory.
 *   - 42100 Interest Income is NEVER a valid stock-adjustment account and is
 *     explicitly rejected, as is the non-posting 54000 and any inactive /
 *     non-posting / missing account. Unresolvable configuration throws
 *     instead of posting — callers must abort the inventory mutation.
 *
 * Single-company deployment: no tenant/organization scoping is introduced.
 */

import {
  resolveAccountForPosting,
  resolveInventoryAccountByItemType,
} from './transactions/_internal';

export type StockAdjustmentReason =
  | 'OPENING_BALANCE'
  | 'OPERATIONAL_ADJUSTMENT'
  | 'RECONCILIATION';

export const INVENTORY_ACCOUNT_CODES = ['11410', '11420', '11430'] as const;

/** Canonical Interest Income code — never valid for stock adjustments. */
export const INTEREST_INCOME_CODE = '42100';
/** Non-posting rounding/configuration account — never valid for posting. */
export const NON_POSTING_CONFIG_CODE = '54000';
/** Non-posting Other Income parent — must never be resolved via child fallback. */
export const OTHER_INCOME_PARENT_CODE = '42000';

export class StockAdjustmentAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockAdjustmentAccountingError';
  }
}

export interface ResolvedStockAdjustmentPosting {
  debitAccountId: string;
  creditAccountId: string;
  debitCode: string;
  creditCode: string;
  reason: StockAdjustmentReason;
}

function codeOf(account: any): string {
  return String(account?.account_number || account?.code || account?.id || '');
}

function findAccount(accounts: any[], ref: string): any | undefined {
  return (accounts || []).find(
    (a: any) => String(a.id) === String(ref) || codeOf(a) === String(ref)
  );
}

function assertPostingAccount(
  account: any,
  ref: string,
  role: string
): void {
  if (!account) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account not found: ${ref}. Posting aborted — no inventory change was journalised.`
    );
  }
  if (account.is_active === false || account.is_active === 0) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account ${codeOf(account)} (${account.name || account.id}) is inactive. Posting aborted.`
    );
  }
  if (account.allow_posting === false || account.allow_posting === 0) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account ${codeOf(account)} (${account.name || account.id}) does not allow posting. Posting aborted — configure a posting account.`
    );
  }
}

/**
 * Reject accounts that are semantically invalid for stock adjustments even
 * when they are active/posting (e.g. 42100 Interest Income, 54000 config).
 */
export function assertAccountSemanticallyValidForStockAdjustment(
  account: any,
  role: string
): void {
  const code = codeOf(account);
  if (code === INTEREST_INCOME_CODE) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account 42100 Interest Income is never valid for inventory adjustments. ` +
        `Opening inventory must credit opening equity (31000/32000); operational adjustments must use COGS (51200). Posting aborted.`
    );
  }
  if (code === NON_POSTING_CONFIG_CODE) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account 54000 is a non-posting configuration account and can never be used. Posting aborted.`
    );
  }
  // The 42000 parent itself must never appear as a resolved posting account.
  if (code === OTHER_INCOME_PARENT_CODE) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account 42000 Other Income is a non-posting summary and cannot be posted directly. ` +
        `Refusing silent child fallback (which previously selected 42100). Posting aborted.`
    );
  }
}

/**
 * Resolve the inventory debit/credit side for one stock movement.
 * Strict: unknown item types fall back to 11410 ONLY through the shared
 * resolveInventoryAccountByItemType() (historical default bucket), never to
 * an income/expense account.
 */
function resolveInventorySide(
  itemType: string | undefined,
  accounts: any[],
  glDefaultInventoryAccount: string | undefined,
  inventoryRole?: unknown
): { id: string; code: string } {
  const viaType = resolveInventoryAccountByItemType(itemType, accounts, inventoryRole);
  if (viaType) {
    const acc = findAccount(accounts, viaType);
    if (acc) {
      assertPostingAccount(acc, viaType, 'inventory');
      const code = codeOf(acc);
      if (!INVENTORY_ACCOUNT_CODES.includes(code as any)) {
        throw new StockAdjustmentAccountingError(
          `Resolved inventory account ${code} is not a valid inventory account (expected 11410/11420/11430). Posting aborted.`
        );
      }
      assertAccountSemanticallyValidForStockAdjustment(acc, 'inventory');
      return { id: String(acc.id), code };
    }
  }
  // Fallback: explicit GL default, but it must itself be a posting inventory account.
  const fallbackRef = glDefaultInventoryAccount || '11400';
  const resolved = resolveAccountForPosting(fallbackRef, accounts, {
    allowNonPosting: false,
  });
  if (!resolved) {
    throw new StockAdjustmentAccountingError(
      `Unable to resolve inventory account: ${fallbackRef}. Posting aborted.`
    );
  }
  const acc = findAccount(accounts, resolved);
  assertPostingAccount(acc, fallbackRef, 'inventory');
  const code = codeOf(acc);
  if (!INVENTORY_ACCOUNT_CODES.includes(code as any)) {
    throw new StockAdjustmentAccountingError(
      `Fallback inventory account ${code} is not a valid inventory account (expected 11410/11420/11430). Posting aborted.`
    );
  }
  assertAccountSemanticallyValidForStockAdjustment(acc, 'inventory');
  return { id: String(acc.id), code };
}

function resolveStrictPostingAccount(
  ref: string,
  accounts: any[],
  role: string
): { id: string; code: string } {
  // Strict: no parent->child fallback laundering. Resolve the exact account
  // and require it to be posting. A non-posting parent (42000, 11400, 52000…)
  // throws instead of silently returning an unrelated child (42100).
  const exact =
    (accounts || []).find(
      (a: any) =>
        String(a.id) === String(ref) ||
        String(a.code) === String(ref) ||
        String(a.account_number) === String(ref)
    ) || null;
  if (!exact) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment ${role} account not found: ${ref}. Posting aborted.`
    );
  }
  assertPostingAccount(exact, ref, role);
  assertAccountSemanticallyValidForStockAdjustment(exact, role);
  return { id: String(exact.id), code: codeOf(exact) };
}

/**
 * Central resolver for stock-adjustment journals.
 *
 * @throws StockAdjustmentAccountingError when any account is missing,
 * inactive, non-posting, or semantically invalid. Callers MUST treat a throw
 * as fail-closed: do not mutate inventory, do not write a ledger row.
 */
export function resolveStockAdjustmentPosting(args: {
  reason: StockAdjustmentReason;
  qtyChange: number;
  itemType?: string;
  inventoryRole?: unknown;
  accounts: any[];
  gl: {
    defaultInventoryAccount?: string;
    defaultCOGSAccount?: string;
    ownerCapitalAccount?: string;
    retainedEarningsAccount?: string;
  };
}): ResolvedStockAdjustmentPosting {
  const { reason, qtyChange, itemType, inventoryRole, accounts, gl } = args;
  if (!reason || !['OPENING_BALANCE', 'OPERATIONAL_ADJUSTMENT', 'RECONCILIATION'].includes(reason)) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment requires an explicit accounting reason (OPENING_BALANCE | OPERATIONAL_ADJUSTMENT | RECONCILIATION). Posting aborted.`
    );
  }
  if (!Number.isFinite(qtyChange) || qtyChange === 0) {
    throw new StockAdjustmentAccountingError(
      `Stock adjustment quantity must be non-zero. Posting aborted.`
    );
  }

  const inventory = resolveInventorySide(
    itemType,
    accounts,
    gl.defaultInventoryAccount,
    inventoryRole
  );

  if (reason === 'OPENING_BALANCE') {
    // Canonical opening-equity precedence (mirrors openingBalanceService):
    // ownerCapitalAccount -> retainedEarningsAccount -> '32000'.
    const equityRef =
      gl.ownerCapitalAccount || gl.retainedEarningsAccount || '32000';
    const equity = resolveStrictPostingAccount(equityRef, accounts, 'opening-equity');
    const equityType = String(equity && findAccount(accounts, equity.id)?.account_type || '').toUpperCase();
    if (equityType && equityType !== 'EQUITY') {
      throw new StockAdjustmentAccountingError(
        `Opening-equity account ${equity.code} must be an EQUITY account (31000/32000), found type ${equityType}. Posting aborted.`
      );
    }
    return {
      debitAccountId: inventory.id,
      creditAccountId: equity.id,
      debitCode: inventory.code,
      creditCode: equity.code,
      reason,
    };
  }

  // OPERATIONAL_ADJUSTMENT / RECONCILIATION: symmetric COGS treatment.
  // Gain (qty up):   DR Inventory / CR COGS. Loss (qty down): DR COGS / CR Inventory.
  const cogsRef = gl.defaultCOGSAccount || '51200';
  const cogs = resolveStrictPostingAccount(cogsRef, accounts, 'cogs');
  const cogsType = String(findAccount(accounts, cogs.id)?.account_type || '').toUpperCase();
  if (cogsType && cogsType !== 'EXPENSE') {
    throw new StockAdjustmentAccountingError(
      `COGS account ${cogs.code} must be an EXPENSE account (51200), found type ${cogsType}. Posting aborted.`
    );
  }

  if (qtyChange > 0) {
    return {
      debitAccountId: inventory.id,
      creditAccountId: cogs.id,
      debitCode: inventory.code,
      creditCode: cogs.code,
      reason,
    };
  }
  return {
    debitAccountId: cogs.id,
    creditAccountId: inventory.id,
    debitCode: cogs.code,
    creditCode: inventory.code,
    reason,
  };
}

/**
 * Read-only guard for ad-hoc journals (e.g. AuditorBridge drift fix):
 * reject any journal that would silently credit Interest Income for an
 * inventory movement. Throws on violation.
 */
export function assertNoInterestIncomeForInventoryMovement(args: {
  debitAccountId: string;
  creditAccountId: string;
  accounts: any[];
  context: string;
}): void {
  const credit = findAccount(args.accounts, args.creditAccountId);
  const debit = findAccount(args.accounts, args.debitAccountId);
  for (const [acc, side] of [[credit, 'credit'], [debit, 'debit']] as const) {
    if (acc && codeOf(acc) === INTEREST_INCOME_CODE) {
      throw new StockAdjustmentAccountingError(
        `${args.context}: account 42100 Interest Income must never be used for inventory movements. ` +
          `Use opening equity (31000/32000) for opening balances or COGS (51200) for operational adjustments.`
      );
    }
  }
}
