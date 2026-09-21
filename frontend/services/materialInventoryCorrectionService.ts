/**
 * Material Inventory Correction Service — approved 11420 Raw Materials
 * capitalisation (2026-09-16 verified physical stock).
 *
 * AUTHORIZED SCOPE (accountant-approved, single execution):
 *
 * 1. Reverse/void EXACTLY ONE duplicate ledger row:
 *      id      LG-COGS-1789787524516-mcpj3jfhj
 *      invoice INV-P726/031
 *      amount  K187,600
 *      date    2026-01-17
 *      entry   DR 51200 COGS / CR 11420 Raw Materials
 *    The original row is NEVER edited or deleted — the correction is a
 *    single offsetting (swapped-side) posted entry linked back to the
 *    original via `reversesEntryId` and a deterministic `referenceId`.
 *
 * 2. Capitalise the verified physical material inventory:
 *      a. 2026-01-01  DR 11420 K1,687,500   / CR 32000 K1,687,500
 *      b. 2026-09-16  DR 11420 K222,500,000 / CR 32000 K222,500,000
 *
 *    Net: 11420 = 0 + 1,687,500 + 222,500,000 − 1,687,500 = K222,500,000,
 *    matching Σ(quantity × stored cost) over the 30 inventory-bearing
 *    Stationery + Raw Material items (15,000 units).
 *
 * EXPLICITLY OUT OF SCOPE (must stay unresolved here):
 * - the K448,985 Product/11410 Merchandise COGS issue;
 * - the K111,400 historical cost/valuation residual;
 * - Smart Stock adjustment records (left byte-for-byte untouched);
 * - inventory quantities, stored costs, invoices, orders, customers.
 *
 * SAFETY / ARCHITECTURE
 * - Every pre-condition is verified BEFORE anything is written; any
 *   mismatch aborts with zero writes.
 * - Journals are written through the application's own durability path
 *   (`dbService.put` via `dbService.executeAtomicOperation`), so ledger rows
 *   are authoritative, balances stay derived, and the durable sync/outbox
 *   rules apply exactly as for any other posting.
 * - Idempotent by deterministic `referenceId`: re-running detects each
 *   component as already applied and writes nothing further.
 * - Reversal rows deliberately carry a NON-'Reversal' entryType: the
 *   canonical `isPostedLedgerEntry` filter excludes `entryType ===
 *   'Reversal'`, and an offsetting row must remain posted in order to net
 *   the original to zero (this matches ledgerService.reverseEntry).
 * - `dryRun` returns the proposed rows without writing.
 */

import { dbService } from './db';
import {
  loadAccountsFromStore,
  resolveAccountForPosting,
  generateId,
} from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';
import { logger } from './logger';

// ── Constants ────────────────────────────────────────────────────

export const MATINV_CORRECTION_SCOPE = 'material_inventory_correction_20260916';
export const MATINV_CORRECTION_ENTRY_TYPE = 'material_inventory_correction';

/** The exact duplicate ledger row approved for reversal. */
export const MATINV_DUPLICATE_LEDGER_ID = 'LG-COGS-1789787524516-mcpj3jfhj';

/** Identifying attributes the duplicate row must match exactly. */
export const MATINV_DUPLICATE_EXPECTED = {
  invoiceRef: 'INV-P726/031',
  date: '2026-01-17',
  amount: 187600,
  debitCode: '51200',
  creditCode: '11420',
} as const;

/** Default date carrying the offsetting reversal entry (approved). */
export const MATINV_REVERSAL_DATE = '2026-09-21';

/** Approved capitalisation components (opening + verified current stock). */
export const MATINV_CAPITALISATION_COMPONENTS = [
  {
    key: 'OPENING' as const,
    referenceId: 'CORR-MATINV-OPENING-11420',
    date: '2026-01-01',
    amount: 1687500,
    description:
      'Material inventory capitalisation — opening balance (FY2026 pre-Smart-Stock material stock, approved correction)',
  },
  {
    key: 'CAPITAL' as const,
    referenceId: 'CORR-MATINV-CAPITAL-11420',
    date: '2026-09-16',
    amount: 222500000,
    description:
      'Material inventory capitalisation — verified physical stock (15,000 units / 30 inventory-bearing items, approved correction)',
  },
];

