import { dbService } from './db';
import { getGLConfig, getCompanyConfig, generateId, resolveAccountForPosting, loadAccountsFromStore } from './transactions/_internal';
import { LedgerEntry } from '../types';
import { roundToCurrency } from '../utils/helpers';
import { normalizeInventoryItems } from '../utils/inventoryNormalization';
import {
  classifyInventoryItem,
  resolveInventoryCostPerUnit,
  resolveInventoryGLAccountCode,
  resolveInventoryQuantity,
} from '../utils/inventoryNormalization';
import { entryTouchesAccount, getNormalBalance, isPostedLedgerEntry } from './accountingEngine';

export interface OpeningInventoryResult {
  success: boolean;
  entriesPosted: number;
  alreadyOpened: boolean;
  journalId: string;
  details: OpeningInventoryDetail[];
  totalDebit: number;
  totalCredit: number;
  variance: number;
  /** Set when an opening exists but no longer matches current valuation. */
  requiresReconciliation?: boolean;
  /** Machine-readable state for the requires-reconciliation case. */
  code?: string;
  /** Reversal entries posted by a forceRebuild (audit trail, never deletions). */
  reversedEntries?: number;
  /** True when this run replaced a stale opening through reversal + repost. */
  rebuilt?: boolean;
  /** Current expected valuation vs active opening (informational). */
  expectedValue?: number;
  openingValue?: number;
  difference?: number;
}

export interface OpeningInventoryPreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: number;
  creditAccountId: string;
  creditAccountCode: string;
  creditAccountName: string;
  itemCount: number;
}

export interface OpeningInventoryPreview {
  lines: OpeningInventoryPreviewLine[];
  totalDebit: number;
  totalCredit: number;
  difference: number;
  offsetAccountId: string;
  offsetAccountCode: string;
  excluded: Record<string, number>;
  eligibleItemCount: number;
}

export interface OpeningInventoryDetail {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: number;
  creditAmount: number;
  itemCount: number;
  physicalValue: number;
}

export interface OpeningInventoryDiagnostic {
  physicalInventoryValue: number;
  glInventoryValue: number;
  variance: number;
  merchandiseValue: number;
  rawMaterialsValue: number;
  finishedGoodsValue: number;
  unclassifiedItems: any[];
  negativeInventoryItems: any[];
  zeroCostItems: any[];
  missingAccountMapping: any[];
  duplicateItems: any[];
  openingEntriesExist: boolean;
}

const OPENING_INVENTORY_REFERENCE = 'OPENING-INVENTORY';
/** Returned when an opening exists but no longer matches current valuation. */
export const OPENING_INVENTORY_REQUIRES_RECONCILIATION = 'OPENING_INVENTORY_REQUIRES_RECONCILIATION';
/** Entry/reference markers for reversal-based replacement (audit trail, never deletions). */
const OPENING_REVERSAL_ENTRY_TYPE = 'opening_inventory_reversal';
const OPENING_REVERSAL_REFERENCE_TYPE = 'opening_inventory_reversal';
/** Tolerance when comparing expected valuation against the active opening. */
const OPENING_STALENESS_TOLERANCE = 0.01;
// Canonical default inventory child codes. The diagnostic function below
// prefers children derived from glMapping (if a custom inventory account is
// configured), otherwise falls back to these defaults.
const DEFAULT_INVENTORY_CHILD_CODES = ['11410', '11420', '11430'];

