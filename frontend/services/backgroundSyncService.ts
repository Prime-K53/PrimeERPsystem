import { durableSyncQueue, quarantineOperationsMissingGeneration, classifyError, QueuedOperation, QueueMetrics } from './durableSyncQueue';
import { sendSyncOps, SyncOp, SyncOpResult, SyncAuthError } from './syncApiClient';
import { resolvePushConflict } from './syncConflictResolver';
import { cloudDb } from './cloudDb';
import { audit } from './syncAudit';
import { logger } from './logger';
import {
  diagActiveSyncId,
  diagCaller,
  diagLockAcquired,
  diagLockReleased,
  diagLog,
  diagNewSyncId,
  diagNextTimerGeneration,
  diagOnlineDetected,
  diagPendingQueueLoaded,
  diagPeriodicLifecycleCall,
  diagRetryAttempt,
  diagRetryWaitStarted,
  diagStageCompleted,
  diagStageFailed,
  diagStageStarted,
  diagSyncCompleted,
  diagSyncSkipped,
  diagSyncStarted,
  diagSyncTriggerInvoked,
  diagSyncTriggerSkipped,
  diagTimerCleared,
  diagTimerFired,
  diagTimerReplaced,
  diagTimerScheduled,
} from './syncDiag';

type SyncEventType = 'sync-start' | 'sync-complete' | 'sync-failure' | 'sync-partial' | 'queue-empty' | 'queue-full' | 'dead-letter' | 'sync-conflict';
type SyncCallback = (event: SyncEventType, data?: unknown) => void;

interface BatchResult {
  success: number;
  failed: number;
  deadLetter: number;
  skipped: number;
  conflictsResolved: number;
  durationMs: number;
}

interface SyncState {
  isSyncing: boolean;
  lastSyncStart: string | null;
  lastSyncSuccess: string | null;
  lastSyncFailure: string | null;
  consecutiveFailures: number;
  totalSynced: number;
  totalFailed: number;
  conflictsResolved: number;
}

/** Upper bound on automatic field-merge round-trips for a single operation
 *  before the conflict is escalated to the dead-letter queue for review. */
const MAX_CONFLICT_MERGES = 3;

const isClient = typeof window !== 'undefined';

let intervalId: ReturnType<typeof setInterval> | null = null;
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
// Generation of the currently installed periodic sync interval instance.
// Incremented on every REAL setInterval creation so logs can distinguish
// one timer being replaced from multiple timers coexisting. DEV-diag only.
let periodicTimerGeneration = 0;
// Last interval passed to setInterval for the periodic sync timer.
// Write-only diagnostic mirror (read only by DEV-only [ERP-SYNC-DIAG] logs);
// never influences scheduling decisions.
let lastScheduledIntervalMs: number | null = null;
let eventListenersRegistered = false;
let isInitialized = false;

let originalPushState: typeof history.pushState | null = null;
let originalReplaceState: typeof history.replaceState | null = null;

// Simulated-offline gate (used by the acceptance framework). While paused the
// sync engine never sends batches to the gateway, but local writes continue to
// enqueue normally — exactly the offline-first condition.
let paused = false;

// ─── Single-consumer sync lock ──────────────────────────────────────────────
// At most ONE syncOnce() execution may actively process the durable queue at
// any moment. The lock is acquired SYNCHRONOUSLY at syncOnce() entry — before
// the first await — so overlapping triggers (online, visibility, navigation,
// periodic timer, per-write triggers) can never enter the queue concurrently.
// `state.isSyncing` mirrors the lock for external readers; `activeSync` is
// the authoritative guard.
let activeSync: { syncId: string; trigger: string } | null = null;

// ─── Single authoritative lifecycle ─────────────────────────────────────────
// ONE named handler per browser event, registered exactly once via
// ensureLifecycleListeners(). Previously the module scope AND
// startPeriodicSync() each registered their own online/visibility listeners,
// so a single browser event fired syncOnce() twice.
// [ERP-SYNC-DIAG] Snapshot of the periodic timer firing context.
// Read-only: safe metadata only, no side effects, DEV-only via diagLog.
function timerOnline(): string {
  try {
    return typeof navigator !== 'undefined' ? String(navigator.onLine) : 'unknown';
  } catch {
    return 'unknown';
  }
}

function timerVisibility(): string {
  try {
    return typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  } catch {
    return 'unknown';
  }
}

function periodicTimerContext(trigger: string = 'periodic-interval') {
  return {
    trigger,
    intervalMs: lastScheduledIntervalMs ?? -1,
    timerGeneration: periodicTimerGeneration,
    timerActive: intervalId !== null,
    online: timerOnline(),
    visibility: timerVisibility(),
    activeSync: activeSync !== null,
    activeSyncId: activeSync?.syncId,
  };
}

async function periodicDoSync(origin: 'timer' | 'initial' = 'timer'): Promise<void> {
  // [ERP-SYNC-DIAG] The immediate initialization invocation is NOT a timer
  // fire (generation 0 = no installed timer). It keeps its own identity so
  // `periodic_timer_fired` always means a genuine interval callback.
  // The immediate sync behavior itself is unchanged and still required.
  if (origin === 'initial') {
    diagLog('periodic_initial_invoked', {
      ...periodicTimerContext(),
      trigger: 'periodic-initial',
    });
  } else {
    // [ERP-SYNC-DIAG] Fires every time the periodic timer callback runs.
    // Placed before any other work; decision logic below is unchanged.
    // Single emission: the full firing context rides on this one event.
    diagTimerFired('periodic', 'backgroundSync', lastScheduledIntervalMs ?? -1, periodicTimerGeneration, {
      trigger: 'periodic-interval',
      timerActive: intervalId !== null,
      online: timerOnline(),
      visibility: timerVisibility(),
      activeSync: activeSync !== null,
      activeSyncId: activeSync?.syncId,
    });
  }
  try {
    audit('push', 'syncOnce begin', {});
    // [ERP-SYNC-DIAG] Immediately before invoking the existing sync function.
    diagLog('periodic_sync_invoking', periodicTimerContext(origin === 'initial' ? 'periodic-initial' : 'periodic-interval'));
    await syncOnce(false, origin === 'initial' ? 'periodic-initial' : 'periodic-interval');
    audit('push', 'syncOnce end', {});
  } catch {
    // background sync errors are handled internally
  }
}

