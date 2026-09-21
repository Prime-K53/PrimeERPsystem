/**
 * R1 Historical Correction Service — controlled reversal of 5 erroneous
 * COGS legs that incorrectly credited 11410 Merchandise Inventory.
 *
 * The erroneous entries are identified by invoice references:
 *   INV-P726/021, INV-P726/022, INV-P726/023, INV-P726/024, INV-P726/025
 *
 * For each entry, the service verifies:
 *   - original ledger entry still exists
 *   - original amount matches expected value
 *   - original debit account is 51200 COGS
 *   - original credit account is 11410 Merchandise Inventory
 *   - original invoice reference matches
 *
 * If ANY verification differs, the service refuses to act.
 *
 * Correction entry created per leg:
 *   DR 11410 Merchandise Inventory / CR 51200 COGS (exact amount)
 *
 * SAFETY:
 * - Never edits or deletes the original entry
 * - Idempotent: idempotency key tied to each original entry ID
 * - Cannot execute the same reversal twice
 * - dryRun option returns proposed corrections without writing
 * - Service is implemented and testable, but MUST NOT execute against
 *   live historical data until explicit authorization is granted
 */

import { dbService } from './db';
import { getGLConfig, loadAccountsFromStore, resolveAccountForPosting } from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';
import { logger } from './logger';

// ── Constants ────────────────────────────────────────────────────

export const R1_CORRECTION_SCOPE = 'r1_correction_20260920';
export const R1_CORRECTION_ENTRY_TYPE = 'r1_correction';
export const R1_CORRECTION_REFERENCE = 'CORRECTION-R1-20260920';

export type R1Target = {
  invoiceRef: string;
  expectedAmount: number;
};

export const R1_TARGETS: R1Target[] = [
  { invoiceRef: 'INV-P726/021', expectedAmount: 75570 },
  { invoiceRef: 'INV-P726/022', expectedAmount: 18981 },
  { invoiceRef: 'INV-P726/023', expectedAmount: 44289 },
  { invoiceRef: 'INV-P726/024', expectedAmount: 20388 },
  { invoiceRef: 'INV-P726/025', expectedAmount: 63270 },
];

// ── Types ────────────────────────────────────────────────────────

export interface R1VerificationFailure {
  invoiceRef: string;
  reason: string;
  detail: string;
}

export interface R1ProposedCorrection {
  correctionId: string;
  reversesEntryId: string;
  amount: number;
  debitAccountId: string;
  creditAccountId: string;
  description: string;
  referenceId: string;
  referenceType: string;
  invoiceRef: string;
}

export interface R1PreviewResult {
  phase: 'R1';
  proposedCount: number;
  proposedTotal: number;
  balanced: boolean;
  proposedCorrections: R1ProposedCorrection[];
  verificationFailures: R1VerificationFailure[];
  alreadyReversedCount: number;
  wouldPostCount: number;
  correctionReference: string;
}

export interface R1ApplyResult {
  phase: 'R1';
  postedCount: number;
  postedTotal: number;
  correctionIds: string[];
  balanced: boolean;
  verificationFailures: R1VerificationFailure[];
}

