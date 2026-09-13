/**
 * stockAdjustmentCorrectionService.ts
 *
 * Safe historical correction for the Sept-12 stock-adjustment defect:
 * 102 ledger entries crediting ACC-42100 Interest Income (K348,704,525)
 * for "Stock Adjustment: Smart stock adjustment (ADD) (...)" postings.
 *
 * BUSINESS INTENT (audited): bulk opening-inventory initialization performed
 * through the Smart Adjust workflow, bypassing openingBalanceService. The
 * correct offset is opening equity (31000 Owner's Capital, fallback 32000).
 *
 * CORRECTION MODEL (reclassification, audit-preserving):
 *   Original (kept, untouched):
 *     DR Inventory (11410/11420) / CR 42100 Interest Income
 *   Correction (new, exactly once per original):
 *     DR 42100 Interest Income / CR 31000 Owner's Capital (same amount)
 *   Final economics:
 *     DR Inventory / CR 31000, with 42100 netting to zero for this batch.
 *
 * Why reclassification (not full reversal + repost):
 *   - Inventory debits were CORRECT and must remain exactly as posted;
 *     touching them twice (reverse + repost) adds 204 rows and churn for no
 *     economic benefit. The error is purely the CREDIT classification.
 *   - One correction row per original preserves a 1:1 audit link via
 *     reversesEntryId while keeping inventory valuation bit-for-bit stable.
 *
 * SAFETY:
 *   - Read-only dry-run first: identify exactly the affected entries, show
 *     totals/distribution, verify balance, verify no unrelated 42100 rows.
 *   - referenceType is 'stock_adjustment_correction' (NOT 'reversal') so the
 *     correction is INCLUDED in trial-balance/P&L/general-ledger reports and
 *     nets against the original. ('reversal' rows are EXCLUDED by both the
 *     frontend isPostedLedgerEntry() and the Supabase v_trial_balance view.)
 *   - Idempotent: deterministic correction ids (LG-CORR-<originalId>) plus an
 *     idempotencyKeys scope ('stock_adjustment_correction_20260912'). A
 *     second run detects existing corrections and posts zero rows.
 *   - Atomic: all corrections + idempotency write in one
 *     executeAtomicOperation. Uses the authoritative ledgerStore path so the
 *     normal durableSyncQueue syncs the correction to Supabase.
 *   - Explicit authorization: applyCorrection() requires { confirmed: true,
 *     reason } — there is no silent auto-execution. Tests must use dryRun.
 *   - Never mutates or deletes originals; never uses UPDATE-in-place.
 */

import { dbService } from './db';
import {
  getGLConfig,
  generateId,
  loadAccountsFromStore,
  resolveAccountForPosting,
} from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';

export const STOCK_ADJUSTMENT_CORRECTION_REFERENCE =
  'CORRECTION-STOCK-ADJUSTMENT-20260912';
export const STOCK_ADJUSTMENT_CORRECTION_SCOPE =
  'stock_adjustment_correction_20260912';
export const STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE =
  'stock_adjustment_correction';

export interface AffectedStockAdjustment {
  id: string;
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  referenceId?: string;
}

export interface StockAdjustmentCorrectionPreview {
  affectedCount: number;
  affectedTotal: number;
  debitDistribution: Record<string, number>;
  incorrectCreditTotal: number;
  other42100Count: number;
  other42100Total: number | null;
  correctionReference: string;
  debitCorrectionAccountId: string;
  debitCorrectionCode: string;
  creditCorrectionAccountId: string;
  creditCorrectionCode: string;
  proposedCorrections: Array<{
    correctionId: string;
    reversesEntryId: string;
    amount: number;
    debitAccountId: string;
    creditAccountId: string;
    description: string;
  }>;
  balanced: boolean;
  alreadyCorrectedCount: number;
  wouldPostCount: number;
}

function codeOf(account: any): string {
  return String(account?.account_number || account?.code || account?.id || '');
}

function accountMatches42100(creditRef: unknown, accounts: any[]): boolean {
  const ref = String(creditRef || '').trim();
  if (!ref) return false;
  if (ref === '42100' || ref === 'ACC-42100') return true;
  const acc = (accounts || []).find(
    (a: any) =>
      String(a.id) === ref || codeOf(a) === ref
  );
  return !!acc && codeOf(acc) === '42100';
}

function isStockAdjustmentDescription(desc: unknown): boolean {
  return String(desc || '').toLowerCase().includes('stock adjustment');
}

/**
 * Read-only identification of the affected historical entries.
 * Never writes. `alreadyCorrectedIds` links prior correction rows so a
 * second preview reports wouldPost:0 (idempotent).
 */