function rearmPeriodicTimer(): void {
  if (intervalId) {
    // [ERP-SYNC-DIAG] real timer replacement only — same clear+create as before.
    const oldGeneration = periodicTimerGeneration;
    clearInterval(intervalId);
    diagTimerCleared('periodic', 'backgroundSync', oldGeneration, 'replaced-by-rearm');
    const rearmMs = getBackoffInterval();
    lastScheduledIntervalMs = rearmMs;
    periodicTimerGeneration = diagNextTimerGeneration('periodic');
    intervalId = setInterval(periodicDoSync, rearmMs);
    diagTimerScheduled('periodic', 'backgroundSync', rearmMs, periodicTimerGeneration);
    diagTimerReplaced('periodic', 'backgroundSync', oldGeneration, periodicTimerGeneration, rearmMs);
  }
}

function handleLifecycleOnline(): void {
  state.consecutiveFailures = 0;
  rearmPeriodicTimer();
  diagOnlineDetected('backgroundSyncService:lifecycle-online');
  syncOnce(true, 'window-online').catch(() => {});
}

function handleLifecycleVisibility(): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  rearmPeriodicTimer();
  diagOnlineDetected('backgroundSyncService:lifecycle-visibility');
  syncOnce(true, 'visibility-visible').catch(() => {});
  runCleanup();
  reportHealth();
}

function ensureLifecycleListeners(): void {
  if (!isClient || eventListenersRegistered) return;
  eventListenersRegistered = true;
  try {
    if (typeof document !== 'undefined' && 'onvisibilitychange' in document) {
      document.addEventListener('visibilitychange', handleLifecycleVisibility);
    }
  } catch { /* listener registration is best-effort */ }
  try {
    if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
      window.addEventListener('online', handleLifecycleOnline);
    }
  } catch { /* listener registration is best-effort */ }
  ensureHistoryWrappers();
}

function removeLifecycleListeners(): void {
  if (!isClient) {
    eventListenersRegistered = false;
    return;
  }
  try {
    if (typeof document !== 'undefined' && 'onvisibilitychange' in document) {
      document.removeEventListener('visibilitychange', handleLifecycleVisibility);
    }
  } catch { /* best-effort */ }
  try {
    window.removeEventListener('online', handleLifecycleOnline);
  } catch { /* best-effort */ }
  eventListenersRegistered = false;
}

function ensureHistoryWrappers(): void {
  if (!isClient || typeof history === 'undefined') return;
  try {
    const marker = '__primeSyncWrapped';
    const alreadyWrapped =
      (history.pushState as unknown as Record<string, unknown>)?.[marker] === true;
    if (alreadyWrapped && originalPushState && originalReplaceState) return;
    if (!alreadyWrapped) {
      originalPushState = history.pushState.bind(history);
      originalReplaceState = history.replaceState.bind(history);
      history.pushState = onPushState;
      history.replaceState = onReplaceState;
      (history.pushState as unknown as Record<string, unknown>)[marker] = true;
      (history.replaceState as unknown as Record<string, unknown>)[marker] = true;
    }
  } catch { /* best-effort */ }
}

function restoreHistoryWrappers(): void {
  if (!isClient || typeof history === 'undefined') return;
  try {
    if (originalPushState) history.pushState = originalPushState;
    if (originalReplaceState) history.replaceState = originalReplaceState;
  } catch { /* best-effort */ }
  originalPushState = null;
  originalReplaceState = null;
}

// Push-sync → application refresh bridge (single signal per cycle; see
// emitPushSyncDataChanged below). One shared BroadcastChannel, mirroring
// syncService.emitDataChanged, so repeated cycles never leak channels.
let pushSyncChannel: BroadcastChannel | null = null;

function getPushSyncChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!pushSyncChannel) {
    try {
      pushSyncChannel = new BroadcastChannel('primeerp-data-sync');
    } catch {
      return null;
    }
  }
  return pushSyncChannel;
}

/**
 * Emit ONE data-changed signal after a push-sync cycle that successfully
 * applied server-bound changes, using the existing window +
 * BroadcastChannel mechanism consumed by DataContext.queueRefresh()
 * (debounced) — the same path realtime/pull completions already use.
 * No-ops when nothing was applied, so no-change cycles never force a
 * full application refresh. This is purely an invalidation signal: no
 * listener in the app starts a sync from it, so no refresh loop can form.
 */
function emitPushSyncDataChanged(syncId: string, successCount: number): void {
  diagLog('sync_data_changed_emitted', { id: syncId, success: successCount, channel: 'primeerp:data-changed' });
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('primeerp:data-changed', {
          detail: { source: 'push-sync', table: '*', eventType: 'PUSH_SYNC_COMPLETE' },
        }),
      );
    }
  } catch { /* best-effort */ }
  try {
    getPushSyncChannel()?.postMessage({
      type: 'data-changed',
      source: 'push-sync',
      table: '*',
      eventType: 'PUSH_SYNC_COMPLETE',
    });
  } catch { /* best-effort */ }
}

function onPushState(this: typeof history, ...args: Parameters<typeof history.pushState>) {
  diagSyncTriggerInvoked('navigation-pushState');
  setTimeout(() => syncOnce(true, 'navigation-pushState').catch(() => {}), 500);
  return originalPushState!.apply(this, args);
}

function onReplaceState(this: typeof history, ...args: Parameters<typeof history.replaceState>) {
  diagSyncTriggerInvoked('navigation-replaceState');
  setTimeout(() => syncOnce(true, 'navigation-replaceState').catch(() => {}), 500);
  return originalReplaceState!.apply(this, args);
}

const state: SyncState = {
  isSyncing: false,
  lastSyncStart: null,
  lastSyncSuccess: null,
  lastSyncFailure: null,
  consecutiveFailures: 0,
  totalSynced: 0,
  totalFailed: 0,
  conflictsResolved: 0,
};

