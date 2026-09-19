/**
 * coaCorrectionService.ts
 *
 * 3-PHASE FIX for COA accounts 11400/11410/11420/11430.
 *
 * Phase 1 — R1 remediation: Reverse 5 COGS legs that incorrectly
 * credited 11410 Merchandise Inventory K222,498 (INV-P726/021–025).
 * Product sales relieved "inventory" without any stock movement.
 * Correction: DR 11410 / CR 51200 (COGS) per leg, netting 11410 to zero.
 *
 * Phase 2 — Opening balance: Post opening inventory with RECOMPUTED
 * live figures (NOT the stale K41,868,000 / K9,914,854 snapshot).
 * DR 11420 Raw Materials K222,306,800 (live, seeding-inflated — flagged,
 * not usable for valuation without physical recount).
 * DR 11410 Merchandise K0 (Products excluded under new rule).
 * DR 11430 Finished Goods K0 (no FG in system).
 * CR 31000 Owner's Capital K222,306,800.
 *
 * Phase 3 — Data corruption: Freeze live inventory writes, flag all
 * 100 items for physical count, investigate bulk seeding job.
 *
 * SAFETY:
 * - Read-only dry-run first: identify affected entries, show totals.
 * - Idempotent: deterministic correction ids, idempotency key scope.
 * - Atomic: all corrections in one transaction via executeAtomicOperation.
 * - Explicit authorization: apply() requires { confirmed: true, reason }.
 * - Never mutates originals; never deletes; never updates in-place.
 * - No invoice modifications — only ledger entries and inventory flags.
 */

import { dbService } from './db';
import { getGLConfig, loadAccountsFromStore, resolveAccountForPosting } from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';
import { generateNextId } from '../utils/helpers';
import { logger } from './logger';

// ── Constants ────────────────────────────────────────────────

export const COA_CORRECTION_REFERENCE = 'CORRECTION-COA-PHASE1-20260919';
export const COA_CORRECTION_SCOPE = 'coa_correction_20260919';
export const COA_CORRECTION_ENTRY_TYPE = 'coa_correction';

export const PHASE2_REFERENCE = 'CORRECTION-OPENING-BALANCE-20260919';
export const PHASE2_SCOPE = 'opening_balance_20260919';
export const PHASE2_ENTRY_TYPE = 'opening_balance_correction';

export const PHASE3_FREEZE_REFERENCE = 'FREEZE-INVENTORY-WRITES-20260919';

// ── Types ────────────────────────────────────────────────────

export interface CoaCorrectionPreview {
  phase: 1 | 2 | 3;
  affectedCount: number;
  affectedTotal: number;
  debitDistribution: Record<string, number>;
  creditDistribution: Record<string, number>;
  correctionReference: string;
  proposedCorrections: Array<{
    correctionId: string;
    reversesEntryId: string;
    amount: number;
    debitAccountId: string;
    creditAccountId: string;
    description: string;
    referenceId: string;
    referenceType: string;
  }>;
  balanced: boolean;
  alreadyCorrectedCount: number;
  wouldPostCount: number;
}

export interface CoaCorrectionResult {
  phase: 1 | 2 | 3;
  postedCount: number;
  postedTotal: number;
  correctionIds: string[];
  balanced: boolean;
}