export async function computeOpeningInventoryDiagnostic(
  inventoryItems: any[],
  accounts: any[],
  ledgerEntries: any[]
): Promise<OpeningInventoryDiagnostic> {
  const normalizedItems = normalizeInventoryItems(inventoryItems);

  let merchandiseValue = 0;
  let rawMaterialsValue = 0;
  let finishedGoodsValue = 0;
  let unclassifiedItems: any[] = [];
  let negativeInventoryItems: any[] = [];
  let zeroCostItems: any[] = [];
  let missingAccountMapping: any[] = [];

  for (const item of normalizedItems) {
    // Services never carry inventory value.
    if (String(item.type || '').toLowerCase().includes('service')) continue;
    const stock = resolveInventoryQuantity(item);
    const cost = resolveInventoryCostPerUnit(item);
    const value = roundToCurrency(stock * cost);

    if (stock < 0) negativeInventoryItems.push(item);
    if (cost <= 0 && stock > 0) zeroCostItems.push(item);

    // Canonical GL mapping (shared with opening posting and COGS relief).
    const accountCode = resolveInventoryGLAccountCode(item);
    if (!accountCode) {
      missingAccountMapping.push(item);
      unclassifiedItems.push(item);
      continue;
    }

    if (accountCode === '11430') {
      finishedGoodsValue += value;
    } else if (accountCode === '11420') {
      rawMaterialsValue += value;
    } else {
      merchandiseValue += value;
    }
  }

  const physicalInventoryValue = merchandiseValue + rawMaterialsValue + finishedGoodsValue;

  const glBalances: Record<string, number> = {};
  // Resolve the inventory child codes from glMapping + accounts, falling back to defaults
  const gl = getCompanyConfig();
  const defaultParentCode = gl?.glMapping?.defaultInventoryAccount || '11400';
  const parentAccount = accounts.find(a =>
    a.code === defaultParentCode || a.account_number === defaultParentCode || a.id === defaultParentCode
  );
  const parentIdOrCode = parentAccount?.id || defaultParentCode;
  const dynamicChildren = accounts
    .filter(a => a.parent_account_id === parentIdOrCode || a.parent_account_id === defaultParentCode)
    .map(a => a.account_number || a.code || a.id);
  const inventoryChildCodes = dynamicChildren.length > 0 ? dynamicChildren : DEFAULT_INVENTORY_CHILD_CODES;

  for (const code of inventoryChildCodes) {
    const account = accounts.find(a => a.account_number === code || a.code === code);
    if (!account) { glBalances[code] = 0; continue; }
    const balance = ledgerEntries.reduce((s: number, e: any) => {
      if (!isPostedLedgerEntry(e)) return s;
      if (entryTouchesAccount(e, account, 'debit')) return s + e.amount;
      if (entryTouchesAccount(e, account, 'credit')) return s - e.amount;
      return s;
    }, 0);
    // Normal-positive presentation: explicit normal_balance wins, otherwise
    // derived from account type (Asset/Expense are debit-normal). A strict
    // `normal_balance === 'DEBIT'` check would invert every canonical account
    // because the chart stores the type as the source of truth.
    glBalances[code] = getNormalBalance(account) === 'DEBIT' ? balance : -balance;
  }

  const glInventoryValue = inventoryChildCodes.reduce((s, code) => s + (glBalances[code] || 0), 0);

  const openingEntriesExist = ledgerEntries.some(
    (e: any) => e.referenceId === OPENING_INVENTORY_REFERENCE || e.entryType === 'opening_inventory'
  );

  return {
    physicalInventoryValue: roundToCurrency(physicalInventoryValue),
    glInventoryValue: roundToCurrency(glInventoryValue),
    variance: roundToCurrency(physicalInventoryValue - glInventoryValue),
    merchandiseValue: roundToCurrency(merchandiseValue),
    rawMaterialsValue: roundToCurrency(rawMaterialsValue),
    finishedGoodsValue: roundToCurrency(finishedGoodsValue),
    unclassifiedItems,
    negativeInventoryItems,
    zeroCostItems,
    missingAccountMapping,
    duplicateItems: [],
    openingEntriesExist,
  };
}

/** True for opening-inventory posting lines (originals and reposts). */
export function isOpeningInventoryLine(entry: Partial<LedgerEntry> | null | undefined): boolean {
  if (!entry) return false;
  return (
    (entry as LedgerEntry).referenceId === OPENING_INVENTORY_REFERENCE &&
    (entry as LedgerEntry).entryType === 'opening_inventory'
  );
}

/** True for reversal lines that supersede opening-inventory postings. */
export function isOpeningInventoryReversal(entry: Partial<LedgerEntry> | null | undefined): boolean {
  if (!entry) return false;
  const e = entry as LedgerEntry;
  return (
    e.referenceId === OPENING_INVENTORY_REFERENCE &&
    (e.entryType === OPENING_REVERSAL_ENTRY_TYPE || e.referenceType === OPENING_REVERSAL_REFERENCE_TYPE)
  );
}