const subscribers = new Map<string, SyncCallback>();

function notify(event: SyncEventType, data?: unknown) {
  for (const cb of subscribers.values()) {
    try { cb(event, data); } catch { /* guard */ }
  }
}

async function processBatch(batchSize: number = 10, batchNumber: number = 0): Promise<BatchResult> {
  const startTime = Date.now();
  let success = 0;
  let failed = 0;
  let deadLetter = 0;
  let skipped = 0;
  let conflictsResolved = 0;

  // [ERP-SYNC-DIAG] pending queue retrieval timing (existing dequeue only — no extra reads).
  const diagDequeueStart = performance.now();
  const items = await durableSyncQueue.dequeue(batchSize);
  const diagDequeueMs = performance.now() - diagDequeueStart;
  const diagOpCounts = { insert: 0, update: 0, upsert: 0, delete: 0, other: 0 };
  const diagTables = new Set<string>();
  for (const it of items) {
    diagTables.add(it.table);
    if (it.operation === 'insert') diagOpCounts.insert++;
    else if (it.operation === 'update') diagOpCounts.update++;
    else if (it.operation === 'upsert') diagOpCounts.upsert++;
    else if (it.operation === 'delete') diagOpCounts.delete++;
    else diagOpCounts.other++;
  }
  diagPendingQueueLoaded(diagActiveSyncId() ?? 'none', items.length, diagOpCounts, diagDequeueMs, batchNumber);
  logger.info('[BackgroundSync] processBatch dequeued', { count: items.length, tables: items.map(i => i.table) });

  if (items.length === 0) return { success: 0, failed: 0, deadLetter: 0, skipped: 0, conflictsResolved: 0, durationMs: 0 };

  /* SYNC-FORENSIC suppressed: STAGE-5 processBatch() dequeued */

  // Split the batch: business ops go through the backend sync gateway
  // (single write path); file uploads stay direct to Supabase Storage.
  const gatewayOps: { item: QueuedOperation; op: SyncOp }[] = [];
  const fileItems: QueuedOperation[] = [];

  for (const item of items) {
    if (item.fileRef) {
      fileItems.push(item);
    } else {
      gatewayOps.push({
        item,
        op: {
          operationId: item.operationId,
          table: item.table,
          recordId: item.recordId,
          operation: item.operation === 'delete' ? 'delete' : 'upsert',
          payload: item.payload,
          syncGeneration: item.syncGeneration,
        },
      });
    }
  }

  // 1) Business ops → backend gateway (one round-trip for the whole batch).
  let opResults = new Map<string, SyncOpResult>();
  let transportFailed = false;
  if (gatewayOps.length > 0) {
    const diagGatewayId = diagActiveSyncId() ?? 'none';
    const diagGatewayStart = performance.now();
    diagStageStarted(diagGatewayId, 'gateway-batch', { batch: batchNumber, ops: gatewayOps.length });
    try {
      const syncPayload = gatewayOps.map(({ op }) => op);
      logger.info('[BackgroundSync] sendSyncOps sending', { ops: syncPayload.length, tables: syncPayload.map(o => o.table) });
      /* SYNC-FORENSIC suppressed: STAGE-6 sendSyncOps() calling POST /api/sync/ops */
      const response = await sendSyncOps(syncPayload);
      diagStageCompleted(diagGatewayId, 'gateway-batch', performance.now() - diagGatewayStart, {
        batch: batchNumber,
        ops: gatewayOps.length,
        results: response.results.length,
      });
      /* SYNC-FORENSIC suppressed: STAGE-6 sendSyncOps() response */
      logger.info('[BackgroundSync] sendSyncOps response', { results: response.results.length });
      // Expose per-operation outcome diagnostics (safe metadata only)
      for (const result of response.results) {
        if (result.operationId) {
          const matchingItem = gatewayOps.find(g => g.op.operationId === result.operationId);
          logger.info('[BackgroundSync] op result', {
            table: matchingItem?.op.table,
            recordId: matchingItem?.op.recordId,
            operation: matchingItem?.op.operation,
            syncGeneration: matchingItem?.op.syncGeneration,
            ok: result.ok,
            error: result.error ? String(result.error).slice(0, 200) : undefined,
            retryable: result.retryable,
            conflict: result.conflict,
            stale: result.stale,
            reason: result.reason,
          });
        }
        if (result.operationId) opResults.set(result.operationId, result);
      }
    } catch (err) {
      // Transport failure: the entire batch is retryable. Mark items failed
      // and bail before the settle loop so they aren't marked completed.
      transportFailed = true;
      // [ERP-SYNC-DIAG] existing retry wait only — mechanism unchanged.
      const diagErrMsg = err instanceof Error ? err.message : String(err);
      const diagErrKind = err instanceof SyncAuthError ? 'unauthorized' : classifyError(diagErrMsg);
      diagStageFailed(diagActiveSyncId() ?? 'none', 'gateway-batch', diagErrKind, { batch: batchNumber, ops: gatewayOps.length });
      try {
        diagRetryWaitStarted(diagActiveSyncId(), getBackoffInterval(), 'transport-failure');
      } catch { /* diag-only */ }
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType = classifyError(errorMessage);
      /* SYNC-FORENSIC suppressed: STAGE-6 sendSyncOps() TRANSPORT FAILURE */
      // SyncAuthError is a sentinel thrown by syncApiClient for 401/403. These
      // are PERMANENT authorization failures — the durable queue must not retry
      // them on the periodic interval, and the sync engine must pause until the
      // user re-authenticates.
      if (err instanceof SyncAuthError) {
        await durableSyncQueue.markAuthBlocked(errorMessage);
        await durableSyncQueue.setMeta?.('sync_auth_block_reason', {
          status: err.status,
          code: err.code,
          at: new Date().toISOString(),
          message: errorMessage,
        });
        // Pause the engine so the periodic interval becomes a no-op until the
        // user signs in again. The AuthContext clears this on login.
        paused = true;
        notify('sync-failure', { failed: gatewayOps.length, deadLetter: 0, totalBefore: gatewayOps.length, authorizationBlocked: true, status: err.status });
      }
      for (const { item } of gatewayOps) {
        if (err instanceof SyncAuthError) {
          // Leave item in 'failed' with errorType='unauthorized' so retryFailed()
          // never auto-resets it. The queue drains again via resumeAfterAuth()
          // after the user re-authenticates.
          await durableSyncQueue.markFailed(item.id, errorMessage, 'unauthorized');
          failed++;
        } else {
          await durableSyncQueue.markFailed(item.id, errorMessage);
          if (errorType === 'permanent') deadLetter++;
          else failed++;
        }
      }
    }
  }

  const settleItem = async (item: QueuedOperation, result: SyncOpResult | undefined) => {
    if (!result || result.ok) {
      logger.info('[BackgroundSync] settleItem COMPLETED', { table: item.table, recordId: item.recordId, operation: item.operation, hasResult: !!result, ok: result?.ok });
      await durableSyncQueue.markCompleted(item.id);

      // Stamp the server-stamped version back into the live record (bulkPut:
      // no re-enqueue) so the next edit carries a valid optimistic-concurrency
      // base and never trips a `version_required` round-trip. Ambiguous or
      // non-business tables are skipped and self-heal through the merge path.
      const serverVersion = result ? Number(result.version) : NaN;
      const stampedPayload = (item.payload ?? {}) as Record<string, unknown>;
      if (Number.isFinite(serverVersion) && item.table !== '_files' && stampedPayload.id) {
        try {
          const { dbService, getStoreForCloudTable } = await import('./db');
          const storeName = getStoreForCloudTable(item.table);
          if (storeName) {
            const live = await dbService.get<Record<string, unknown>>(storeName as never, String(stampedPayload.id));
            if (live && typeof live === 'object') {
              (live as Record<string, unknown>)._version = serverVersion;
              (live as Record<string, unknown>).version = serverVersion;
              await dbService.bulkPut(storeName as never, [live]);
            }
          }
        } catch {
          // best-effort version stamp
        }
      }
      return 'success';
    }
    // Optimistic-concurrency conflict: the gateway rejected the write because
    // another device committed a newer version. Holds a current server snapshot
    // so we can field-merge and requeue in place — no extra round-trip.
    if (result.conflict && result.server) {
      return resolveConflict(item, result);
    }
    // Per-op rejection from the gateway: dead-letter permanent errors,
    // keep retrying transient ones.
    //
    // CRITICAL STATE MACHINE: a permanent rejection (including the server's
    // SYNC_GENERATION_MISSING / SYNC_GENERATION_STALE company-reset guards,
    // which always arrive with retryable:false) must move the item to the
    // terminal dead-letter state in the queue. Previously this only returned
    // a 'deadLetter' counter value while markFailed() classified the message
    // as retryable, leaving the item in 'failed' where the next sync cycle
    // re-queued and re-sent it forever — the source of the endless repeated
    // warnings for INV-P726/001 and prime:pagination:default.
    const errorMessage = result.error || 'Sync gateway rejected the operation';
    const permanent = result.retryable === false || classifyError(errorMessage) === 'permanent';
    logger.warn('[BackgroundSync] settleItem FAILED', { table: item.table, recordId: item.recordId, operation: item.operation, error: errorMessage.slice(0, 200), retryable: result.retryable, permanent, syncGeneration: item.syncGeneration });
    if (permanent) {
      await durableSyncQueue.deadLetter(item.id, errorMessage);
      return 'deadLetter';
    }
    await durableSyncQueue.markFailed(item.id, errorMessage);
    return 'failed';
  };

  const resolveConflict = async (item: QueuedOperation, result: SyncOpResult): Promise<'success' | 'deadLetter' | 'conflict' | 'failed'> => {
    const serverVersion = Number(result.server?.version ?? 0);
    const table = item.table;
    const recordId = item.recordId;

    const recordConflict = async (resolved: 'auto' | 'review', conflictedFields: string[]) => {
      await durableSyncQueue.recordConflict({
        operationId: item.operationId,
        table,
        recordId,
        conflictedFields,
        resolved,
        serverVersion,
      });
      notify('sync-conflict', {
        table,
        recordId,
        operation: item.operation,
        resolved,
        conflictedFields,
        serverVersion,
      });
    };

    // Deletes are tombstones that always bind; a conflict only means a
    // concurrent upsert raced ahead of the delete — the delete intent stands.
    // NARROW EXCEPTION (P0 examination canonical-ID guard): when the server
    // row is a DIFFERENT examination invoice sharing this id, neither merge
    // nor delete may touch the winner. Delegated to the examination-owned
    // module; every other record flows through generic handling unchanged.
    if (table === 'invoices') {
      // Contained: an unexpected guard failure must never abort the batch
      // settle loop and must never fall through to a merge. Retryable
      // failure preserves all data (local row + queue op intact).
      try {
        const { tryResolveExaminationInvoiceCollision } = await import('./examinationInvoiceCollisionService');
        const { dbService } = await import('./db');
        const { examinationBatchService } = await import('./examinationBatchService');
        const collision = await tryResolveExaminationInvoiceCollision(
          {
            id: item.id,
            operationId: item.operationId ?? null,
            table: item.table,
            recordId: item.recordId,
            operation: item.operation,
            payload: item.payload,
            conflictCount: item.conflictCount,
          },
          {
            version: serverVersion,
            updatedAt: result.server?.updatedAt ?? null,
            data: (result.server?.data ?? null) as Record<string, unknown> | null,
          },
          {
            listInvoices: () => dbService.getAll('invoices').catch(() => []) as Promise<Array<Record<string, unknown>>>,
            saveInvoiceLocal: (invoice: Record<string, unknown>) => dbService.put('invoices', invoice),
            removeInvoiceLocal: (id: string) => dbService.hardDelete('invoices', id),
            listBatches: () => examinationBatchService.listBatches().catch(() => []) as Promise<Array<Record<string, unknown>>>,
            updateBatchInvoiceLink: (batchId: string, invoiceId: string) =>
              examinationBatchService.updateBatch(batchId, { invoice_id: invoiceId } as never).then(() => undefined),
            completeQueueItem: (queueId: string) => durableSyncQueue.markCompleted(queueId),
            deadLetterQueueItem: (queueId: string, reason: string) => durableSyncQueue.deadLetter(queueId, reason),
            recordConflictAudit: (entry: { operationId: string | null; table: string; recordId: string | null; conflictedFields: string[]; resolved: 'auto' | 'review'; serverVersion: number }) =>
              recordConflict(entry.resolved, entry.conflictedFields),
            notifyUser: (event: string, data: unknown) => notify(event as SyncEventType, data),
            numberingConfig: undefined,
            ...(item.operation === 'delete'
              ? { localRecord: (await dbService.get('invoices', String(recordId || '')).catch(() => null)) as unknown as Record<string, unknown> | null }
              : {}),
          }
        );
        if (collision.handled) {
          if (collision.outcome === 'deadLetter') {
            state.totalFailed++;
          } else {
            state.conflictsResolved++;
            conflictsResolved++;
          }
          return collision.outcome;
        }
      } catch (guardError) {
        const message = guardError instanceof Error ? guardError.message : String(guardError);
        logger.warn('[BackgroundSync] examination collision guard failed — item retryable, never merged', {
          table,
          recordId,
          error: message.slice(0, 200),
        });
        try {
          await durableSyncQueue.markFailed(
            item.id,
            `Examination collision guard error (retryable, never merged): ${message}`
          );
        } catch {
          // Queue itself unavailable; the item stays syncing for a later pass.
        }
        return 'failed';
      }
    }

    if (item.operation === 'delete') {
      await durableSyncQueue.markCompleted(item.id);
      state.conflictsResolved++;
      conflictsResolved++;
      await durableSyncQueue.recordConflict({
        operationId: item.operationId,
        table,
        recordId,
        conflictedFields: [],
        resolved: 'auto',
        serverVersion,
      });
      // Hard-delete the tombstoned record from IndexedDB now that the
      // cloud has confirmed the delete.  This prevents tombstones from
      // accumulating locally forever.
      try {
        const { dbService, getStoreForCloudTable } = await import('./db');
        const localStore = getStoreForCloudTable(table);
        if (localStore && recordId) {
          await dbService.hardDelete(localStore as any, recordId);
        }
      } catch {
        // best-effort cleanup — the tombstone is harmless if left behind
      }
      return 'success';
    }

    const localPayload = (item.payload ?? {}) as Record<string, unknown>;
    const resolution = resolvePushConflict(localPayload, result.server.data, {
      version: serverVersion,
      updatedAt: result.server?.updatedAt,
    });

    // No local delta vs the server row — the conflicting update already
    // captured our intent (or only timestamps diverged). No re-push needed.
    if (resolution.converged) {
      await durableSyncQueue.markCompleted(item.id);
      state.conflictsResolved++;
      conflictsResolved++;
      await recordConflict(resolution.conflictedFields.length > 0 ? 'review' : 'auto', resolution.conflictedFields);
      return 'success';
    }

    const mergeCount = (item.conflictCount || 0) + 1;
    if (mergeCount > MAX_CONFLICT_MERGES) {
      // Back-and-forth on the same record with no convergence — stop looping
      // and leave it visible for manual review/retry.
      const reason = resolution.conflictedFields.length > 0
        ? `CONFLICT requires review — same-field edits: ${resolution.conflictedFields.join(', ')}`
        : 'CONFLICT requires review — repeated versioning conflicts';
      await durableSyncQueue.deadLetter(item.id, reason);
      state.totalFailed++;
      await recordConflict('review', resolution.conflictedFields);
      notify('dead-letter', { table, recordId, reason });
      return 'deadLetter';
    }

    // Requeue the field-merged payload with the fresh base version. It is
    // picked up by the next batch in this sync pass (or the next interval).
    await durableSyncQueue.requeue(item.id, resolution.merged, { conflictCount: mergeCount });
    state.conflictsResolved++;
    conflictsResolved++;
    await recordConflict(resolution.conflictedFields.length > 0 ? 'review' : 'auto', resolution.conflictedFields);
    return 'conflict';
  };

  for (const { item } of gatewayOps) {
    if (transportFailed) {
      // Already handled in the transport-failure catch above.
      continue;
    }
    const outcome = await settleItem(item, opResults.get(item.operationId));
    /* SYNC-FORENSIC suppressed: STAGE-7 settleItem() */
    if (outcome === 'success') {
      // Mark the local record as synced so the FY migration is idempotent
      // and the record is never re-queued. Uses bulkPut (no re-enqueue).
      if (item.table === 'financial_years' && item.recordId) {
        try {
          const { dbService } = await import('./db');
          const record = await dbService.get<any>('financialYears', item.recordId);
          if (record && !record.deletedAt) {
            record.syncStatus = 'synced';
            record.lastSyncedAt = new Date().toISOString();
            record._cloudSource = true;
            await dbService.bulkPut('financialYears', [record]);
          }
        } catch {
          // best-effort status write
        }
      }
      success++;
    } else if (outcome === 'deadLetter') {
      deadLetter++;
    } else if (outcome === 'conflict') {
      // Field-merged and requeued; it re-runs in the next batch of this pass.
      // conflictsResolved was already incremented inside resolveConflict so
      // delete/converged/requeue resolutions all count exactly once.
    } else {
      failed++;
    }
  }

  // 2) File uploads → direct Supabase Storage (large binaries bypass the
  // backend so the gateway never becomes a bandwidth bottleneck).
  const diagFileId = diagActiveSyncId() ?? 'none';
  const diagFileStart = performance.now();
  if (fileItems.length > 0) diagStageStarted(diagFileId, 'file-upload', { files: fileItems.length });
  const filePromises = fileItems.map(async (item) => {
    try {
      // Blobs live in the canonical PrimeERP IndexedDB `files` store
      // (written by dbService.uploadFile); never open a separate database —
      // a mismatched DB name would silently never find the blob.
      const { dbService } = await import('./db');
      const blob = await dbService.getFileBlob(item.fileRef);
      if (!blob) {
        await durableSyncQueue.markFailed(item.id, 'File blob missing locally — upload cannot proceed');
        deadLetter++;
        return;
      }
      await cloudDb.uploadFile(blob as File, 'documents', item.operationId);
      await durableSyncQueue.markCompleted(item.id);
      success++;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType = classifyError(errorMessage);
      await durableSyncQueue.markFailed(item.id, errorMessage);
      if (errorType === 'permanent') deadLetter++;
      else failed++;
    }
  });

  const settled = await Promise.allSettled(filePromises);
  if (fileItems.length > 0) {
    diagStageCompleted(diagFileId, 'file-upload', performance.now() - diagFileStart, { files: fileItems.length });
  }
  for (const result of settled) {
    if (result.status === 'rejected') {
      skipped++;
    }
  }

  const durationMs = Date.now() - startTime;
  state.lastSyncStart = new Date().toISOString();

  return { success, failed, deadLetter, skipped, conflictsResolved, durationMs };
}

