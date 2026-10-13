/**
 * closedPeriodQueue.ts — ERP-only operator queue for sync operations the
 * gateway rejected with `adjustmentRequired` (closed financial period).
 *
 * READ-ONLY FIRST. This module never:
 *   - changes an operation's original business transaction date,
 *   - posts an adjusting journal entry or any financial adjustment,
 *   - reopens/creates a financial year or edits the closed-period registry,
 *   - bypasses the gateway's closed-period refusal.
 *
 * The ONLY mutation it can perform is re-queueing an existing operation
 * unchanged, and only after proving the period is currently OPEN via the
 * existing closed-period registry (financialPeriodClosure). Anything that
 * would require a financial adjustment is surfaced as requiring the existing
 * explicit approval mechanism and is deliberately left unimplemented.
 */
import { durableSyncQueue, type QueuedOperation } from './durableSyncQueue';
import { isFinancialPeriodClosed, loadClosedPeriods } from '../utils/financialPeriodClosure';

/** Contract financial tables that can be refused by the closed-period gate. */
export const CONTRACT_FINANCIAL_TABLES = new Set([
  'assessment_contract_items',
  'wallet_transactions',
  'ledger_entries',
  'assessment_contracts',
]);

const CLOSED_MARKERS = /closed financial year|closed period|CLOSED_PERIOD|adjustmentRequired|is not permitted within a closed/i;

export type AdjustmentQueueReason =
  | 'closed-period'
  | 'closed-period-missing-business-date'
  | 'other-permanent-rejection';

export interface AdjustmentQueueEntry {
  queueId: string;
  operationId: string;
  table: string;
  recordId: string | null;
  operation: string;
  status: QueuedOperation['status'];
  /** Original business transaction date carried by the operation — never rewritten. */
  businessDate: string | null;
  contractId: string | null;
  contractNumber: string | null;
  reason: AdjustmentQueueReason;
  rejectionReason: string;
  queueStatus: QueuedOperation['status'];
  createdAt: string;
  lastAttempt: string | null;
  retryCount: number;
  /** True only when the period is currently OPEN and re-queueing is safe. */
  retryEligible: boolean;
  retryBlockedBecause: string | null;
  /**
   * True when resolving this entry would require a real financial adjustment
   * (the correct business outcome). Those stay pending explicit approval.
   */
  requiresFinancialAdjustment: true;
}

const toDate = (v: unknown): string | null => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const readBusinessDate = (payload: unknown): string | null => {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  return toDate(
    p.business_date ?? p.businessDate ??
    p.consumed_at ?? p.consumedAt ??
    p.assessment_date ?? p.assessmentDate ??
    p.reserved_at ?? p.reservedAt ??
    p.date,
  );
};

/**
 * List contract operations awaiting an operator decision. Read-only.
 * Only surfaces entries whose rejection is (or looks like) a closed-period /
 * adjustment-required refusal.
 */