/**
 * Active (unreversed, posted) opening-inventory lines. Reversal-based
 * replacement nets originals to zero; this set drives staleness checks so a
 * superseded opening is never mistaken for the current one.
 */
export function getActiveOpeningLines(allEntries: Array<Partial<LedgerEntry>>): LedgerEntry[] {
  const reversedIds = new Set<string>();
  for (const e of allEntries || []) {
    if (isOpeningInventoryReversal(e) && isPostedLedgerEntry(e)) {
      const target = String((e as any).reversesEntryId || '').trim();
      if (target) reversedIds.add(target);
    }
  }
  return (allEntries || []).filter(
    (e): e is LedgerEntry =>
      isOpeningInventoryLine(e) && isPostedLedgerEntry(e) && !reversedIds.has(String((e as LedgerEntry).id || ''))
  );
}

interface OpeningInventoryPlan {
  debitEntries: { accountId: string; amount: number; accountCode: string; accountName: string; count: number }[];
  totalDebit: number;
  totalCredit: number;
  details: OpeningInventoryDetail[];
  excluded: Record<string, number>;
  eligibleItemCount: number;
  offsetAccountCode: string;
}

/**
 * The SINGLE valuation calculation shared by preview and posting (Phase 7:
 * never two independent algorithms). Pure apart from account lookups.
 */
export function buildOpeningInventoryPlan(
  rawInventory: any[],
  accounts: any[],
  openingEquityAccount: string
): OpeningInventoryPlan {
  const normalizedInventory = normalizeInventoryItems(rawInventory || []);
  const childBalances: Record<string, { value: number; count: number }> = {};
  const excluded: Record<string, number> = {};
  let eligibleItemCount = 0;

  for (const item of normalizedInventory) {
    const classified = classifyInventoryItem(item);
    if (!classified.included) {
      const reason = classified.exclusionReason || 'other';
      excluded[reason] = (excluded[reason] || 0) + 1;
      continue;
    }
    eligibleItemCount += 1;
    const accountCode = classified.expectedAccount as string;
    const account = accounts.find((a: any) => a.account_number === accountCode || a.code === accountCode);
    if (!account || account.allow_posting === false) {
      excluded['NON_POSTING_ACCOUNT'] = (excluded['NON_POSTING_ACCOUNT'] || 0) + 1;
      continue;
    }
    const childId = String(account.id);
    if (!childBalances[childId]) childBalances[childId] = { value: 0, count: 0 };
    childBalances[childId].value += classified.inventoryValue;
    childBalances[childId].count += 1;
  }

  const debitEntries: OpeningInventoryPlan['debitEntries'] = [];
  let totalDebit = 0;
  for (const [childAccountId, data] of Object.entries(childBalances)) {
    const account = accounts.find((a: any) => String(a.id) === childAccountId);
    if (!account || account.allow_posting === false) continue;
    const amount = roundToCurrency(data.value);
    if (amount <= 0) continue;
    debitEntries.push({
      accountId: childAccountId,
      amount,
      accountCode: account.account_number || account.code || childAccountId,
      accountName: account.name,
      count: data.count,
    });
    totalDebit = roundToCurrency(totalDebit + amount);
  }

  return {
    debitEntries,
    totalDebit: roundToCurrency(totalDebit),
    totalCredit: roundToCurrency(totalDebit),
    details: debitEntries.map((d) => ({
      accountId: d.accountId,
      accountCode: d.accountCode,
      accountName: d.accountName,
      debitAmount: d.amount,
      creditAmount: 0,
      itemCount: d.count,
      physicalValue: d.amount,
    })),
    excluded,
    eligibleItemCount,
    offsetAccountCode: openingEquityAccount,
  };
}

/**
 * Writes one balanced opening journal for a prebuilt plan. Posting-only
 * helper used by openInventory (initial post and post-reversal repost).
 */