async function syncOnce(force: boolean = false, triggerSource: string = 'unknown'): Promise<BatchResult | null> {
  // Every invocation is logged with its trigger source (diag-only).
  diagSyncTriggerInvoked(triggerSource);
  // Invocation ID doubles as the cycle correlation ID when admitted.
  const invocationId = diagNewSyncId();

  // ── Synchronous admission (BEFORE any await) ─────────────────────────────
  // This closes the race where N triggers overlapped during the
  // isAuthBlocked()/retryFailed()/countPending() awaits and each entered
  // queue processing. Exactly one invocation holds the lock; all others
  // return here without touching the queue.
  if (activeSync !== null) {
    diagSyncSkipped(activeSync.syncId, triggerSource, 'sync-in-progress');
    return null;
  }
  activeSync = { syncId: invocationId, trigger: triggerSource };
  state.isSyncing = true;
  diagLockAcquired(invocationId, triggerSource);
  // Reported in `finally` so every exit path (completed / exception /
  // paused / auth-blocked / zero-pending) shows lock release exactly once.
  let diagLockOutcome = 'early-return';

  try {
    // Simulated offline: the acceptance framework (and any user who wants a
    // true airplane mode) pauses network sync while local writes keep queuing.
    if (paused) {
      /* SYNC-FORENSIC suppressed: syncOnce() SKIPPED — paused (simulated offline) */
      diagSyncTriggerSkipped(triggerSource, 'paused');
      return null;
    }

    // Authorization-blocked: the sync gateway returned 401/403 for the current
    // session. RetryFailed() will not auto-requeue these items; the queue will
    // resume only after the user re-authenticates (AuthContext calls
    // durableSyncQueue.resumeAfterAuth() and clears the block).
    try {
      if (await durableSyncQueue.isAuthBlocked()) {
        diagSyncTriggerSkipped(triggerSource, 'auth-blocked');
        return null;
      }
    } catch {
      // non-fatal; fall through
    }

  // Cheap short-circuit: when nothing is pending there is nothing to do, so we
  // avoid the heavy getMetrics()/dequeue() scans that fired on every page
  // navigation and every background interval tick.
  //
  // CRITICAL: retry failed operations first. When the device goes offline
  // mid-sync, the transport failure catch marks pending ops as `failed`.
  // On reconnect, `countPending()` returns 0 because the items are `failed`,
  // so `syncOnce()` would skip forever. Retrying them restores them to
  // `pending` so the normal dequeue path picks them up.
  // [ERP-SYNC-DIAG] existing retryFailed() return value only — no extra query.
  let diagRetriedFailed = 0;
  try {
    diagRetriedFailed = await durableSyncQueue.retryFailed();
    if (diagRetriedFailed > 0) diagRetryAttempt(diagActiveSyncId(), 'retryFailed-on-sync-start', diagRetriedFailed);
  } catch {
    // non-fatal
  }

  let pendingCount = 0;
  try {
    pendingCount = await durableSyncQueue.countPending();
    logger.info('[BackgroundSync] syncOnce pendingCount:', pendingCount);
    if (pendingCount === 0) {
      /* SYNC-FORENSIC suppressed: syncOnce() SKIPPED — 0 pending ops */
      diagSyncTriggerSkipped(triggerSource, 'zero-pending');
      return null;
    }
  } catch {
    // If the count fails, proceed anyway.
  }

  /* SYNC-FORENSIC suppressed: syncOnce() START */
  // [ERP-SYNC-DIAG] correlation ID for this offline → online sync cycle (client-side only).
  // Reuses the invocation ID issued at lock acquisition so entry, lock, and
  // processing events share one ID.
  const diagSyncId = diagSyncStarted(pendingCount, diagRetriedFailed, invocationId);
  const diagSyncStartMs = performance.now();
  logger.info('[BackgroundSync] syncOnce starting to process', { pendingCount });

  const metricsBefore: QueueMetrics = await durableSyncQueue.getMetrics();
    const totalBefore = metricsBefore.total;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalDeadLetter = 0;
    let totalSkipped = 0;
    let totalConflicts = 0;
    let totalDuration = 0;
    let batchCount = 0;

    const maxBatches = 5;

    // Batch size scales with what's actually queued so a burst of offline edits
    // isn't serialized through tiny 10-item batches, while a sparse queue stays
    // small and responsive. Capped to keep a single request well under the
    // gateway limit.
    let batchSize = 10;
    try {
      const pendingCount = await durableSyncQueue.countPending();
      if (pendingCount > 40) batchSize = 25;
      else if (pendingCount > 20) batchSize = 15;
    } catch {
      batchSize = 10;
    }

    for (let i = 0; i < maxBatches; i++) {
      const result = await processBatch(batchSize, i + 1);
      if (result.success === 0 && result.failed === 0 && result.deadLetter === 0 && result.skipped === 0 && result.conflictsResolved === 0) break;

      totalSuccess += result.success;
      totalFailed += result.failed;
      totalDeadLetter += result.deadLetter;
      totalSkipped += result.skipped;
      totalConflicts += result.conflictsResolved;
      totalDuration += result.durationMs;
      batchCount++;
    }

    state.totalSynced += totalSuccess;
    state.totalFailed += totalFailed + totalDeadLetter;

    const metricsAfter: QueueMetrics = await durableSyncQueue.getMetrics();

    await durableSyncQueue.setMeta('last_sync_batch', {
      timestamp: new Date().toISOString(),
      success: totalSuccess,
      failed: totalFailed,
      deadLetter: totalDeadLetter,
      conflictsResolved: totalConflicts,
      durationMs: totalDuration,
      batchCount,
      totalBefore,
      totalAfter: metricsAfter.total,
    });

    if (totalFailed > 0 || totalDeadLetter > 0) {
      state.consecutiveFailures++;
      state.lastSyncFailure = new Date().toISOString();
      await durableSyncQueue.recordMetric('last_sync_failure', state.lastSyncFailure);
      notify('sync-failure', { failed: totalFailed, deadLetter: totalDeadLetter, totalBefore });
    } else if (totalSuccess > 0) {
      state.consecutiveFailures = 0;
      state.lastSyncSuccess = new Date().toISOString();
      await durableSyncQueue.recordMetric('last_sync_success', state.lastSyncSuccess);
      notify('sync-complete', { synced: totalSuccess, totalBefore });
    }

    if (totalBefore > 0 && metricsAfter.total === 0) {
      notify('queue-empty');
    }

    /* SYNC-FORENSIC suppressed: syncOnce() COMPLETE */
    // [ERP-SYNC-DIAG] sync completion uses only values already in hand — no extra queries.
    diagSyncCompleted(
      diagSyncId,
      performance.now() - diagSyncStartMs,
      totalSuccess,
      totalFailed + totalDeadLetter,
      metricsAfter.total,
    );
    if (totalSuccess > 0) {
      // Exactly ONE data-changed signal per cycle that actually applied
      // changes (never one per operation). No-change cycles (only failures,
      // dead-letters, skips, no-ops) emit nothing and never force a refresh.
      emitPushSyncDataChanged(diagSyncId, totalSuccess);
    } else {
      diagLog('sync_completed_no_data_change', {
        id: diagSyncId,
        note: 'no-successful-operations-no-refresh-emitted',
      });
    }
    diagLockOutcome = 'completed';
    return { success: totalSuccess, failed: totalFailed, deadLetter: totalDeadLetter, skipped: totalSkipped, conflictsResolved: totalConflicts, durationMs: totalDuration };
  } catch (err) {
    state.consecutiveFailures++;
    state.lastSyncFailure = new Date().toISOString();
    await durableSyncQueue.recordMetric('last_sync_failure', state.lastSyncFailure);
    notify('sync-failure', { error: err instanceof Error ? err.message : String(err) });
    /* SYNC-FORENSIC suppressed: syncOnce() EXCEPTION */
    diagLockOutcome = 'exception';
    return null;
  } finally {
    // The lock is ALWAYS released here: success, failure, exception, and
    // every early return above. The next legitimate sync can always proceed.
    if (activeSync?.syncId === invocationId) activeSync = null;
    state.isSyncing = false;
    diagLockReleased(invocationId, diagLockOutcome);
  }
}