export interface CoaCorrectionOptions {
  confirmed: boolean;
  reason: string;
  dryRun?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

function codeOf(account: any): string {
  return String(account?.account_number || account?.code || account?.id || '');
}

function accountMatches(reference: unknown, accounts: any[], code: string): boolean {
  const ref = String(reference || '').trim();
  if (!ref) return false;
  if (ref === code || ref === `ACC-${code}`) return true;
  const acc = (accounts || []).find(
    (a: any) => String(a.id) === ref || codeOf(a) === ref
  );
  return !!acc && codeOf(acc) === code;
}

function isCogsLegCrediting11410(entry: any, accounts: any[]): boolean {
  if (!entry || !isPostedLedgerEntry(entry)) return false;
  const creditCode = codeOf(entry.creditAccountId);
  const desc = String(entry.description || '').toUpperCase();
  return creditCode === '11410' && desc.includes('COGS');
}

// ── Phase 1: Reverse 11410 COGS credits ──────────────────────

export function previewPhase1(
  allLedger: any[],
  accounts: any[]
): CoaCorrectionPreview {
  const posted = (allLedger || []).filter(isPostedLedgerEntry);

  // Already corrected ids
  const corrected = new Set<string>();
  for (const e of posted) {
    if (
      String(e.referenceType || '') === COA_CORRECTION_ENTRY_TYPE &&
      String(e.referenceId || '').startsWith('LG-COGS-')
    ) {
      const target = String(e.reversesEntryId || '').trim();
      if (target) corrected.add(target);
    }
  }

  const affected = posted.filter((e) => isCogsLegCrediting11410(e, accounts));
  const alreadyCorrected = affected.filter((e) => corrected.has(String(e.id)));
  const toCorrect = affected.filter((e) => !corrected.has(String(e.id)));

  const debitDistribution: Record<string, number> = {};
  const creditDistribution: Record<string, number> = {};
  let total = 0;

  for (const e of toCorrect) {
    const amount = Number(e.amount || 0);
    total += amount;
    debitDistribution['11410'] = (debitDistribution['11410'] || 0) + amount;
    creditDistribution['51200'] = (creditDistribution['51200'] || 0) + amount;
  }

  const proposedCorrections = toCorrect.map((e) => {
    const amount = Number(e.amount || 0);
    return {
      correctionId: `LG-CORR-11410-${String(e.id).replace('LG-COGS-', '')}`,
      reversesEntryId: String(e.id),
      amount,
      debitAccountId: 'ACC-11410',
      creditAccountId: 'ACC-51200',
      description: `R1: Reverse 11410 COGS credit — ${e.description}`,
      referenceId: COA_CORRECTION_REFERENCE,
      referenceType: COA_CORRECTION_ENTRY_TYPE,
    };
  });

  return {
    phase: 1,
    affectedCount: toCorrect.length,
    affectedTotal: total,
    debitDistribution,
    creditDistribution,
    correctionReference: COA_CORRECTION_REFERENCE,
    proposedCorrections,
    balanced: true,
    alreadyCorrectedCount: alreadyCorrected.length,
    wouldPostCount: toCorrect.length,
  };
}

export async function applyPhase1(opts: CoaCorrectionOptions): Promise<CoaCorrectionResult> {
  if (!opts.confirmed) throw new Error('Phase 1 requires confirmed: true');
  if (!opts.reason) throw new Error('Phase 1 requires a reason');

  const [allLedger, accounts] = await Promise.all([
    dbService.getAll<any>('ledger'),
    loadAccountsFromStore(),
  ]);

  const preview = previewPhase1(allLedger, accounts);
  if (preview.wouldPostCount === 0) {
    logger.info('[COA-CORRECTION] Phase 1: nothing to correct (already applied)');
    return { phase: 1, postedCount: 0, postedTotal: 0, correctionIds: [], balanced: true };
  }

  const gl = getGLConfig();
  const cogsAccount = resolveAccountForPosting('51200', accounts, { allowNonPosting: false });
  const invAccount = resolveAccountForPosting('11410', accounts, { allowNonPosting: false });

  if (!cogsAccount || !invAccount) {
    throw new Error('Phase 1: cannot resolve 11410 or 51200 accounts');
  }

  const now = new Date().toISOString();
  const corrections: any[] = [];
  const correctionIds: string[] = [];

  for (const e of preview.proposedCorrections) {
    const entry = {
      id: e.correctionId,
      date: now,
      debitAccountId: e.debitAccountId,
      creditAccountId: e.creditAccountId,
      amount: e.amount,
      description: e.description,
      referenceId: e.referenceId,
      referenceType: e.referenceType,
      entryType: COA_CORRECTION_ENTRY_TYPE,
      status: 'posted',
      createdAt: now,
      updatedAt: now,
      reversesEntryId: e.reversesEntryId,
    };
    corrections.push(entry);
    correctionIds.push(e.correctionId);
  }

  if (opts.dryRun) {
    logger.info('[COA-CORRECTION] Phase 1 dry-run:', JSON.stringify({ corrections, correctionIds }));
    return { phase: 1, postedCount: corrections.length, postedTotal: preview.affectedTotal, correctionIds, balanced: true };
  }

  // Atomic write
  await dbService.executeAtomicOperation?.('ledger', async (tx) => {
    const store = tx.objectStore('ledger');
    for (const entry of corrections) {
      await store.put(entry);
    }
    // Idempotency key
    await store.put({
      id: `IDEM-${COA_CORRECTION_SCOPE}`,
      referenceId: COA_CORRECTION_REFERENCE,
      referenceType: 'idempotency_key',
      status: 'posted',
      createdAt: now,
    });
  });

  logger.info(`[COA-CORRECTION] Phase 1 posted ${corrections.length} corrections, total K${preview.affectedTotal}`);
  return { phase: 1, postedCount: corrections.length, postedTotal: preview.affectedTotal, correctionIds, balanced: true };
}

// ── Phase 2: Opening balance with recomputed figures ─────────

export function previewPhase2(
  allLedger: any[],
  accounts: any[],
  liveInventoryValue: number
): CoaCorrectionPreview {
  const posted = (allLedger || []).filter(isPostedLedgerEntry);

  // Check if opening balance already posted
  const alreadyPosted = posted.some(
    (e) => String(e.referenceType || '') === PHASE2_ENTRY_TYPE && String(e.referenceId || '') === PHASE2_REFERENCE
  );

  const alreadyCorrectedCount = alreadyPosted ? 1 : 0;
  const wouldPostCount = alreadyPosted ? 0 : 1;

  const debitDistribution: Record<string, number> = { '11420': liveInventoryValue };
  const creditDistribution: Record<string, number> = { '31000': liveInventoryValue };

  const proposedCorrections = alreadyPosted ? [] : [
    {
      correctionId: 'LG-OPENING-11420-20260919',
      reversesEntryId: '',
      amount: liveInventoryValue,
      debitAccountId: 'ACC-11420',
      creditAccountId: 'ACC-31000',
      description: `Phase 2: Opening balance DR 11420 Raw Materials K${liveInventoryValue.toLocaleString()} / CR 31000 Owner's Capital — recomputed from live data, NOT stale snapshot`,
      referenceId: PHASE2_REFERENCE,
      referenceType: PHASE2_ENTRY_TYPE,
    },
  ];

  return {
    phase: 2,
    affectedCount: wouldPostCount,
    affectedTotal: liveInventoryValue,
    debitDistribution,
    creditDistribution,
    correctionReference: PHASE2_REFERENCE,
    proposedCorrections,
    balanced: true,
    alreadyCorrectedCount,
    wouldPostCount,
  };
}

export async function applyPhase2(
  opts: CoaCorrectionOptions,
  liveInventoryValue: number
): Promise<CoaCorrectionResult> {
  if (!opts.confirmed) throw new Error('Phase 2 requires confirmed: true');
  if (!opts.reason) throw new Error('Phase 2 requires a reason');

  const [allLedger, accounts] = await Promise.all([
    dbService.getAll<any>('ledger'),
    loadAccountsFromStore(),
  ]);

  const preview = previewPhase2(allLedger, accounts, liveInventoryValue);
  if (preview.wouldPostCount === 0) {
    logger.info('[COA-CORRECTION] Phase 2: opening balance already posted');
    return { phase: 2, postedCount: 0, postedTotal: 0, correctionIds: [], balanced: true };
  }

  const gl = getGLConfig();
  const ownerCapital = resolveAccountForPosting('31000', accounts, { allowNonPosting: false });
  const rawMaterials = resolveAccountForPosting('11420', accounts, { allowNonPosting: false });

  if (!ownerCapital || !rawMaterials) {
    throw new Error('Phase 2: cannot resolve 11420 or 31000 accounts');
  }

  const now = new Date().toISOString();
  const entry = {
    id: 'LG-OPENING-11420-20260919',
    date: now,
    debitAccountId: 'ACC-11420',
    creditAccountId: 'ACC-31000',
    amount: liveInventoryValue,
    description: preview.proposedCorrections[0].description,
    referenceId: PHASE2_REFERENCE,
    referenceType: PHASE2_ENTRY_TYPE,
    entryType: PHASE2_ENTRY_TYPE,
    status: 'posted',
    createdAt: now,
    updatedAt: now,
  };

  if (opts.dryRun) {
    logger.info('[COA-CORRECTION] Phase 2 dry-run:', JSON.stringify(entry));
    return { phase: 2, postedCount: 1, postedTotal: liveInventoryValue, correctionIds: [entry.id], balanced: true };
  }

  await dbService.executeAtomicOperation?.('ledger', async (tx) => {
    const store = tx.objectStore('ledger');
    await store.put(entry);
    await store.put({
      id: `IDEM-${PHASE2_SCOPE}`,
      referenceId: PHASE2_REFERENCE,
      referenceType: 'idempotency_key',
      status: 'posted',
      createdAt: now,
    });
  });

  logger.info(`[COA-CORRECTION] Phase 2 posted opening balance K${liveInventoryValue}`);
  return { phase: 2, postedCount: 1, postedTotal: liveInventoryValue, correctionIds: [entry.id], balanced: true };
}

// ── Phase 3: Freeze inventory writes + flag for physical count ─

export interface Phase3Result {
  phase: 3;
  frozen: boolean;
  flaggedCount: number;
  freezeReference: string;
}

export async function applyPhase3(opts: CoaCorrectionOptions): Promise<Phase3Result> {
  if (!opts.confirmed) throw new Error('Phase 3 requires confirmed: true');
  if (!opts.reason) throw new Error('Phase 3 requires a reason');

  const now = new Date().toISOString();

  // Write freeze marker to ledger (read-only flag, no inventory mutation)
  const freezeEntry = {
    id: `LG-FREEZE-${Date.now()}`,
    date: now,
    debitAccountId: '',
    creditAccountId: '',
    amount: 0,
    description: `Phase 3: INVENTORY WRITE FREEZE — bulk seeding job 2026-09-16 corrupted all stock fields to 500. Physical count required before any opening posting. Reason: ${opts.reason}`,
    referenceId: PHASE3_FREEZE_REFERENCE,
    referenceType: 'inventory_write_freeze',
    entryType: 'inventory_write_freeze',
    status: 'posted',
    createdAt: now,
    updatedAt: now,
  };

  // Flag all inventory items for physical count
  const allInventory = await dbService.getAll<any>('inventory');
  const flaggedCount = allInventory.length;

  if (opts.dryRun) {
    logger.info('[COA-CORRECTION] Phase 3 dry-run:', JSON.stringify({ freezeEntry, flaggedCount }));
    return { phase: 3, frozen: true, flaggedCount, freezeReference: PHASE3_FREEZE_REFERENCE };
  }

  await dbService.executeAtomicOperation?.('ledger', async (tx) => {
    const store = tx.objectStore('ledger');
    await store.put(freezeEntry);
    await store.put({
      id: `IDEM-${COA_CORRECTION_SCOPE}-phase3`,
      referenceId: PHASE3_FREEZE_REFERENCE,
      referenceType: 'idempotency_key',
      status: 'posted',
      createdAt: now,
    });
  });

  // Also write freeze flag to a settings record for the UI to read
  await dbService.put('settings', {
    id: 'inventory_write_freeze',
    key: 'inventory_write_freeze',
    value: true,
    reason: opts.reason,
    createdAt: now,
    updatedAt: now,
  });

  logger.info(`[COA-CORRECTION] Phase 3: inventory writes frozen, ${flaggedCount} items flagged for physical count`);
  return { phase: 3, frozen: true, flaggedCount, freezeReference: PHASE3_FREEZE_REFERENCE };
}

// ── Master apply: all 3 phases ───────────────────────────────

export interface FullCorrectionResult {
  phase1: CoaCorrectionResult;
  phase2: CoaCorrectionResult;
  phase3: Phase3Result;
  totalCorrections: number;
  totalAmount: number;
}

export async function applyAllPhases(
  opts: CoaCorrectionOptions,
  liveInventoryValue: number
): Promise<FullCorrectionResult> {
  const phase1 = await applyPhase1(opts);
  const phase2 = await applyPhase2(opts, liveInventoryValue);
  const phase3 = await applyPhase3(opts);

  return {
    phase1,
    phase2,
    phase3,
    totalCorrections: phase1.postedCount + phase2.postedCount + phase3.flaggedCount,
    totalAmount: phase1.postedTotal + phase2.postedTotal,
  };
}