export const listAdjustmentQueue = async (): Promise<AdjustmentQueueEntry[]> => {
  const all = await durableSyncQueue.getAll('dead_letter' as QueuedOperation['status']).catch(() => [] as QueuedOperation[]);
  const candidates = (all || []).filter((op) => {
    if (!CONTRACT_FINANCIAL_TABLES.has(String(op?.table || ''))) return false;
    const err = String(op?.lastError || '');
    if (CLOSED_MARKERS.test(err)) return true;
    // A contract financial row with no resolvable business date is also an
    // adjustment-required rejection from the gateway gate.
    if (!readBusinessDate(op?.payload)) return true;
    return false;
  });

  const periods = await loadClosedPeriods().catch(() => []);

  const entries: AdjustmentQueueEntry[] = [];
  for (const op of candidates) {
    const businessDate = readBusinessDate(op.payload);
    const payload = (op.payload && typeof op.payload === 'object' ? op.payload : {}) as Record<string, unknown>;
    const err = String(op?.lastError || '');

    let reason: AdjustmentQueueReason;
    if (/business transaction date|sync timestamp/i.test(err)) reason = 'closed-period-missing-business-date';
    else if (CLOSED_MARKERS.test(err)) reason = 'closed-period';
    else reason = 'other-permanent-rejection';

    // Eligibility is re-derived from the CURRENT registry, never assumed.
    let retryEligible = false;
    let retryBlockedBecause: string | null = null;
    if (!businessDate) {
      retryBlockedBecause = 'Operation carries no original business transaction date. Re-save the record in the app so a fresh operation carries its real date. The original date is never synthesized here.';
    } else {
      const stillClosed = periods.find((p) => {
        const from = String(p.from || '').slice(0, 10);
        const to = String(p.to || '').slice(0, 10);
        return (!from || businessDate >= from) && (!to || businessDate <= to);
      });
      if (stillClosed) {
        retryBlockedBecause = `Business date ${businessDate} is still inside closed period ${String(stillClosed.from || '').slice(0, 10)} → ${String(stillClosed.to || '').slice(0, 10)}${stillClosed.reason ? ` (${stillClosed.reason})` : ''}. Re-queueing is blocked.`;
      } else {
        retryEligible = true;
      }
    }

    entries.push({
      queueId: String(op.id),
      operationId: String(op.operationId || ''),
      table: String(op.table || ''),
      recordId: op.recordId ? String(op.recordId) : null,
      operation: String(op.operation || ''),
      status: op.status,
      businessDate,
      contractId: payload.contract_id ? String(payload.contract_id) : null,
      contractNumber: payload.contract_number ? String(payload.contract_number) : null,
      reason,
      rejectionReason: err || 'Rejected by the sync gateway.',
      queueStatus: op.status,
      createdAt: String(op.createdAt || ''),
      lastAttempt: op.lastAttempt ? String(op.lastAttempt) : null,
      retryCount: Number(op.retryCount || 0),
      retryEligible,
      retryBlockedBecause,
      requiresFinancialAdjustment: true,
    });
  }

  return entries.sort((a, b) => (a.businessDate || '').localeCompare(b.businessDate || ''));
};

/**
 * Re-queue ONE rejected operation, unchanged, only when the closed-period
 * registry says its business date is now open.
 *
 * Deliberately does NOT: rewrite `business_date`, post an adjustment, or
 * reopen a financial year. Returns a typed outcome so the UI can report
 * "still blocked" instead of silently doing nothing.
 */
export const retryAdjustmentEntry = async (queueId: string): Promise<{
  retried: boolean;
  reason: string;
}> => {
  const op = (await durableSyncQueue.getAll('dead_letter' as QueuedOperation['status']).catch(() => [] as QueuedOperation[]))
    .find((o) => String(o.id) === String(queueId));
  if (!op) return { retried: false, reason: 'Queue entry no longer exists (it may have been processed elsewhere).' };

  const businessDate = readBusinessDate(op.payload);
  if (!businessDate) {
    return { retried: false, reason: 'Refused: operation has no original business transaction date. It will never be re-queued with a substituted date.' };
  }
  const conflict = await isFinancialPeriodClosed(businessDate).catch(() => null);
  if (conflict) {
    return {
      retried: false,
      reason: `Refused: ${businessDate} is still inside closed period ${String(conflict.from || '').slice(0, 10)} → ${String(conflict.to || '').slice(0, 10)}. Reopen the period through the existing approval flow before retrying.`,
    };
  }
  await durableSyncQueue.retryDeadLetter(String(op.id));
  return { retried: true, reason: `Re-queued unchanged (business date ${businessDate}). The gateway will re-validate it.` };
};

export const adjustmentQueueService = {
  listAdjustmentQueue,
  retryAdjustmentEntry,
  CONTRACT_FINANCIAL_TABLES,
};

export default adjustmentQueueService;