async function postOpeningPlan(
  ledgerStore: any,
  idempotencyStore: any,
  plan: OpeningInventoryPlan,
  resolveAcct: (ref: string | undefined) => string,
  reason: string,
  supersedesJournalId: string | null
): Promise<{ entriesPosted: number; journalId: string; details: OpeningInventoryDetail[]; totalDebit: number; totalCredit: number }> {
  if (plan.debitEntries.length === 0 || plan.totalDebit <= 0) {
    return { entriesPosted: 0, journalId: '', details: [], totalDebit: 0, totalCredit: 0 };
  }
  const creditAccountId = resolveAcct(plan.offsetAccountCode);
  const journalId = generateId('INV-OPEN');
  const now = new Date().toISOString();
  const entries: LedgerEntry[] = plan.debitEntries.map((debit) => ({
    id: generateId('LG-INV'),
    date: now,
    description:
      `Opening Inventory: ${debit.accountName} (${debit.count} items)` +
      (reason ? ` — ${reason}` : '') +
      (supersedesJournalId ? ` (supersedes ${supersedesJournalId})` : ''),
    debitAccountId: debit.accountId,
    creditAccountId,
    amount: debit.amount,
    referenceId: OPENING_INVENTORY_REFERENCE,
    referenceType: 'opening_inventory',
    entryType: 'opening_inventory',
    journalId,
    supersedesJournalId: supersedesJournalId || undefined,
    reconciled: false,
  }));
  for (const entry of entries) {
    await ledgerStore.put(entry);
  }
  await idempotencyStore.put({
    id: generateId('IK-INV'),
    scope: 'opening_inventory',
    sourceId: journalId,
    createdAt: now,
  });
  return {
    entriesPosted: entries.length,
    journalId,
    details: plan.details,
    totalDebit: plan.totalDebit,
    totalCredit: plan.totalCredit,
  };
}

/**
 * Read-only preview of the exact journal openInventory() would post
 * (Phase 7). Shares buildOpeningInventoryPlan with posting, so preview and
 * execution can never diverge. NEVER writes.
 */
export async function previewOpeningInventory(): Promise<OpeningInventoryPreview> {
  const [inventory, accounts] = await Promise.all([
    dbService.getAll<any>('inventory'),
    dbService.getAll<any>('accounts'),
  ]);
  const gl = getGLConfig();
  const openingEquityAccount = gl.ownerCapitalAccount || gl.retainedEarningsAccount || '32000';
  const plan = buildOpeningInventoryPlan(inventory, accounts, openingEquityAccount);
  const offsetAccount =
    accounts.find((a: any) => a.account_number === openingEquityAccount || a.code === openingEquityAccount || a.id === openingEquityAccount) || null;
  return {
    lines: plan.debitEntries.map((d) => ({
      accountId: d.accountId,
      accountCode: d.accountCode,
      accountName: d.accountName,
      debitAmount: d.amount,
      creditAccountId: String(offsetAccount?.id || openingEquityAccount),
      creditAccountCode: String(offsetAccount?.account_number || offsetAccount?.code || openingEquityAccount),
      creditAccountName: String(offsetAccount?.name || openingEquityAccount),
      itemCount: d.count,
    })),
    totalDebit: plan.totalDebit,
    totalCredit: plan.totalCredit,
    difference: roundToCurrency(plan.totalDebit - plan.totalCredit),
    offsetAccountId: String(offsetAccount?.id || openingEquityAccount),
    offsetAccountCode: String(offsetAccount?.account_number || offsetAccount?.code || openingEquityAccount),
    excluded: plan.excluded,
    eligibleItemCount: plan.eligibleItemCount,
  };
}

