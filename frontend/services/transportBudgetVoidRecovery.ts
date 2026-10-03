/**
 * transportBudgetVoidRecovery.ts — Phase 6E: full-void REVERSAL recovery reconciliation.
 *
 * Repairs the known Phase 6 lifecycle gap:
 *   commercial void succeeds
 *     -> REVERSAL is missing
 *
 * DETECTION + DELEGATION ONLY. This module contains no business semantics:
 *   - no SALES_ALLOCATION lookup logic beyond the frozen deterministic key,
 *   - no reversal amount calculation,
 *   - no REVERSAL event construction,
 *   - no idempotency-key construction (key helpers are reused from the
 *     frozen producer module),
 *   - no `appendReversal` call,
 *   - no validator logic,
 *   - no Transport Budget policy access (the policy store field, the rate
 *     resolver, and the company-config policy object are never imported
 *     or invoked — the reconciler has no rate responsibility),
 *   - no commercial void (`voidInvoice` is never invoked — an
 *     already-Cancelled invoice must never re-enter the void lifecycle).
 *
 * A recovery candidate satisfies ALL of:
 *   invoice.status === 'Cancelled'
 *   AND SALES_ALLOCATION:${invoice.id} exists with kind SALES_ALLOCATION
 *   AND REVERSAL:${invoice.id}:VOID does not exist
 *
 * Candidates are repaired exclusively through the existing deterministic
 * producer `produceVoidReversalSafely({ id })`, so the final architecture is:
 *   voidInvoice    -> produceVoidReversalSafely()
 *   reconciliation -> produceVoidReversalSafely()
 * There is exactly one semantic REVERSAL producer.
 *
 * SAFE TO RUN REPEATEDLY AND OFFLINE:
 *   - reads are local IndexedDB only (invoices + transport events);
 *   - the REVERSAL is created locally and transported later by the normal
 *     durable sync queue (IndexedDB -> queue -> /api/sync/ops);
 *   - no HTTP call is made here;
 *   - a failure for one invoice never aborts the scan (per-invoice isolation);
 *   - the reconciler never throws into its lifecycle trigger.
 *
 * Concurrency relies on the existing Phase 4 controls (deterministic
 * idempotency key, per-instance repository mutex, database unique
 * idempotency index, target row locking, cumulative reversal cap,
 * append-only enforcement). No new locking is introduced. Within one scan
 * each invoice id is handled at most once.
 */
import { dbService } from './db';
import { logger } from './logger';
import {
  produceVoidReversalSafely,
  salesAllocationIdempotencyKey,
  voidEconomicKey,
  voidReversalIdempotencyKey,
} from './transportBudgetVoidReversal';
import { transportBudgetRepository } from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';

/** Minimal invoice shape required for recovery detection (read-only). */
export interface VoidRecoveryInvoice {
  id?: string;
  status?: string;
}