export function findAffectedStockAdjustments(
  allLedger: any[],
  accounts: any[]
): {
  affected: AffectedStockAdjustment[];
  other42100: any[];
} {
  const posted = (allLedger || []).filter(isPostedLedgerEntry);
  // Ids already neutralised by a prior correction run.
  const corrected = new Set<string>();
  for (const e of posted) {
    if (
      String((e as any).referenceId || '') ===
        STOCK_ADJUSTMENT_CORRECTION_REFERENCE &&
      String((e as any).referenceType || '') ===
        STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE
    ) {
      const target = String((e as any).reversesEntryId || '').trim();
      if (target) corrected.add(target);
    }
  }
  const affected: AffectedStockAdjustment[] = [];
  const other42100: any[] = [];
  for (const e of posted) {
    if (!accountMatches42100((e as any).creditAccountId, accounts)) continue;
    if (isStockAdjustmentDescription((e as any).description)) {
      // Skip rows already corrected (idempotency) — they remain traceable
      // but are not re-proposed.
      if (corrected.has(String((e as any).id || ''))) continue;
      affected.push({
        id: String((e as any).id || ''),
        date: String((e as any).date || ''),
        description: String((e as any).description || ''),
        debitAccountId: String((e as any).debitAccountId || ''),
        creditAccountId: String((e as any).creditAccountId || ''),
        amount: Number((e as any).amount || 0),
        referenceId: (e as any).referenceId,
      });
    } else {
      other42100.push(e);
    }
  }
  return { affected, other42100 };
}

/**
 * Pure preview builder (no I/O). Resolves the correction account pair and
 * lays out deterministic 1:1 reclassification rows.
 */
export function buildCorrectionPreview(args: {
  affected: AffectedStockAdjustment[];
  other42100: any[];
  accounts: any[];
  alreadyCorrectedCount?: number;
}): StockAdjustmentCorrectionPreview {
  const { affected, other42100, accounts } = args;
  const gl = getGLConfig();
  const equityRef =
    (gl as any).ownerCapitalAccount ||
    (gl as any).retainedEarningsAccount ||
    '32000';

  const interest = (accounts || []).find((a: any) => codeOf(a) === '42100');
  const equity =
    (accounts || []).find(
      (a: any) =>
        String(a.id) === String(equityRef) || codeOf(a) === String(equityRef)
    ) || null;
  if (!interest || interest.allow_posting === false || interest.allow_posting === 0) {
    throw new Error('Correction requires a posting 42100 Interest Income account to debit.');
  }
  if (!equity || equity.allow_posting === false || equity.allow_posting === 0) {
    throw new Error(
      `Correction requires a posting opening-equity account (${equityRef}). Posting aborted.`
    );
  }
  if (String((equity as any).account_type || '').toUpperCase() !== 'EQUITY') {
    throw new Error(
      `Correction offset ${codeOf(equity)} must be an EQUITY account (31000/32000). Posting aborted.`
    );
  }

  const affectedTotal = Math.round(
    affected.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100
  ) / 100;
  const debitDistribution: Record<string, number> = {};
  for (const e of affected) {
    const key = String(e.debitAccountId || '');
    // Present distribution by canonical code where possible.
    const acc = (accounts || []).find(
      (a: any) => String(a.id) === key || codeOf(a) === key
    );
    const label = acc ? codeOf(acc) : key;
    debitDistribution[label] = Math.round(((debitDistribution[label] || 0) + Number(e.amount || 0)) * 100) / 100;
  }
  const otherTotal =
    other42100.length === 0
      ? null
      : Math.round(other42100.reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0) * 100) / 100;

  const journalId = `${STOCK_ADJUSTMENT_CORRECTION_REFERENCE}`;
  const proposedCorrections = affected.map((e) => ({
    correctionId: `LG-CORR-${e.id}`,
    reversesEntryId: e.id,
    amount: Number(e.amount) || 0,
    debitAccountId: String((interest as any).id),
    creditAccountId: String((equity as any).id),
    description:
      `CORRECTION: Reclassify Stock Adjustment ${e.id} ` +
      `from Interest Income (42100) to ${codeOf(equity)} (${(equity as any).name || 'opening equity'}) — ` +
      `Sept-12 bulk Smart Adjust credited 42100 via 42000 parent fallback; correct offset is opening equity.`,
    journalId,
  }));

  const proposedTotal =
    Math.round(proposedCorrections.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  return {
    affectedCount: affected.length,
    affectedTotal,
    debitDistribution,
    incorrectCreditTotal: affectedTotal,
    other42100Count: other42100.length,
    other42100Total: otherTotal,
    correctionReference: STOCK_ADJUSTMENT_CORRECTION_REFERENCE,
    debitCorrectionAccountId: String((interest as any).id),
    debitCorrectionCode: codeOf(interest),
    creditCorrectionAccountId: String((equity as any).id),
    creditCorrectionCode: codeOf(equity),
    proposedCorrections,
    balanced: Math.abs(proposedTotal - affectedTotal) < 0.01,
    alreadyCorrectedCount: args.alreadyCorrectedCount || 0,
    wouldPostCount: proposedCorrections.length,
  };
}