export async function openInventory(
  options: { forceRebuild?: boolean; reason?: string } = {}
): Promise<OpeningInventoryResult> {
  return dbService.executeAtomicOperation(
    ['ledger', 'accounts', 'inventory', 'idempotencyKeys'],
    async (tx) => {
      const ledgerStore = tx.objectStore('ledger');
      const inventoryStore = tx.objectStore('inventory');
      const idempotencyStore = tx.objectStore('idempotencyKeys');

      const accounts = await loadAccountsFromStore(tx);
      const companyConfig = getCompanyConfig();
      const companyId = companyConfig?.companyId;
      const accountOptions = { allowNonPosting: false, companyId };
      const resolveAcct = (ref: string | undefined) => {
        if (!ref) throw new Error('Account reference is undefined');
        const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
        if (!resolved) throw new Error(`Unable to resolve account: ${ref}`);
        return resolved;
      };

      const gl = getGLConfig();
      const openingEquityAccount = gl.ownerCapitalAccount || gl.retainedEarningsAccount || '32000';

      const allEntries = await ledgerStore.getAll();
      const activeOpenings = getActiveOpeningLines(allEntries);

      // Build the posting plan from CURRENT inventory through the single
      // canonical calculation (previewOpeningInventory uses this same plan).
      const inventory = await inventoryStore.getAll();
      const plan = buildOpeningInventoryPlan(inventory, accounts, openingEquityAccount);

      if (activeOpenings.length > 0 && !options.forceRebuild) {
        const openingValue = roundToCurrency(
          activeOpenings.reduce((s: number, e: LedgerEntry) => s + (Number(e.amount) || 0), 0)
        );
        const difference = roundToCurrency(plan.totalDebit - openingValue);
        if (Math.abs(difference) <= OPENING_STALENESS_TOLERANCE) {
          return {
            success: true,
            entriesPosted: 0,
            alreadyOpened: true,
            journalId: activeOpenings[0].journalId || activeOpenings[0].id,
            details: [],
            totalDebit: 0,
            totalCredit: 0,
            variance: 0,
            expectedValue: plan.totalDebit,
            openingValue,
            difference: 0,
          };
        }
        // An opening exists but no longer matches current valuation.
        // NEVER silently rebuild or silently skip: report explicitly so the
        // operator chooses the approved correction/reversal workflow.
        return {
          success: false,
          entriesPosted: 0,
          alreadyOpened: false,
          requiresReconciliation: true,
          code: OPENING_INVENTORY_REQUIRES_RECONCILIATION,
          journalId: activeOpenings[0].journalId || activeOpenings[0].id,
          details: plan.details,
          totalDebit: plan.totalDebit,
          totalCredit: plan.totalCredit,
          variance: difference,
          expectedValue: plan.totalDebit,
          openingValue,
          difference,
        };
      }

      if (activeOpenings.length > 0 && options.forceRebuild) {
        // Reversal-based replacement: originals stay in history; offsetting
        // reversal lines net them to zero exactly once; fresh lines follow.
        // Everything happens inside this same atomic transaction.
        const reversalJournalId = generateId('INV-OPEN-REV');
        const now = new Date().toISOString();
        const reason = (options.reason || 'opening rebuild').trim() || 'opening rebuild';
        const reversals: LedgerEntry[] = [];
        for (const original of activeOpenings) {
          reversals.push({
            id: generateId('LG-INV-REV'),
            date: now,
            description: `REVERSAL: ${original.description || 'Opening Inventory'} — ${reason} (reverses ${original.id})`,
            debitAccountId: original.creditAccountId,
            creditAccountId: original.debitAccountId,
            amount: original.amount,
            referenceId: OPENING_INVENTORY_REFERENCE,
            referenceType: OPENING_REVERSAL_REFERENCE_TYPE,
            entryType: OPENING_REVERSAL_ENTRY_TYPE,
            journalId: reversalJournalId,
            reversesEntryId: original.id,
            reversedJournalId: original.journalId || original.id,
            reconciled: false,
          });
        }
        for (const reversal of reversals) {
          await ledgerStore.put(reversal);
        }

        const posted = await postOpeningPlan(
          ledgerStore, idempotencyStore, plan, resolveAcct, reason, reversalJournalId
        );
        return {
          success: true,
          entriesPosted: reversals.length + posted.entriesPosted,
          alreadyOpened: false,
          rebuilt: true,
          reversedEntries: reversals.length,
          journalId: posted.journalId || reversalJournalId,
          details: posted.details,
          totalDebit: posted.totalDebit,
          totalCredit: posted.totalCredit,
          variance: 0,
          expectedValue: plan.totalDebit,
          openingValue: roundToCurrency(
            activeOpenings.reduce((s: number, e: LedgerEntry) => s + (Number(e.amount) || 0), 0)
          ),
          difference: 0,
        };
      }

      if (plan.totalDebit <= 0) {
        return {
          success: true,
          entriesPosted: 0,
          alreadyOpened: false,
          journalId: '',
          details: [],
          totalDebit: 0,
          totalCredit: 0,
          variance: 0,
          expectedValue: 0,
          openingValue: 0,
          difference: 0,
        };
      }

      const posted = await postOpeningPlan(
        ledgerStore, idempotencyStore, plan, resolveAcct, (options.reason || '').trim(), null
      );
      return {
        success: true,
        entriesPosted: posted.entriesPosted,
        alreadyOpened: false,
        journalId: posted.journalId,
        details: posted.details,
        totalDebit: posted.totalDebit,
        totalCredit: posted.totalCredit,
        variance: 0,
        expectedValue: plan.totalDebit,
        openingValue: 0,
        difference: plan.totalDebit,
      };
    }
  );
}