export const MATINV_REVERSAL_REFERENCE = `CORR-MATINV-REV-${MATINV_DUPLICATE_LEDGER_ID}`;

/** Expected post-correction 11420 balance (verified physical valuation). */
export const MATINV_EXPECTED_11420 = 222500000;

/** Approved debits to 11420 from the two capitalisation components. */
export const MATINV_APPROVED_CAPITALISATION_DEBIT_11420 = 224187500;

/** Every approved debit to 11420, including the reversal leg. */
export const MATINV_APPROVED_TOTAL_DEBIT_11420 =
  MATINV_APPROVED_CAPITALISATION_DEBIT_11420 + MATINV_DUPLICATE_EXPECTED.amount;

// ── Types ────────────────────────────────────────────────────────

export interface MatInvFailure {
  check: string;
  reason: string;
  detail: string;
}

export interface MatInvProposedEntry {
  component: 'REVERSAL' | 'OPENING' | 'CAPITAL';
  id: string;
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  referenceId: string;
  revertsEntryId?: string;
}

export interface MatInvPreview {
  phase: 'MATINV';
  scope: string;
  duplicateFound: boolean;
  duplicateIdempotency: {
    reversalAlreadyApplied: boolean;
    existingReversalIds: string[];
    openingAlreadyApplied: boolean;
    capitalisationAlreadyApplied: boolean;
  };
  resolvedAccounts: {
    rawMaterials: string | null;
    retainedEarnings: string | null;
    cogs: string | null;
  };
  proposedEntries: MatInvProposedEntry[];
  /** Approved capitalisation only (both components): K224,187,500. */
  proposedCapitalisationTotal: number;
  /** Every proposed debit leg into 11420, including the reversal: K224,375,100. */
  proposedTotalDebit11420: number;
  failures: MatInvFailure[];
  fullyApplied: boolean;
  canApply: boolean;
}

export interface MatInvApplyOptions {
  /** Must be literally true — guards against accidental invocation. */
  confirmed: true;
  /** Non-empty audit reason recorded on every created row. */
  reason: string;
  /** Return the proposed rows without writing. */
  dryRun?: boolean;
  /** Override the reversal entry date (default MATINV_REVERSAL_DATE). */
  reversalDate?: string;
}

export interface MatInvApplyResult {
  phase: 'MATINV';
  status: 'applied' | 'already-applied' | 'dry-run' | 'aborted';
  wroteOutOfScopeData: false;
  reversal: {
    originalLedgerId: string;
    reversalEntryId: string | null;
    reversalReferenceId: string;
    amount: number;
    created: boolean;
  };
  capitalisation: Array<{
    component: 'OPENING' | 'CAPITAL';
    referenceId: string;
    entryId: string | null;
    date: string;
    amount: number;
    created: boolean;
  }>;
  /**
   * Effect of the approved correction on 11420 as it stands after this call
   * (0 when aborted): capitalisation legs, and all legs incl. the reversal.
   */
  capitalisationDebit11420: number;
  totalDebit11420: number;
  failures: MatInvFailure[];
}

// ── Helpers ──────────────────────────────────────────────────────