/** Read-only dry-run against live stores. Never writes. */
export async function previewStockAdjustmentCorrection(): Promise<StockAdjustmentCorrectionPreview> {
  const [ledger, accounts] = await Promise.all([
    dbService.getAll<any>('ledger'),
    dbService.getAll<any>('accounts'),
  ]);
  const { affected, other42100 } = findAffectedStockAdjustments(ledger, accounts);
  // Count already-corrected rows for the report (traceability, not re-posted).
  const alreadyCorrectedCount = (ledger || []).filter(
    (e: any) =>
      String(e.referenceId || '') === STOCK_ADJUSTMENT_CORRECTION_REFERENCE &&
      String(e.referenceType || '') === STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE &&
      isPostedLedgerEntry(e)
  ).length;
  return buildCorrectionPreview({ affected, other42100, accounts, alreadyCorrectedCount });
}

export interface ApplyCorrectionResult {
  applied: boolean;
  entriesPosted: number;
  journalId: string;
  total: number;
  reason?: string;
}

/**
 * Apply the correction exactly once. Requires explicit confirmation:
 *   applyStockAdjustmentCorrection({ confirmed: true, reason: '...' })
 * Without confirmed:true the call throws and writes nothing. With dryRun:true
 * it returns the preview and writes nothing.
 */
export async function applyStockAdjustmentCorrection(options: {
  confirmed?: boolean;
  dryRun?: boolean;
  reason?: string;
}): Promise<ApplyCorrectionResult & { preview?: StockAdjustmentCorrectionPreview }> {
  if (options.dryRun) {
    const preview = await previewStockAdjustmentCorrection();
    return {
      applied: false,
      entriesPosted: 0,
      journalId: '',
      total: 0,
      reason: 'dry-run: no writes performed',
      preview,
    };
  }
  if (options.confirmed !== true) {
    throw new Error(
      'Historical stock-adjustment correction requires explicit confirmation ({ confirmed: true, reason }). No writes performed.'
    );
  }
  const reason = String(options.reason || '').trim();
  if (!reason) {
    throw new Error('Historical correction requires a non-empty audit reason. No writes performed.');
  }

  return dbService.executeAtomicOperation(
    ['ledger', 'accounts', 'idempotencyKeys'],
    async (tx) => {
      const ledgerStore = tx.objectStore('ledger');
      const idempotencyStore = tx.objectStore('idempotencyKeys');
      const accounts = await loadAccountsFromStore(tx);

      // Idempotency gate: a prior successful run recorded this scope.
      const gateKey = `${STOCK_ADJUSTMENT_CORRECTION_SCOPE}:apply`;
      const existingGate = await idempotencyStore.get(gateKey);
      if (existingGate) {
        return {
          applied: false,
          entriesPosted: 0,
          journalId: String((existingGate as any).sourceId || ''),
          total: 0,
          reason: 'already applied (idempotency gate)',
        };
      }

      const allLedger: any[] = await ledgerStore.getAll();
      const { affected, other42100 } = findAffectedStockAdjustments(allLedger, accounts);
      if (affected.length === 0) {
        return {
          applied: false,
          entriesPosted: 0,
          journalId: '',
          total: 0,
          reason: 'no outstanding affected entries (already corrected or none found)',
        };
      }
      const preview = buildCorrectionPreview({ affected, other42100, accounts });
      if (!preview.balanced) {
        throw new Error('Correction preview is unbalanced — refusing to post.');
      }

      const now = new Date().toISOString();
      const journalId = generateId('LG-CORR-120912');
      let posted = 0;
      for (const c of preview.proposedCorrections) {
        // Deterministic per-original id: retries converge (put = upsert).
        const entry = {
          id: c.correctionId,
          date: now,
          description: `${c.description} — ${reason}`,
          debitAccountId: c.debitAccountId,
          creditAccountId: c.creditAccountId,
          amount: c.amount,
          referenceId: STOCK_ADJUSTMENT_CORRECTION_REFERENCE,
          referenceType: STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE,
          entryType: STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE,
          journalId,
          reversesEntryId: c.reversesEntryId,
          reconciled: false,
        };
        // Validate the pair resolves to posting accounts (fail closed).
        for (const ref of [entry.debitAccountId, entry.creditAccountId]) {
          const resolved = resolveAccountForPosting(ref, accounts, {
            allowNonPosting: false,
          });
          if (!resolved) throw new Error(`Correction account unresolvable: ${ref}`);
        }
        await ledgerStore.put(entry);
        posted += 1;
      }
      await idempotencyStore.put({
        id: gateKey,
        scope: STOCK_ADJUSTMENT_CORRECTION_SCOPE,
        sourceId: journalId,
        createdAt: now,
      });

      return {
        applied: true,
        entriesPosted: posted,
        journalId,
        total: preview.affectedTotal,
      };
    }
  );
}