export async function getOpeningInventoryStatus(): Promise<{
  opened: boolean;
  journalId?: string;
  date?: string;
  totalDebit?: number;
  totalCredit?: number;
  /** Distinct journals backing the ACTIVE opening (duplicates if > 1). */
  activeJournalIds?: string[];
  /** Net active opening value (posted originals minus posted reversals). */
  activeDebitTotal?: number;
  /** Posted reversal lines superseding prior openings. */
  reversedCount?: number;
  /** Draft/voided opening-shaped rows (never counted as posted). */
  draftCount?: number;
  voidedCount?: number;
  /** Current expected valuation from the subledger (informational). */
  expectedValue?: number;
  difference?: number;
  /** True when an opening exists but no longer matches current valuation. */
  requiresReconciliation?: boolean;
}> {
  const [ledger, inventory] = await Promise.all([
    dbService.getAll<LedgerEntry>('ledger'),
    dbService.getAll<any>('inventory').catch(() => [] as any[]),
  ]);
  const refLines = ledger.filter(
    (e: LedgerEntry) => e.referenceId === OPENING_INVENTORY_REFERENCE
  );
  if (refLines.length === 0) {
    return { opened: false };
  }
  const postedReversals = refLines.filter((e) => isOpeningInventoryReversal(e) && isPostedLedgerEntry(e));
  const active = getActiveOpeningLines(ledger);
  const firstActive = active[0] || refLines.find((e) => isPostedLedgerEntry(e) && isOpeningInventoryLine(e));
  const activeJournalIds = [...new Set(active.map((e) => String(e.journalId || e.id)))];
  const activeDebitTotal = roundToCurrency(active.reduce((s, e) => s + (Number(e.amount) || 0), 0));

  let expectedValue = 0;
  try {
    const normalized = normalizeInventoryItems(inventory || []);
    for (const item of normalized) {
      const classified = classifyInventoryItem(item);
      if (classified.included) expectedValue = roundToCurrency(expectedValue + classified.inventoryValue);
    }
  } catch {
    expectedValue = 0;
  }
  const difference = roundToCurrency(expectedValue - activeDebitTotal);
  const requiresReconciliation =
    active.length > 0 && Math.abs(difference) > OPENING_STALENESS_TOLERANCE;

  return {
    opened: active.length > 0,
    journalId: firstActive?.journalId || firstActive?.id,
    date: firstActive?.date,
    totalDebit: activeDebitTotal,
    totalCredit: activeDebitTotal,
    activeJournalIds,
    activeDebitTotal,
    reversedCount: postedReversals.length,
    draftCount: refLines.filter((e) => !isPostedLedgerEntry(e) && String((e as any).status || '').toUpperCase() === 'DRAFT').length,
    voidedCount: refLines.filter(
      (e) => !isPostedLedgerEntry(e) && ['VOID', 'VOIDED', 'DELETED', 'CANCELLED'].includes(String((e as any).status || '').toUpperCase())
    ).length,
    expectedValue,
    difference,
    requiresReconciliation,
  };
}