function getBackoffInterval(): number {
  const base = 15000;
  const maxInterval = 600000;
  const multiplier = Math.min(state.consecutiveFailures, 8);
  return Math.min(base * Math.pow(2, multiplier), maxInterval);
}

async function runCleanup(): Promise<void> {
  try {
    const removed = await durableSyncQueue.cleanup(86400000);
    if (removed > 0) {
      await durableSyncQueue.recordMetric('cleanup_removed', removed);
    }
  } catch {
    // cleanup errors are non-fatal
  }
}

async function reportHealth(): Promise<void> {
  try {
    const metrics = await durableSyncQueue.getMetrics();
    const stuckThreshold = 300000;
    if (metrics.oldestPending) {
      const oldestAge = Date.now() - new Date(metrics.oldestPending).getTime();
      if (oldestAge > stuckThreshold && metrics.pending > 0) {
        notify('queue-full', { oldestAge, pending: metrics.pending });
      }
    }
  } catch {
    // health check errors are non-fatal
  }
}

if (isClient) {
  // Navigation triggers only — online/visibility listeners are owned by the
  // single authoritative lifecycle (ensureLifecycleListeners, called from
  // startPeriodicSync). History wrappers install once (marker-guarded).
  ensureHistoryWrappers();
}

export const backgroundSyncService = {
  get state(): Readonly<SyncState> { return state; },

  async initialize(intervalMs?: number): Promise<void> {
    if (isInitialized) return;
    isInitialized = true;
    logger.info('[BackgroundSync] initialize starting');

    // Legacy queue records (persisted by an older build before syncGeneration
    // metadata existed) have no generation provenance. Quarantine them at
    // startup so the background loop never transmits an operation whose
    // generation cannot be verified after a company reset. Idempotent and
    // payload-preserving (records stay visible in SyncHealth with a reason).
    try {
      const quarantined = await quarantineOperationsMissingGeneration();
      if (quarantined > 0) {
        await durableSyncQueue.recordMetric('legacy_quarantined', quarantined);
      }
    } catch (quarantineErr) {
      // non-fatal: dequeue() also quarantines as a second line of defence
      logger.warn('[BackgroundSync] initialize quarantine step failed (dequeue will retry)', { error: String(quarantineErr) });
    }

    const recovered = await durableSyncQueue.rebuildDependencyGraph();
    if (recovered > 0) {
      await durableSyncQueue.recordMetric('graph_recovered', recovered);
    }

    logger.info('[BackgroundSync] initialize calling startPeriodicSync');
    await this.startPeriodicSync(intervalMs);
    await runCleanup();
    logger.info('[BackgroundSync] initialize complete');
  },

  startPeriodicSync(intervalMs?: number): void {
    // [ERP-SYNC-DIAG] lifecycle entry only — who called, no behavior change.
    const diagStartCaller = diagCaller('startPeriodicSync');
    diagPeriodicLifecycleCall('backgroundSync', 'start', 'started', diagStartCaller);
    // Idempotent: repeated calls never create duplicate timers or listeners.
    // The existing interval is replaced (single timer), listeners are
    // registered exactly once via the guard in ensureLifecycleListeners().
    const replacedOldGeneration = intervalId ? periodicTimerGeneration : null;
    if (intervalId) {
      clearInterval(intervalId);
      // [ERP-SYNC-DIAG] real timer replacement only — same clear as before.
      diagTimerCleared('periodic', 'backgroundSync', replacedOldGeneration as number, 'replaced-by-startPeriodicSync');
      intervalId = null;
    }
    logger.info('[BackgroundSync] startPeriodicSync starting', { intervalMs });

    audit('push', 'backgroundSyncService startPeriodicSync', { intervalMs });

    ensureLifecycleListeners();

    // Immediate first pass (existing behavior, still required): runs once
    // synchronously at startup. It is NOT a timer fire — see periodicDoSync.
    periodicDoSync('initial');
    // Normal path: the caller threads the configured interval (60000 ms from
    // syncService). The backoff fallback applies ONLY when no interval was
    // configured (direct no-arg calls) — it is the failure/retry polling
    // branch and must not replace the normal 60s configuration.
    const diagScheduledMs = intervalMs ?? getBackoffInterval();
    lastScheduledIntervalMs = diagScheduledMs;
    diagLog('sync_polling_scheduled', {
      requested_interval_ms: intervalMs ?? -1,
      effective_interval_ms: diagScheduledMs,
      consecutiveFailures: state.consecutiveFailures,
    });
    periodicTimerGeneration = diagNextTimerGeneration('periodic');
    intervalId = setInterval(periodicDoSync, diagScheduledMs);
    // [ERP-SYNC-DIAG] real interval creation only — value unchanged.
    diagTimerScheduled('periodic', 'backgroundSync', diagScheduledMs, periodicTimerGeneration);
    if (replacedOldGeneration !== null) {
      diagTimerReplaced('periodic', 'backgroundSync', replacedOldGeneration, periodicTimerGeneration, diagScheduledMs);
    }

    if (!cleanupIntervalId) {
      cleanupIntervalId = setInterval(runCleanup, 3600000);
    }
  },

  stopPeriodicSync(): void {
    // [ERP-SYNC-DIAG] lifecycle entry only — who called, no behavior change.
    diagPeriodicLifecycleCall('backgroundSync', 'stop', 'stopped', diagCaller('stopPeriodicSync'));
    // Full lifecycle teardown (symmetric with start): timers AND the single
    // authoritative listener set. A later startPeriodicSync() re-registers.
    // After logout this also stops wasted wakeups (previously listeners
    // survived and every online event ran a no-op syncOnce).
    if (intervalId) {
      clearInterval(intervalId);
      // [ERP-SYNC-DIAG] real clear only — same clear as before.
      diagTimerCleared('periodic', 'backgroundSync', periodicTimerGeneration, 'stopPeriodicSync');
      intervalId = null;
    }
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }
    removeLifecycleListeners();
  },

  async syncNow(force: boolean = true, triggerSource: string = 'manual-syncNow'): Promise<BatchResult | null> {
    return syncOnce(force, triggerSource);
  },

  async getMetrics(): Promise<QueueMetrics> {
    return durableSyncQueue.getMetrics();
  },

  async retryDeadLetter(id: string): Promise<void> {
    await durableSyncQueue.retryDeadLetter(id);
  },

  async retryAllFailed(): Promise<number> {
    return durableSyncQueue.retryFailed();
  },

  async getState(): Promise<SyncState & { queueMetrics: QueueMetrics }> {
    const metrics = await durableSyncQueue.getMetrics();
    return { ...state, queueMetrics: metrics };
  },

  subscribe(id: string, callback: SyncCallback): () => void {
    subscribers.set(id, callback);
    return () => { subscribers.delete(id); };
  },

  async exportQueue(): Promise<QueuedOperation[]> {
    return durableSyncQueue.getAll();
  },

  /** Conflict records (auto-resolved + flagged-for-review) for dashboards/UI. */
  async getConflicts(limit?: number): Promise<unknown[]> {
    return durableSyncQueue.getConflicts(limit);
  },

  async getConflictCount(): Promise<{ auto: number; review: number }> {
    return durableSyncQueue.getConflictCount();
  },

  triggerImmediateSync(): void {
    syncOnce(true, 'immediate').catch(() => {});
  },

  /** Alias for syncNow — used by syncService.ts */
  async trigger(): Promise<BatchResult | null> {
    return syncOnce(true, 'queue-trigger');
  },

  /** True while the sync engine is in simulated-offline mode. */
  isPaused(): boolean {
    return paused;
  },

  /** Pause/resume network sync without touching the local queue. */
  setPaused(value: boolean): void {
    paused = value;
  },

  /** Alias for initialize — used by syncService.ts. Threads the configured
   *  periodic interval through so the normal background timer uses it
   *  instead of falling back to the retry/backoff base interval. */
  start(intervalMs?: number): void {
    this.initialize(intervalMs).catch(() => {});
  },

  /** Reset internal state for test isolation */
  reset(): void {
    if (activeSync !== null) activeSync = null;
    state.isSyncing = false;
    paused = false;
    state.lastSyncStart = null;
    state.lastSyncSuccess = null;
    state.lastSyncFailure = null;
    state.consecutiveFailures = 0;
    state.totalSynced = 0;
    state.totalFailed = 0;
    state.conflictsResolved = 0;
    subscribers.clear();
    this.stopPeriodicSync();
    restoreHistoryWrappers();
    if (pushSyncChannel) {
      try { pushSyncChannel.close(); } catch { /* best-effort */ }
      pushSyncChannel = null;
    }
    eventListenersRegistered = false;
    isInitialized = false;
  },
};