/** Injectable seams (hermetic tests supply fakes; production uses defaults). */
export interface VoidRecoveryDeps {
  /** Local invoice rows (bulk read; filtered in-memory for Cancelled). */
  listInvoices(): Promise<VoidRecoveryInvoice[]>;
  /** Local transport-budget events (single bulk read; indexed in-memory). */
  listTransportEvents(): Promise<TransportBudgetEvent[]>;
  /**
   * The existing deterministic full-void REVERSAL producer. Production
   * delegates to `produceVoidReversalSafely` with its default Phase 4 deps.
   */
  produceVoidReversal(
    invoice: { id: string },
  ): Promise<Awaited<ReturnType<typeof produceVoidReversalSafely>>>;
  log: Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/** Production deps: local IndexedDB reads + the frozen Phase 6 producer. */
export const defaultVoidRecoveryDeps: VoidRecoveryDeps = {
  listInvoices: () => dbService.getAll<VoidRecoveryInvoice>('invoices'),
  listTransportEvents: () =>
    transportBudgetRepository.listTransportBudgetEvents(),
  produceVoidReversal: (invoice) => produceVoidReversalSafely(invoice),
  log: logger,
};

export interface VoidRecoveryFailure {
  invoiceId: string;
  error: string;
}

export interface VoidRecoverySummary {
  /** Cancelled invoices examined (after identity normalization + dedupe). */
  scannedCancelled: number;
  /** REVERSALs created-or-resolved through the existing producer. */
  appended: number;
  /** Invoice ids for which the producer reported `appended`. */
  appendedIds: string[];
  /** Skipped because REVERSAL:${id}:VOID already exists (idempotent). */
  skippedExisting: number;
  /** Deferred because SALES_ALLOCATION:${id} is absent (Case A). */
  deferredMissingAllocation: number;
  /** Skipped because non-full-void reversals already target the allocation. */
  skippedAmbiguous: number;
  /** Producer reported `failed` (or threw outside its own guard). */
  failed: number;
  failures: VoidRecoveryFailure[];
}

const emptySummary = (): VoidRecoverySummary => ({
  scannedCancelled: 0,
  appended: 0,
  appendedIds: [],
  skippedExisting: 0,
  deferredMissingAllocation: 0,
  skippedAmbiguous: 0,
  failed: 0,
  failures: [],
});

/**
 * Scan local Cancelled invoices for a missing deterministic full-void
 * REVERSAL and repair each candidate through the existing producer.
 * Never throws: read failures and per-invoice failures are logged and
 * reflected in the summary.
 */
export async function reconcileMissingFullVoidReversals(
  deps: VoidRecoveryDeps = defaultVoidRecoveryDeps,
): Promise<VoidRecoverySummary> {
  const summary = emptySummary();
  const log = deps.log ?? logger;

  let invoices: VoidRecoveryInvoice[];
  let events: TransportBudgetEvent[];
  try {
    [invoices, events] = await Promise.all([
      deps.listInvoices(),
      deps.listTransportEvents(),
    ]);
  } catch (err) {
    log.error(
      '[TransportBudget] void-recovery scan aborted (local read failed):',
      err,
    );
    return summary;
  }

  const byKey = new Map<string, TransportBudgetEvent>();
  for (const entry of events || []) {
    if (entry && typeof entry.idempotencyKey === 'string') {
      byKey.set(entry.idempotencyKey, entry);
    }
  }

  const seenInScan = new Set<string>();

  for (const invoice of invoices || []) {
    // Only already-commercially-voided invoices are in scope. The status
    // match is exact: the commercial void persists precisely 'Cancelled'.
    if (String(invoice?.status ?? '') !== 'Cancelled') continue;
    // Reuse the frozen economic-identity derivation (no key duplication).
    const economicKey = voidEconomicKey(invoice);
    if (!economicKey) {
      log.debug(
        '[TransportBudget] void-recovery skipped invoice without identity.',
      );
      continue;
    }
    // One attempt per invoice id within a scan, even if the local store
    // somehow holds duplicate rows for the same id.
    if (seenInScan.has(economicKey)) continue;
    seenInScan.add(economicKey);
    summary.scannedCancelled += 1;

    try {
      // Case A — allocation not yet available locally: defer. No zero
      // reversal, no policy read, no placeholder, no invoice mutation.
      const allocationKey = salesAllocationIdempotencyKey(economicKey);
      const original = byKey.get(allocationKey);
      if (!original || original.kind !== 'SALES_ALLOCATION') {
        summary.deferredMissingAllocation += 1;
        log.debug(
          `[TransportBudget] void-recovery deferred (missing original allocation) invoice=${economicKey} allocationKey=${allocationKey}`,
        );
        continue;
      }

      // Case C — expected REVERSAL already exists: idempotent skip. The
      // producer is not invoked unnecessarily.
      const reversalKey = voidReversalIdempotencyKey(economicKey);
      const existing = byKey.get(reversalKey);
      if (existing) {
        summary.skippedExisting += 1;
        log.debug(
          `[TransportBudget] void-recovery skipped (reversal exists) invoice=${economicKey} reversalKey=${reversalKey}`,
        );
        continue;
      }

      // Partial/foreign-reversal safety (§11): a REVERSAL already targets
      // the original allocation under a different key. Do not invent a
      // repair policy — log and leave for explicit future handling.
      const hasOtherReversal = (events || []).some(
        (entry) =>
          entry?.kind === 'REVERSAL' &&
          (entry.reversesEventId ?? null) === String(original.id),
      );
      if (hasOtherReversal) {
        summary.skippedAmbiguous += 1;
        log.warn(
          `[TransportBudget] void-recovery skipped ambiguous partial-reversal state invoice=${economicKey} allocationId=${String(original.id)} reversalKey=${reversalKey}`,
        );
        continue;
      }

      // Case B — allocation exists, REVERSAL missing: delegate to the
      // existing deterministic producer (never voidInvoice, never direct
      // event construction, never policy access).
      const outcome = await deps.produceVoidReversal({ id: economicKey });
      if (outcome.status === 'appended') {
        summary.appended += 1;
        summary.appendedIds.push(economicKey);
        log.info(
          `[TransportBudget] void-recovery appended REVERSAL invoice=${economicKey} reversalKey=${reversalKey} deduplicated=${String(outcome.deduplicated)}`,
        );
      } else if (outcome.status === 'missing-allocation') {
        // Lost race between the bulk read and the append (allocation
        // removed locally). Defer like Case A.
        summary.deferredMissingAllocation += 1;
        log.debug(
          `[TransportBudget] void-recovery deferred at append (allocation gone) invoice=${economicKey}`,
        );
      } else if (outcome.status === 'skipped') {
        log.debug(
          `[TransportBudget] void-recovery skipped at append invoice=${economicKey} reason=${outcome.reason}`,
        );
      } else {
        // 'failed' — the producer already logged the cause; record it and
        // continue with the next invoice. A later trigger may retry the
        // same deterministic key.
        summary.failed += 1;
        summary.failures.push({
          invoiceId: economicKey,
          error: String(
            (outcome as { error?: unknown }).error instanceof Error
              ? ((outcome as { error?: unknown }).error as Error).message
              : JSON.stringify(
                  (outcome as { error?: unknown }).error ?? 'append failed',
                ),
          ).slice(0, 300),
        });
        log.error(
          `[TransportBudget] void-recovery append failed invoice=${economicKey} reversalKey=${reversalKey}`,
        );
      }
    } catch (err) {
      // Per-invoice isolation: record, log, and continue the scan.
      summary.failed += 1;
      summary.failures.push({
        invoiceId: economicKey,
        error: String(
          err instanceof Error ? err.message : JSON.stringify(err ?? 'error'),
        ).slice(0, 300),
      });
      log.error(
        `[TransportBudget] void-recovery failed invoice=${economicKey}:`,
        err,
      );
    }
  }

  return summary;
}

/**
 * Lifecycle-safe entry point: concurrent triggers share a single in-flight
 * scan instead of overlapping. The reconciler only invokes the existing
 * producer (which enqueues through the durable queue); it never starts a
 * sync itself, so no sync -> reconciliation -> sync loop can form: a
 * follow-up run finds the REVERSAL present (Case C) and performs no work.
 */
let activeRecovery: Promise<VoidRecoverySummary> | null = null;

export function requestVoidRecoveryReconciliation(
  deps: VoidRecoveryDeps = defaultVoidRecoveryDeps,
): Promise<VoidRecoverySummary> {
  if (activeRecovery) return activeRecovery;
  const run = reconcileMissingFullVoidReversals(deps);
  activeRecovery = run;
  const clear = () => {
    if (activeRecovery === run) activeRecovery = null;
  };
  run.then(clear, clear);
  return run;
}