function round2(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Resolve a ledger account reference (id/code/account_number) on a row. */
function accountCodeOf(ref: string | undefined, accounts: any[]): string | null {
  if (!ref) return null;
  const found = accounts.find(
    (a) => a.id === ref || a.code === ref || a.account_number === ref
  );
  return found ? String(found.account_number ?? found.code ?? '') : null;
}

function isMatInvRow(entry: any): boolean {
  return (
    String(entry?.entryType || '') === MATINV_CORRECTION_ENTRY_TYPE ||
    String(entry?.referenceType || '') === MATINV_CORRECTION_ENTRY_TYPE
  );
}

// ── Preview ──────────────────────────────────────────────────────

/**
 * Pure verification pass: resolves the required accounts, verifies the
 * duplicate row's identity, and reports which components are already
 * applied. Performs no writes.
 */
export function previewMaterialInventoryCorrection(
  ledger: any[],
  accounts: any[],
  options: { reversalDate?: string } = {}
): MatInvPreview {
  const failures: MatInvFailure[] = [];
  const posted = (ledger || []).filter(isPostedLedgerEntry);
  const reversalDate = options.reversalDate || MATINV_REVERSAL_DATE;

  // ── Step 1: resolve accounts by code ──────────────────────────
  const rawMaterials = resolveAccountForPosting('11420', accounts, { allowNonPosting: false });
  const retainedEarnings = resolveAccountForPosting('32000', accounts, { allowNonPosting: false });
  const cogs = resolveAccountForPosting('51200', accounts, { allowNonPosting: false });

  const requireAccount = (
    role: string,
    id: string | null,
    expectedCode: string,
    expectedName: string
  ): string | null => {
    if (!id) {
      failures.push({
        check: `ACCOUNT_${role}`,
        reason: 'ACCOUNT_NOT_RESOLVED',
        detail: `Could not resolve a posting account for ${expectedCode} (${expectedName})`,
      });
      return null;
    }
    const acct = accounts.find((a) => a.id === id);
    const code = String(acct?.account_number ?? acct?.code ?? '');
    if (code !== expectedCode) {
      failures.push({
        check: `ACCOUNT_${role}`,
        reason: 'ACCOUNT_CODE_MISMATCH',
        detail: `Expected ${expectedCode} (${expectedName}), resolved to ${code || '(unknown)'}`,
      });
      return null;
    }
    if (acct && (acct.allow_posting === false || acct.allow_posting === 0)) {
      failures.push({
        check: `ACCOUNT_${role}`,
        reason: 'GROUP_ACCOUNT',
        detail: `${expectedCode} is a GROUP account and cannot receive postings`,
      });
      return null;
    }
    return id;
  };

  const rawMaterialsId = requireAccount('11420', rawMaterials, '11420', 'Raw Materials');
  const retainedEarningsId = requireAccount('32000', retainedEarnings, '32000', 'Retained Earnings');
  const cogsId = requireAccount('51200', cogs, '51200', 'Cost of Goods Sold');

  // ── Step 2: verify the duplicate ledger row ───────────────────
  const duplicate = posted.find((e) => String(e.id) === MATINV_DUPLICATE_LEDGER_ID) || null;

  if (!duplicate) {
    failures.push({
      check: 'DUPLICATE_ROW',
      reason: 'MISSING_ENTRY',
      detail: `Ledger row ${MATINV_DUPLICATE_LEDGER_ID} not found (or not posted)`,
    });
  } else {
    const amount = round2(duplicate.amount);
    if (amount !== MATINV_DUPLICATE_EXPECTED.amount) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'AMOUNT_MISMATCH',
        detail: `Expected K${MATINV_DUPLICATE_EXPECTED.amount}, found K${amount}`,
      });
    }
    const day = String(duplicate.date || '').slice(0, 10);
    if (day !== MATINV_DUPLICATE_EXPECTED.date) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'DATE_MISMATCH',
        detail: `Expected ${MATINV_DUPLICATE_EXPECTED.date}, found ${day || '(none)'}`,
      });
    }
    const debitCode = accountCodeOf(duplicate.debitAccountId, accounts);
    if (debitCode !== MATINV_DUPLICATE_EXPECTED.debitCode) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'DEBIT_ACCOUNT_MISMATCH',
        detail: `Expected debit ${MATINV_DUPLICATE_EXPECTED.debitCode}, found ${debitCode || duplicate.debitAccountId || '(none)'}`,
      });
    }
    const creditCode = accountCodeOf(duplicate.creditAccountId, accounts);
    if (creditCode !== MATINV_DUPLICATE_EXPECTED.creditCode) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'CREDIT_ACCOUNT_MISMATCH',
        detail: `Expected credit ${MATINV_DUPLICATE_EXPECTED.creditCode}, found ${creditCode || duplicate.creditAccountId || '(none)'}`,
      });
    }
    const ref = String(duplicate.referenceId || '').trim().toUpperCase();
    if (ref !== MATINV_DUPLICATE_EXPECTED.invoiceRef.toUpperCase()) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'INVOICE_REFERENCE_MISMATCH',
        detail: `Expected reference ${MATINV_DUPLICATE_EXPECTED.invoiceRef}, found ${ref || '(none)'}`,
      });
    }
    // The reversal and the capitalisation must act on the SAME account ids
    // the duplicate already uses, otherwise the netting would not land on
    // one 11420 balance.
    if (rawMaterialsId && duplicate.creditAccountId !== rawMaterialsId) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'CREDIT_ACCOUNT_ID_MISMATCH',
        detail: `Duplicate credits ${duplicate.creditAccountId} but 11420 resolves to ${rawMaterialsId}; posting would not net`,
      });
    }
    if (cogsId && duplicate.debitAccountId !== cogsId) {
      failures.push({
        check: 'DUPLICATE_ROW',
        reason: 'DEBIT_ACCOUNT_ID_MISMATCH',
        detail: `Duplicate debits ${duplicate.debitAccountId} but 51200 resolves to ${cogsId}; posting would not net`,
      });
    }
  }

  // ── Step 3: idempotency — detect already-applied components ────
  const existingReversalIds = posted
    .filter(
      (e) =>
        String(e.reversesEntryId || '') === MATINV_DUPLICATE_LEDGER_ID ||
        String(e.referenceId || '') === MATINV_REVERSAL_REFERENCE
    )
    .map((e) => String(e.id));
  const reversalAlreadyApplied = existingReversalIds.length > 0;

  const markerFor = (referenceId: string) =>
    posted.find((e) => isMatInvRow(e) && String(e.referenceId || '') === referenceId) || null;

  const openingComponents = MATINV_CAPITALISATION_COMPONENTS.map((c) => ({
    ...c,
    existing: markerFor(c.referenceId),
  }));

  const openingAlreadyApplied = !!openingComponents.find((c) => c.key === 'OPENING')?.existing;
  const capitalisationAlreadyApplied = !!openingComponents.find((c) => c.key === 'CAPITAL')?.existing;

  // ── Step 4: build the proposed rows (only fully-verified ones) ─
  const proposedEntries: MatInvProposedEntry[] = [];

  if (failures.length === 0 && duplicate && rawMaterialsId && retainedEarningsId && cogsId) {
    if (!reversalAlreadyApplied) {
      proposedEntries.push({
        component: 'REVERSAL',
        id: generateId('LG-MIC-REV'),
        date: reversalDate,
        description: `REVERSAL: duplicate material COGS leg ${MATINV_DUPLICATE_EXPECTED.invoiceRef} (${duplicate.description || ''}) — approved material-inventory correction`,
        // Swapped sides net the original exactly once.
        debitAccountId: rawMaterialsId,
        creditAccountId: cogsId,
        amount: MATINV_DUPLICATE_EXPECTED.amount,
        referenceId: MATINV_REVERSAL_REFERENCE,
        revertsEntryId: MATINV_DUPLICATE_LEDGER_ID,
      });
    }
    for (const c of openingComponents) {
      if (c.existing) continue;
      proposedEntries.push({
        component: c.key,
        id: generateId(`LG-MIC-${c.key}`),
        date: c.date,
        description: c.description,
        debitAccountId: rawMaterialsId,
        creditAccountId: retainedEarningsId,
        amount: c.amount,
        referenceId: c.referenceId,
      });
    }
  }

  const proposedCapitalisationTotal = round2(
    proposedEntries
      .filter((e) => e.component !== 'REVERSAL')
      .reduce((sum, e) => sum + e.amount, 0)
  );
  const proposedTotalDebit11420 = round2(
    proposedEntries
      .filter((e) => e.debitAccountId === rawMaterialsId)
      .reduce((sum, e) => sum + e.amount, 0)
  );

  const fullyApplied =
    reversalAlreadyApplied && openingAlreadyApplied && capitalisationAlreadyApplied;

  return {
    phase: 'MATINV',
    scope: MATINV_CORRECTION_SCOPE,
    duplicateFound: !!duplicate,
    duplicateIdempotency: {
      reversalAlreadyApplied,
      existingReversalIds,
      openingAlreadyApplied,
      capitalisationAlreadyApplied,
    },
    resolvedAccounts: {
      rawMaterials: rawMaterialsId,
      retainedEarnings: retainedEarningsId,
      cogs: cogsId,
    },
    proposedEntries,
    proposedCapitalisationTotal,
    proposedTotalDebit11420,
    failures,
    fullyApplied,
    canApply: failures.length === 0 && proposedEntries.length > 0,
  };
}