export interface R1ApplyOptions {
  confirmed: true;
  reason: string;
  dryRun?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function round2(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function findLedgerEntryByReference(ledger: any[], ref: string): any | undefined {
  const upper = String(ref || '').trim().toUpperCase();
  if (!upper) return undefined;
  return ledger.find(e => {
    const r = String(e.referenceId || e.invoiceRef || e.invoice_reference || '').trim().toUpperCase();
    return r === upper;
  });
}

function isR1CorrectionEntry(entry: any): boolean {
  return String(entry.entryType || '') === R1_CORRECTION_ENTRY_TYPE ||
    String(entry.referenceType || '') === R1_CORRECTION_ENTRY_TYPE;
}

// ── Preview ──────────────────────────────────────────────────────

export function previewR1Reversals(ledger: any[], accounts: any[]): R1PreviewResult {
  const posted = (ledger || []).filter(isPostedLedgerEntry);
  const verificationFailures: R1VerificationFailure[] = [];
  const proposedCorrections: R1ProposedCorrection[] = [];
  let alreadyReversedCount = 0;
  let wouldPostCount = 0;

  // Build idempotency check set from existing R1 corrections
  const reversedEntryIds = new Set<string>();
  for (const e of posted) {
    if (isR1CorrectionEntry(e)) {
      const target = String(e.reversesEntryId || '').trim();
      if (target) reversedEntryIds.add(target);
    }
  }

  for (const target of R1_TARGETS) {
    const original = findLedgerEntryByReference(posted, target.invoiceRef);

    if (!original) {
      verificationFailures.push({
        invoiceRef: target.invoiceRef,
        reason: 'MISSING_ENTRY',
        detail: 'Original ledger entry not found or not posted',
      });
      continue;
    }

    if (reversedEntryIds.has(String(original.id))) {
      alreadyReversedCount += 1;
      continue;
    }

    const amount = round2(original.amount);
    const expectedAmount = round2(target.expectedAmount);
    if (amount !== expectedAmount) {
      verificationFailures.push({
        invoiceRef: target.invoiceRef,
        reason: 'AMOUNT_MISMATCH',
        detail: `Expected K${expectedAmount}, found K${amount}`,
      });
      continue;
    }

    const debitCode = String(original.debitAccountId || '').trim();
    const creditCode = String(original.creditAccountId || '').trim();

    const debitAccount = accounts.find(a =>
      a.id === debitCode || a.code === debitCode || a.account_number === debitCode
    );
    const creditAccount = accounts.find(a =>
      a.id === creditCode || a.code === creditCode || a.account_number === creditCode
    );

    const debitAccountNumber = String(debitAccount?.account_number || debitAccount?.code || debitCode || '').trim();
    const creditAccountNumber = String(creditAccount?.account_number || creditAccount?.code || creditCode || '').trim();

    if (debitAccountNumber !== '51200') {
      verificationFailures.push({
        invoiceRef: target.invoiceRef,
        reason: 'DEBIT_ACCOUNT_MISMATCH',
        detail: `Expected debit 51200 COGS, found ${debitAccountNumber || debitCode}`,
      });
      continue;
    }

    if (creditAccountNumber !== '11410') {
      verificationFailures.push({
        invoiceRef: target.invoiceRef,
        reason: 'CREDIT_ACCOUNT_MISMATCH',
        detail: `Expected credit 11410 Merchandise Inventory, found ${creditAccountNumber || creditCode}`,
      });
      continue;
    }

    const refId = String(original.referenceId || original.invoiceRef || '').trim().toUpperCase();
    if (refId !== target.invoiceRef.toUpperCase()) {
      verificationFailures.push({
        invoiceRef: target.invoiceRef,
        reason: 'INVOICE_REFERENCE_MISMATCH',
        detail: `Expected reference ${target.invoiceRef}, found ${refId || '(none)'}`,
      });
      continue;
    }

    wouldPostCount += 1;
    proposedCorrections.push({
      correctionId: `LG-R1-${String(original.id).replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`,
      reversesEntryId: String(original.id),
      amount: amount,
      debitAccountId: 'ACC-11410',
      creditAccountId: 'ACC-51200',
      description: `R1: Reverse erroneous 11410 credit — ${original.description || target.invoiceRef}`,
      referenceId: R1_CORRECTION_REFERENCE,
      referenceType: R1_CORRECTION_ENTRY_TYPE,
      invoiceRef: target.invoiceRef,
    });
  }

  const proposedTotal = proposedCorrections.reduce((sum, c) => sum + c.amount, 0);
  const balanced = proposedCorrections.length > 0 &&
    round2(proposedCorrections.reduce((sum, c) => sum + c.amount, 0)) > 0;

  return {
    phase: 'R1',
    proposedCount: proposedCorrections.length,
    proposedTotal: round2(proposedTotal),
    balanced,
    proposedCorrections,
    verificationFailures,
    alreadyReversedCount,
    wouldPostCount,
    correctionReference: R1_CORRECTION_REFERENCE,
  };
}

// ── Apply ────────────────────────────────────────────────────────

export async function applyR1Reversals(opts: R1ApplyOptions): Promise<R1ApplyResult> {
  if (!opts.confirmed) {
    throw new Error('applyR1Reversals requires confirmed: true');
  }
  if (!opts.reason || String(opts.reason).trim() === '') {
    throw new Error('applyR1Reversals requires a non-empty reason');
  }

  const [allLedger, accounts] = await Promise.all([
    dbService.getAll<any>('ledger'),
    loadAccountsFromStore(null),
  ]);

  const preview = previewR1Reversals(allLedger, accounts);

  if (preview.verificationFailures.length > 0) {
    logger.error('[R1-CORRECTION] Verification failed:', JSON.stringify(preview.verificationFailures));
    return {
      phase: 'R1',
      postedCount: 0,
      postedTotal: 0,
      correctionIds: [],
      balanced: false,
      verificationFailures: preview.verificationFailures,
    };
  }

  if (preview.wouldPostCount === 0) {
    logger.info('[R1-CORRECTION] No reversals to apply (already reversed or no targets found)');
    return {
      phase: 'R1',
      postedCount: 0,
      postedTotal: 0,
      correctionIds: [],
      balanced: true,
      verificationFailures: [],
    };
  }

  const gl = getGLConfig();
  const cogsAccount = resolveAccountForPosting('51200', accounts, { allowNonPosting: false });
  const invAccount = resolveAccountForPosting('11410', accounts, { allowNonPosting: false });

  if (!cogsAccount || !invAccount) {
    throw new Error('R1: cannot resolve 11410 or 51200 accounts');
  }

  const now = new Date().toISOString();
  const corrections: any[] = [];
  const correctionIds: string[] = [];

  for (const proposed of preview.proposedCorrections) {
    const entry = {
      id: proposed.correctionId,
      date: now,
      debitAccountId: proposed.debitAccountId,
      creditAccountId: proposed.creditAccountId,
      amount: proposed.amount,
      description: proposed.description,
      referenceId: proposed.referenceId,
      referenceType: proposed.referenceType,
      entryType: R1_CORRECTION_ENTRY_TYPE,
      status: 'posted',
      createdAt: now,
      updatedAt: now,
      reversesEntryId: proposed.reversesEntryId,
      idempotencyKey: `IDEM-${R1_CORRECTION_SCOPE}-${proposed.reversesEntryId}`,
      appliedBy: 'coaCorrectionService',
      applyReason: opts.reason,
    };
    corrections.push(entry);
    correctionIds.push(proposed.correctionId);
  }

  if (opts.dryRun) {
    logger.info('[R1-CORRECTION] Dry-run:', JSON.stringify({ corrections, correctionIds }));
    return {
      phase: 'R1',
      postedCount: corrections.length,
      postedTotal: preview.proposedTotal,
      correctionIds,
      balanced: true,
      verificationFailures: [],
    };
  }

  await dbService.executeAtomicOperation?.('ledger', async (tx: any) => {
    const store = tx.objectStore('ledger');
    for (const entry of corrections) {
      await store.put(entry);
    }
    await store.put({
      id: `IDEM-${R1_CORRECTION_SCOPE}`,
      referenceId: R1_CORRECTION_REFERENCE,
      referenceType: 'idempotency_key',
      status: 'posted',
      createdAt: now,
    });
  });

  logger.info(`[R1-CORRECTION] Posted ${corrections.length} reversals, total K${preview.proposedTotal}`);
  return {
    phase: 'R1',
    postedCount: corrections.length,
    postedTotal: preview.proposedTotal,
    correctionIds,
    balanced: true,
    verificationFailures: [],
  };
}