// ── Apply ────────────────────────────────────────────────────────

/**
 * Apply the approved correction. Verifies everything first; aborts with
 * zero writes on any failed pre-condition. Re-running after a successful
 * apply reports `already-applied` and writes nothing.
 */
export async function applyMaterialInventoryCorrection(
  options: MatInvApplyOptions
): Promise<MatInvApplyResult> {
  if (options?.confirmed !== true) {
    throw new Error('applyMaterialInventoryCorrection requires confirmed: true');
  }
  if (!options.reason || String(options.reason).trim() === '') {
    throw new Error('applyMaterialInventoryCorrection requires a non-empty reason');
  }

  const [ledger, accounts] = await Promise.all([
    dbService.getAll<any>('ledger'),
    loadAccountsFromStore(null),
  ]);

  const preview = previewMaterialInventoryCorrection(ledger, accounts, {
    reversalDate: options.reversalDate,
  });

  const emptyResult = (status: MatInvApplyResult['status']): MatInvApplyResult => ({
    phase: 'MATINV',
    status,
    wroteOutOfScopeData: false,
    reversal: {
      originalLedgerId: MATINV_DUPLICATE_LEDGER_ID,
      reversalEntryId: null,
      reversalReferenceId: MATINV_REVERSAL_REFERENCE,
      amount: MATINV_DUPLICATE_EXPECTED.amount,
      created: false,
    },
    capitalisation: MATINV_CAPITALISATION_COMPONENTS.map((c) => ({
      component: c.key,
      referenceId: c.referenceId,
      entryId: null,
      date: c.date,
      amount: c.amount,
      created: false,
    })),
    capitalisationDebit11420: 0,
    totalDebit11420: 0,
    failures: preview.failures,
  });

  if (preview.failures.length > 0) {
    logger.error(
      '[MATINV-CORRECTION] Pre-flight verification failed — nothing written:',
      JSON.stringify(preview.failures)
    );
    return emptyResult('aborted');
  }

  if (preview.fullyApplied) {
    logger.info('[MATINV-CORRECTION] Correction already applied — no new rows written');
    return {
      ...emptyResult('already-applied'),
      reversal: {
        ...emptyResult('already-applied').reversal,
        reversalEntryId: preview.duplicateIdempotency.existingReversalIds[0] ?? null,
      },
      capitalisation: MATINV_CAPITALISATION_COMPONENTS.map((c) => ({
        component: c.key,
        referenceId: c.referenceId,
        entryId: c.referenceId,
        date: c.date,
        amount: c.amount,
        created: false,
      })),
      capitalisationDebit11420: MATINV_APPROVED_CAPITALISATION_DEBIT_11420,
      totalDebit11420: MATINV_APPROVED_TOTAL_DEBIT_11420,
    };
  }

  if (preview.proposedEntries.length === 0) {
    logger.info('[MATINV-CORRECTION] Nothing to post');
    return emptyResult('already-applied');
  }

  if (options.dryRun) {
    logger.info('[MATINV-CORRECTION] Dry-run', { proposedEntries: preview.proposedEntries });
    const reversal = preview.proposedEntries.find((e) => e.component === 'REVERSAL');
    return {
      phase: 'MATINV',
      status: 'dry-run',
      wroteOutOfScopeData: false,
      reversal: {
        originalLedgerId: MATINV_DUPLICATE_LEDGER_ID,
        reversalEntryId: reversal?.id ?? null,
        reversalReferenceId: MATINV_REVERSAL_REFERENCE,
        amount: MATINV_DUPLICATE_EXPECTED.amount,
        created: !!reversal,
      },
      capitalisation: preview.proposedEntries
        .filter((e) => e.component !== 'REVERSAL')
        .map((e) => ({
          component: e.component as 'OPENING' | 'CAPITAL',
          referenceId: e.referenceId,
          entryId: e.id,
          date: e.date,
          amount: e.amount,
          created: true,
        })),
      capitalisationDebit11420: preview.proposedCapitalisationTotal,
      totalDebit11420: preview.proposedTotalDebit11420,
      failures: [],
    };
  }

  const now = new Date().toISOString();
  const rows = preview.proposedEntries.map((e) => ({
    id: e.id,
    date: e.date,
    description: e.description,
    debitAccountId: e.debitAccountId,
    creditAccountId: e.creditAccountId,
    amount: e.amount,
    referenceId: e.referenceId,
    // Deliberately NOT 'Reversal': isPostedLedgerEntry excludes that
    // value, and an offsetting row must stay posted to net the original.
    referenceType: MATINV_CORRECTION_ENTRY_TYPE,
    entryType: MATINV_CORRECTION_ENTRY_TYPE,
    status: 'posted',
    reconciled: false,
    reversesEntryId: e.revertsEntryId,
    idempotencyKey: `${MATINV_CORRECTION_SCOPE}:${e.referenceId}`,
    appliedBy: 'materialInventoryCorrectionService',
    applyReason: options.reason,
    created_at: now,
    createdAt: now,
    updatedAt: now,
  }));

  const writeOutcome = { writtenReferenceIds: [] as string[] };

  await dbService.executeAtomicOperation(['ledger'], async (tx: any) => {
    const store = tx.objectStore('ledger');
    const live: any[] = await store.getAll();

    for (const row of rows) {
      // Defensive re-check inside the write pass so a concurrent or
      // repeated run can never post a second copy.
      const clash = (live || []).find(
        (e) =>
          String(e.referenceId || '') === row.referenceId ||
          (row.reversesEntryId && String(e.reversesEntryId || '') === row.reversesEntryId)
      );
      if (clash) {
        logger.warn(
          `[MATINV-CORRECTION] Skipping ${row.referenceId} — already present as ${clash.id}`
        );
        continue;
      }
      await store.put(row);
      live.push(row);
      writeOutcome.writtenReferenceIds.push(row.referenceId);
    }
  });

  const reversalRow = rows.find((r) => r.reversesEntryId);
  const written = new Set(writeOutcome.writtenReferenceIds);
  logger.info(
    `[MATINV-CORRECTION] Applied: reversal ${reversalRow?.id ?? '(none)'}, capitalisation DR 11420 K${preview.proposedCapitalisationTotal}, total DR 11420 K${preview.proposedTotalDebit11420}`
  );

  return {
    phase: 'MATINV',
    status: 'applied',
    wroteOutOfScopeData: false,
    reversal: {
      originalLedgerId: MATINV_DUPLICATE_LEDGER_ID,
      reversalEntryId: reversalRow?.id ?? null,
      reversalReferenceId: MATINV_REVERSAL_REFERENCE,
      amount: MATINV_DUPLICATE_EXPECTED.amount,
      created: !!reversalRow,
    },
    capitalisation: MATINV_CAPITALISATION_COMPONENTS.map((c) => {
      const row = rows.find((r) => r.referenceId === c.referenceId);
      return {
        component: c.key,
        referenceId: c.referenceId,
        entryId: row ? row.id : c.referenceId,
        date: c.date,
        amount: c.amount,
        created: written.has(c.referenceId),
      };
    }),
    capitalisationDebit11420: preview.proposedCapitalisationTotal,
    totalDebit11420: preview.proposedTotalDebit11420,
    failures: [],
  };
}

export const materialInventoryCorrectionService = {
  previewMaterialInventoryCorrection,
  applyMaterialInventoryCorrection,
};

export default materialInventoryCorrectionService;
